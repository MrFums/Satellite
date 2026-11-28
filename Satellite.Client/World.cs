using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Comfort.Common;
using EFT;
using EFT.Interactive;
using Satellite.Shared;
using UnityEngine;

namespace Satellite.Client
{
    // What's in the raid, read straight from the game: the players and bots, the bodies of the ones that died, and
    // the ways out. Places are sent as [east, north, height] in metres, the game's own x, z and y.
    internal static class World
    {
        // what each part of somebody's body has left, filled for each one sent (see "hb")
        private static readonly int[] PartsNow = new int[Health.Parts.Length];

        private sealed class Dot
        {
            public int Id;
            public string Kind;
            public string Text;
            public Vector3 At;
            public float Yaw;
            public Player Player;
            public ExfiltrationPoint Exit;
            // an extract: one of the secret ones (found by picking up its note)
            public bool Secret;
            // a transit to another location: the point, and the location it takes you to
            public EFT.Interactive.TransitPoint Transit;
            public string To;
            // a body: killed by a person playing, not a bot
            public bool ByPlayer;
            // the profile id of the person playing who killed them (a body's)
            public string Killer;
            // moves though it's nobody (the BTR)
            public bool Moves;
            // a body: whose it was, so the page can put what it carries on it
            public string Profile;
            // a body: the kind it was alive ("Scav", "Boss")
            public string Was;
            // the group a person or a PMC came in with, if any, and their level (0: not told)
            public string Group;
            public int Level;
            // any other bot's level ("bl"), a person's or a PMC's side ("Usec", "Bear", "Savage"), and whether this
            // is somebody playing (not a bot)
            public int BotLevel;
            public string Side;
            public bool Person;
            public bool PlayerScav;
            // a bot: how hard it is ("easy" to "impossible"), SAIN's personality for it, the brain layer deciding
            // for it now, whether ORBIT has it parked as a ghost, what ORBIT has it heading for, and the move COMET
            // has it making in a fight
            public string Difficulty;
            public string Personality;
            public string Layer;
            public string Decision;
            public bool Ghost;
            public string Objective;
            // why ORBIT has it leaving the raid ("loot ≥ 400k₽"): null while it isn't
            public string Leaving;
            public string Tactic;
            public Brains.Squad Squad;
            public int Band;
            public bool HasHeading;
            public float HeadingX;
            public float HeadingY;
            public float HeadingZ;
            // what it was before it joined the player's team (Pit FireTeam)
            public string WasKind;
            // who says what it's after, when ORBIT doesn't: "QuestingBots" or "Phobos"
            public string ObjectiveBy;
            // one of PBT's cheaters
            public bool Cheater;
            // what PBT made of it: "personality|cheat,cheat" (null: not read yet, "": nothing to read)
            public string CheatSaid;
            // an airdrop: its crate (what's in it is told by the crate's id), and whether it's still coming down
            public LootableContainer Crate;
            public bool Falling;
        }

        // the airdrops of this raid, looked for every couple of seconds in the game's own list of such things (searching
        // the whole scene for them, as this did at first, is a hitch every time on a big location)
        private static readonly Dictionary<EFT.SynchronizableObjects.AirdropSynchronizableObject, Dot> Drops
            = new Dictionary<EFT.SynchronizableObjects.AirdropSynchronizableObject, Dot>();
        private static float _nextDrops;

        private static void Airdrops()
        {
            try
            {
                if (Time.time >= _nextDrops)
                {
                    _nextDrops = Time.time + 2f;
                    var things = _world != null ? _world.SynchronizableObjectLogicProcessor : null;
                    var active = things != null ? things._activeSynchronizableObjects : null;
                    for (var i = 0; active != null && i < active.Count; i++)
                    {
                        var drop = active[i] as EFT.SynchronizableObjects.AirdropSynchronizableObject;
                        // The plane takes its crate when it sets off, and the crate waits where it was kept until it's
                        // dropped: only from then on (IsInited) is it where the airdrop is.
                        if (drop != null && drop.IsInited && !Drops.ContainsKey(drop))
                        {
                            Drops[drop] = new Dot
                            {
                                Id = ++_nextId, Kind = "Airdrop", Text = drop.AirdropType.ToString(), Moves = true,
                                At = drop.transform.position, Crate = drop.GetComponentInChildren<LootableContainer>(true)
                            };
                        }
                    }
                }

                foreach (var pair in Drops)
                {
                    if (pair.Key == null)
                    {
                        continue;
                    }

                    var at = pair.Key.transform.position;
                    // coming down while it still sinks; on the ground once it lies still
                    pair.Value.Falling = pair.Value.At.y - at.y > 0.002f;
                    pair.Value.At = at;
                }
            }
            catch (Exception)
            {
                // none shown this time
            }
        }

        // the crates of the airdrops, for what's in them
        internal static IEnumerable<LootableContainer> Crates()
        {
            foreach (var dot in Drops.Values)
            {
                if (dot.Crate != null)
                {
                    yield return dot.Crate;
                }
            }
        }

        // the BTR, while there is one
        private static Dot _btr;

        private static GameWorld _world;
        private static int _nextId;
        private static bool _exitsLooked;
        private static bool _exitsFailed;
        private static bool _transitsFailed;
        private static readonly Dictionary<Player, Dot> Players = new Dictionary<Player, Dot>();
        private static readonly List<Dot> Still = new List<Dot>();
        private static readonly HashSet<Player> Alive = new HashSet<Player>();
        private static readonly List<Player> Gone = new List<Player>();

        // Every kind is reported; the page decides what it shows. Only the kinds the server's config.jsonc turns off
        // are left out, as the server's answers say (it would drop them anyway).
        private static volatile HashSet<string> _off = new HashSet<string>();

        internal static void ServerOff(HashSet<string> off)
        {
            _off = off ?? new HashSet<string>();
        }

        // the server's config.jsonc keeps what bots are like and are up to off the page
        internal static volatile bool BrainsOff;

        // a page is open: only then is anything noted of what happens (shots, what's picked up)
        internal static volatile bool Watched;

        // each one's marker by their profile id, and when they were first seen (Time.realtimeSinceStartup)
        internal static readonly Dictionary<string, long> Ids = new Dictionary<string, long>();
        internal static readonly Dictionary<string, float> Born = new Dictionary<string, float>();

        // What the last full report spent asking the bot mods (ORBIT's news, COMET's squads) and reading each bot, and
        // how many came into the raid since the last report: for the plugin's meter.
        internal static double ModsMs, ThinkMs;
        internal static int Arrived;
        private static readonly System.Diagnostics.Stopwatch Meter = System.Diagnostics.Stopwatch.StartNew();

