using System.Buffers;
using System.Collections.Concurrent;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading.Channels;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using SPTarkov.Common.Models.Logging;
using SPTarkov.DI.Annotations;
using SPTarkov.Server.Core.DI;
using SPTarkov.Server.Core.Helpers.Server;
using SPTarkov.Server.Core.Models.Common;
using SPTarkov.Server.Core.Models.Spt.Config;
using SPTarkov.Server.Core.Servers;
using SPTarkov.Server.Core.Servers.Http;

namespace Satellite.Server;

// A live map of the raid in the browser: https://<server>:6969/satellite. The map is a picture of the location from
// above, which the game plugin takes once for each location and sends here in tiles; the markers are what the plugin
// reports several times a second while a page is open. The page only looks: nothing it sends reaches the game.
//   /satellite/                          the page (the mod's web folder)
//   /satellite/api/maps                  every location captured so far, as JSON
//   /satellite/map/<location>/<v>/<tile> a tile of a location's picture
//   /satellite/api/stream[?session=]     what the game reports, as it arrives (server-sent events)
//   /satellite/api/state[?session=]      the last full report, for a page that can't keep a stream open
//   /satellite/api/games                 the games reporting now, each with its player's name
//   /satellite/api/lan                   this PC's addresses on its network, for opening the page on a phone (see Lan)
//   /satellite/api/places, api/things    where things stand on a location, and what lies about in a raid
//   /satellite/api/spawns?loc=           where loot can spawn on a location, and what (the server's loot tables)
//   /satellite/api/quests[?session=]     that player's started quests and where they send them
//   /satellite/api/history               the raids recorded, to play back (see Recorder)
//   POST /satellite/api/push             what the game plugin reports
//   POST /satellite/api/tile, api/map    a location's picture, from the game plugin
[Injectable(InjectionType.Singleton, TypePriority = OnLoadOrder.Preload)]
public partial class LiveMapRoute(ISptLogger<LiveMapRoute> logger, ModHelper modHelper, SaveServer saveServer,
    SPTarkov.Server.Core.Models.Spt.Tables.TemplateTable templates, SPTarkov.Server.Core.Services.Locales.LocaleService locales,
    SPTarkov.Server.Core.Models.Spt.Tables.LocationTable locationTable, IServiceProvider services) : IHttpListener
{
    public const string Root = "/satellite";

    // a report from the game is small; a map tile is under a megabyte
    private const int MaxBody = 4_000_000;
    // a game not heard from for this long (milliseconds) has gone
    private const int GoneAfter = 15_000;

    private static readonly Dictionary<string, string> ContentTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        [".html"] = "text/html; charset=utf-8",
        [".js"] = "text/javascript; charset=utf-8",
        [".mjs"] = "text/javascript; charset=utf-8",
        [".css"] = "text/css; charset=utf-8",
        [".svg"] = "image/svg+xml",
        [".png"] = "image/png",
        [".jpg"] = "image/jpeg",
        [".jpeg"] = "image/jpeg",
        [".webp"] = "image/webp",
        [".ico"] = "image/x-icon"
    };

    private sealed class Session(string id)
    {
        public string Id { get; } = id;
        public volatile string? LastFull;
        public long LastFullAt;
        public long SeenAt;
        public long PolledAt;
        // the player's name, as JSON text
        public volatile string? Name;
        // the goals of the player's started quests that their own game says are done (a full report's "qd")
        public volatile HashSet<string> QuestsDone = [];
        // the keys the player has with them in a raid, as their own game says (a full report's "kh"); null: not told
        public volatile HashSet<string>? KeysCarried;
        public volatile bool Raid;
        // the markers of the kinds config.jsonc keeps off the page, from the last full report
        public volatile HashSet<long> Blocked = [];
        // what lies about in the raid, as the plugin last sent it, and how many times it has
        public volatile string? Things;
        public int ThingsSent;
        // that, as a page is answered (names added, packed): made once for each change, not for each page that asks
        public volatile ThingsAnswer? ThingsMade;
        // the raid's containers and quest places that its map's places.json doesn't have (POST api/more), as JSON text:
        // {"loc","boxes":[..],"zones":[..]}; null: none
        public volatile string? More;
        // all of the raid's containers as that sent them, {"loc","boxes":[..]} (null: none yet), and when (Now): kept with
        // the raid's recording, so its replay has them whatever places.json says by then
        public volatile string? Spots;
        public long SpotsAt;
        // what has happened in the raid it's in (see Events in the game's plugin): the latest, for a page opened later
        public readonly Lock EventsLock = new();
        public readonly List<(long Number, string Json)> Events = [];
        public string EventsRaid = "";
        // Fika (see FikaHost). Headless: a headless host, never offered to a page. IsHost: the host of the raid it's in,
        // and Host what it last said of it; Own: a player's id in the raid, Me where they are, OwnFull their own last
        // full report (censored)
        public volatile bool Headless;
        public volatile bool IsHost;
        public volatile HostBots? HostBots;
        public volatile HostView? Host;
        public volatile string? Own;
        public volatile string? OwnName;
        public volatile string? Me;
        public volatile string? OwnFull;
        // the raid as this game's own plugin names it ("rid", a new one each raid): in a Fika raid whose host reports,
        // the raid recorded is the host's, under the host's id, and how it ended for this player comes under this one
        public volatile string OwnRid = "";
    }

    // From: the report the answer was made of
    private sealed record ThingsAnswer(string From, Answer Sent);

    private sealed class Subscriber(string? session)
    {
        public string? Session { get; } = session;
        public Channel<string> Messages { get; } = Channel.CreateBounded<string>(
            new BoundedChannelOptions(64) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true });
    }

    private readonly ConcurrentDictionary<string, Session> _sessions = new();
    private readonly ConcurrentDictionary<Subscriber, byte> _subscribers = new();

    private string? _folder;
    private string Folder => _folder ??= modHelper.GetAbsolutePathToModFolder(Assembly.GetExecutingAssembly());

    private static long Now => Environment.TickCount64;

    // the addresses the page had before (/map until 1.0.0), and another a person might try: all lead to Root
    public static readonly string[] OtherRoots = ["/map", "/livemap", "/webmap"];

    // the root a path is under (Root or one of the others), or null
    public static string? RootOf(string path)
    {
        foreach (var root in OtherRoots.Prepend(Root))
        {
            if (path.Equals(root, StringComparison.OrdinalIgnoreCase) || path.StartsWith(root + "/", StringComparison.OrdinalIgnoreCase))
            {
                return root;
            }
        }

        return null;
    }

    public bool CanHandle(HttpContext context)
    {
        return RootOf(context.Request.Path.Value ?? "") != null;
    }

    public async Task HandleAsync(MongoId sessionId, HttpContext context, CancellationToken cancellationToken)
    {
        var full = context.Request.Path.Value ?? "";
        var root = RootOf(full) ?? Root;
        // An old address: the page and its files are sent to the same place under Root. A game plugin from before
        // the move still reports to api/ under the old one, which is answered where it is.
        var rest = full.Length > root.Length ? full[(root.Length + 1)..] : "";
        if (root != Root && !rest.StartsWith("api/", StringComparison.OrdinalIgnoreCase))
        {
            context.Response.Redirect(Root + "/" + rest + context.Request.QueryString);
            return;
        }

        if (full.Equals(root, StringComparison.OrdinalIgnoreCase))
        {
            // relative addresses in the page need the slash
            context.Response.Redirect(Root + "/" + context.Request.QueryString);
            return;
        }

        var path = rest;
        var query = context.Request.Query;
        // Better Flea's prices, asked for once in the background (FleaPrices)
        FleaWarm();
        var post = HttpMethods.IsPost(context.Request.Method);
        context.Response.Headers.CacheControl = "no-cache";

        try
        {
            if (path.StartsWith("api/link/", StringComparison.OrdinalIgnoreCase) && context.WebSockets.IsWebSocketRequest)
            {
                await Link(sessionId, context, path[9..].ToLowerInvariant(), cancellationToken);
                return;
            }

            switch (path.ToLowerInvariant())
            {
                case "api/push" when post:
                    await Push(sessionId, context, cancellationToken);
                    return;
                case "api/tile" when post:
                    await SaveTile(sessionId, context, cancellationToken);
                    return;
                case "api/map" when post:
                    await SaveMap(sessionId, context, cancellationToken);
                    return;
                case "api/key" when post:
                    await SendKey(sessionId, context, cancellationToken);
                    return;
                case "api/places" when post:
                    await SavePlaces(sessionId, context, cancellationToken);
                    return;
                case "api/places":
                    await SendJson(context, PlacesFor(query["loc"].ToString()), cancellationToken);
                    return;
                case "api/spawns":
                    await SendJson(context, SpawnsFor(query["loc"].ToString()), cancellationToken);
                    return;
                case "api/things" when post:
                    await SaveThings(sessionId, context, cancellationToken);
                    return;
                case "api/things":
                    await SendJson(context, ThingsFor(query["session"].ToString()), cancellationToken);
                    return;
                case "api/more" when post:
                    await SaveMore(sessionId, context, cancellationToken);
                    return;
                case "api/quests":
                    await SendJson(context, QuestsFor(query["session"].ToString()), cancellationToken);
                    return;
                case "api/games":
                    await SendJson(context, Games(), cancellationToken);
                    return;
                case "api/lan":
                    await SendJson(context, Lan.Json(), cancellationToken);
                    return;
                case "api/maps":
                    // a page that has them already is only told so: they're over a megabyte, and asked for every
                    // few seconds
                    var (maps, print) = Maps();
                    if (query["have"].ToString() == print)
                    {
                        await SendJson(context, "{\"same\":true}", cancellationToken);
                    }
                    else
                    {
                        await SendJson(context, maps, cancellationToken);
                    }

                    return;
                case "api/stream":
                    await Stream(context, query["session"].ToString(), cancellationToken);
                    return;
                case "api/events":
                    await SendEvents(context, query["session"].ToString(), query["after"].ToString(), cancellationToken);
                    return;
#if RECORDING
                case "api/history":
                    await SendJson(context, HistoryList(), cancellationToken);
                    return;
                case "api/history/rec":
                    await SendRecording(context, query["id"].ToString(), cancellationToken);
                    return;
                case "api/history/comet":
                    if (query["debug"] == "1")
                    {
                        await SendCometDebug(context, cancellationToken);
                        return;
                    }
                    await SendComet(context, query["id"].ToString(), query["p"].ToString(), query["sum"].ToString() == "1", cancellationToken);
                    return;
                case "api/history/export":
                    await ExportRecording(context, query["id"].ToString(), cancellationToken);
                    return;
                case "api/history/import" when post:
                    await SendJson(context, await ImportRecording(context, cancellationToken), cancellationToken);
                    return;
                case "api/history/names" when post:
                    await SendJson(context, await HistoryNames(context, cancellationToken), cancellationToken);
                    return;
                case "api/history/delete" when post:
                    await SendJson(context, DeleteRecording(query["id"].ToString()), cancellationToken);
                    return;
                case "api/history/deleteAll" when post:
                    await SendJson(context, DeleteAllRecordings(), cancellationToken);
                    return;
                case "api/history/keep" when post:
                    await SendJson(context, SaveKeep(context), cancellationToken);
                    return;
                case "api/history/tidy" when post:
                    await SendJson(context, TidyRecordings(), cancellationToken);
                    return;
                case "api/prices":
                    await SendJson(context, Pricing(context, post), cancellationToken);
                    return;
                case "api/history/pause":
                    await SendJson(context, Pausing(context, post), cancellationToken);
                    return;
                case "api/history/rr":
                    await SendJson(context, RrList(), cancellationToken);
                    return;
                case "api/history/rr/import" when post:
                    var wanted = query["id"].ToString();
                    await SendJson(context, await Task.Run(() => RrImport(wanted), cancellationToken), cancellationToken);
                    return;
#endif
                case "api/state":
                    await State(context, query["session"].ToString(), cancellationToken);
                    return;
                case "":
                    await SendWebFile(context, "index.html", cancellationToken);
                    return;
            }

#if RECORDING
            // the raid history page: the page itself at any address under raids/ (it reads the rest of the address:
            // raids/<id>/<tab>), so each of its views can be gone to straight away
            if (path.Equals("raids", StringComparison.OrdinalIgnoreCase))
            {
                context.Response.Redirect(Root + "/raids/" + context.Request.QueryString);
                return;
            }

            if (path.StartsWith("raids/", StringComparison.OrdinalIgnoreCase))
            {
                await SendWebFile(context, "index.html", cancellationToken);
                return;
            }
#endif

            if (path.StartsWith("map/", StringComparison.OrdinalIgnoreCase))
            {
                await SendTile(context, path[4..], cancellationToken);
                return;
            }

            if (path.StartsWith("api/", StringComparison.OrdinalIgnoreCase))
            {
                context.Response.StatusCode = 404;
                return;
            }

            await SendWebFile(context, path, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            // the browser or the game went away
        }
        catch (Exception ex) when (ex is IOException or JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
        {
            logger.Debug($"[Satellite] {path}: {ex.Message}");
            if (!context.Response.HasStarted)
            {
                context.Response.StatusCode = 400;
            }
        }
    }

    // ---- what the game sends -------------------------------------------------------------------------------------

    // The game's own requests carry its profile id; a browser has none. Reports are only taken from a game.
    private static string? GameSession(MongoId sessionId)
    {
        var id = sessionId.ToString();
        return string.IsNullOrEmpty(id) || !MongoId.IsValidMongoId(id) ? null : id;
    }

    private int Watchers(Session session)
    {
        var count = 0;
        foreach (var pair in _subscribers)
        {
            if (string.IsNullOrEmpty(pair.Key.Session) || pair.Key.Session == session.Id)
            {
                count++;
            }
        }

        // a page that polls instead of streaming counts while it keeps asking
        if (Now - Interlocked.Read(ref session.PolledAt) < 5000)
        {
            count++;
        }

        return count;
    }

    // One report: {"t":"full"|"fast"|"idle", ...}. It's passed on to the pages as it is. The answer says how many
    // pages are looking and, for a game in a raid, whether its location has a map yet.
    private async Task Push(MongoId sessionId, HttpContext context, CancellationToken cancellationToken)
    {
        var id = GameSession(sessionId);
        if (id == null)
        {
            context.Response.StatusCode = 403;
            return;
        }

        var answer = Pushed(id, await ReadBody(context, cancellationToken));
        if (answer == null)
        {
            context.Response.StatusCode = 400;
            return;
        }

        await SendJson(context, answer, cancellationToken);
    }

    // A report taken in (by POST, or over the plugin's link): the answer, or null when it isn't one
    private string? Pushed(string id, byte[] body)
    {
        if (body.Length == 0)
        {
            return null;
        }

        var session = _sessions.GetOrAdd(id, key => new Session(key));
        Interlocked.Exchange(ref session.SeenAt, Now);
        session.Name ??= PlayerName(id);

        string? location = null;
        string? matched = null;
        using (var report = JsonDocument.Parse(body))
        {
            var root = report.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("t", out var kind))
            {
                return null;
            }

            if (root.TryGetProperty("raid", out var raid) && raid.ValueKind is JsonValueKind.True or JsonValueKind.False)
            {
                session.Raid = raid.GetBoolean();
            }

            session.Headless = IsHeadless(session, root);
            if (session.Raid && root.TryGetProperty("rid", out var ownRid) && ownRid.ValueKind == JsonValueKind.String && ownRid.GetString() is { Length: > 0 and <= 64 } rid)
            {
                session.OwnRid = rid;
            }
            if (kind.ValueEquals("full") || kind.ValueEquals("idle"))
            {
                session.IsHost = session.Raid && Flag(root, "fh");
            }

            // where the player is, as their own game says (for when the page is shown their Fika host's report)
            if (root.TryGetProperty("me", out var me) && me.ValueKind == JsonValueKind.Array)
            {
                session.Me = me.GetRawText();
            }

            // the goals of their quests their own game has done, the profile here not knowing it until the raid ends
            if (root.TryGetProperty("qd", out var qd) && qd.ValueKind == JsonValueKind.Array)
            {
                var done = new HashSet<string>(StringComparer.Ordinal);
                foreach (var goal in qd.EnumerateArray())
                {
                    if (goal.ValueKind == JsonValueKind.String && goal.GetString() is { Length: > 0 and <= 64 } goalId)
                    {
                        done.Add(goalId);
                    }
                }

                session.QuestsDone = done;
            }

            // the keys the player has with them in the raid (to mark the locks they open as theirs)
            if (root.TryGetProperty("kh", out var kh) && kh.ValueKind == JsonValueKind.Array)
            {
                var keys = new HashSet<string>(StringComparer.Ordinal);
                foreach (var key in kh.EnumerateArray())
                {
                    if (key.ValueKind == JsonValueKind.String && key.GetString() is { Length: > 0 and <= 64 } tpl)
                    {
                        keys.Add(tpl);
                    }
                }

                session.KeysCarried = keys;
            }

            if (session.Raid && root.TryGetProperty("loc", out var loc) && loc.ValueKind == JsonValueKind.String
                && LocationName().IsMatch(loc.GetString() ?? ""))
            {
                location = loc.GetString();
                // which map is this? the location, a guess and the scenes loaded: answered with the map they match
                if (KeyAsked(root) is { } key)
                {
                    matched = key;
                    location = matched;
                }
            }

            // one line, so it fits a server-sent event as it is
            var text = Censor(session, kind.GetString() ?? "", Encoding.UTF8.GetString(body));
            if (text.AsSpan().IndexOfAny('\r', '\n') >= 0)
            {
                text = text.Replace("\r", "").Replace("\n", "");
            }

            // In a Fika raid whose host reports, the page is shown the host's raid with this player's own part (see
            // FikaHost); a headless's own reports go to no page
            var host = HostOf(session);
            if (host != null)
            {
                // the player's own full report is kept (Censor: their extracts, name, "me") and goes out with the
                // host's next one (ToPlayers). Sent now, it would carry the host's last full report, up to a second
                // old: every bot would jump back to where it was, then on again.
                if (kind.ValueEquals("fast") && OwnFast(host, session) is { } own)
                {
                    Publish(session, own);
                }
            }
            else if (!session.Headless)
            {
                if (kind.ValueEquals("full") || kind.ValueEquals("idle"))
                {
                    // (idle: out of sight, the last full report is old news)
                    session.LastFull = text;
                    Interlocked.Exchange(ref session.LastFullAt, Now);
                }

                Publish(session, text);
            }

            if (session.IsHost)
            {
                ToPlayers(session, kind.GetString() ?? "", text);
            }
        }

        // the kinds the plugin needn't send at all: the same every time, so written out once (this is answered ten
        // times a second for each game that's watched)
        _offAnswer ??= ",\"off\":" + OffList().ToJsonString() + ",\"layers\":" + LayersOffList().ToJsonString();
        // nobody watching a raid that's recorded: the game reports all the same, slower ("slow")
        var watchers = session.Headless || session.IsHost ? HostWatchers(session) : Watchers(session);
#if RECORDING
        var slow = watchers == 0 && Recorded(session);
#else
        const bool slow = false;
#endif
        var answer = new StringBuilder(160).Append("{\"w\":").Append(slow ? 1 : watchers).Append(slow ? ",\"slow\":1" : "").Append(_offAnswer);
#if RECORDING
        // COMET's decisions, for the raid's recording (see CometRecord)
        if (CometAsked(session) is var comet and > 0)
        {
            answer.Append(",\"cm\":").Append(comet);
        }
#endif
        if (location != null)
        {
            answer.Append(",\"loc\":").Append(JsonSerializer.Serialize(location));
            answer.Append(",\"map\":").Append(HasMap(location) ? "true" : "false");
            // captured with snow on the ground: the plugin takes it again in a raid without
            if (SnowyMap(location))
            {
                answer.Append(",\"snow\":true");
            }

            if (matched != null)
            {
                answer.Append(",\"key\":").Append(JsonSerializer.Serialize(matched));
            }
        }

        return answer.Append('}').ToString();
    }

    // ---- what the server never passes on: config.jsonc ------------------------------------------------------------

    // the config's switch for each kind of marker, and the kind as the plugin names it
    private static readonly (string Key, string Kind)[] Switches =
    [
        ("friendlyPlayers", "Friendly Player"), ("enemyPmcs", "Enemy Player"), ("scavs", "Scav"), ("snipers", "Sniper"),
        ("guards", "Guard"), ("cultists", "Cultist"), ("goons", "Goon"), ("bosses", "Boss"), ("raiders", "Raider"), ("rogues", "Rogue"),
        ("smugglers", "Smuggler"), ("blackDivision", "Black Division"), ("ruaf", "RUAF"),
        ("ruafRemnant", "RUAF Remnant"), ("untar", "UNTAR"), ("isb", "ISB"), ("isbWhiteTusks", "ISB WT"), ("bloodhounds", "Bloodhound"), ("mercenaries", "Mercenary"), ("combine", "Combine"), ("civilians", "Civilian"), ("infected", "Infected"), ("otherAi", "Other AI"),
        ("corpses", "Corpse"), ("extracts", "Extract"), ("transits", "Transit"), ("airdrops", "Airdrop")
    ];

    private string[]? _off;
    private string? _offAnswer;

    // the kinds config.jsonc turns off, read once
    private string[] Off => _off ??= ReadOff();

    private JsonArray OffList() => new(Off.Select(k => (JsonNode?)JsonValue.Create(k)).ToArray());

    // config.jsonc, in the mod's folder (see ConfigFile, written at start-up)
    private string ConfigFile() => ConfigFile(Folder, m => logger.Info(m), m => logger.Warning(m));

    // Not in the zip, so extracting an update never overwrites the owner's: when the server starts without one, it's
    // written from the default kept in this DLL (a config.json from before 1.0.0 is taken over as it is).
    private static readonly object ConfigLock = new();

    // (the owner's config brought up to date once each time the server starts: see AddMissing)
    private static bool _configChecked;

    public static string ConfigFile(string folder, Action<string> info, Action<string> warn)
    {
        var file = Path.Combine(folder, "config.jsonc");
        lock (ConfigLock)
        {
            if (File.Exists(file))
            {
                if (!_configChecked)
                {
                    _configChecked = true;
                    var shipped = DefaultConfig();
                    if (shipped != null)
                    {
                        AddMissing(file, shipped, info, warn);
                    }
                }

                return file;
            }

            try
            {
                var old = Path.Combine(folder, "config.json");
                if (File.Exists(old))
                {
                    File.Move(old, file);
                    info("[Satellite] Renamed config.json to config.jsonc. Your settings in it are kept.");
                    return file;
                }

                var text = DefaultConfig();
                if (text != null)
                {
                    _configChecked = true;
                    File.WriteAllText(file, text);
                    info("[Satellite] Wrote config.jsonc with every kind of marker on. Edit it to keep some off the page.");
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                warn($"[Satellite] Couldn't write config.jsonc, so everything may be shown: {ex.Message}");
            }
        }

        return file;
    }

    // the config as it ships, kept in this DLL (without raid recording in this build, its settings aren't offered)
    private static string? DefaultConfig()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Satellite.config.jsonc");
        if (stream == null)
        {
            return null;
        }

        using var reader = new StreamReader(stream);
        var text = reader.ReadToEnd();
#if !RECORDING
        text = Regex.Replace(text, @"\r?\n  // Raid history:[^\n]*\r?\n  ""history"": \{.*?\r?\n  \},", "", RegexOptions.Singleline);
#endif
        return text;
    }

    // An update never overwrites the owner's config, so what a newer version adds would never be in it. Each option (and
    // each section) the shipped config has and theirs hasn't is written into theirs, with its comment, where it belongs;
    // nothing of theirs is changed. Once, for a config from before configVersion 3: "history": "comet" false is made
    // true (it shipped false in 1.1.0 beta 2 only until it was tried in raids).
    private static void AddMissing(string file, string shipped, Action<string> info, Action<string> warn)
    {
        try
        {
            var options = new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };
            var text = File.ReadAllText(file);
            if (JsonNode.Parse(text, null, options) is not JsonObject theirs || JsonNode.Parse(shipped, null, options) is not JsonObject ours)
            {
                return;
            }

            var nl = text.Contains("\r\n") ? "\r\n" : "\n";
            var added = new List<string>();
            var old = !theirs.ContainsKey("configVersion");
            foreach (var (name, value) in ours)
            {
                if (!theirs.ContainsKey(name))
                {
                    // a whole section (or an option of its own at the top), at the end
                    var block = Block(shipped, 0, shipped.Length, name, 2);
                    if (block != null && Insert(ref text, Close(text, text.IndexOf('{')), block, nl))
                    {
                        added.Add(name);
                    }

                    continue;
                }

                if (value is not JsonObject section || theirs[name] is not JsonObject mine)
                {
                    continue;
                }

                foreach (var (key, _) in section)
                {
                    if (mine.ContainsKey(key))
                    {
                        continue;
                    }

                    // in their section, at its end
                    var (from, to) = Section(shipped, name);
                    var block = from >= 0 ? Block(shipped, from, to, key, 4) : null;
                    var (start, end) = Section(text, name);
                    if (block != null && start >= 0 && Insert(ref text, end, block, nl))
                    {
                        added.Add(name + "." + key);
                    }
                }
            }

            var comet = false;
            if (old)
            {
                var (start, end) = Section(text, "history");
                if (start >= 0)
                {
                    var part = text.Substring(start, end - start);
                    var turned = Regex.Replace(part, @"(""comet""\s*:\s*)false", "${1}true");
                    if (turned != part)
                    {
                        text = text.Substring(0, start) + turned + text.Substring(end);
                        comet = true;
                    }
                }
            }

            if (added.Count == 0 && !comet)
            {
                return;
            }

            File.WriteAllText(file, text);
            if (added.Count > 0)
            {
                info("[Satellite] Added the new options of this version to config.jsonc (your own settings are kept): " + string.Join(", ", added) + ".");
            }

            if (comet)
            {
                info("[Satellite] COMET's decisions are now recorded with each raid for its replay (config.jsonc: history.comet). Set it to false to stop.");
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or ArgumentException)
        {
            warn($"[Satellite] Couldn't add this version's new options to config.jsonc (it's used as it is): {ex.Message}");
        }
    }

    // where a top-level section's braces are in a config's text: its "{" and its "}"; (-1, -1) when it isn't there
    private static (int Open, int End) Section(string text, string name)
    {
        var at = Regex.Match(text, "(?m)^\\s*\"" + Regex.Escape(name) + "\"\\s*:\\s*\\{");
        if (!at.Success)
        {
            return (-1, -1);
        }

        var open = at.Index + at.Length - 1;
        var end = Close(text, open);
        return end < 0 ? (-1, -1) : (open, end);
    }

    // the "}" that closes the "{" at open, past strings and // comments; -1 when there's none
    private static int Close(string text, int open)
    {
        if (open < 0)
        {
            return -1;
        }

        var depth = 0;
        var quoted = false;
        for (var i = open; i < text.Length; i++)
        {
            var c = text[i];
            if (quoted)
            {
                if (c == '\\')
                {
                    i++;
                }
                else if (c == '"')
                {
                    quoted = false;
                }

                continue;
            }

            if (c == '"')
            {
                quoted = true;
            }
            else if (c == '/' && i + 1 < text.Length && text[i + 1] == '/')
            {
                var line = text.IndexOf('\n', i);
                if (line < 0)
                {
                    return -1;
                }

                i = line;
            }
            else if (c == '{')
            {
                depth++;
            }
            else if (c == '}' && --depth == 0)
            {
                return i;
            }
        }

        return -1;
    }

    // An option of the shipped config (indented so, between from and to), with the comment over it, as lines without
    // a comma at the end; a section's whole. Null when it can't be found.
    private static string? Block(string text, int from, int to, string name, int indent)
    {
        var lines = text.Substring(from, to - from).Replace("\r\n", "\n").Split('\n');
        var head = new string(' ', indent) + "\"" + name + "\"";
        var at = Array.FindIndex(lines, l => l.StartsWith(head, StringComparison.Ordinal) && l.Substring(head.Length).TrimStart().StartsWith(':'));
        if (at < 0)
        {
            return null;
        }

        var first = at;
        while (first > 0 && lines[first - 1].TrimStart().StartsWith("//", StringComparison.Ordinal))
        {
            first--;
        }

        var last = at;
        if (lines[at].TrimEnd().EndsWith('{'))
        {
            // a section: down to its closing brace, at the same indent
            var close = new string(' ', indent) + "}";
            while (last + 1 < lines.Length && !lines[last].StartsWith(close, StringComparison.Ordinal))
            {
                last++;
            }
        }

        var block = string.Join("\n", lines, first, last - first + 1).TrimEnd();
        return block.EndsWith(',') ? block.Substring(0, block.Length - 1) : block;
    }

    // block written on lines of its own just before the "}" at end, a comma after what was last before it
    private static bool Insert(ref string text, int end, string block, string nl)
    {
        if (end < 0)
        {
            return false;
        }

        var lineStart = text.LastIndexOf('\n', end - 1) + 1;
        // the last line with a value on it before then: a comma after it, unless it has one or opens the section
        var scan = lineStart - 1;
        while (scan > 0)
        {
            var from = text.LastIndexOf('\n', scan - 1) + 1;
            var line = text.Substring(from, scan - from).TrimEnd('\r').Trim();
            if (line.Length > 0 && !line.StartsWith("//", StringComparison.Ordinal))
            {
                if (!line.EndsWith(',') && !line.EndsWith('{'))
                {
                    var after = from + text.Substring(from, scan - from).TrimEnd('\r').TrimEnd().Length;
                    text = text.Insert(after, ",");
                    lineStart++;
                }

                break;
            }

            scan = from - 1;
        }

        text = text.Insert(lineStart, block.Replace("\n", nl) + nl);
        return true;
    }

    // config.jsonc's server.quietLogs: on unless it says false
    public static bool QuietLogs(string file)
    {
        try
        {
            var options = new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };
            return !(File.Exists(file) && JsonNode.Parse(File.ReadAllText(file), null, options)?["server"]?["quietLogs"] is JsonValue value
                && value.TryGetValue<bool>(out var on) && !on);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException)
        {
            return true;
        }
    }

    private string[] ReadOff()
    {
        var off = new List<string>();
        var file = ConfigFile();
        try
        {
            if (File.Exists(file))
            {
                var options = new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };
                var markers = JsonNode.Parse(File.ReadAllText(file), null, options)?["markers"];
                foreach (var (key, kind) in Switches)
                {
                    if (markers?[key] is JsonValue value && value.TryGetValue<bool>(out var on) && !on)
                    {
                        off.Add(kind);
                    }
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException)
        {
            logger.Warning($"[Satellite] Couldn't read config.jsonc, so every kind of marker may be shown: {ex.Message}");
        }

        if (off.Count > 0)
        {
            logger.Info($"[Satellite] config.jsonc keeps these off the page: {string.Join(", ", off)}.");
        }

        return off.ToArray();
    }

    // A report with what config.jsonc turns off taken out. A full report loses those markers, and their ids are kept so
    // the fast reports until the next full one lose them too; it also says which kinds are off, for the page.
    private static readonly string[] BrainFields = ["df", "ps", "ly", "gh", "ob", "cm", "bg", "sq", "og", "os", "ch"];

    // ---- what happened in the raid --------------------------------------------------------------------------------
    // A full report may bring events: "rid" the raid they belong to, "clk" its clock now (ms), "ev" the ones since the
    // last report, each {"n":number in the raid,"t":ms on its clock,"k":kind,"p":whose,"nm":name,"d":{...}}. They go
    // on to the pages with the report, and the raid's latest are kept for a page opened later: api/events?after=<n>.
    // Nothing is written to disk. Kinds so far: "comet.squad" (what COMET has a bot doing with its squad).
    private const int MostEvents = 2000;

    private void KeepEvents(Session session, JsonObject node)
    {
        var raid = node["rid"] is JsonValue rid && rid.TryGetValue<string>(out var said) ? said : "";
        if (node["ev"] is not JsonArray events)
        {
            if (raid.Length > 0 && raid != session.EventsRaid)
            {
                lock (session.EventsLock)
                {
                    session.EventsRaid = raid;
                    session.Events.Clear();
                }
            }

            return;
        }

        // what bots are up to, when the config keeps it off
        var noBrains = LayersOff.Contains("brains");
        var off = Off;
        bool Kept(JsonObject one, string field) =>
            one["d"] is not JsonObject detail || detail[field] is not JsonValue v || !v.TryGetValue<string>(out var what) || !off.Contains(what);
        for (var i = events.Count - 1; i >= 0; i--)
        {
            if (events[i] is not JsonObject one || one["n"] is not JsonValue n || !n.TryGetValue<long>(out _)
                || one["k"] is not JsonValue k || !k.TryGetValue<string>(out var kind)
                || (noBrains && kind.StartsWith("comet.", StringComparison.Ordinal))
                || (noBrains && kind.StartsWith("orbit.", StringComparison.Ordinal))
                || ((kind == "loot" || kind == "left" || kind == "drop") && off.Length > 0 && !Kept(one, "wk"))
                || (kind == "kill" && off.Length > 0 && !(Kept(one, "vk") && Kept(one, "kk"))))
            {
                events.RemoveAt(i);
            }
        }

        lock (session.EventsLock)
        {
            if (raid.Length > 0 && raid != session.EventsRaid)
            {
                session.EventsRaid = raid;
                session.Events.Clear();
            }

            foreach (var one in events)
            {
                session.Events.Add((one!["n"]!.GetValue<long>(), one.ToJsonString()));
            }

            if (session.Events.Count > MostEvents)
            {
                session.Events.RemoveRange(0, session.Events.Count - MostEvents);
            }
        }

        if (events.Count == 0)
        {
            node.Remove("ev");
        }
    }

    private async Task SendEvents(HttpContext context, string? wanted, string? after, CancellationToken cancellationToken)
    {
        var session = Pick(wanted);
        if (session == null)
        {
            await SendJson(context, "{\"rid\":\"\",\"ev\":[]}", cancellationToken);
            return;
        }

        _ = long.TryParse(after, out var from);
        // a player in a Fika raid whose host reports: the host's events, with the player named as on their account
        var player = session;
        var from_ = HostOf(session) ?? session;
        var ownId = from_ != player ? player.Own : null;
        var ownName = from_ != player ? player.OwnName ?? PlainName(player) : null;
        var answer = new StringBuilder(4096);
        lock (from_.EventsLock)
        {
            answer.Append("{\"rid\":").Append(JsonSerializer.Serialize(from_.EventsRaid)).Append(",\"ev\":[");
            var first = true;
            foreach (var (number, json) in from_.Events)
            {
                if (number <= from)
                {
                    continue;
                }

                if (!first)
                {
                    answer.Append(',');
                }

                first = false;
                answer.Append(RenameIn(json, ownId, ownName));
            }
        }

        await SendJson(context, answer.Append("]}").ToString(), cancellationToken);
    }

    private string Censor(Session session, string kind, string report)
    {
        var off = Off;
        if (kind == "full")
        {
            var node = JsonNode.Parse(report)!.AsObject();
            node["off"] = OffList();
            node["layersOff"] = LayersOffList();
            // "rec": this raid is being recorded (the page shows a sign); not in a replay, where it's always so
#if RECORDING
            if (RecordOn() && node["raid"] is JsonValue inRaid && inRaid.TryGetValue<bool>(out var raiding) && raiding && node["rid"] is JsonValue)
            {
                node["rec"] = 1;
            }
#endif
            var blocked = new HashSet<long>();
            if (off.Length > 0 && node["markers"] is JsonArray markers)
            {
                for (var i = markers.Count - 1; i >= 0; i--)
                {
                    var marker = markers[i];
                    if (marker?["c"] is JsonValue c && c.TryGetValue<string>(out var what) && off.Contains(what))
                    {
                        if (marker["id"] is JsonValue id && id.TryGetValue<long>(out var number))
                        {
                            blocked.Add(number);
                        }

                        markers.RemoveAt(i);
                    }
                }
            }

            // what bots are like and are up to, when the config keeps it off (an older plugin might still send it)
            if (LayersOff.Contains("brains") && node["markers"] is JsonArray all)
            {
                foreach (var marker in all)
                {
                    if (marker is JsonObject one)
                    {
                        foreach (var field in BrainFields)
                        {
                            one.Remove(field);
                        }
                    }
                }
            }

            session.Blocked = blocked;
            DropShots(node, blocked);
            // the plane goes with the airdrops
            if (off.Contains("Airdrop"))
            {
                node.Remove("plane");
            }

            // Fika (see FikaHost): a player's own part, kept for when their host's report is shown; without a host
            // that reports, what a host says its bots are up to, where this game knows nothing
            if (!session.Headless)
            {
                KeepOwn(session, node);
            }

            if (!session.IsHost && !LayersOff.Contains("brains") && HostOf(session) == null)
            {
                AddHostBots(node);
            }

            KeepEvents(session, node);
            // the quest goals done and the keys carried are for the server (QuestsFor), not the pages
            node.Remove("qd");
            node.Remove("kh");
            var censored = node.ToJsonString();
            if (session.IsHost)
            {
                // with its events still in, for the players in its raid
                KeepHost(session, node, censored);
            }

            if (!session.Headless)
            {
                session.OwnFull = censored;
            }

            return censored;
        }

        var known = session.Blocked;
        if (kind == "fast" && known.Count > 0)
        {
            var node = JsonNode.Parse(report)!.AsObject();
            DropShots(node, known);
            if (node["m"] is JsonArray rows)
            {
                for (var i = rows.Count - 1; i >= 0; i--)
                {
                    if (rows[i] is JsonArray row && row.Count > 0 && row[0] is JsonValue id && id.TryGetValue<long>(out var number)
                        && known.Contains(number))
                    {
                        rows.RemoveAt(i);
                    }
                }
            }

            return node.ToJsonString();
        }

        return report;
    }

    // the shots of somebody the config keeps off the page aren't passed on either
    private static void DropShots(JsonObject node, HashSet<long> blocked)
    {
        if (blocked.Count == 0 || node["sh"] is not JsonArray shots)
        {
            return;
        }

        for (var i = shots.Count - 1; i >= 0; i--)
        {
            if (shots[i] is JsonArray shot && shot.Count > 0 && shot[0] is JsonValue who && who.TryGetValue<long>(out var id) && blocked.Contains(id))
            {
                shots.RemoveAt(i);
            }
        }
    }

    private void Publish(Session session, string report)
    {
#if RECORDING
        Record(session, report);
#endif
        var message = Envelope(session, 0, report);
        foreach (var subscriber in _subscribers.Keys)
        {
            if (string.IsNullOrEmpty(subscriber.Session) || subscriber.Session == session.Id)
            {
                subscriber.Messages.Writer.TryWrite(message);
            }
        }
    }

    private static string Envelope(Session session, long age, string report) =>
        "{\"sid\":\"" + session.Id + "\",\"name\":" + (session.Name ?? "\"\"") + ",\"age\":" + age + ",\"d\":" + report + "}";

    // the character's name of the profile a game is signed in to, as JSON text; null until the profile has one
    private string? PlayerName(string id)
    {
        try
        {
            foreach (var (profileId, profile) in saveServer.GetProfiles())
            {
                if (profileId.ToString() != id)
                {
                    continue;
                }

                var name = profile?.CharacterData?.PmcData?.Info?.Nickname;
                if (string.IsNullOrEmpty(name))
                {
                    name = profile?.ProfileInfo?.Username;
                }

                return string.IsNullOrEmpty(name) ? null : JsonSerializer.Serialize(name);
            }
        }
        catch (Exception ex)
        {
            logger.Debug($"[Satellite] No name for {id}: {ex.Message}");
        }

        return null;
    }

    // the games heard from in the last few seconds: {"games":[{"sid":"..","name":"..","raid":true}]}
    private string Games()
    {
        var list = new JsonArray();
        foreach (var session in _sessions.Values.OrderBy(s => s.Id))
        {
            if (!session.Headless && Now - Interlocked.Read(ref session.SeenAt) < GoneAfter)
            {
                var game = new JsonObject
                {
                    ["sid"] = session.Id,
                    ["name"] = session.Name is { } name ? JsonNode.Parse(name) : "",
                    ["raid"] = session.Raid
                };
                // in a raid a Fika headless runs: the page says so by the name
                if (HostOf(session) is { Headless: true })
                {
                    game["hl"] = true;
                }

                list.Add(game);
            }
        }

        // and every other profile on the server, not playing now ("off"): a page can be kept on one player's game
        // while a friend plays, before that player has started theirs (not a Fika headless's own profile)
        try
        {
            var live = new HashSet<string>(list.Select(g => (string?)g?["sid"] ?? ""));
            foreach (var (profileId, profile) in saveServer.GetProfiles())
            {
                var id = profileId.ToString();
                var name = profile?.CharacterData?.PmcData?.Info?.Nickname;
                var user = profile?.ProfileInfo?.Username ?? "";
                if (live.Contains(id) || string.IsNullOrEmpty(name) || user.StartsWith("headless_", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                list.Add(new JsonObject { ["sid"] = id, ["name"] = name, ["raid"] = false, ["off"] = true });
            }
        }
        catch (Exception ex)
        {
            logger.Debug($"[Satellite] No profiles to list: {ex.Message}");
        }

        return new JsonObject { ["games"] = list }.ToJsonString();
    }

    // ---- what the page asks ----------------------------------------------------------------------------------------

    private Session? Pick(string? wanted)
    {
        if (!string.IsNullOrEmpty(wanted))
        {
            return _sessions.GetValueOrDefault(wanted) is { Headless: false } named ? named : null;
        }

        // nobody named: the game heard from last (never a Fika headless)
        return _sessions.Values.Where(s => !s.Headless).OrderByDescending(s => Interlocked.Read(ref s.SeenAt)).FirstOrDefault();
    }

    private async Task Stream(HttpContext context, string? wanted, CancellationToken cancellationToken)
    {
        context.Response.ContentType = "text/event-stream; charset=utf-8";
        context.Response.Headers.CacheControl = "no-cache, no-transform";
        context.Response.Headers["X-Accel-Buffering"] = "no";
        context.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

        using var gone = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, context.RequestAborted);
        var subscriber = new Subscriber(wanted);
        _subscribers[subscriber] = 0;
        try
        {
            // what's known already, so the page isn't empty until the next full report
            foreach (var session in _sessions.Values)
            {
                if (!session.Headless && (string.IsNullOrEmpty(wanted) || wanted == session.Id) && session.LastFull is { } last
                    && Now - Interlocked.Read(ref session.SeenAt) < GoneAfter)
                {
                    var age = Now - Interlocked.Read(ref session.LastFullAt);
                    await context.Response.WriteAsync("data: " + Envelope(session, age, last) + "\n\n", gone.Token);
                }
            }

            await context.Response.WriteAsync(": hello\n\n", gone.Token);
            var news = new StreamNews();
            await context.Response.WriteAsync(News(news, wanted), gone.Token);
            await context.Response.Body.FlushAsync(gone.Token);

            var reader = subscriber.Messages.Reader;
            while (!gone.IsCancellationRequested)
            {
                using var quiet = CancellationTokenSource.CreateLinkedTokenSource(gone.Token);
                quiet.CancelAfter(TimeSpan.FromSeconds(2));
                try
                {
                    var message = await reader.ReadAsync(quiet.Token);
                    // what's new first (loot a report is about to tell of, say), so the page needn't ask for it
                    var batch = new StringBuilder(News(news, wanted));
                    batch.Append("data: ").Append(message).Append("\n\n");
                    while (reader.TryRead(out var more))
                    {
                        batch.Append("data: ").Append(more).Append("\n\n");
                    }

                    await context.Response.WriteAsync(batch.ToString(), gone.Token);
                }
                catch (OperationCanceledException) when (!gone.IsCancellationRequested)
                {
                    // nothing from the game for a while: keep the line open, and say what's new
                    await context.Response.WriteAsync(": quiet\n\n" + News(news, wanted), gone.Token);
                }

                await context.Response.Body.FlushAsync(gone.Token);
            }
        }
        finally
        {
            _subscribers.TryRemove(subscriber, out _);
        }
    }

    // What a page would otherwise keep asking for, sent down its stream when it changes, so it needn't ask: the
    // games ("event: games", as api/games answers), a mark of the maps ("event: maps", {"print"}: the page asks
    // api/maps only when it differs), the loot of the game it watches ("event: things", as api/things answers) and
    // that player's quests ("event: quests", as api/quests answers).
    private sealed class StreamNews
    {
        public string Games = "";
        public string MapsPrint = "";
        public int Things = -1;
        public string Quests = "";
        public long At;
        public long QuestsAt;
    }

    private string News(StreamNews news, string? wanted)
    {
        var to = new StringBuilder();
        // loot as soon as there's more; the games and maps at most once a second
        if (Pick(wanted) is { } session && session.Things != null && session.ThingsSent != news.Things)
        {
            news.Things = session.ThingsSent;
            to.Append("event: things\ndata: ").Append(OneLine(ThingsFor(wanted).Text)).Append("\n\n");
        }

        if (Now - news.At < 1000)
        {
            return to.ToString();
        }

        news.At = Now;
        var games = Games();
        if (games != news.Games)
        {
            news.Games = games;
            to.Append("event: games\ndata: ").Append(games).Append("\n\n");
        }

        var (_, print) = Maps();
        if (print != news.MapsPrint)
        {
            news.MapsPrint = print;
            to.Append("event: maps\ndata: {\"print\":").Append(JsonSerializer.Serialize(print)).Append("}\n\n");
        }

        // the quests: looked at every few seconds (they change when the player hands one in, between raids)
        if (Now - news.QuestsAt >= 5000)
        {
            news.QuestsAt = Now;
            var quests = OneLine(QuestsFor(wanted));
            if (quests != news.Quests)
            {
                news.Quests = quests;
                to.Append("event: quests\ndata: ").Append(quests).Append("\n\n");
            }
        }

        return to.ToString();
    }

    private static string OneLine(string text) =>
        text.AsSpan().IndexOfAny('\r', '\n') >= 0 ? text.Replace("\r", "").Replace("\n", "") : text;

    private async Task State(HttpContext context, string? wanted, CancellationToken cancellationToken)
    {
        var session = Pick(wanted);
        if (session?.LastFull is not { } last)
        {
            await SendJson(context, "{\"sid\":null}", cancellationToken);
            return;
        }

        Interlocked.Exchange(ref session.PolledAt, Now);
        var age = Now - Interlocked.Read(ref session.LastFullAt);
        await SendJson(context, Envelope(session, age, last), cancellationToken);
    }

    // ---- the maps: each location's picture from above, as the game plugin took it -----------------------------------
    // maps/<location>/meta.json           what the picture covers: {"loc","v","min":[east,north],"tile","px","cols","rows",
    //                                     "small","zones","floors"}
    // maps/<location>/<v>/<x>_<y>.jpg     its tiles; x counts east from the west edge, y north from the south edge
    //                    <x>_<y>_f<n>.jpg the same tile with floor n showing in the buildings that have one
    //                    ..._s.jpg        either of those, small

    private const int MaxFloors = 16;

    private const int MaxTilesAcross = 64;

    // a map: the game's location id (a mod's own location too), and after a "~" the version a mod swapped in
    // ("Interchange~backport"), each kept apart; "@snow", "@lateautumn" or "@earlyspring" after it: the same map in a
    // season with snow on the ground (Seasons below)
    [GeneratedRegex("^[A-Za-z0-9_-]{1,40}(~[a-z0-9_-]{1,24})?(@(snow|lateautumn|earlyspring))?$")]
    private static partial Regex LocationName();

    [GeneratedRegex("^[A-Za-z0-9_-]{1,40}$")]
    private static partial Regex BaseLocationName();

    [GeneratedRegex("^[0-9a-f]{24}$")]
    private static partial Regex GameId();

    [GeneratedRegex("^[0-9]{1,12}$")]
    private static partial Regex VersionName();

    private readonly Lock _mapsLock = new();
    private Dictionary<string, string>? _maps;
    // when the maps folder was last looked at, and what was in it then: map folders added or taken away (an add-on
    // installed or deleted) are seen within a few seconds, without a restart
    private DateTime _mapsLooked;
    private string _mapsPrint = "";
    private static readonly TimeSpan LookAgain = TimeSpan.FromSeconds(10);

    // the map folders with a meta.json, and when each was written
    private string MapsPrint()
    {
        try
        {
            return !Directory.Exists(MapsFolder) ? "" : string.Join("|", Directory.EnumerateDirectories(MapsFolder)
                .Select(folder => Path.Combine(folder, "meta.json")).Where(File.Exists)
                .Select(file => file + "@" + File.GetLastWriteTimeUtc(file).Ticks).OrderBy(f => f, StringComparer.Ordinal));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return _mapsPrint;
        }
    }

    private string MapsFolder => Path.Combine(Folder, "maps");

    // location -> its meta.json, read from the folder the first time
    private Dictionary<string, string> KnownMaps()
    {
        lock (_mapsLock)
        {
            if (_maps != null)
            {
                if (DateTime.UtcNow - _mapsLooked < LookAgain)
                {
                    return _maps;
                }

                _mapsLooked = DateTime.UtcNow;
                if (MapsPrint() == _mapsPrint)
                {
                    return _maps;
                }
            }

            _mapsLooked = DateTime.UtcNow;
            _mapsPrint = MapsPrint();

            var found = new Dictionary<string, string>(StringComparer.Ordinal);
            try
            {
                if (Directory.Exists(MapsFolder))
                {
                    foreach (var folder in Directory.EnumerateDirectories(MapsFolder))
                    {
                        var file = Path.Combine(folder, "meta.json");
                        var name = Path.GetFileName(folder);
                        if (LocationName().IsMatch(name) && File.Exists(file))
                        {
                            // a map is the folder it's in: a copy put under another name (a snow map, "bigmap@snow")
                            // is that map, whatever its meta.json was captured as
                            var meta = JsonNode.Parse(File.ReadAllText(file))!;
                            if (meta is JsonObject about)
                            {
                                about["loc"] = name;
                            }

                            found[name] = meta.ToJsonString();
                        }
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
            {
                logger.Warning($"[Satellite] Couldn't read the captured maps: {ex.Message}");
            }

            return _maps = found;
        }
    }

    // the version name the location's map has now, if it has one
    private string? KeptVersionName(string location)
    {
        lock (_mapsLock)
        {
            try
            {
                return KnownMaps().TryGetValue(location, out var meta) && JsonNode.Parse(meta) is JsonObject about
                    && about["vname"] is JsonValue name && name.TryGetValue<string>(out var text) && text.Length is > 0 and <= 40 ? text : null;
            }
            catch (JsonException)
            {
                return null;
            }
        }
    }

    private bool HasMap(string location)
    {
        lock (_mapsLock)
        {
            return KnownMaps().ContainsKey(location);
        }
    }

    // Seasons: a map can come again for a season the game puts snow down in, captured then, as a folder of its own
    // from a season add-on: "<map>@snow" (winter, all under snow), "<map>@lateautumn" and "<map>@earlyspring" (patches
    // of it). The page shows one in place of the map in a raid of its season, when it's installed; everything else
    // (the places, the loot, which map a raid is on) goes by the map itself.
    public static readonly string[] SeasonSuffixes = ["@snow", "@lateautumn", "@earlyspring"];

    // the season map a key is ("@snow"), or null
    public static string? SeasonOf(string key) => SeasonSuffixes.FirstOrDefault(s => key.EndsWith(s, StringComparison.Ordinal));

    public static bool IsSnow(string key) => SeasonOf(key) != null;

    // the map a season map is of ("bigmap@snow": "bigmap")
    public static string WithoutSnow(string key) => SeasonOf(key) is { } season ? key[..^season.Length] : key;

    // the seasons the game puts snow down in (all over in winter, patches late in autumn and early in spring): a map
    // captured in one is taken again in a season without
    private static readonly HashSet<string> SnowySeasons = new(StringComparer.Ordinal) { "Winter", "AutumnLate", "SpringEarly" };

    // whether a map was captured with snow on the ground (one captured before seasons were kept: not known, so no)
    private readonly Dictionary<string, bool> _snowy = new(StringComparer.Ordinal);

    private bool SnowyMap(string location)
    {
        lock (_mapsLock)
        {
            if (!KnownMaps().TryGetValue(location, out var meta))
            {
                return false;
            }

            if (_snowy.TryGetValue(meta, out var known))
            {
                return known;
            }

            var snowy = false;
            try
            {
                snowy = JsonNode.Parse(meta) is JsonObject about && about["season"]?.GetValue<string>() is { } season
                    && SnowySeasons.Contains(season);
            }
            catch (Exception ex) when (ex is JsonException or InvalidOperationException or FormatException)
            {
                // not known
            }

            _snowy[meta] = snowy;
            return snowy;
        }
    }

    // The map a raid is on: of the maps of its location (the game's own and every version a mod swapped in, each
    // captured once, here or on another game and handed round), the one whose scenes are the ones loaded now. A
    // version swaps scenes of the game's own for its own (Manimal's Interchange all of them, its Labs Boiler only one
    // office), so a map doesn't match when one of its scenes isn't loaded and one it didn't have is: that's a swap.
    // A scene only added (another mod's) or only missing (one for a season or an event) still matches, and of the
    // maps that match, the one with the fewest differences wins. A map captured before scenes were kept matches only
    // when it's the one guessed. When none matches, it's a version not captured yet: it's kept as the guess (from
    // MapVariants, or the location itself), or, when that's taken by another version, by its scenes.
    // {"base":location id,"hint":a guess,"scn":[scenes loaded]}: the map they match (see MapFor), or null. loose:
    // whether a map that only nearly fits will do (for showing a raid, yes; for the scanner, no, see MapFor)
    private string? KeyAsked(JsonElement root, bool loose = true)
    {
        if (!root.TryGetProperty("scn", out var scenes) || scenes.ValueKind != JsonValueKind.Array
            || !root.TryGetProperty("base", out var place) || place.ValueKind != JsonValueKind.String
            || !BaseLocationName().IsMatch(place.GetString() ?? ""))
        {
            return null;
        }

        var hint = root.TryGetProperty("hint", out var guess) && guess.ValueKind == JsonValueKind.String
            && LocationName().IsMatch(guess.GetString() ?? "") ? guess.GetString()! : place.GetString()!;
        var loaded = new List<string>();
        foreach (var scene in scenes.EnumerateArray())
        {
            if (scene.ValueKind == JsonValueKind.String && scene.GetString() is { Length: > 0 and <= 120 } name)
            {
                loaded.Add(name);
            }
        }

        return MapFor(place.GetString()!, hint, loaded, loose);
    }

    // POST api/key with {"base","hint","scn"}, from the map scanner: {"key":the map this raid is on,"map":whether
    // there's a picture of it yet,"snow":whether that picture has snow on the ground,"seasons":the season maps of it
    // there are, as "snow", "lateautumn", "earlyspring"}
    private async Task SendKey(MongoId sessionId, HttpContext context, CancellationToken cancellationToken)
    {
        if (GameSession(sessionId) == null)
        {
            context.Response.StatusCode = 403;
            return;
        }

        using var sent = JsonDocument.Parse(await ReadBody(context, cancellationToken));
        if (sent.RootElement.ValueKind != JsonValueKind.Object || KeyAsked(sent.RootElement, false) is not { } key)
        {
            context.Response.StatusCode = 400;
            return;
        }

        var answer = new JsonObject
        {
            ["key"] = key, ["map"] = HasMap(key), ["snow"] = SnowyMap(key),
            ["seasons"] = new JsonArray(SeasonSuffixes.Where(s => HasMap(key + s)).Select(s => (JsonNode?)s[1..]).ToArray())
        };
        await SendJson(context, answer.ToJsonString(), cancellationToken);
    }

    // a scene's name without the count Unity puts after some made in the raid ("PhysicsWorld_... (82)"), which
    // changes from one raid to the next
    private static string PlainScene(string name) => SceneCount().Replace(name, "");

    [GeneratedRegex(@"\s*\(\d+\)$")]
    private static partial Regex SceneCount();

    // the game's events, as their scenes and the versions made for them are named
    [GeneratedRegex("halloween|christmas|xmas|newyear|new_year", RegexOptions.IgnoreCase)]
    private static partial Regex EventScene();

    private string MapFor(string place, string hint, List<string> loaded, bool loose = true)
    {
        var now = new HashSet<string>(loaded.Select(PlainScene), StringComparer.Ordinal);
        string? best = null, unknown = null;
        var bestScore = int.MaxValue;
        var taken = new HashSet<string>(StringComparer.Ordinal);
        // every map of this location with scenes kept, installed or an add-on: for the loose pass below
        var near = new List<(string Key, List<string> Scenes)>();
        lock (_mapsLock)
        {
            foreach (var (key, meta) in KnownMaps())
            {
                // a snow map is never what a raid is told by: it's shown in place of its own in a snowy one (Snow)
                if ((key != place && !key.StartsWith(place + "~", StringComparison.Ordinal)) || IsSnow(key))
                {
                    continue;
                }

                taken.Add(key);
                List<string>? then = null;
                try
                {
                    if (JsonNode.Parse(meta) is JsonObject about && about["scenes"] is JsonArray scenes)
                    {
                        then = scenes.Select(s => PlainScene(s?.GetValue<string>() ?? "")).Where(s => s.Length > 0).Distinct().ToList();
                    }
                }
                catch (Exception ex) when (ex is JsonException or InvalidOperationException or FormatException)
                {
                    // read as captured before scenes were kept
                }

                if (then == null || then.Count == 0)
                {
                    if (key == hint)
                    {
                        unknown = key;
                    }

                    continue;
                }

                near.Add((key, then));
                // the game's own map, when the raid is said to be the game's own version (MapVariants, or nothing
                // swaps it): scenes another mod adds (props, ladders) don't make it another version, even for the scanner
                var ownMap = key == place && hint == place;
                // (two versions that load the same scenes fit alike: the one MapVariants says it loaded is taken, by the
                // name its mod gives that version, "bigmap~fums")
                if (Fit(then, now, loose, ownMap, !EventScene().IsMatch(key)) is { } score && (score < bestScore || (score == bestScore && key == hint)))
                {
                    best = key;
                    bestScore = score;
                }
            }
        }

        if (best != null || unknown != null)
        {
            return best ?? unknown!;
        }

        // not a map here, but maybe one of the add-ons, not installed: kept by the add-on's name, so the page can say
        // which add-on to get
        foreach (var addon in Addons())
        {
            if ((addon.Loc == place || addon.Loc.StartsWith(place + "~", StringComparison.Ordinal))
                && !IsSnow(addon.Loc) && !taken.Contains(addon.Loc) && addon.Scenes.Count > 0)
            {
                near.Add((addon.Loc, addon.Scenes));
                if (Fit(addon.Scenes, now, loose) is { } score && score < bestScore)
                {
                    best = addon.Loc;
                    bestScore = score;
                }
            }
        }

        if (best != null)
        {
            return best;
        }

        // nothing fits strictly (a mod's update may rename a scene, which reads as a swap): the map with the most of
        // its scenes loaded, if that's at least half of them, so a raid is shown on the nearest map there is. Not for
        // the scanner: a version that swaps one scene (Manimal's Labs Boiler, one office) is nearly the game's own,
        // and taking one for the other there would scan it over the game's own map and never keep it apart.
        var bestShare = 0.0;
        foreach (var (key, scenes) in loose ? near : [])
        {
            var share = (double)scenes.Count(now.Contains) / scenes.Count;
            var score = scenes.Count(s => !now.Contains(s)) + now.Count(s => !scenes.Contains(s));
            if (share >= 0.5 && (share > bestShare || (share == bestShare && score < bestScore)))
            {
                best = key;
                bestShare = share;
                bestScore = score;
            }
        }

        if (best != null)
        {
            return best;
        }

        if (!taken.Contains(hint))
        {
            return hint;
        }

        // FNV-1a over the scenes' names: the same version always comes out the same
        var hash = 2166136261u;
        foreach (var c in string.Join("|", now.OrderBy(s => s, StringComparer.Ordinal)))
        {
            hash = (hash ^ c) * 16777619u;
        }

        return place + "~" + hash.ToString("x8");
    }

    // How well the scenes a map was captured with fit the ones loaded now: the differences, or null when they don't
    // fit (one of its scenes isn't loaded and one it didn't have is: a swap; or more than half of its own are missing).
    // Not loose (the scanner): only the very same scenes fit. A version can be another with a scene added (Manimal's
    // Halloween 2026 Labs is his Labs Boiler with one layer more), and scanning it as that one would scan over it.
    // eventOk: a version captured while an event was on (Customs Classic in Halloween) has the event's props as scenes,
    // gone once it's over; only those missing, it's still that version. Not for a version named for the event
    // (Halloween 2026 Labs is Labs with its Halloween layer): without the layer, it's the other.
    private static int? Fit(List<string> then, HashSet<string> now, bool loose = true, bool addedOk = false, bool eventOk = false)
    {
        var thenSet = new HashSet<string>(then, StringComparer.Ordinal);
        var missing = then.Count(s => !now.Contains(s));
        var added = now.Count(s => !thenSet.Contains(s));
        if (!loose)
        {
            var eventGone = eventOk && missing > 0 && then.Where(s => !now.Contains(s)).All(s => EventScene().IsMatch(s));
            return (missing == 0 || eventGone) && (added == 0 || addedOk) ? added + missing : null;
        }

        var swapped = missing > 0 && added > 0;
        return !swapped && missing <= then.Count / 2 ? missing + added : null;
    }

    // An add-on: a map that comes in a zip of its own (a version of a location, or a location a mod adds), as the
    // mod's addons.json lists it. Scenes: what tells it in a raid; About: what the page is told of it.
    private sealed record Addon(string Loc, List<string> Scenes, JsonObject About);

    private List<Addon>? _addons;

    // the add-ons there are, read once from addons.json (made by build.ps1 from the add-ons' maps); none if it's
    // missing or broken, which only means a version not installed is told by its scenes' hash
    private List<Addon> Addons()
    {
        lock (_mapsLock)
        {
            if (_addons != null)
            {
                return _addons;
            }

            var found = new List<Addon>();
            try
            {
                var file = Path.Combine(Folder, "addons.json");
                if (File.Exists(file) && JsonNode.Parse(File.ReadAllText(file))?["addons"] is JsonArray list)
                {
                    foreach (var item in list.OfType<JsonObject>())
                    {
                        var loc = item["loc"]?.GetValue<string>();
                        if (string.IsNullOrEmpty(loc) || !LocationName().IsMatch(loc) || item["scenes"] is not JsonArray scenes)
                        {
                            continue;
                        }

                        var names = scenes.Select(s => PlainScene(s?.GetValue<string>() ?? "")).Where(s => s.Length > 0).Distinct().ToList();
                        if (names.Count == 0)
                        {
                            continue;
                        }

                        var about = new JsonObject { ["loc"] = loc };
                        foreach (var field in new[] { "base", "name", "vname", "zip" })
                        {
                            if (item[field] is JsonValue value && value.TryGetValue<string>(out var text) && text.Length is > 0 and <= 120)
                            {
                                about[field] = text;
                            }
                        }

                        found.Add(new Addon(loc, names, about));
                    }
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or FormatException)
            {
                logger.Warning($"[Satellite] Couldn't read addons.json: {ex.Message}");
            }

            return _addons = found;
        }
    }

    // the answer below, kept until the maps change, and what the maps were when it was made
    private Answer? _mapsAnswer;
    private string _mapsAnswerPrint = "";
    private Dictionary<string, string>? _mapsAnswerOf;

    // {"print":..,"maps":[...],"addons":[...]}: every location captured so far; the add-ons there are that aren't
    // installed; print: a mark that changes when any of it does. Made once, and again when the maps change.
    private (Answer Maps, string Print) Maps()
    {
        lock (_mapsLock)
        {
            var known = KnownMaps();
            if (_mapsAnswer == null || !ReferenceEquals(known, _mapsAnswerOf))
            {
                var missing = new JsonArray(Addons().Where(a => !known.ContainsKey(a.Loc)).Select(a => (JsonNode)a.About.DeepClone()).ToArray());
                var body = "\"maps\":[" + string.Join(",", known.OrderBy(m => m.Key, StringComparer.Ordinal).Select(m => m.Value)) + "],\"addons\":"
                    + missing.ToJsonString() + "}";
                _mapsAnswerPrint = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(body)), 0, 8);
                _mapsAnswer = Packed("{\"print\":\"" + _mapsAnswerPrint + "\"," + body);
                _mapsAnswerOf = known;
            }

            return (_mapsAnswer, _mapsAnswerPrint);
        }
    }

    private static bool Whole(string? text, int most, out int value)
    {
        return int.TryParse(text, out value) && value >= 0 && value < most;
    }

    // POST api/tile?loc=&v=&x=&y=[&f=floor][&s=1] with a JPEG as the body: one tile of a capture under way
    private async Task SaveTile(MongoId sessionId, HttpContext context, CancellationToken cancellationToken)
    {
        if (GameSession(sessionId) == null)
        {
            context.Response.StatusCode = 403;
            return;
        }

        var query = context.Request.Query;
        var location = query["loc"].ToString();
        var version = query["v"].ToString();
        var body = await ReadAtMost(context.Request.Body, cancellationToken);
        var isJpeg = body.Length > 4 && body[0] == 0xFF && body[1] == 0xD8;
        if (!LocationName().IsMatch(location) || !VersionName().IsMatch(version) || !isJpeg
            || !Whole(query["x"], MaxTilesAcross, out var x) || !Whole(query["y"], MaxTilesAcross, out var y))
        {
            context.Response.StatusCode = 400;
            return;
        }

        var floor = 0;
        if (query.ContainsKey("f") && (!Whole(query["f"], MaxFloors + 1, out floor) || floor < 1))
        {
            context.Response.StatusCode = 400;
            return;
        }

        var name = $"{x}_{y}" + (floor > 0 ? $"_f{floor}" : "") + (query["s"] == "1" ? "_s" : "");

        var folder = Path.Combine(MapsFolder, location, version);
        Directory.CreateDirectory(folder);
        await File.WriteAllBytesAsync(Path.Combine(folder, name + ".jpg"), body, cancellationToken);
        await SendJson(context, "{\"saved\":true}", cancellationToken);
    }

    // POST api/map: a capture is complete. From here on it's the location's map, and the one before it is deleted.
    private async Task SaveMap(MongoId sessionId, HttpContext context, CancellationToken cancellationToken)
    {
        if (GameSession(sessionId) == null)
        {
            context.Response.StatusCode = 403;
            return;
        }

        using var sent = JsonDocument.Parse(await ReadBody(context, cancellationToken));
        var root = sent.RootElement;
        var location = root.GetProperty("loc").GetString() ?? "";
        var version = root.GetProperty("v").GetInt64().ToString();
        var min = root.GetProperty("min");
        var tile = root.GetProperty("tile").GetDouble();
        var pixels = root.GetProperty("px").GetInt32();
        var columns = root.GetProperty("cols").GetInt32();
        var rows = root.GetProperty("rows").GetInt32();
        var east = min[0].GetDouble();
        var north = min[1].GetDouble();
        var folder = Path.Combine(MapsFolder, location, version);
        var sound = LocationName().IsMatch(location) && VersionName().IsMatch(version)
            && columns is > 0 and <= MaxTilesAcross && rows is > 0 and <= MaxTilesAcross
            && tile is > 1 and < 5000 && pixels is >= 64 and <= 8192
            && double.IsFinite(east) && double.IsFinite(north);
        if (sound)
        {
            for (var y = 0; y < rows && sound; y++)
            {
                for (var x = 0; x < columns && sound; x++)
                {
                    sound = File.Exists(Path.Combine(folder, $"{x}_{y}.jpg"));
                }
            }
        }

        if (!sound)
        {
            context.Response.StatusCode = 400;
            return;
        }

        var about = new JsonObject
        {
            ["loc"] = location, ["v"] = long.Parse(version), ["min"] = new JsonArray(east, north),
            ["tile"] = tile, ["px"] = pixels, ["cols"] = columns, ["rows"] = rows, ["zones"] = Zones(root)
        };
        // every tile was sent small as well
        if (root.TryGetProperty("small", out var small) && small.ValueKind == JsonValueKind.Number
            && File.Exists(Path.Combine(folder, "0_0_s.jpg")))
        {
            about["small"] = 1;
        }

        if (Floors(root, columns * rows) is { } floors)
        {
            about["floors"] = floors;
        }

        // what the page names it by: the location, the game's id for it (quests name locations by it), its name in
        // the game and the version's name, when a mod swapped one in
        string? Said(string field, int most) => root.TryGetProperty(field, out var value) && value.ValueKind == JsonValueKind.String
            && value.GetString() is { Length: > 0 } text && text.Length <= most ? text : null;
        if (Said("base", 40) is { } place && BaseLocationName().IsMatch(place))
        {
            about["base"] = place;
        }

        if (Said("lid", 24) is { } gameId && GameId().IsMatch(gameId))
        {
            about["lid"] = gameId;
        }

        if (Said("name", 60) is { } title)
        {
            about["name"] = title;
        }

        if (Said("vname", 40) is { } versionName)
        {
            about["vname"] = versionName;
        }
        else if (KeptVersionName(location) is { } keptName)
        {
            // taken again without one (a mod that swaps the version in without MapVariants naming it, as Manimal's
            // Labs office does): the name it was captured with before is kept, or the picker would name it by its key
            about["vname"] = keptName;
        }

        // the season the game showed (snow on the ground in some)
        if (Said("season", 20) is { } season && season.All(char.IsLetter))
        {
            about["season"] = season;
        }

        // the scenes the game had loaded: what tells this version of the location from another
        if (root.TryGetProperty("scenes", out var loaded) && loaded.ValueKind == JsonValueKind.Array && loaded.GetArrayLength() <= 400)
        {
            var scenes = new JsonArray();
            foreach (var scene in loaded.EnumerateArray())
            {
                if (scene.ValueKind == JsonValueKind.String && scene.GetString() is { Length: > 0 and <= 120 } sceneName)
                {
                    scenes.Add(sceneName);
                }
            }

            about["scenes"] = scenes;
        }

        var meta = about.ToJsonString();
        lock (_mapsLock)
        {
            File.WriteAllText(Path.Combine(MapsFolder, location, "meta.json"), meta);
            KnownMaps()[location] = meta;
            _mapsAnswer = null;
            foreach (var old in Directory.EnumerateDirectories(Path.Combine(MapsFolder, location)))
            {
                if (Path.GetFileName(old) != version)
                {
                    try
                    {
                        Directory.Delete(old, true);
                    }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                    {
                        logger.Debug($"[Satellite] Couldn't delete {old}: {ex.Message}");
                    }
                }
            }
        }

        logger.Success($"[Satellite] Captured the map of {location} ({columns} by {rows} tiles).");
        await SendJson(context, "{\"saved\":true}", cancellationToken);

        // then its tiles in one file, as the release zips have them, after the answer (a big map takes a few seconds);
        // the loose tiles are served until the pack is in place
        _ = Task.Run(() => PackLoose(folder));
    }

    [GeneratedRegex("^[a-z]{1,16}$")]
    private static partial Regex ZoneKind();

    // The floors under the location's roofs, as the plugin worked them out: {"n","cell","min":[east,north],"wide",
    // "tall","grid":[place,squares,..],"has":[floors,squares,..],"levels":[[height,..],..],"tiles":[[tile,..],..]}.
    // Kept only when all of it has that shape ("has" is left out on its own when it hasn't).
    private static JsonObject? Floors(JsonElement root, int tiles)
    {
        if (!root.TryGetProperty("floors", out var floors) || floors.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        static bool Number(JsonElement from, string name, double least, double most, out double value)
        {
            value = 0;
            return from.TryGetProperty(name, out var found) && found.ValueKind == JsonValueKind.Number
                && found.TryGetDouble(out value) && double.IsFinite(value) && value >= least && value <= most;
        }

        static bool Numbers(JsonElement list, int longest, double least, double most, bool whole)
        {
            if (list.ValueKind != JsonValueKind.Array || list.GetArrayLength() > longest)
            {
                return false;
            }

            foreach (var item in list.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Number || !item.TryGetDouble(out var value) || !double.IsFinite(value)
                    || value < least || value > most || (whole && value != Math.Floor(value)))
                {
                    return false;
                }
            }

            return true;
        }

        static bool Lists(JsonElement lists, int longest, Func<JsonElement, bool> each)
        {
            return lists.ValueKind == JsonValueKind.Array && lists.GetArrayLength() <= longest && lists.EnumerateArray().All(each);
        }

        if (!Number(floors, "n", 1, MaxFloors, out var count) || !Number(floors, "cell", 0.25, 100, out var cell)
            || !Number(floors, "wide", 1, 20000, out var wide) || !Number(floors, "tall", 1, 20000, out var tall)
            || !floors.TryGetProperty("min", out var min) || !Numbers(min, 2, -1e6, 1e6, false) || min.GetArrayLength() != 2
            || !floors.TryGetProperty("grid", out var grid) || !Numbers(grid, 2_000_000, 0, 1e9, true)
            || !floors.TryGetProperty("levels", out var levels) || !Lists(levels, 50_000, l => Numbers(l, MaxFloors, -1e5, 1e5, false))
            || !floors.TryGetProperty("tiles", out var which) || !Lists(which, MaxFloors, l => Numbers(l, tiles, 0, tiles - 1, true)))
        {
            return null;
        }

        var kept = new JsonObject
        {
            ["n"] = (int)count, ["cell"] = cell, ["min"] = JsonNode.Parse(min.GetRawText()), ["wide"] = (int)wide, ["tall"] = (int)tall,
            ["grid"] = JsonNode.Parse(grid.GetRawText()), ["levels"] = JsonNode.Parse(levels.GetRawText()),
            ["tiles"] = JsonNode.Parse(which.GetRawText())
        };
        // which floors each square has, as runs like the grid's (bits, one for each floor)
        if (floors.TryGetProperty("has", out var has) && Numbers(has, 2_000_000, 0, (1 << MaxFloors) - 1, true))
        {
            kept["has"] = JsonNode.Parse(has.GetRawText());
        }

        // the buildings' outlines, worked out by the scanner (tools/outlines.js): kept as they came, the page checks
        // each one
        if (floors.TryGetProperty("buildings", out var buildings) && buildings.ValueKind == JsonValueKind.Array
            && buildings.GetArrayLength() <= 20_000 && buildings.EnumerateArray().All(b => b.ValueKind == JsonValueKind.Object))
        {
            kept["buildings"] = JsonNode.Parse(buildings.GetRawText());
        }

        return kept;
    }

    // The location's minefields, sniper zones and claymores, as the plugin read them: [{"k":kind,"p":[[east,north],..],
    // "q":[..] or "kill":[[..],..],"off"?:true,"flare"?:true}]. Only what has that shape is kept.
    private static JsonArray Zones(JsonElement root)
    {
        var kept = new JsonArray();
        if (!root.TryGetProperty("zones", out var zones) || zones.ValueKind != JsonValueKind.Array)
        {
            return kept;
        }

        foreach (var zone in zones.EnumerateArray())
        {
            if (kept.Count >= 2000 || zone.ValueKind != JsonValueKind.Object
                || !zone.TryGetProperty("k", out var kind) || kind.ValueKind != JsonValueKind.String
                || !ZoneKind().IsMatch(kind.GetString() ?? "") || Points(zone, "p") is not { } shape)
            {
                continue;
            }

            var entry = new JsonObject { ["k"] = kind.GetString(), ["p"] = shape };
            if (Points(zone, "q") is { } inner)
            {
                entry["q"] = inner;
            }

            // newer captures: the outlines of where it kills, as the game decides it (an empty list: nowhere)
            if (Outlines(zone) is { } kill)
            {
                entry["kill"] = kill;
            }

            // switched off when the picture was taken; spares whoever fires a flare at an extract
            foreach (var flag in new[] { "off", "flare" })
            {
                if (zone.TryGetProperty(flag, out var on) && on.ValueKind == JsonValueKind.True)
                {
                    entry[flag] = true;
                }
            }

            kept.Add(entry);
        }

        return kept;
    }

    private static JsonArray? Points(JsonElement zone, string name) =>
        zone.TryGetProperty(name, out var points) ? PointList(points, 64) : null;

    // "kill": outlines, each a list of points
    private static JsonArray? Outlines(JsonElement zone)
    {
        if (!zone.TryGetProperty("kill", out var loops) || loops.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var kept = new JsonArray();
        foreach (var loop in loops.EnumerateArray())
        {
            if (kept.Count >= 32 || PointList(loop, 5000) is not { } points)
            {
                return null;
            }

            kept.Add(points);
        }

        return kept;
    }

    private static JsonArray? PointList(JsonElement points, int most)
    {
        if (points.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var kept = new JsonArray();
        foreach (var point in points.EnumerateArray())
        {
            if (kept.Count >= most || point.ValueKind != JsonValueKind.Array || point.GetArrayLength() != 2
                || point[0].ValueKind != JsonValueKind.Number || point[1].ValueKind != JsonValueKind.Number)
            {
                return null;
            }

            var east = point[0].GetDouble();
            var north = point[1].GetDouble();
            if (!double.IsFinite(east) || !double.IsFinite(north))
            {
                return null;
            }

            kept.Add(new JsonArray(east, north));
        }

        return kept.Count > 0 ? kept : null;
    }

    // the file inside the folder, or null when the path leads out of it
    private static string? Inside(string folder, string relative)
    {
        string full;
        try
        {
            full = Path.GetFullPath(Path.Combine(folder, relative));
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return null;
        }

        return full.StartsWith(Path.GetFullPath(folder) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ? full : null;
    }

    // (a map's tiles: SendTile, in TilePacks.cs)

    // ---- the page ---------------------------------------------------------------------------------------------------

    private async Task SendWebFile(HttpContext context, string relative, CancellationToken cancellationToken)
    {
        var web = Path.Combine(Folder, "web");
        var file = Inside(web, relative);
        if (file == null || !ContentTypes.TryGetValue(Path.GetExtension(file), out var type) || !File.Exists(file))
        {
            context.Response.StatusCode = 404;
            return;
        }

        context.Response.ContentType = type;
        if (relative == "index.html")
        {
            // the page asks for its style and script with their save times in the address ("?v=..."), so a browser
            // never keeps an old copy after an update
            var html = await File.ReadAllTextAsync(file, cancellationToken);
            foreach (var name in new[] { "livemap.css", "livemap.js" })
            {
                var stamp = File.GetLastWriteTimeUtc(Path.Combine(web, name)).Ticks.ToString("x");
                html = html.Replace($"\"{name}\"", $"\"{name}?v={stamp}\"");
            }

            await context.Response.WriteAsync(html, cancellationToken);
            return;
        }

        // kept until the file is saved again; text is kept packed as well
        var saved = File.GetLastWriteTimeUtc(file).Ticks;
        if (!_web.TryGetValue(file, out var kept) || kept.Saved != saved)
        {
            var bytes = await File.ReadAllBytesAsync(file, cancellationToken);
            var text = type.StartsWith("text/", StringComparison.Ordinal) || type.StartsWith("image/svg", StringComparison.Ordinal);
            _web[file] = kept = new WebFile(saved, bytes, text && bytes.Length > 1024 ? Pack(bytes, CompressionLevel.Optimal) : null);
        }

        // asked for with its save time in the address (the page does, for its style and script): a browser may keep
        // it for good, since a newer one has another address
        if (context.Request.Query.ContainsKey("v"))
        {
            context.Response.Headers.CacheControl = "public, max-age=31536000, immutable";
        }

        await SendBytes(context, kept.Plain, kept.Packed, cancellationToken);
    }

    private sealed record WebFile(long Saved, byte[] Plain, byte[]? Packed);

    private readonly ConcurrentDictionary<string, WebFile> _web = new(StringComparer.OrdinalIgnoreCase);

    // ---- sending ----------------------------------------------------------------------------------------------------

    // An answer as text and, when it's big, packed (gzip) as well: a browser that takes it packed has a fifth to a
    // tenth as much to fetch. Packed once and kept, where the answer is.
    private sealed record Answer(string Text, byte[]? Gzip);

    private static Answer Packed(string text, CompressionLevel level = CompressionLevel.Optimal) =>
        new(text, text.Length > 2048 ? Pack(Encoding.UTF8.GetBytes(text), level) : null);

    private static byte[] Pack(byte[] bytes, CompressionLevel level)
    {
        using var to = new MemoryStream();
        using (var gzip = new GZipStream(to, level, true))
        {
            gzip.Write(bytes);
        }

        return to.ToArray();
    }

    private static Task SendJson(HttpContext context, string json, CancellationToken cancellationToken)
    {
        context.Response.ContentType = "application/json; charset=utf-8";
        return context.Response.WriteAsync(json, cancellationToken);
    }

    private static Task SendJson(HttpContext context, Answer answer, CancellationToken cancellationToken)
    {
        context.Response.ContentType = "application/json; charset=utf-8";
        return answer.Gzip != null && TakesGzip(context)
            ? SendBytes(context, [], answer.Gzip, cancellationToken)
            : context.Response.WriteAsync(answer.Text, cancellationToken);
    }

    private static bool TakesGzip(HttpContext context) =>
        context.Request.Headers.AcceptEncoding.ToString().Contains("gzip", StringComparison.OrdinalIgnoreCase);

    // packed, for a browser that takes it so; else plain
    private static Task SendBytes(HttpContext context, byte[] plain, byte[]? packed, CancellationToken cancellationToken)
    {
        context.Response.Headers.Vary = "Accept-Encoding";
        if (packed != null && TakesGzip(context))
        {
            context.Response.Headers.ContentEncoding = "gzip";
            context.Response.ContentLength = packed.Length;
            return context.Response.Body.WriteAsync(packed, cancellationToken).AsTask();
        }

        context.Response.ContentLength = plain.Length;
        return context.Response.Body.WriteAsync(plain, cancellationToken).AsTask();
    }

    // a POST body, unpacked when it was zlib-packed (SPT's own request handler packs; the plugin doesn't)
    private static async Task<byte[]> ReadBody(HttpContext context, CancellationToken cancellationToken)
    {
        var body = await ReadAtMost(context.Request.Body, cancellationToken, context.Request.ContentLength);
        if (body.Length > 1 && body[0] == 0x78)
        {
            try
            {
                await using var zlib = new System.IO.Compression.ZLibStream(new MemoryStream(body), System.IO.Compression.CompressionMode.Decompress);
                body = await ReadAtMost(zlib, cancellationToken);
            }
            catch (InvalidDataException)
            {
                return [];
            }
        }

        return body;
    }

    // length: how long the sender said it is, when it did. Then it's read straight into an array of that size; else
    // through a buffer that's borrowed and given back (one made for every request, ten a second for each game, is a
    // lot for the server to clear away).
    private static async Task<byte[]> ReadAtMost(Stream stream, CancellationToken cancellationToken, long? length = null)
    {
        if (length > MaxBody)
        {
            return [];
        }

        if (length is > 0)
        {
            var exact = new byte[(int)length];
            var got = 0;
            int more;
            while (got < exact.Length && (more = await stream.ReadAsync(exact.AsMemory(got), cancellationToken)) > 0)
            {
                got += more;
            }

            return got == exact.Length ? exact : exact[..got];
        }

        using var buffer = new MemoryStream();
        var chunk = ArrayPool<byte>.Shared.Rent(81920);
        try
        {
            int read;
            while ((read = await stream.ReadAsync(chunk, cancellationToken)) > 0)
            {
                if (buffer.Length + read > MaxBody)
                {
                    return [];
                }

                buffer.Write(chunk, 0, read);
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(chunk);
        }

        return buffer.ToArray();
    }
}

// After every mod has loaded: say where the page is.
[Injectable(TypePriority = OnLoadOrder.PostLoad + 1000)]
public class LiveMapStartup(ISptLogger<LiveMapStartup> logger, HttpConfig http, ModHelper modHelper) : IOnLoad
{
    public Task OnLoadAsync(CancellationToken cancellationToken)
    {
        // the server owner's settings: written now when there are none, so the file is there to edit
        LiveMapRoute.ConfigFile(modHelper.GetAbsolutePathToModFolder(Assembly.GetExecutingAssembly()), m => logger.Info(m), m => logger.Warning(m));

        logger.Success($"[Satellite] Open it at https://127.0.0.1:{http.Port}{LiveMapRoute.Root}/");

        // and from a phone on the same network, when the server can be reached from one
        Lan.Ip = http.Ip ?? "127.0.0.1";
        Lan.Port = http.Port;
        if (Lan.Open)
        {
            var addresses = Lan.Addresses();
            if (addresses.Count > 0)
            {
                logger.Success($"[Satellite] On a phone on the same network: https://{addresses[0]}:{http.Port}{LiveMapRoute.Root}/ (or Settings > About, in the page)");
            }
        }
        else
        {
            logger.Info("[Satellite] Only this PC can open the map. To open it on a phone, the server needs Fika (it opens the server to your network).");
        }

        return Task.CompletedTask;
    }
}
