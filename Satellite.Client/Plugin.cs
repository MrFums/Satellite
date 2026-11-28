using System;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using BepInEx;
using BepInEx.Configuration;
using BepInEx.Logging;
using Satellite.Shared;
using Newtonsoft.Json.Linq;
using SPT.Common.Http;
using UnityEngine;

namespace Satellite.Client
{
    // A live map of the raid in the browser, at https://<server>:6969/satellite. The map is a picture of the location from
    // above, which comes with the server mod (taken beforehand by the map scanner); the markers are read from the game.
    // While no page is open it only asks the server, every couple of seconds, whether one is; a raid then costs
    // nothing. The page only looks: nothing in the game can be changed from it.
    [BepInPlugin(Guid, Name, Version)]
    public class Plugin : BaseUnityPlugin
    {
        public const string Guid = "com.fums.satellite";
        public const string Name = "Fums-Satellite";
        public const string Version = "1.1.0";

        private const string PushRoute = "/satellite/api/push";

        // while nobody's looking, and after the server didn't answer
        private const float IdleGap = 2f;
        private const float FailedGap = 5f;
        // everything is sent again this often; in between, only what moves
        private const float FullGap = 1f;
        // between reports while the server only records the raid
        private const float SlowGap = 0.25f;

        internal static ManualLogSource Log;

        private ConfigEntry<bool> _enabled;
        private ConfigEntry<int> _rate;
        private ConfigEntry<KeyboardShortcut> _open;
        private ConfigEntry<KeyboardShortcut> _openHistory;

        // set by the server's answers, which arrive on another thread
        private volatile int _watchers;
        // nobody is looking and the server only records the raid: reports go out slower
        private volatile bool _slow;
        private volatile bool _sending;
        private volatile bool _failed;

        // the links reports and loot go by, once they're open (see Link)
        private readonly Link _pushLink = new Link("push");
        private readonly Link _thingsLink = new Link("things");

        private readonly StringBuilder _report = new StringBuilder(64 * 1024);
        // the report as it's sent: kept and used again, so a report leaves nothing behind for the game to clear away
        private readonly Outbox _out = new Outbox();
        private string _lastAnswer;
        // what the reports cost the game, said in the log once a minute while a page is open
        private readonly System.Diagnostics.Stopwatch _clock = new System.Diagnostics.Stopwatch();
        private double _spent, _worst;
        // where the time of a report went (looking at the raid, writing it, sending it), and of the slowest one
        private double _lapScan, _lapWrite, _lapSend;
        private string _worstLaps = "";
        private bool _collected;
        private bool _warmed;
        private const double SlowMs = 8.0;
        private const double SlowAverageMs = 2.0;
        private int _reports;
        private float _sinceSaid;
        private float _wait;
        private float _sinceFull = FullGap;
        private int _lastPrint;
        private int _sequence;
        private bool _saidBroken;

        private void Awake()
        {
            Log = Logger;
            Variant.Log = Logger;
            try
            {
                Hooks.Apply();
            }
            catch (Exception)
            {
                // the map works without them
            }
            _enabled = Config.Bind("General", "Enabled", true,
                "Turns the Open the map and Open the raid history keys on or off. The map itself keeps working either way.");
            _rate = Config.Bind("General", "Updates per second", 10,
                new ConfigDescription("How often moving markers are reported while a page is open.", new AcceptableValueRange<int>(1, 30)));
            _open = Config.Bind("General", "Open the map", new KeyboardShortcut(KeyCode.M, KeyCode.LeftAlt),
                "Opens the map in your browser, at the server this game is connected to.");
            _openHistory = Config.Bind("General", "Open the raid history", new KeyboardShortcut(KeyCode.H, KeyCode.LeftAlt),
                "Opens the raid history in your browser (the raids recorded, and their replays), at the server this game is connected to.");

            // A Fika headless host: nobody plays it, so the server never offers it as a game to watch, but the raid is
            // shown from what it says (see FikaHost on the server)
            Headless = BepInEx.Bootstrap.Chainloader.PluginInfos.ContainsKey("com.fika.headless")
                || SystemInfo.graphicsDeviceType == UnityEngine.Rendering.GraphicsDeviceType.Null;
            try
            {
                var fika = Type.GetType("Fika.Core.Main.Utils.FikaBackendUtils, Fika.Core", false);
                _fikaServer = fika?.GetProperty("IsServer", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static);
            }
            catch (Exception)
            {
                _fikaServer = null;
            }
        }

        internal static bool Headless;
        private static System.Reflection.PropertyInfo _fikaServer;

        // this game runs the Fika raid it's in (the headless, or a player hosting it): its bots are the real ones, and
        // the server shows the raid to the players who joined it from what this game says
        private static bool FikaHost()
        {
            try
            {
                return Headless || (_fikaServer != null && _fikaServer.GetValue(null, null) is bool host && host);
            }
            catch (Exception)
            {
                return false;
            }
        }