        // Reading the bots may take this long per report. Past it, the rest keep what they had and are read first next
        // time: a wave of new bots, or a mod slow to answer, is spread over a few seconds instead of one long frame.
        private const double ThinkBudgetMs = 2.0;
        private static readonly List<Dot> Order = new List<Dot>();
        private static int _thinkFrom;

        private static void ThinkAll()
        {
            Order.Clear();
            foreach (var dot in Players.Values)
            {
                if (Shown(dot))
                {
                    Order.Add(dot);
                }
            }

            var count = Order.Count;
            if (count == 0)
            {
                return;
            }

            var start = Meter.Elapsed.TotalMilliseconds;
            var from = _thinkFrom % count;
            for (var k = 0; k < count; k++)
            {
                var i = (from + k) % count;
                if (k > 0 && Meter.Elapsed.TotalMilliseconds - start >= ThinkBudgetMs)
                {
                    _thinkFrom = i;
                    return;
                }

                Think(Order[i]);
            }

            _thinkFrom = 0;
        }

        // What a bot is up to changes all the time: read again for each full report (one a second).
        private static void Think(Dot dot)
        {
            var player = dot.Player;
            if (player == null || !IsBot(player))
            {
                return;
            }

            // taken for a person when first seen, and found since to be a bot (Fika marks its copies of the host's bots
            // a moment after they appear)
            if (dot.Kind == "Friendly Player" && dot.WasKind == null)
            {
                var main = Singleton<GameWorld>.Instance?.MainPlayer;
                var kind = main != null || Plugin.Headless ? KindOf(player, main) : null;
                if (kind != null && kind != dot.Kind)
                {
                    dot.Kind = kind;
                    dot.Level = 0;
                    dot.Group = null;
                    Describe(dot, player);
                    if (!string.IsNullOrEmpty(player.ProfileId))
                    {
                        Kinds[player.ProfileId] = kind;
                    }
                }
            }

            // a bot on the player's own team (Pit FireTeam) is a friend while it is, whatever it was before
            try
            {
                if (Brains.Teammate(player.ProfileId))
                {
                    if (dot.Kind != null && dot.Kind != "Friendly Player")
                    {
                        dot.WasKind = dot.Kind;
                        dot.Kind = "Friendly Player";
                        Kinds[player.ProfileId] = dot.Kind;
                    }
                }
                else if (dot.WasKind != null)
                {
                    dot.Kind = dot.WasKind;
                    dot.WasKind = null;
                    Kinds[player.ProfileId] = dot.Kind;
                }
            }
            catch (Exception)
            {
                // as it was
            }

            if (BrainsOff)
            {
                return;
            }

            try
            {
                var bot = player.AIData != null ? player.AIData.BotOwner : null;
                if (dot.Personality == null)
                {
                    dot.Personality = Brains.Personality(bot);
                }

                dot.Layer = Brains.Layer(bot);
                dot.Decision = Brains.Decision(player, bot);
                dot.Ghost = Brains.Ghost(player.ProfileId);
                dot.Objective = Brains.Objective(player.ProfileId);
                dot.Leaving = string.IsNullOrEmpty(dot.Objective) ? null : Brains.Leaving(player.ProfileId);
                // the moment ORBIT has it leave, and why: an event ("orbit.leave", {"why":...}), once for each reason
                if (!string.IsNullOrEmpty(dot.Leaving) && (!LeftFor.TryGetValue(player.ProfileId, out var leftWas) || leftWas != dot.Leaving))
                {
                    LeftFor[player.ProfileId] = dot.Leaving;
                    var why = dot.Leaving;
                    Names.TryGetValue(player.ProfileId, out var leaver);
                    Events.Add("orbit.leave", player.ProfileId, leaver, Time.realtimeSinceStartup, to =>
                    {
                        to.Append("{\"why\":");
                        Text(to, why);
                        to.Append('}');
                    });
                }

                dot.Tactic = Brains.Tactic(player.ProfileId);
                dot.Squad = Brains.SquadOf(player.ProfileId);
                dot.HasHeading = Brains.Heading(player.ProfileId, out dot.HeadingX, out dot.HeadingY, out dot.HeadingZ);
                // QuestingBots or Phobos, for a bot ORBIT says nothing about
                dot.ObjectiveBy = null;
                if (string.IsNullOrEmpty(dot.Objective) && Objectives.Of(player, bot, out var by, out var what, out var place, out var placed))
                {
                    dot.ObjectiveBy = by;
                    dot.Objective = what;
                    dot.HasHeading = placed;
                    dot.HeadingX = place.x;
                    dot.HeadingY = place.y;
                    dot.HeadingZ = place.z;
                }

                dot.Cheater = dot.Cheater || Cheaters.Is(player, dot.Layer);
                if (dot.Cheater && dot.CheatSaid == null)
                {
                    dot.CheatSaid = Cheaters.Detail(player);
                }
                // the bots it goes about with, when it isn't on its own
                var band = bot != null ? bot.BotsGroup : null;
                dot.Band = band != null && band.MembersCount > 1 ? band.Id : 0;
            }
            catch (Exception)
            {
                // drawn without them
            }
        }

        private static bool Wanted(string kind)
        {
            return !_off.Contains(kind);
        }

        internal static bool InRaid()
        {
            try
            {
                var game = Singleton<AbstractGame>.Instance;
                var world = Singleton<GameWorld>.Instance;
                if (game == null || world == null)
                {
                    return false;
                }

                // a Fika headless has no player of its own in the raid it runs
                return Plugin.Headless ? game.InRaid || game.Status == GameStatus.Started : game.InRaid && world.MainPlayer != null;
            }
            catch (Exception)
            {
                return false;
            }
        }

        // the raid has begun: the countdown is over and the player can move
        internal static bool Started()
        {
            var game = Singleton<AbstractGame>.Instance;
            return game != null && game.Status == GameStatus.Started;
        }

        // the map as the server keeps it: the location id, and its version when a mod swapped it (see Variant)
        internal static string Location()
        {
            return Variant.Key();
        }

        // ---- who and what is where ------------------------------------------------------------------------------

