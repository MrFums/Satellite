using System;
using System.Collections.Generic;
using System.Reflection;
using EFT;
using UnityEngine;

namespace Satellite.Client
{
    // What a bot is like and what it's up to, asked of the mods that decide it: SAIN (its personality), ORBIT (whether
    // it's parked as a "ghost" far from every player, and what it's heading for) and the game's own brain (the layer
    // deciding for it right now, which BigBrain lets SAIN and ORBIT add theirs to) and COMET (the move it has the bot
    // making in a fight). None of the mods is needed: each is found by name once, and what isn't there is left out.
    internal static class Brains
    {
        private static bool _looked;
        private static MethodInfo _personality;
        private static MethodInfo _dormant;
        private static MethodInfo _objective;
        private static FieldInfo _category;
        private static FieldInfo _status;
        // why ORBIT has the bot (or its squad) leaving the raid: "loot ≥ 400k₽", "raid time low (300s left)" (a newer ORBIT)
        private static FieldInfo _extractReason;
        // where ORBIT has the bot heading
        private static FieldInfo _headingX;
        private static FieldInfo _headingY;
        private static FieldInfo _headingZ;
        // Pit FireTeam: whether a bot is one of the player's own team
        private static Func<string, bool> _teammate;
        // the same three, to call without the wrapping a call by name needs (it's asked of every bot, every second)
        private static Func<BotOwner, string> _personalityOf;
        private static Func<string, bool> _dormantIs;
        private static Func<string, object> _objectiveOf;
        // COMET's three: the move it has a bot making, as part of a squad's crossfire, and once the fight is over
        private static Func<string, string> _tactic;
        private static Func<string, string> _crossfire;
        private static Func<string, string> _after;
        private static string[] _mods = new string[0];

        private static T Direct<T>(MethodInfo method) where T : class
        {
            try
            {
                return method != null ? Delegate.CreateDelegate(typeof(T), method, false) as T : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static void Look()
        {
            if (_looked)
            {
                return;
            }

            _looked = true;
            try
            {
                foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
                {
                    var name = assembly.GetName().Name;
                    if (string.Equals(name, "SAIN", StringComparison.OrdinalIgnoreCase))
                    {
                        _personality = assembly.GetType("SAIN.Interop.SAINExternal")
                            ?.GetMethod("GetPersonality", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(BotOwner) }, null);
                    }
                    else if (string.Equals(name, "ORBIT", StringComparison.OrdinalIgnoreCase))
                    {
                        var telemetry = assembly.GetType("Orbit.Api.OrbitTelemetry");
                        _dormant = telemetry?.GetMethod("IsBotDormant", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(string) }, null);
                        _objective = telemetry?.GetMethod("GetBotObjective", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(string) }, null);
                        var objective = assembly.GetType("Orbit.Api.OrbitBotObjective");
                        _category = objective?.GetField("Category");
                        _status = objective?.GetField("Status");
                        _extractReason = objective?.GetField("ExtractReason");
                        _headingX = objective?.GetField("ObjectiveX");
                        _headingY = objective?.GetField("ObjectiveY");
                        _headingZ = objective?.GetField("ObjectiveZ");
                    }
                    else if (string.Equals(name, "pitFireTeam", StringComparison.OrdinalIgnoreCase))
                    {
                        _teammate = Direct<Func<string, bool>>(assembly.GetType("pitTeam.Modules.BossPlayers")
                            ?.GetMethod("IsFollowerProfileId", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(string) }, null));
                    }
                    else if (string.Equals(name, "COMET", StringComparison.OrdinalIgnoreCase))
                    {
                        var decisions = assembly.GetType("Comet.Api.Decisions");
                        _tactic = Direct<Func<string, string>>(Said(decisions, "GetCurrentDecision"));
                        _crossfire = Direct<Func<string, string>>(Said(decisions, "GetCrossfireDecision"));
                        _after = Direct<Func<string, string>>(Said(decisions, "GetPostCombatDecision"));
                        Listen(decisions);
                        CometLog.Bind(decisions);
                    }
                }
            }
            catch (Exception)
            {
                // neither, then
            }