        private void Update()
        {
            if (_enabled.Value && OpenPressed(_open.Value))
            {
                OpenMap("");
            }
            else if (_enabled.Value && OpenPressed(_openHistory.Value))
            {
                // (the page goes on to the raid history, where the server records raids; else it stays the map)
                OpenMap("?menu=history");
            }

            try
            {
                _pushLink.Tick(Time.unscaledDeltaTime);
                _thingsLink.Tick(Time.unscaledDeltaTime);
                CometLog.Tick(Time.unscaledDeltaTime);
                Things.Tick(this, _watchers > 0 && !_failed);

                _wait -= Time.unscaledDeltaTime;
                _sinceFull += Time.unscaledDeltaTime;
                if (_wait > 0f || _sending)
                {
                    return;
                }

                var watched = _watchers > 0 && !_failed;
                _wait = _failed ? FailedGap : watched ? (World.InRaid() ? (_slow ? SlowGap : 1f / _rate.Value) : FullGap) : IdleGap;
                _clock.Restart();
                _lapScan = 0;
                World.ModsMs = World.ThinkMs = 0;
                World.Arrived = 0;
                var collections = GC.CollectionCount(0);
                Report(watched);
                _collected = GC.CollectionCount(0) != collections;
                _lapWrite = _clock.Elapsed.TotalMilliseconds - _lapScan;
                SendReport();
                _lapSend = _clock.Elapsed.TotalMilliseconds - _lapScan - _lapWrite;
                Cost(_clock.Elapsed.TotalMilliseconds, watched);
            }
            catch (Exception e)
            {
                // never in the way of the game: say it once and try again later
                _wait = FailedGap;
                if (!_saidBroken)
                {
                    _saidBroken = true;
                    Log.LogError($"Couldn't report the raid: {e}");
                }
            }
        }

        // The key went down with its other keys held. Not BepInEx's own test, which says no while any other key is
        // held: the key to walk forward, say.
        private bool OpenPressed(KeyboardShortcut keys)
        {
            if (keys.MainKey == KeyCode.None || !UnityInput.Current.GetKeyDown(keys.MainKey))
            {
                return false;
            }

            var extra = 0;
            foreach (var held in keys.Modifiers)
            {
                if (!UnityInput.Current.GetKey(held))
                {
                    return false;
                }

                extra += Array.IndexOf(Shifts, held) >= 0 ? 1 : 0;
            }

            // but not with another of Ctrl, Shift and Alt held as well: that's some other shortcut (Ctrl+Alt+M)
            var shifts = 0;
            foreach (var shift in Shifts)
            {
                shifts += UnityInput.Current.GetKey(shift) ? 1 : 0;
            }

            return shifts == extra;
        }

        private static readonly KeyCode[] Shifts =
        {
            KeyCode.LeftControl, KeyCode.RightControl, KeyCode.LeftShift, KeyCode.RightShift, KeyCode.LeftAlt, KeyCode.RightAlt
        };

        // the page, at the address the game itself uses for its server: so it's right on another PC's server too
        private void OpenMap(string page)
        {
            try
            {
                var url = RequestHandler.Host.TrimEnd('/') + "/satellite/" + page;
                Application.OpenURL(url);
                Log.LogInfo($"Opened the map: {url}");
            }
            catch (Exception e)
            {
                Log.LogError($"Couldn't open the map: {e.Message}");
            }
        }

        private void Cost(double ms, bool watched)
        {
            if (!watched)
            {
                return;
            }

            _spent += ms;
            if (ms > _worst)
            {
                _worst = ms;
                // writing: of it, asking the bot mods and reading the bots; and whether the game's own clean-up of
                // its memory fell in this report (that would have stopped the game wherever it fell)
                _worstLaps = $"looking {_lapScan:0.0}, writing {_lapWrite:0.0} (bot mods {World.ModsMs:0.0}, bots {World.ThinkMs:0.0}), "
                    + $"sending {_lapSend:0.0}, {World.Arrived} new in the raid{(_collected ? ", memory cleaned up during it" : "")}";
            }

            _reports++;
            _sinceSaid += Math.Max(_wait, 0f);
            if (_sinceSaid >= 60f && _reports > 0)
            {
                // said only when the map cost the game something it would feel: a report or a look at the loot taking
                // half a frame or more (8 ms), or reports taking 2 ms each on average. Otherwise the log stays quiet.
                if (_worst >= SlowMs || Things.Worst >= SlowMs || _spent / _reports >= SlowAverageMs)
                {
                    Log.LogWarning($"Slow for the game, last minute: {_reports} reports, {_spent / _reports:0.000} ms each, worst {_worst:0.00} ms ({_worstLaps}); "
                        + $"loot looked at {Things.Looks} times, {Things.Spent / Math.Max(1, Things.Looks):0.00} ms each, worst {Things.Worst:0.00} ms.");
                }

                _spent = _worst = 0;
                _reports = 0;
                _sinceSaid = 0f;
                Things.Spent = Things.Worst = 0;
                Things.Looks = 0;
            }
        }