        // Looks at the raid as it is now. Called before each report while a page is open.
        internal static void Scan()
        {
            var world = Singleton<GameWorld>.Instance;
            if (world != _world)
            {
                _world = world;
                _exitsLooked = false;
                Players.Clear();
                Still.Clear();
                Names.Clear();
                LeftFor.Clear();
                Kinds.Clear();
                Ids.Clear();
                Born.Clear();
                Shots.Forget();
                KeysCarried.Forget();
                Recorded.Forget();
                Brains.ForgetDecisions();
                Pickups.Forget();
                Planes.Forget();
                KilledByPlayers.Clear();
                Leaving.Clear();
                LeftAt.Clear();
                _btr = null;
                Drops.Clear();
                _nextDrops = 0f;
            }

            // (a Fika headless has no player of its own: everyone in the raid is somebody else)
            var main = world != null ? world.MainPlayer : null;
            if (world == null || (main == null && !Plugin.Headless))
            {
                return;
            }

            Alive.Clear();
            foreach (var player in world.AllAlivePlayersList)
            {
                if (player == null)
                {
                    continue;
                }

                Alive.Add(player);
                if (!Players.TryGetValue(player, out var dot))
                {
                    dot = new Dot { Id = ++_nextId, Player = player, Kind = KindOf(player, main), Text = NameOf(player) };
                    Describe(dot, player);
                    Players[player] = dot;
                    Arrived++;
                    if (!string.IsNullOrEmpty(player.ProfileId))
                    {
                        Names[player.ProfileId] = dot.Text;
                        Ids[player.ProfileId] = dot.Id;
                        Born[player.ProfileId] = Time.realtimeSinceStartup;
                        if (dot.Kind != null)
                        {
                            Kinds[player.ProfileId] = dot.Kind;
                        }
                    }
                }

                dot.At = player.Position;
                dot.Yaw = player.Rotation.x;
            }

            Gone.Clear();
            foreach (var pair in Players)
            {
                if (!Alive.Contains(pair.Key))
                {
                    Gone.Add(pair.Key);
                }
            }

            foreach (var player in Gone)
            {
                var dot = Players[player];
                Players.Remove(player);
                if (dot.Kind == null || ReferenceEquals(player, null))
                {
                    continue;
                }

                // died, rather than left the raid; marked when a player (not a bot) did it
                if (player != null && Dead(player))
                {
                    Died(player, dot, world);
                }
                else
                {
                    // In a Fika raid joined from another PC, a player may leave the list a moment before the game
                    // here hears they died: looked at again for a few seconds
                    Leaving.Add(new KeyValuePair<Player, Dot>(player, dot));
                    LeftAt[player] = Time.realtimeSinceStartup;
                }
            }

            for (var i = Leaving.Count - 1; i >= 0; i--)
            {
                var player = Leaving[i].Key;
                if (player != null && Dead(player))
                {
                    Died(player, Leaving[i].Value, world);
                }
                else if (player != null && LeftAt.TryGetValue(player, out var left) && Time.realtimeSinceStartup - left < LeavingFor)
                {
                    continue;
                }
                else if (main != null && Leaving[i].Value.Person && Leaving[i].Value.Kind != "Main Player")
                {
                    // somebody playing who is gone and didn't die: they left the raid (extracted, when Fika says so)
                    Recorded.PersonLeft(player, Leaving[i].Value.Text, Leaving[i].Value.Kind, Leaving[i].Value.At);
                }

                LeftAt.Remove(player);
                Leaving.RemoveAt(i);
            }

            Btr();
            Airdrops();

            if (!_exitsLooked && main != null && Started())
            {
                _exitsLooked = true;
                LookForExits(world, main);
            }
        }

        // the name of everyone seen this raid, by their profile id (a body is named by it)
        internal static readonly Dictionary<string, string> Names = new Dictionary<string, string>();
        // why ORBIT has each bot leaving, as last told (see the "orbit.leave" event)
        internal static readonly Dictionary<string, string> LeftFor = new Dictionary<string, string>();

        // and the kind each was ("Scav", "Boss"), so a body can say what it was
        internal static readonly Dictionary<string, string> Kinds = new Dictionary<string, string>();

        // a person's or a PMC bot's level, and the group they came in with
        private static void Describe(Dot dot, Player player)
        {
            try
            {
                dot.Person = !IsBot(player);
                if (dot.Kind == "Main Player" || dot.Kind == "Friendly Player" || dot.Kind == "Enemy Player")
                {
                    dot.Level = player.Profile?.Info != null ? player.Profile.Info.Level : 0;
                    dot.Group = player.GroupId;
                    dot.Side = player.Side.ToString();
                    dot.BotLevel = 0;
                }
                else if (!dot.Person)
                {
                    dot.BotLevel = player.Profile?.Info != null ? player.Profile.Info.Level : 0;
                }

                var info = player.Profile?.Info;
                if (!dot.Person && info?.Settings != null)
                {
                    dot.Difficulty = info.Settings.BotDifficulty.ToString();
                    dot.PlayerScav = IsPlayerScav(player.Side, info.Settings.Role, info.MainProfileNickname, info.Nickname);
                }
            }
            catch (Exception)
            {
                // drawn without them
            }
        }

        private static bool IsPlayerScav(EPlayerSide side, WildSpawnType role, string mainName, string scavName)
        {
            if (side != EPlayerSide.Savage || role != WildSpawnType.assault)
            {
                return false;
            }

            // SPT records the PMC name separately. Older profiles use "scav (PMC)".
            if (!string.IsNullOrEmpty(mainName))
            {
                return true;
            }

            int suffix = scavName?.LastIndexOf(" (", StringComparison.Ordinal) ?? -1;
            return suffix > 0 && scavName.Length > suffix + 3 && scavName.EndsWith(")", StringComparison.Ordinal);
        }

        // The kinds only a mod brings, and whether that mod is in this game: the page offers a switch for a kind only
        // when it can turn up at all. (Never by who is in the raid: that would give away what the switch hides.)
        private static string[] _has;

        internal static string[] Has()
        {
            if (_has != null)
            {
                return _has;
            }

            var has = new List<string>();
            try
            {
                var loaded = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
                {
                    loaded.Add(assembly.GetName().Name);
                }

                if (loaded.Contains("BlackDiv"))
                {
                    has.Add("Black Division");
                }

                if (loaded.Contains("RUAFComeHomePlugin"))
                {
                    has.Add("RUAF");
                    has.Add("RUAF Remnant");
                }

                if (loaded.Contains("ManimalTerminalClient"))
                {
                    has.Add("Civilian");
                }

                if (loaded.Contains("UNTARGHPlugin"))
                {
                    has.Add("UNTAR");
                }

                if (loaded.Contains("ISB-SpecialForces"))
                {
                    has.Add("ISB");
                    has.Add("ISB WT");
                }
            }
            catch (Exception)
            {
                // none of them, then
            }

            return _has = has.ToArray();
        }