            _personalityOf = Direct<Func<BotOwner, string>>(_personality);
            _dormantIs = Direct<Func<string, bool>>(_dormant);
            _objectiveOf = Direct<Func<string, object>>(_objective);
            var mods = new System.Collections.Generic.List<string>();
            if (_personality != null)
            {
                mods.Add("SAIN");
            }

            if (_dormant != null)
            {
                mods.Add("ORBIT");
            }

            if (_tactic != null)
            {
                mods.Add("COMET");
            }

            if (Objectives.Questing)
            {
                mods.Add("QuestingBots");
            }

            if (Objectives.Phobos)
            {
                mods.Add("Phobos");
            }

            _mods = mods.ToArray();
            Plugin.Log.LogInfo("Bot details: SAIN " + (_personality != null ? "found" : "not found")
                + ", ORBIT " + (_dormant != null ? "found" : "not found")
                + ", COMET " + (_tactic != null ? "found" + (_listener != null ? " (listening for its squads)" : " (no squad feed in this version)") : "not found"));
        }

        private static MethodInfo Said(Type decisions, string name)
        {
            return decisions?.GetMethod(name, BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(string) }, null);
        }

        // the mods found here that say something about a bot ("SAIN", "ORBIT", "COMET"): the page names only these
        internal static string[] Mods()
        {
            Look();
            return _mods;
        }

        // the move COMET has the bot making ("Push", "Hold", "CrossfireMoving", "PostCombatHealing"): null when
        // COMET isn't deciding for it (or always, without COMET)
        internal static string Tactic(string profileId)
        {
            Look();
            if (_tactic == null || string.IsNullOrEmpty(profileId))
            {
                return null;
            }

            try
            {
                var said = _crossfire != null ? _crossfire(profileId) : null;
                if (string.IsNullOrEmpty(said) && _after != null)
                {
                    said = _after(profileId);
                }

                if (string.IsNullOrEmpty(said))
                {
                    said = _tactic(profileId);
                }

                if (string.IsNullOrEmpty(said))
                {
                    return null;
                }

                said = said.StartsWith("COMET:", StringComparison.Ordinal) ? said.Substring(6) : said;
                return said.Length > 0 ? said : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        // ---- what a squad is doing together (COMET) ---------------------------------------------------------------
        // COMET says each decision it makes as a line of JSON to whoever listens (Comet.Api.Decisions.Published, on
        // the game's own thread, a few a second for each bot in a fight). Only the six about a squad acting together
        // are kept: S01 crossfire angles, S02 a second way in, S03 support and flank, S04 covering a teammate who is
        // busy, S05 answering a teammate's death, S06 the squad going in together. Each has a "crossfire" part: how
        // far along it is, whether COMET has the bot doing it yet ("applied") or only means to, the plan its squad
        // shares, who it's against and where the bot is sent. A newer COMET has two more, said as its other decisions
        // are (no "crossfire" part): S10 grenade suppression (one throws, the rest hold angles: "squadGrenade") and S11
        // a siege (each watches a way out of the building the enemy is in: "siege"). An older COMET says neither, and
        // all this is left alone without COMET.

        internal sealed class Squad
        {
            public string Feature;
            public string State;
            public string Role;
            public string Sub;
            public string Plan;
            public string Contact;
            public string AssaultReason;
            public string Mate;
            public string Key;
            public bool Applied;
            public bool Fire;
            public bool Ended;
            public bool HasGoal;
            public float X;
            public float Y;
            public float Z;
            public float At;
            // S10, S11: how long it holds without being said again (they're said as they start and end, not every
            // half second)
            public float Hold;
        }

        private const int MostHeard = 256;
        private const int MostLength = 32768;
        private static readonly System.Collections.Generic.Queue<string> Heard = new System.Collections.Generic.Queue<string>();
        private static readonly System.Collections.Generic.Dictionary<string, Squad> Squads = new System.Collections.Generic.Dictionary<string, Squad>();
        private static Action<string> _listener;
        private static bool _saidUnread;
        private static bool _saidHeard;

        internal static bool GestureEvents { get; private set; }

        private static void Listen(Type decisions)
        {
            try
            {
                var schema = decisions?.GetField("SchemaVersion", BindingFlags.Public | BindingFlags.Static);
                var published = decisions?.GetEvent("Published", BindingFlags.Public | BindingFlags.Static);
                if (schema == null || published == null || !(schema.GetRawConstantValue() is int version) || version != 1)
                {
                    return;
                }

                _listener = Hear;
                published.AddEventHandler(null, _listener);
                GestureEvents = decisions.GetField("GestureEventVersion", BindingFlags.Public | BindingFlags.Static)?.GetRawConstantValue() is int versionGestures && versionGestures >= 1;
            }
            catch (Exception)
            {
                // an older COMET, or a newer one that says it another way: each bot's own move is still read
                _listener = null;
            }
        }

        // COMET allows each listener a millisecond: the line is only looked at and put by, and read when a report
        // is made (Sort). Its "feature" is among the first things in it.
        private static void Hear(string json)
        {
            if (World.BrainsOff || json == null)
            {
                return;
            }

            var at = json.IndexOf("\"feature\":", 0, Math.Min(json.Length, 400), StringComparison.Ordinal);
            if (at < 0)
            {
                return;
            }

            at += 10;
            while (at < json.Length && json[at] == ' ')
            {
                at++;
            }

            // the squad ones (S01..S06, S10, S11), and W04: a bot going back for a magazine it dropped in a quick reload
            if (at + 4 >= json.Length || json[at] != '"')
            {
                return;
            }

            bool action = json.Length <= 2048 && (json.IndexOf("\"stage\":\"performed\"", at, Math.Min(120, json.Length - at), StringComparison.Ordinal) >= 0
                || json.IndexOf("\"stage\":\"activity-", at, Math.Min(120, json.Length - at), StringComparison.Ordinal) >= 0);
            if (!action && json[at + 1] == 'S' && json[at + 2] == '1' && (json[at + 3] == '0' || json[at + 3] == '1') && json[at + 4] == '"')
            {
                json = Cut(json, json[at + 3] == '0' ? "squadGrenade" : "siege");
                if (json == null)
                {
                    return;
                }
            }
            else if (!action && (json.Length > MostLength || !(json[at + 1] == 'S' && json[at + 2] == '0' || json[at + 1] == 'W' && json[at + 2] == '0' && json[at + 3] == '4')))
            {
                return;
            }

            lock (Heard)
            {
                if (Heard.Count >= MostHeard)
                {
                    Heard.Dequeue();
                }

                Heard.Enqueue(json);
            }

            // once a game: so the log shows that COMET does say what its squads do, when the map shows nothing of it
            if (!_saidHeard)
            {
                _saidHeard = true;
                Plugin.Log.LogInfo("COMET's first squad decision heard.");
            }
        }

        // An S10 or S11 decision cut down to what's read of it: its feature, stage, when, whose, what and the tactic's
        // own part (a flat object), found by where COMET puts them (whose and what come after its config). Null when
        // it isn't said that way.
        private static string Cut(string json, string part)
        {
            var whose = json.IndexOf("\"profileId\":", StringComparison.Ordinal);
            if (whose < 0)
            {
                return null;
            }

            var cut = new System.Text.StringBuilder(256).Append('{');
            Keep(cut, json, "feature", 0);
            Keep(cut, json, "stage", 0);
            Keep(cut, json, "session", 0);
            Keep(cut, json, "realtime", 0);
            Keep(cut, json, "profileId", whose);
            Keep(cut, json, "name", whose);
            Keep(cut, json, "decision", whose);
            var from = json.IndexOf("\"" + part + "\":{", whose, StringComparison.Ordinal);
            var to = from < 0 ? -1 : json.IndexOf('}', from);
            if (to > from && to - from < 2048)
            {
                cut.Append(json, from, to - from + 1).Append(',');
            }

            cut.Length--;
            return cut.Append('}').ToString();
        }

        // "name":value (a string or a number), the first after from, onto what's kept
        private static void Keep(System.Text.StringBuilder to, string json, string name, int from)
        {
            var at = json.IndexOf("\"" + name + "\":", from, StringComparison.Ordinal);
            if (at < 0)
            {
                return;
            }

            var start = at + name.Length + 3;
            var end = start;
            if (end < json.Length && json[end] == '"')
            {
                for (end++; end < json.Length && json[end] != '"'; end++)
                {
                    if (json[end] == '\\')
                    {
                        end++;
                    }
                }

                end++;
            }
            else
            {
                while (end < json.Length && json[end] != ',' && json[end] != '}')
                {
                    end++;
                }
            }

            if (end <= json.Length && end - start < 512)
            {
                to.Append(json, at, end - at).Append(',');
            }
        }

        // Grenade suppression (S10: "Grenade suppression - throw" or "- hold angle") and a siege (S11: "Siege - watch
        // exit"), as a squad tactic like the rest: on from when it's picked ("selected") until it's let go
        private static void Tactic(Newtonsoft.Json.Linq.JObject said, string profileId, string feature, float when)
        {
            var stage = Word(said, "stage");
            var decision = Word(said, "decision");
            var part = Part(said, feature == "S10" ? "squadGrenade" : "siege");
            var over = stage == "released" || stage == "rejected";
            if (!over && stage != "selected" && stage != "accepted" && stage != "started")
            {
                return;
            }

            var contact = part == null ? "" : feature == "S10" ? Word(part, "contact") : Word(part, "target");
            var thrower = feature == "S10" && part != null ? Word(part, "thrower") : "";
            var mate = "";
            if (thrower.Length > 0 && thrower != profileId)
            {
                World.Names.TryGetValue(thrower, out mate);
            }

            var squad = new Squad
            {
                Feature = feature,
                State = over ? "ended" : "active",
                Applied = !over,
                Ended = over,
                At = when,
                Hold = feature == "S10" ? 12f : 60f,
                Contact = contact,
                Mate = mate ?? "",
                Role = decision.IndexOf("throw", StringComparison.OrdinalIgnoreCase) >= 0 ? "throw"
                    : decision.IndexOf("hold", StringComparison.OrdinalIgnoreCase) >= 0 ? "hold"
                    : decision.IndexOf("exit", StringComparison.OrdinalIgnoreCase) >= 0 ? "watch" : "",
                Sub = part != null && feature == "S11" ? Word(part, "exit") : "",
                // (the squad's members share it by who it's against)
                Plan = contact.Length > 0 ? feature + ":" + contact : "",
            };
            Told(said, profileId, squad, when);
        }

        // a new raid: nothing said in the last one stands
        internal static void Forget()
        {
            lock (Heard)
            {
                Heard.Clear();
            }

            Squads.Clear();
            MagStages.Clear();
        }

        // Reads what COMET has said since the last report. Called before the markers of a full report are written.
        internal static void Sort()
        {
            while (true)
            {
                string json;
                lock (Heard)
                {
                    if (Heard.Count == 0)
                    {
                        return;
                    }

                    json = Heard.Dequeue();
                }

                try
                {
                    Read(json);
                }
                catch (Exception e)
                {
                    if (!_saidUnread)
                    {
                        _saidUnread = true;
                        Plugin.Log.LogWarning("Couldn't read what COMET said about a squad (said once): " + e.Message);
                    }
                }
            }
        }

        private static string Word(Newtonsoft.Json.Linq.JToken from, string name)
        {
            var value = from != null && from.Type == Newtonsoft.Json.Linq.JTokenType.Object ? from[name] : null;
            return value != null && value.Type == Newtonsoft.Json.Linq.JTokenType.String ? (string)value : "";
        }

        private static bool Flag(Newtonsoft.Json.Linq.JToken from, string name)
        {
            var value = from != null && from.Type == Newtonsoft.Json.Linq.JTokenType.Object ? from[name] : null;
            return value != null && value.Type == Newtonsoft.Json.Linq.JTokenType.Boolean && (bool)value;
        }

        private static bool Amount(Newtonsoft.Json.Linq.JToken from, string name, out float amount)
        {
            amount = 0f;
            var value = from != null && from.Type == Newtonsoft.Json.Linq.JTokenType.Object ? from[name] : null;
            if (value == null || (value.Type != Newtonsoft.Json.Linq.JTokenType.Float && value.Type != Newtonsoft.Json.Linq.JTokenType.Integer))
            {
                return false;
            }

            amount = (float)value;
            return !float.IsNaN(amount) && !float.IsInfinity(amount);
        }

        private static Newtonsoft.Json.Linq.JToken Part(Newtonsoft.Json.Linq.JToken from, string name)
        {
            var value = from[name];
            return value != null && value.Type == Newtonsoft.Json.Linq.JTokenType.Object ? value : null;
        }

        private static void Read(string json)
        {
            Newtonsoft.Json.Linq.JObject said;
            using (var text = new System.IO.StringReader(json))
            using (var reader = new Newtonsoft.Json.JsonTextReader(text) { DateParseHandling = Newtonsoft.Json.DateParseHandling.None, MaxDepth = 64 })
            {
                said = Newtonsoft.Json.Linq.JObject.Load(reader);
            }

            var profileId = Word(said, "profileId");
            var feature = Word(said, "feature");
            var stage = Word(said, "stage");
            bool activity = stage == "activity-start" || stage == "activity-end";
            if ((stage == "performed" || activity) && profileId.Length > 0 && Amount(said, "realtime", out var performed))
            {
                var gesture = Word(said, "decision");
                if (gesture.Length > 0)
                    Events.Add(activity ? "comet.activity" : "comet.gesture", profileId, Word(said, "name"), performed, to =>
                    {
                        to.Append("{\"action\":");
                        World.Text(to, gesture);
                        if (activity) to.Append(stage == "activity-start" ? ",\"active\":true" : ",\"active\":false");
                        to.Append('}');
                    });
                return;
            }
            if (feature == "W04")
            {
                Magazine(said, profileId);
                return;
            }

            if ((feature == "S10" || feature == "S11") && profileId.Length > 0 && Amount(said, "realtime", out var told))
            {
                Tactic(said, profileId, feature, told);
                return;
            }

            var crossfire = Part(said, "crossfire");
            if (profileId.Length == 0 || feature.Length != 3 || crossfire == null || !Amount(said, "realtime", out var when))
            {
                return;
            }

            var storm = Part(crossfire, "storm");
            var trade = Part(crossfire, "trade");
            var cover = Part(crossfire, "coverMate");
            var maneuver = Part(crossfire, "maneuver");
            var entrance = Part(crossfire, "entrance");
            var squad = new Squad
            {
                Feature = feature,
                State = Word(crossfire, "state"),
                Applied = Flag(crossfire, "applied"),
                Contact = Word(crossfire, "contact"),
                AssaultReason = feature == "S06" ? AssaultReason(storm) : null,
                At = when,
                Role = maneuver != null ? Word(maneuver, "role") : trade != null ? Word(trade, "choice") : "",
                Sub = storm != null ? Word(storm, "status") : trade != null ? Word(trade, "status") : cover != null ? Word(cover, "status")
                    : maneuver != null ? Word(maneuver, "state") : entrance != null ? Word(entrance, "state") : "",
                Plan = maneuver != null ? Word(maneuver, "plan") : storm != null ? Word(storm, "plan") : "",
                Mate = cover != null ? Word(cover, "mateName") : trade != null ? Word(trade, "mateName")
                    : maneuver != null ? Word(maneuver, "supportName") : Word(crossfire, "supportName"),
                Fire = maneuver != null && Word(maneuver, "fireState") == "observed suppression fire",
            };
            squad.Ended = squad.State == "ended" || (maneuver != null && Word(maneuver, "state") == "ended")
                || (storm != null && Word(storm, "state") == "ended");
            if (Amount(crossfire, "goalX", out var x) && Amount(crossfire, "goalY", out var y) && Amount(crossfire, "goalZ", out var z))
            {
                squad.HasGoal = true;
                squad.X = x;
                squad.Y = y;
                squad.Z = z;
            }

            Told(said, profileId, squad, when);
        }

        private static string AssaultReason(Newtonsoft.Json.Linq.JToken storm)
        {
            if (storm == null || Word(storm, "reason") != "storm-weak-enemy")
            {
                return null;
            }

            if (storm["evidence"] is Newtonsoft.Json.Linq.JArray evidence)
            {
                // A storm can have several contributing clues. Prefer a specific, recorded observation.
                bool hurt = false, alone = false;
                string busy = null;
                foreach (var clue in evidence)
                {
                    if (clue.Type != Newtonsoft.Json.Linq.JTokenType.String) continue;
                    switch ((string)clue)
                    {
                        case "badly hurt": case "dying": hurt = true; break;
                        case "alone": alone = true; break;
                        case "busy (Reloading)": busy = "reload"; break;
                        case "busy (Healing)": case "busy (UsingSurgery)": busy = "heal"; break;
                        case "busy (Looting)": busy = "loot"; break;
                        case "busy (TryingToExtract)": busy = "extract"; break;
                        case "busy (HasGrenade)": busy = "grenade"; break;
                    }
                }
                if (hurt) return "hurt";
                if (busy != null) return busy;
                if (alone) return "alone";
            }

            return "vulnerable";
        }

        private static void Told(Newtonsoft.Json.Linq.JObject said, string profileId, Squad squad, float when)
        {
            squad.Key = squad.Feature + "|" + squad.State + "|" + squad.Applied + "|" + squad.Role + "|" + squad.Sub + "|" + squad.Plan + "|" + squad.Fire + "|" + squad.AssaultReason;
            Squads.TryGetValue(profileId, out var before);
            Squads[profileId] = squad;
            // an event only when it changed, and not for what was said long ago while nobody was looking
            if ((before == null || before.Key != squad.Key) && UnityEngine.Time.realtimeSinceStartup - when < 10f)
            {
                var session = Word(said, "session");
                Events.Add("comet.squad", profileId, Word(said, "name"), when, to => Write(to, squad, session));
            }
        }

        // A magazine a bot dropped in a quick reload, and its going back for it (COMET's W04 "RecoverMagazine"): said as
        // an event ("comet.mag") each time it moves on a stage: {"st":"queued"|"started"|"arrived"|"pickup-wait"|
        // "pickup-started"|"pickup-ready"|"completed"|"failed"|"interrupted"|"unavailable","id":the magazine's item id,
        // "i":its name,"tpl":its template,"at":[east,north,height] where it lies}. A page keeps it on the ground until
        // it's picked up (completed, unavailable).
        private static readonly System.Collections.Generic.Dictionary<string, string> MagStages = new System.Collections.Generic.Dictionary<string, string>();

        private static void Magazine(Newtonsoft.Json.Linq.JObject said, string profileId)
        {
            var mag = Part(said, "magazineRecovery");
            var stage = Word(said, "stage");
            var id = mag != null ? Word(mag, "magazine") : "";
            if (Word(said, "decision") != "RecoverMagazine" || id.Length == 0 || stage.Length == 0 || !Amount(said, "realtime", out var when)
                || (MagStages.TryGetValue(id, out var was) && was == stage) || UnityEngine.Time.realtimeSinceStartup - when > 10f)
            {
                return;
            }

            if (MagStages.Count > 512)
            {
                MagStages.Clear();
            }

            MagStages[id] = stage;
            var name = Word(mag, "itemName");
            var tpl = Word(mag, "template");
            var hasAt = Amount(mag, "x", out var x) & Amount(mag, "y", out var y) & Amount(mag, "z", out var z);
            Events.Add("comet.mag", profileId, Word(said, "name"), when, to =>
            {
                to.Append("{\"st\":");
                World.Text(to, stage);
                to.Append(",\"id\":");
                World.Text(to, id);
                if (name.Length > 0)
                {
                    to.Append(",\"i\":");
                    World.Text(to, name);
                }

                if (tpl.Length > 0)
                {
                    to.Append(",\"tpl\":");
                    World.Text(to, tpl);
                }

                if (hasAt)
                {
                    // the game's x, z and y: east, north, height
                    to.Append(",\"at\":[");
                    World.Number(to, x);
                    to.Append(',');
                    World.Number(to, z);
                    to.Append(',');
                    World.Number(to, y);
                    to.Append(']');
                }

                to.Append('}');
            });
        }

        // what the bot's squad has it doing now: null when COMET has said nothing lately, or that it's over
        internal static Squad SquadOf(string profileId)
        {
            if (_listener == null || string.IsNullOrEmpty(profileId) || !Squads.TryGetValue(profileId, out var squad) || squad.Ended)
            {
                return null;
            }

            // said again every half second while the bot is doing it, and once at each change otherwise (grenade
            // suppression and a siege only as they start and end: held as long as they're likely to last)
            if (UnityEngine.Time.realtimeSinceStartup - squad.At < (squad.Hold > 0f ? squad.Hold : 2.5f))
            {
                return squad;
            }

            try
            {
                return squad.Applied && _crossfire != null && !string.IsNullOrEmpty(_crossfire(profileId)) ? squad : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        // {"f":"S03","s":"moving","a":1,"r":"flank","u":"active","p":"<plan>","c":"<profile id it's against>",
        //  "m":"<teammate's name>","x":1,"g":[east,north,height]}: "a" COMET has the bot doing it, "x" it's laying
        // down fire, "g" where it's sent; session: COMET's own name for the raid, said with an event only
        internal static void Write(System.Text.StringBuilder to, Squad squad, string session)
        {
            to.Append("{\"f\":");
            World.Text(to, squad.Feature);
            to.Append(",\"s\":");
            World.Text(to, squad.State);
            if (squad.Applied)
            {
                to.Append(",\"a\":1");
            }

            if (!string.IsNullOrEmpty(squad.Role))
            {
                to.Append(",\"r\":");
                World.Text(to, squad.Role);
            }

            if (!string.IsNullOrEmpty(squad.Sub))
            {
                to.Append(",\"u\":");
                World.Text(to, squad.Sub);
            }

            if (!string.IsNullOrEmpty(squad.Plan))
            {
                to.Append(",\"p\":");
                World.Text(to, squad.Plan);
            }

            if (!string.IsNullOrEmpty(squad.Contact))
            {
                to.Append(",\"c\":");
                World.Text(to, squad.Contact);
            }

            if (!string.IsNullOrEmpty(squad.Mate))
            {
                to.Append(",\"m\":");
                World.Text(to, squad.Mate);
            }

            if (!string.IsNullOrEmpty(squad.AssaultReason))
            {
                to.Append(",\"why\":");
                World.Text(to, squad.AssaultReason);
            }

            if (squad.Fire)
            {
                to.Append(",\"x\":1");
            }

            if (squad.HasGoal)
            {
                to.Append(",\"g\":[");
                World.Number(to, squad.X);
                to.Append(',');
                World.Number(to, squad.Z);
                to.Append(',');
                World.Number(to, squad.Y);
                to.Append(']');
            }

            if (!string.IsNullOrEmpty(session))
            {
                to.Append(",\"cs\":");
                World.Text(to, session);
            }

            to.Append('}');
        }

        // "Chad", "Rat"...: null until SAIN has made its mind up about this bot (or always, without SAIN)
        internal static string Personality(BotOwner bot)
        {
            Look();
            if (_personality == null || bot == null)
            {
                return null;
            }

            try
            {
                var said = _personalityOf != null ? _personalityOf(bot) : _personality.Invoke(null, new object[] { bot }) as string;
                return string.IsNullOrEmpty(said) ? null : said;
            }
            catch (Exception)
            {
                return null;
            }
        }

        // parked by ORBIT: far from every player, its body and brain switched off, moved along its way as a "ghost"
        internal static bool Ghost(string profileId)
        {
            Look();
            if (_dormant == null || string.IsNullOrEmpty(profileId))
            {
                return false;
            }

            try
            {
                return _dormantIs != null ? _dormantIs(profileId) : (bool)_dormant.Invoke(null, new object[] { profileId });
            }
            catch (Exception)
            {
                return false;
            }
        }

        // what ORBIT has it heading for ("Loot", "AirdropLoot", a rush plan's step), and how far along it is
        // why ORBIT has it leaving the raid, when it does: "" or null otherwise (and with an ORBIT that doesn't say)
        internal static string Leaving(string profileId)
        {
            Look();
            if (_objective == null || _extractReason == null || string.IsNullOrEmpty(profileId))
            {
                return null;
            }

            try
            {
                var objective = _objectiveOf != null ? _objectiveOf(profileId) : _objective.Invoke(null, new object[] { profileId });
                return objective != null ? _extractReason.GetValue(objective) as string : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        internal static string Objective(string profileId)
        {
            Look();
            if (_objective == null || _category == null || string.IsNullOrEmpty(profileId))
            {
                return null;
            }

            try
            {
                var objective = _objectiveOf != null ? _objectiveOf(profileId) : _objective.Invoke(null, new object[] { profileId });
                if (objective == null)
                {
                    return null;
                }

                var category = _category.GetValue(objective) as string;
                var status = _status != null ? _status.GetValue(objective) as string : null;
                if (string.IsNullOrEmpty(category))
                {
                    return null;
                }

                return string.IsNullOrEmpty(status) ? category : category + " (" + status + ")";
            }
            catch (Exception)
            {
                return null;
            }
        }

        // where ORBIT has the bot heading (the place its objective is at): false when it has none, or without ORBIT
        internal static bool Heading(string profileId, out float x, out float y, out float z)
        {
            x = y = z = 0f;
            Look();
            if (_objective == null || _headingX == null || _headingY == null || _headingZ == null || string.IsNullOrEmpty(profileId))
            {
                return false;
            }

            try
            {
                var objective = _objectiveOf != null ? _objectiveOf(profileId) : _objective.Invoke(null, new object[] { profileId });
                if (objective == null)
                {
                    return false;
                }

                x = Convert.ToSingle(_headingX.GetValue(objective));
                y = Convert.ToSingle(_headingY.GetValue(objective));
                z = Convert.ToSingle(_headingZ.GetValue(objective));
                return (x != 0f || y != 0f || z != 0f) && !float.IsNaN(x) && !float.IsNaN(y) && !float.IsNaN(z);
            }
            catch (Exception)
            {
                return false;
            }
        }

        // one of the player's own team of bots (Pit FireTeam): always false without that mod
        internal static bool Teammate(string profileId)
        {
            Look();
            if (_teammate == null || string.IsNullOrEmpty(profileId))
            {
                return false;
            }

            try
            {
                return _teammate(profileId);
            }
            catch (Exception)
            {
                return false;
            }
        }

        // What the bot has decided to do this moment, finer than its layer: SAIN's own decision when SAIN has one
        // ("SAIN:Search", "SAIN:ThrowGrenade", "SAIN:FirstAid"), else the game's ("simplePatrol", "heal",
        // "throwGrenadeFromPlace"). A raid's behaviour chart is drawn from these.
        private static bool _sainLooked;
        private static Type _sainBot;
        private static readonly Dictionary<string, Component> SainBots = new Dictionary<string, Component>();
        private static readonly string[] SainDecisions = { "CurrentSelfDecision", "CurrentCombatDecision", "CurrentSquadDecision" };

        internal static void ForgetDecisions()
        {
            SainBots.Clear();
        }

        internal static string Decision(Player player, BotOwner bot)
        {
            try
            {
                if (!_sainLooked)
                {
                    _sainLooked = true;
                    _sainBot = Types.Find("SAIN.Components.BotComponent");
                }

                if (_sainBot != null && player != null && !string.IsNullOrEmpty(player.ProfileId))
                {
                    if (!SainBots.TryGetValue(player.ProfileId, out var sain) || sain == null)
                    {
                        sain = player.gameObject.GetComponent(_sainBot);
                        SainBots[player.ProfileId] = sain;
                    }

                    var decision = sain != null ? Hooks.Get(sain, "Decision") : null;
                    if (decision != null)
                    {
                        foreach (var name in SainDecisions)
                        {
                            var said = Convert.ToString(Hooks.Get(decision, name));
                            if (!string.IsNullOrEmpty(said) && said != "None" && said != "0")
                            {
                                return "SAIN:" + said;
                            }
                        }
                    }
                }

                var last = bot != null && bot.Brain != null ? Hooks.Get(bot.Brain, "LastDecision") : null;
                return last != null ? last.ToString() : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        // the brain layer deciding for the bot now: "SAIN : Combat Layer", "OrbitBrainLayer", or one of the game's own
        internal static string Layer(BotOwner bot)
        {
            try
            {
                return bot != null && bot.Brain != null ? bot.Brain.ActiveLayerName() : null;
            }
            catch (Exception)
            {
                return null;
            }
        }
    }
}