        // {"t":"idle"}: nobody's looking, only "is the game there, is it in a raid"
        // {"t":"full"}: every marker
        // {"t":"fast"}: only where the moving markers are now
        private void Report(bool watched)
        {
            var to = _report;
            to.Length = 0;
            var raid = World.InRaid();
            Events.Tick(raid);
            World.Watched = watched && raid;
            var location = raid ? World.Location() : null;
            // out of a raid, once: everything that's looked up by name in the other mods, so no raid pays for it
            if (!raid && !_warmed)
            {
                _warmed = true;
                try
                {
                    Brains.Mods();
                    World.Has();
                    Ghosts.Warm();
                    Cheaters.Warm();
                }
                catch (Exception)
                {
                    // each is looked up again when it's first needed
                }
            }

            // (just out of a raid with how it ended still to tell: a full report, once, so the recording has it)
            if (!watched && !(Events.Unsaid && !raid))
            {
                to.Append("{\"t\":\"idle\"").Append(Headless ? ",\"hl\":1" : "").Append(raid && FikaHost() ? ",\"fh\":1" : "")
                    .Append(",\"raid\":").Append(raid ? "true" : "false").Append(",\"loc\":");
                World.Text(to, location);
                AskScenes(to, location);
                to.Append('}');
                return;
            }

            if (raid)
            {
                var before = _clock.Elapsed.TotalMilliseconds;
                Recorded.Tick();
                World.Scan();
                _lapScan = _clock.Elapsed.TotalMilliseconds - before;
            }

            var print = raid ? World.Print() : 0;
            if (raid && _sinceFull < FullGap && print == _lastPrint)
            {
                to.Append("{\"t\":\"fast\",\"seq\":");
                World.Whole(to, ++_sequence);
                to.Append(",\"me\":");
                World.Me(to);
                to.Append(",\"m\":");
                World.MovingMarkers(to);
                Shots.Take(to);
                to.Append('}');
                return;
            }

            _sinceFull = 0f;
            _lastPrint = print;
            to.Append("{\"t\":\"full\",\"seq\":").Append(++_sequence);
            // "hl": a Fika headless; "fh": the Fika host of the raid it's in
            if (Headless)
            {
                to.Append(",\"hl\":1");
            }

            if (raid && FikaHost())
            {
                to.Append(",\"fh\":1");
            }

            to.Append(",\"raid\":").Append(raid ? "true" : "false");
            // "go":0 while the raid is loaded but hasn't begun (the countdown): a recording leaves that wait out
            if (raid && !World.Started())
            {
                to.Append(",\"go\":0");
            }

            to.Append(",\"loc\":");
            World.Text(to, location);
            AskScenes(to, location);
            // "sea": the season the raid shows (Summer, Winter...): in one with snow, the page shows a snow map when there is one
            if (raid && Variant.Season() is { } season)
            {
                to.Append(",\"sea\":");
                World.Text(to, season);
            }
            // "has": the kinds of marker only a mod brings, for the ones installed here
            to.Append(",\"has\":[");
            var has = World.Has();
            for (var i = 0; i < has.Length; i++)
            {
                if (i > 0)
                {
                    to.Append(',');
                }

                World.Text(to, has[i]);
            }

            to.Append(']');
            // "brains": the mods here that say something about a bot, so the page names only those
            if (!World.BrainsOff)
            {
                to.Append(",\"brains\":[");
                var brains = Brains.Mods();
                for (var i = 0; i < brains.Length; i++)
                {
                    if (i > 0)
                    {
                        to.Append(',');
                    }

                    World.Text(to, brains[i]);
                }

                to.Append(']');
                if (Brains.GestureEvents) to.Append(",\"gestures\":1");
            }

            if (raid)
            {
                to.Append(",\"me\":");
                World.Me(to);
                to.Append(",\"markers\":");
                World.FullMarkers(to);
                // what happened since the last full report (after the markers: making those reads what COMET said)
                Events.Take(to);
                Shots.Take(to);
                Planes.Take(to);
                QuestsDone.Take(to);
                KeysCarried.Take(to);
            }
            else
            {
                // just out of a raid: what happened in its last moments (how it ended)
                Events.Take(to);
            }

            to.Append('}');
        }

        // asks the server which of its maps this raid is on (by the scenes loaded), until it has said
        private void AskScenes(StringBuilder to, string location)
        {
            if (!string.IsNullOrEmpty(location) && !Variant.Resolved && Variant.Settled)
            {
                Variant.Ask(to);
            }
        }