        // the profile ids of the ones a person playing (not a bot) killed this raid, so their bodies can be told apart
        internal static readonly HashSet<string> KilledByPlayers = new HashSet<string>();

        // Somebody died: said once, as an event ("kill"), for the page's kill feed. {"vk":what the dead one was,
        // "k":the killer's profile id,"kn":their name,"kk":what they are,"w":the weapon,"bp":where it hit,"m":how far,
        // "at":[east,north,height] where they died,"ka":where the killer stood,"self":1 when they killed themselves}
        private const System.Reflection.BindingFlags Kept = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic;
        private static readonly System.Reflection.FieldInfo LastDamage = typeof(Player).GetField("LastDamageInfo", Kept);
        private static readonly System.Reflection.FieldInfo LastPart = typeof(Player).GetField("LastBodyPart", Kept);
        private static readonly System.Reflection.FieldInfo LastHit = typeof(Player).GetField("LastAggressor", Kept);

        private static void Killed(Player dead, Dot dot)
        {
            try
            {
                var killer = dead.KillerId;
                string killerName = null, killerKind = null, weapon = null, part = null;
                var far = -1f;
                // killed by a gas explosion (Lab's gas, a burst pipe): nobody did it, and it's said as such
                var gas = false;
                var where = dead.Position;
                Vector3? from = null;
                // killed by their own hand (their own grenade, a fall): said as such, not as no killer known
                var self = killer == dead.ProfileId;
                if (!string.IsNullOrEmpty(killer))
                {
                    Names.TryGetValue(killer, out killerName);
                    Kinds.TryGetValue(killer, out killerKind);
                }

                try
                {
                    // the game keeps these to itself: read by name
                    var info = LastDamage != null ? LastDamage.GetValue(dead) : null;
                    var kept = info != null ? info.GetType() : null;
                    var item = (kept != null ? (kept.GetField("Weapon") != null ? kept.GetField("Weapon").GetValue(info)
                        : kept.GetProperty("Weapon") != null ? kept.GetProperty("Weapon").GetValue(info, null) : null) : null) as EFT.InventoryLogic.Item;
                    weapon = item != null ? RichText.Plain(item.LocalizedShortName()) : null;
                    part = LastPart != null ? Convert.ToString(LastPart.GetValue(dead)) : null;
                    var aggressor = LastHit != null ? LastHit.GetValue(dead) as IPlayer : null;
                    var kind = kept == null ? null : kept.GetField("DamageType") != null ? kept.GetField("DamageType").GetValue(info)
                        : kept.GetProperty("DamageType") != null ? kept.GetProperty("DamageType").GetValue(info, null) : null;
                    gas = kind != null && kind.ToString() == "HotGases" && aggressor == null;
                    if (aggressor != null && aggressor.ProfileId == dead.ProfileId && string.IsNullOrEmpty(killer))
                    {
                        self = true;
                    }

                    if (aggressor != null && aggressor.ProfileId != dead.ProfileId)
                    {
                        far = Vector3.Distance(aggressor.Position, dead.Position);
                        from = aggressor.Position;
                    }
                }
                catch (Exception)
                {
                    // said without them
                }

                var victimKind = dot.WasKind == null ? dot.Kind : "Friendly Player";
                Events.Add("kill", dead.ProfileId, dot.Text, Time.realtimeSinceStartup, to =>
                {
                    to.Append("{\"vk\":");
                    Text(to, victimKind);
                    if (!string.IsNullOrEmpty(killer) && killer != dead.ProfileId)
                    {
                        to.Append(",\"k\":");
                        Text(to, killer);
                        if (!string.IsNullOrEmpty(killerName))
                        {
                            to.Append(",\"kn\":");
                            Text(to, killerName);
                        }

                        if (!string.IsNullOrEmpty(killerKind))
                        {
                            to.Append(",\"kk\":");
                            Text(to, killerKind);
                        }
                    }
                    else if (self)
                    {
                        to.Append(",\"self\":1");
                    }

                    if (gas)
                    {
                        to.Append(",\"gas\":1");
                    }

                    if (!string.IsNullOrEmpty(weapon))
                    {
                        to.Append(",\"w\":");
                        Text(to, weapon);
                    }

                    if (!string.IsNullOrEmpty(part))
                    {
                        to.Append(",\"bp\":");
                        Text(to, part);
                    }

                    if (far >= 0f)
                    {
                        to.Append(",\"m\":").Append((int)Math.Round(far));
                    }

                    // where they died, and where the one who killed them stood
                    Spot(to, "at", where);
                    if (from.HasValue)
                    {
                        Spot(to, "ka", from.Value);
                    }

                    to.Append('}');
                });
            }
            catch (Exception)
            {
                // the body is still marked
            }
        }

        // the ones that left the list of the living and may yet turn out dead, and since when
        private static readonly List<KeyValuePair<Player, Dot>> Leaving = new List<KeyValuePair<Player, Dot>>();
        private static readonly Dictionary<Player, float> LeftAt = new Dictionary<Player, float>();
        private const float LeavingFor = 3f;

        private static void Died(Player player, Dot dot, GameWorld world)
        {
            var byPlayer = KilledByPlayer(player, world);
            Killed(player, dot);
            Still.Add(new Dot { Id = ++_nextId, Kind = "Corpse", Text = dot.Text, At = dot.At, ByPlayer = byPlayer, Killer = byPlayer ? player.KillerId : null, Profile = player.ProfileId, Was = dot.Kind });
            if (byPlayer && !string.IsNullOrEmpty(player.ProfileId))
            {
                KilledByPlayers.Add(player.ProfileId);
            }
        }

        // whether whoever dealt the last blow was a person playing (the player, a friend), not a bot
        private static bool KilledByPlayer(Player dead, GameWorld world)
        {
            try
            {
                var killer = dead.KillerId;
                if (string.IsNullOrEmpty(killer))
                {
                    return false;
                }

                foreach (var player in world.AllAlivePlayersList)
                {
                    if (player != null && player.ProfileId == killer)
                    {
                        return !IsBot(player);
                    }
                }

                foreach (var player in Players.Keys)
                {
                    if (player != null && player.ProfileId == killer)
                    {
                        return !IsBot(player);
                    }
                }
            }
            catch (Exception)
            {
                // nobody to go by
            }

            return false;
        }

        // where the BTR is and which way it faces, while the location has one out
        private static void Btr()
        {
            try
            {
                var controller = EFT.Vehicle.BtrController.Instance;
                var btr = controller != null ? controller.BtrVehicle : null;
                if (btr == null || !btr.gameObject.activeInHierarchy)
                {
                    _btr = null;
                    return;
                }

                if (_btr == null)
                {
                    _btr = new Dot { Id = ++_nextId, Kind = "BTR", Text = "BTR", Moves = true };
                }

                _btr.At = btr.transform.position;
                _btr.Yaw = btr.transform.eulerAngles.y;
            }
            catch (Exception)
            {
                _btr = null;
            }
        }

        private static bool Dead(Player player)
        {
            try
            {
                return player.HealthController != null && !player.HealthController.IsAlive;
            }
            catch (Exception)
            {
                return false;
            }
        }

        // null: not shown at all
        private static string KindOf(Player player, Player main)
        {
            try
            {
                if (player.IsYourPlayer)
                {
                    return "Main Player";
                }

                var info = player.Profile?.Info;
                // a Fika headless host is in the raid as a player, and isn't one
                if (info != null && info.MemberCategory == EMemberCategory.UnitTest)
                {
                    return null;
                }

                var group = main != null ? main.GroupId : null;
                if (!IsBot(player) || (!string.IsNullOrEmpty(group) && player.GroupId == group))
                {
                    return "Friendly Player";
                }

                if (player.Side == EPlayerSide.Bear || player.Side == EPlayerSide.Usec)
                {
                    return "Enemy Player";
                }

                var role = info?.Settings != null ? info.Settings.Role.ToString() : "";
                if (role == "shooterBTR")
                {
                    return null;
                }

                if (role == "bossKnight" || role == "followerBigPipe" || role == "followerBirdEye")
                {
                    return "Goon";
                }

                if (role == "marksman")
                {
                    return "Sniper";
                }

                // the priest and the warriors that walk with them
                if (role.StartsWith("sectant", StringComparison.OrdinalIgnoreCase))
                {
                    return "Cultist";
                }

                if (Scavs.Contains(role))
                {
                    return "Scav";
                }

                if (role == "pmcBot")
                {
                    return "Raider";
                }

                // the arena's fighters let loose in an event, a mod's mercenaries, and Manimal's Combine
                if (role == "arenaFighterEvent" || role == "arenaFighter")
                {
                    return "Bloodhound";
                }

                if (role.Equals("mercenary", StringComparison.OrdinalIgnoreCase))
                {
                    return "Mercenary";
                }

                if (role.StartsWith("Combine", StringComparison.OrdinalIgnoreCase))
                {
                    return "Combine";
                }

                if (role == "exUsec")
                {
                    return "Rogue";
                }

                if (role.IndexOf("smuggler", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    return "Smuggler";
                }

                if (BlackDivision.Contains(role) || role.StartsWith("blackDiv", StringComparison.OrdinalIgnoreCase))
                {
                    return "Black Division";
                }

                if (Remnant.Contains(role) || role.StartsWith("remnant", StringComparison.OrdinalIgnoreCase))
                {
                    return "RUAF Remnant";
                }

                if (Ruaf.Contains(role) || role.StartsWith("ruaf", StringComparison.OrdinalIgnoreCase))
                {
                    return "RUAF";
                }

                if (Untar.Contains(role))
                {
                    return "UNTAR";
                }

                if (WhiteTusks.Contains(role))
                {
                    return "ISB WT";
                }

                if (IsbSpecialForces(role))
                {
                    return "ISB";
                }

                // Scourge (Manimal's boss) and its followers, as a boss and guards: by number too, should the game not know
                // their names
                if (role == "776720")
                {
                    return "Boss";
                }

                if (role == "776721")
                {
                    return "Guard";
                }

                if (Civilians.Contains(role) || role.StartsWith("civilian", StringComparison.OrdinalIgnoreCase))
                {
                    return "Civilian";
                }

                if (role.StartsWith("infected", StringComparison.OrdinalIgnoreCase))
                {
                    return "Infected";
                }

                return IsBoss(role) ? "Boss" : IsGuard(role) ? "Guard" : "Other AI";
            }
            catch (Exception)
            {
                return "Other AI";
            }
        }

        // the scavs proper; any other bot not named here (event and arena bots, a mod's own) is "Other AI"
        private static readonly HashSet<string> Scavs = new HashSet<string> { "assault", "assaultGroup", "cursedAssault", "crazyAssaultEvent" };

        // Black Division (the BlackDiv mod): its own bot types, which the game knows only by number (a mod adds them
        // past the end of the game's list), so their numbers are given here as well as their names: lead, assault,
        // breacher, support, Wedge (their boss) and raider
        private static readonly HashSet<string> BlackDivision = new HashSet<string>
        {
            "848420", "848421", "848422", "848423", "848424", "848426", "bossWedge"
        };

        // the RUAF (the RUAFComeHome mod, and Manimal's Terminal, which brings them in), known by number likewise, as
        // the mod lists them: its six soldier types, and the remnant rifleman
        private static readonly HashSet<string> Ruaf = new HashSet<string>
        {
            "848400", "848401", "848402", "848403", "848404", "848405"
        };

        private static readonly HashSet<string> Remnant = new HashSet<string> { "848406" };

        // UNTAR (the UNTAR Go Home mod), by name and by number as the mod lists them: grunt, squad leader, marksman, officer
        private static readonly HashSet<string> Untar = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "followeruntar", "bossuntarlead", "followeruntarmarksman", "bossuntarofficer", "1170", "1171", "1172", "1173"
        };

        // ISB's White Tusks (Firefly and those with her), a group of their own: by name and by number
        private static readonly HashSet<string> WhiteTusks = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "ISBBossFirefly", "ISBFollowerVipper", "ISBFollowerLoghan", "ISBFollowerSpearthrower", "ISBFollowerZofia",
            "ISBFollowerEvernight", "ISBFollowerNemesis", "13702", "13703", "13704", "13705", "13706", "13715", "13716"
        };

        // ISB Special Forces: its sixteen types, their bosses among them, named "ISB..." or numbered 13701 to 13716
        private static bool IsbSpecialForces(string role)
        {
            return role.StartsWith("ISB", StringComparison.OrdinalIgnoreCase)
                || (int.TryParse(role, out var number) && number >= 13701 && number <= 13716);
        }

        // the people still living on Manimal's Terminal, who run rather than fight
        private static readonly HashSet<string> Civilians = new HashSet<string> { "776701" };