        private void SendReport()
        {
            _sending = true;
            var raid = Variant.Raid;
            var count = _out.Take(_report);
            Post(PushRoute, _out.Bytes, count, (ok, answer) =>
            {
                try
                {
                    if (!ok)
                    {
                        // the server's restarting or gone, or has no such mod: asked again in a few seconds
                        _failed = true;
                        _watchers = 0;
                        _lastAnswer = null;
                        return;
                    }

                    // the same answer as last time (nearly always), and no map named in it: nothing new to read
                    if (answer == _lastAnswer && answer.IndexOf("\"key\"", StringComparison.Ordinal) < 0)
                    {
                        _failed = false;
                        return;
                    }

                    _lastAnswer = answer;

                    var read = JObject.Parse(answer);
                    _watchers = read.Value<int?>("w") ?? 0;
                    _slow = (read.Value<int?>("slow") ?? 0) > 0;
                    // COMET's decisions, for the raid's recording (see CometLog)
                    CometLog.Mode = read.Value<int?>("cm") ?? 0;
                    // the kinds of marker the server's config keeps off the page
                    if (read["off"] is JArray off)
                    {
                        var kinds = new System.Collections.Generic.HashSet<string>();
                        foreach (var kind in off)
                        {
                            kinds.Add(kind.ToString());
                        }

                        World.ServerOff(kinds);
                    }

                    // and the layers of what lies about that it keeps off
                    if (read["layers"] is JArray layers)
                    {
                        var layersOff = new System.Collections.Generic.HashSet<string>();
                        foreach (var layer in layers)
                        {
                            layersOff.Add(layer.ToString());
                        }

                        Things.ServerOff(layersOff);
                        World.BrainsOff = layersOff.Contains("brains");
                    }

                    // which of the server's maps this raid is on, when it was asked
                    var key = read.Value<string>("key");
                    if (!string.IsNullOrEmpty(key))
                    {
                        Variant.Resolve(raid, key);
                    }

                    _failed = false;
                }
                catch (Exception)
                {
                    _failed = true;
                    _watchers = 0;
                }
                finally
                {
                    _sending = false;
                }
            });
        }

        // Sent with the game's own connection to the server (its address, its session), without SPT's request log
        // line and retries. The answer comes back on another thread.
        internal void Post(string route, byte[] bytes, Action<bool, string> done)
        {
            Post(route, bytes, bytes.Length, done);
        }

        // count: how much of bytes is sent (a buffer that's kept and used again is longer than what's in it)
        internal void Post(string route, byte[] bytes, int count, Action<bool, string> done)
        {
            // by the link when it's open: no request of its own
            var link = route == PushRoute ? _pushLink : route == Things.LootRoute ? _thingsLink : null;
            if (link != null && link.Send(bytes, count, done))
            {
                return;
            }

            Task.Run(async () =>
            {
                var ok = false;
                string answer = null;
                try
                {
                    var client = RequestHandler.HttpClient;
                    using (var request = client.CreateNewHttpRequest(HttpMethod.Post, route))
                    {
                        request.Content = new ByteArrayContent(bytes, 0, count);
                        using (var response = await client.HttpClient.SendAsync(request).ConfigureAwait(false))
                        {
                            answer = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                            ok = response.IsSuccessStatusCode;
                        }
                    }
                }
                catch (Exception)
                {
                    ok = false;
                }

                done(ok, answer);
            });
        }
    }

    // What's written in a StringBuilder, as the bytes to send: in buffers that are kept and used again. Making a string
    // and then an array of it for every report (ten a second) is rubbish for the game to stop and clear away. One
    // sender at a time: the bytes are in use until that send is over.
    internal sealed class Outbox
    {
        internal char[] Chars = new char[64 * 1024];
        internal byte[] Bytes = new byte[96 * 1024];
        internal int Length;

        // copies the text in; returns how many bytes it came to
        internal int Take(StringBuilder text)
        {
            Length = text.Length;
            if (Chars.Length < Length)
            {
                Chars = new char[Math.Max(Length, Chars.Length * 2)];
            }

            text.CopyTo(0, Chars, 0, Length);
            var most = Encoding.UTF8.GetMaxByteCount(Length);
            if (Bytes.Length < most)
            {
                Bytes = new byte[Math.Max(most, Bytes.Length * 2)];
            }

            return Encoding.UTF8.GetBytes(Chars, 0, Length, Bytes, 0);
        }

        // a number that changes when the text taken does
        internal int Print()
        {
            unchecked
            {
                var print = (int)2166136261;
                for (var i = 0; i < Length; i++)
                {
                    print = (print ^ Chars[i]) * 16777619;
                }

                return print == 0 ? 1 : print;
            }
        }
    }
}