        // by the role's name, so a boss a mod or a later game version adds is one too
        private static bool IsBoss(string role)
        {
            return role.StartsWith("boss", StringComparison.OrdinalIgnoreCase)
                || role == "followerBigPipe" || role == "followerBirdEye" || role == "sectantPriest" || role == "gifter";
        }

        // a boss's followers, the cultists that walk with their priest, and the Labyrinth's Shadow of Tagilla's helpers
        private static bool IsGuard(string role)
        {
            return role.StartsWith("follower", StringComparison.OrdinalIgnoreCase) || role == "sectantWarrior"
                || role.EndsWith("HelperAgro", StringComparison.OrdinalIgnoreCase);
        }

        // Whether a player is a bot. In a Fika raid joined from another PC, the host's bots are copies Fika keeps in step
        // ("observed" players), and the game counts those as people; Fika marks them with its own field, IsObservedAI,
        // read by name so the plugin needs no Fika to run.
        private static readonly Dictionary<Type, System.Reflection.FieldInfo> ObservedAi = new Dictionary<Type, System.Reflection.FieldInfo>();

        internal static bool IsBot(Player player)
        {
            if (player == null)
            {
                return false;
            }

            try
            {
                if (player.IsAI)
                {
                    return true;
                }

                var type = player.GetType();
                if (!ObservedAi.TryGetValue(type, out var field))
                {
                    for (var t = type; t != null && field == null; t = t.BaseType)
                    {
                        field = t.GetField("IsObservedAI", Kept | System.Reflection.BindingFlags.DeclaredOnly);
                    }

                    ObservedAi[type] = field;
                }

                return field != null && field.GetValue(player) is bool bot && bot;
            }
            catch (Exception)
            {
                return false;
            }
        }

        // The player's name. Playing as a scav, the scav's with the account's after it: "Nikita Berg (fums)".
        private static string NameOf(Player player)
        {
            try
            {
                var name = player.Profile?.Nickname ?? "";
                if (player.IsYourPlayer && player.Side == EPlayerSide.Savage)
                {
                    var own = AccountName();
                    if (!string.IsNullOrEmpty(own) && own != name)
                    {
                        return string.IsNullOrEmpty(name) ? own : name + " (" + own + ")";
                    }
                }

                return name;
            }
            catch (Exception)
            {
                return "";
            }
        }

        // the name on the account (its PMC's), as the server knows it
        private static string AccountName()
        {
            try
            {
                var app = UnityEngine.Object.FindObjectOfType<EFT.TarkovApplication>();
                var session = app != null ? app.GetClientBackEndSession() : null;
                return session?.Profile?.Nickname;
            }
            catch (Exception)
            {
                return null;
            }
        }

        // the main player's ways out of this raid
        private static void LookForExits(GameWorld world, Player main)
        {
            try
            {
                var control = world.ExfiltrationController;
                ExfiltrationPoint[] points = control == null ? null : main.Side == EPlayerSide.Savage ? control.ScavExfiltrationPoints : control.ExfiltrationPoints;
                // and the secret ones this side can take: hidden until their note is picked up (ExitState 3)
                var secret = control?.SecretExfiltrationPoints ?? new EFT.Interactive.SecretExfiltrations.SecretExfiltrationPoint[0];
                foreach (var point in (points ?? new ExfiltrationPoint[0]).Concat(secret))
                {
                    if (point == null || !point.isActiveAndEnabled || !point.InfiltrationMatch(main))
                    {
                        continue;
                    }

                    var name = point.Settings != null ? point.Settings.Name : "";
                    Still.Add(new Dot
                    {
                        Id = ++_nextId, Kind = "Extract", Exit = point, At = ExitPlace.Of(point),
                        Text = string.IsNullOrEmpty(name) ? "" : RichText.Plain(name.Localized()),
                        Secret = point is EFT.Interactive.SecretExfiltrations.SecretExfiltrationPoint
                    });
                }
            }
            catch (Exception e)
            {
                if (!_exitsFailed)
                {
                    _exitsFailed = true;
                    Plugin.Log.LogWarning($"Couldn't read this raid's extracts: {e.Message}");
                }
            }

            // the transits to other locations
            try
            {
                var transits = world.TransitController?.pointsById;
                if (transits == null)
                {
                    return;
                }

                foreach (var point in transits.Values)
                {
                    if (point == null || point.parameters == null || !point.parameters.active)
                    {
                        continue;
                    }

                    var name = point.parameters.name;
                    Still.Add(new Dot
                    {
                        Id = ++_nextId, Kind = "Transit", Transit = point, At = point.transform.position,
                        Text = string.IsNullOrEmpty(name) ? "" : RichText.Plain(name.Localized()), To = point.parameters.location
                    });
                }
            }
            catch (Exception e)
            {
                if (!_transitsFailed)
                {
                    _transitsFailed = true;
                    Plugin.Log.LogWarning($"Couldn't read this raid's transits: {e.Message}");
                }
            }
        }

        // 0 closed, 1 wants something of you first, 2 open
        private static int ExitState(ExfiltrationPoint point)
        {
            try
            {
                if (point == null)
                {
                    return 0;
                }

                switch (point.Status)
                {
                    case EExfiltrationStatus.NotPresent: return 0;
                    case EExfiltrationStatus.UncompleteRequirements: return 1;
                    // a secret one not found yet
                    case EExfiltrationStatus.Hidden: return 3;
                    default: return 2;
                }
            }
            catch (Exception)
            {
                return 2;
            }
        }

        // a transit: 0 not open (yet, or not for this raid), 2 open
        private static int TransitState(EFT.Interactive.TransitPoint point)
        {
            try
            {
                return point != null && point.Enabled && point.IsActive ? 2 : 0;
            }
            catch (Exception)
            {
                return 2;
            }
        }

        private static bool Shown(Dot dot)
        {
            return dot.Kind != null && Wanted(dot.Kind);
        }

        // ---- the report -----------------------------------------------------------------------------------------

        internal static void Number(StringBuilder to, float value)
        {
            if (float.IsNaN(value) || float.IsInfinity(value))
            {
                to.Append('0');
                return;
            }

            // two decimals, written digit by digit: this is called thousands of times a second, and a string made
            // for each number is rubbish the game then has to stop and clear away
            var hundredths = (long)Math.Round(value * 100.0);
            if (hundredths < 0)
            {
                to.Append('-');
                hundredths = -hundredths;
            }

            Whole(to, hundredths / 100);
            var rest = (int)(hundredths % 100);
            if (rest != 0)
            {
                to.Append('.').Append((char)('0' + rest / 10));
                if (rest % 10 != 0)
                {
                    to.Append((char)('0' + rest % 10));
                }
            }
        }

        // a whole number that isn't negative, without making a string of it
        internal static void Whole(StringBuilder to, long value)
        {
            if (value >= 10)
            {
                Whole(to, value / 10);
            }

            to.Append((char)('0' + value % 10));
        }

        // a JSON string, written straight in
        internal static void Text(StringBuilder to, string value)
        {
            to.Append('"');
            if (value != null)
            {
                foreach (var c in value)
                {
                    switch (c)
                    {
                        case '"': to.Append('\\').Append('"'); break;
                        case '\\': to.Append('\\').Append('\\'); break;
                        case '\n': to.Append('\\').Append('n'); break;
                        case '\r': to.Append('\\').Append('r'); break;
                        case '\t': to.Append('\\').Append('t'); break;
                        default:
                            if (c < ' ' || c == '\u2028' || c == '\u2029')
                            {
                                const string hex = "0123456789abcdef";
                                to.Append('\\').Append('u').Append(hex[(c >> 12) & 15]).Append(hex[(c >> 8) & 15]).Append(hex[(c >> 4) & 15]).Append(hex[c & 15]);
                            }
                            else
                            {
                                to.Append(c);
                            }

                            break;
                    }
                }
            }

            to.Append('"');
        }

        // a number that changes when a marker comes, goes or changes state
        internal static int Print()
        {
            var print = 17;
            foreach (var dot in Players.Values)
            {
                if (Shown(dot))
                {
                    print = unchecked(print * 31 + dot.Id);
                }
            }

            if (_btr != null && Shown(_btr))
            {
                print = unchecked(print * 31 + _btr.Id);
            }

            foreach (var dot in Drops.Values)
            {
                if (Shown(dot))
                {
                    print = unchecked(print * 31 + dot.Id * 2 + (dot.Falling ? 1 : 0));
                }
            }

            foreach (var dot in Still)
            {
                if (Shown(dot))
                {
                    print = unchecked(print * 31 + dot.Id * 8 + (dot.Exit != null ? ExitState(dot.Exit) : dot.Transit != null ? 4 + TransitState(dot.Transit) : 7));
                }
            }

            return print;
        }

        // "me":[east,north,height,facing,indoors]: where the player is, for following (and zooming in under a roof)
        internal static void Me(StringBuilder to)
        {
            var player = Singleton<GameWorld>.Instance?.MainPlayer;
            if (player == null)
            {
                to.Append("null");
                return;
            }

            var at = player.Position;
            to.Append('[');
            Place(to, at, player.Rotation.x);
            to.Append(',').Append(Indoors(player) ? '1' : '0');
            to.Append(']');
        }

        // what the game itself goes by for sound and weather: inside a building or out in the open
        private static bool Indoors(Player player)
        {
            try
            {
                return player.Environment == EnvironmentType.Indoor;
            }
            catch (Exception)
            {
                return false;
            }
        }

        // where something happened, into an event: ,"<name>":[east,north,height]
        internal static void Spot(StringBuilder to, string name, Vector3 at)
        {
            to.Append(",\"").Append(name).Append("\":[");
            Number(to, at.x);
            to.Append(',');
            Number(to, at.z);
            to.Append(',');
            Number(to, at.y);
            to.Append(']');
        }

        // east, north, height, facing (degrees clockwise from north)
        private static void Place(StringBuilder to, Vector3 at, float yaw)
        {
            Number(to, at.x);
            to.Append(',');
            Number(to, at.z);
            to.Append(',');
            Number(to, at.y);
            to.Append(',');
            Number(to, yaw);
        }

        // every marker: {"id":1,"c":"Scav","t":"name","p":[east,north,height],"r":facing,"dyn":1,"st":2}
        internal static void FullMarkers(StringBuilder to)
        {
            var began = Meter.Elapsed.TotalMilliseconds;
            if (!BrainsOff)
            {
                Brains.Sort();
                Ghosts.Tick();
            }

            var thought = Meter.Elapsed.TotalMilliseconds;
            ModsMs = thought - began;
            ThinkAll();
            ThinkMs = Meter.Elapsed.TotalMilliseconds - thought;

            to.Append('[');
            var first = true;
            foreach (var dot in Still)
            {
                if (Shown(dot))
                {
                    Full(to, dot, ref first);
                }
            }

            foreach (var dot in Players.Values)
            {
                if (Shown(dot))
                {
                    Full(to, dot, ref first);
                }
            }

            if (_btr != null && Shown(_btr))
            {
                Full(to, _btr, ref first);
            }

            foreach (var dot in Drops.Values)
            {
                if (Shown(dot))
                {
                    Full(to, dot, ref first);
                }
            }

            to.Append(']');
        }

        private static void Full(StringBuilder to, Dot dot, ref bool first)
        {
            if (!first)
            {
                to.Append(',');
            }

            first = false;
            to.Append("{\"id\":").Append(dot.Id);
            to.Append(",\"c\":");
            Text(to, dot.Kind);
            to.Append(",\"t\":");
            Text(to, dot.Text);
            to.Append(",\"p\":[");
            Number(to, dot.At.x);
            to.Append(',');
            Number(to, dot.At.z);
            to.Append(',');
            Number(to, dot.At.y);
            to.Append("],\"r\":");
            Number(to, dot.Yaw);
            if (dot.Player != null || dot.Moves)
            {
                to.Append(",\"dyn\":1");
            }

            if (dot.Exit != null)
            {
                to.Append(",\"st\":").Append(ExitState(dot.Exit));
            }

            if (dot.Secret)
            {
                to.Append(",\"sec\":1");
            }

            if (dot.Transit != null)
            {
                to.Append(",\"st\":").Append(TransitState(dot.Transit));
                to.Append(",\"to\":");
                Text(to, dot.To ?? "");
            }

            if (dot.ByPlayer)
            {
                to.Append(",\"kp\":1");
                // "kb": which player it was, so a page can tell its own player's kills from a friend's
                if (!string.IsNullOrEmpty(dot.Killer))
                {
                    to.Append(",\"kb\":");
                    Text(to, dot.Killer);
                }
            }

            if (!string.IsNullOrEmpty(dot.Profile))
            {
                to.Append(",\"pid\":");
                Text(to, dot.Profile);
            }
            else if (dot.Player != null && IsBot(dot.Player) && !string.IsNullOrEmpty(dot.Player.ProfileId))
            {
                // a living bot: what it carries is told by this id
                to.Append(",\"pid\":");
                Text(to, dot.Player.ProfileId);
            }
            else if (dot.Player != null && !string.IsNullOrEmpty(dot.Player.ProfileId))
            {
                // "u": a person's id in this raid, so the server can find a player in their Fika host's report
                to.Append(",\"u\":");
                Text(to, dot.Player.ProfileId);
            }

            // "was": the kind a body was; "g": the group a person or PMC is in; "lv": their level
            if (!string.IsNullOrEmpty(dot.Was))
            {
                to.Append(",\"was\":");
                Text(to, dot.Was);
            }

            if (!string.IsNullOrEmpty(dot.Group))
            {
                to.Append(",\"g\":");
                Text(to, dot.Group);
            }

            if (dot.Level > 0)
            {
                to.Append(",\"lv\":").Append(dot.Level);
            }
            else if (dot.BotLevel > 0)
            {
                to.Append(",\"bl\":").Append(dot.BotLevel);
            }

            // "sd": a person's or a PMC's side; "dn": a person who is down and can be got up again (Fika)
            if (!string.IsNullOrEmpty(dot.Side))
            {
                to.Append(",\"sd\":");
                Text(to, dot.Side);
            }

            if (dot.PlayerScav)
            {
                to.Append(",\"psc\":1");
            }

            if (dot.Person && dot.Player != null && FikaSide.Downed(dot.Player))
            {
                to.Append(",\"dn\":1");
            }

            // an airdrop. "box": its crate's id, which what's in it goes by; "fall": still coming down
            if (dot.Crate != null && !string.IsNullOrEmpty(dot.Crate.Id))
            {
                to.Append(",\"box\":");
                Text(to, dot.Crate.Id);
            }

            if (dot.Falling)
            {
                to.Append(",\"fall\":1");
            }

            // "hp": how hurt a person or a bot is, [now, when whole]
            if (dot.Player != null && Health.Of(dot.Player, out var hurt, out var whole))
            {
                to.Append(",\"hp\":[").Append(hurt).Append(',').Append(whole).Append(']');

                // "hb": while hurt, what each part of the body has left (head, chest, stomach, arms, legs)
                if (hurt < whole && Health.PartsOf(dot.Player, PartsNow))
                {
                    to.Append(",\"hb\":[");
                    for (var i = 0; i < PartsNow.Length; i++)
                    {
                        if (i > 0)
                        {
                            to.Append(',');
                        }

                        to.Append(PartsNow[i]);
                    }

                    to.Append(']');
                }
            }

            // "eh": somebody playing's energy and water
            if (dot.Person && dot.Player != null && Health.UpkeepOf(dot.Player, out var energy, out var water))
            {
                to.Append(",\"eh\":[").Append(energy).Append(',').Append(water).Append(']');
            }

            // a bot. "df": how hard; "ps": SAIN's personality; "ly": the brain layer deciding for it; "gh": parked
            // by ORBIT as a ghost; "ob": what ORBIT has it heading for; "cm": the move COMET has it making
            if (!BrainsOff && dot.Player != null)
            {
                if (!string.IsNullOrEmpty(dot.Difficulty))
                {
                    to.Append(",\"df\":");
                    Text(to, dot.Difficulty);
                }

                if (!string.IsNullOrEmpty(dot.Personality))
                {
                    to.Append(",\"ps\":");
                    Text(to, dot.Personality);
                }

                if (!string.IsNullOrEmpty(dot.Layer))
                {
                    to.Append(",\"ly\":");
                    Text(to, dot.Layer);
                }

                // "dc": what it has decided to do this moment (SAIN's decision, else the game's)
                if (!string.IsNullOrEmpty(dot.Decision))
                {
                    to.Append(",\"dc\":");
                    Text(to, dot.Decision);
                }

                if (dot.Ghost)
                {
                    to.Append(",\"gh\":1");
                }

                if (!string.IsNullOrEmpty(dot.Objective))
                {
                    to.Append(",\"ob\":");
                    Text(to, dot.Objective);
                }

                // why ORBIT has it leaving ("xr"), while it is
                if (!string.IsNullOrEmpty(dot.Leaving))
                {
                    to.Append(",\"xr\":");
                    Text(to, dot.Leaving);
                }

                if (!string.IsNullOrEmpty(dot.Tactic))
                {
                    to.Append(",\"cm\":");
                    Text(to, dot.Tactic);
                }

                // "bg": the band of bots it goes about with; "sq": what COMET has that squad doing together
                if (dot.Band != 0)
                {
                    to.Append(",\"bg\":").Append(dot.Band);
                }

                // "os": who says what it's after when ORBIT doesn't; "ch": one of PBT's cheaters
                if (!string.IsNullOrEmpty(dot.ObjectiveBy))
                {
                    to.Append(",\"os\":");
                    Text(to, dot.ObjectiveBy);
                }

                if (dot.Cheater)
                {
                    to.Append(",\"ch\":1");
                    // "chd": PBT's personality for it and the cheats it has, "personality|cheat,cheat"
                    if (!string.IsNullOrEmpty(dot.CheatSaid))
                    {
                        to.Append(",\"chd\":");
                        Text(to, dot.CheatSaid);
                    }
                }

                // "og": where ORBIT has it heading
                if (dot.HasHeading)
                {
                    to.Append(",\"og\":[");
                    Number(to, dot.HeadingX);
                    to.Append(',');
                    Number(to, dot.HeadingZ);
                    to.Append(',');
                    Number(to, dot.HeadingY);
                    to.Append(']');
                }

                if (dot.Squad != null)
                {
                    to.Append(",\"sq\":");
                    Brains.Write(to, dot.Squad, null);
                }
            }

            to.Append('}');
        }

        // only the ones that move: [[id,east,north,height,facing],...]
        internal static void MovingMarkers(StringBuilder to)
        {
            to.Append('[');
            var first = true;
            foreach (var dot in Players.Values)
            {
                Moving(to, dot, ref first);
            }

            if (_btr != null)
            {
                Moving(to, _btr, ref first);
            }

            foreach (var dot in Drops.Values)
            {
                Moving(to, dot, ref first);
            }

            to.Append(']');
        }

        private static void Moving(StringBuilder to, Dot dot, ref bool first)
        {
            if (!Shown(dot))
            {
                return;
            }

            if (!first)
            {
                to.Append(',');
            }

            first = false;
            to.Append('[');
            Whole(to, dot.Id);
            to.Append(',');
            Place(to, dot.At, dot.Yaw);
            to.Append(']');
        }
    }
}
