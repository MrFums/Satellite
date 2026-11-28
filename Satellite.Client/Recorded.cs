using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using Comfort.Common;
using EFT;
using EFT.Interactive;
using HarmonyLib;
using UnityEngine;

namespace Satellite.Client
{
    // What a raid's recording needs beyond where everybody is (see the server's Recorder): each said once, as an event.
    //   "switch"      a switch and how it stands: {"id","nm":its name,"st":"Open"|"Shut"|..,"at":[east,north,height]},
    //                 every one as the raid begins, and again whenever one changes
    //   "end"         the player's raid is over: {"st":"Survived"|"Killed"|..,"ex":the extract's name}
    //   "left"        a bot left the raid alive (it extracted): {"wk":what kind it was,"at":[..]}
    //   "orbit.main"  what each ORBIT squad is out to do, whenever that changes: {"s":ORBIT's own snapshot}
    //   "orbit.field" ORBIT's field over the map, every two minutes: {"s":ORBIT's own snapshot}
    //   "door"        a door opened, shut or unlocked: {"id","nm":its name,"st":how it stands now,"was":before,
    //                 "at":[..]}, whose: the nearest one alive within DoorReach of it (with nobody that near, not told)
    // ORBIT's snapshots are passed on as they are (every public field, by its own name), so a newer ORBIT's are
    // recorded whole without this plugin knowing them; places in them are the game's own x, y (height), z.
    internal static class Recorded
    {
        private const BindingFlags Any = BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;

        // ---- switches ----
        private static GameWorld _world;
        private static readonly Dictionary<WorldInteractiveObject, string> Switches = new Dictionary<WorldInteractiveObject, string>();
        private static bool _switchesFailed;
        private static readonly Dictionary<WorldInteractiveObject, string> Doors = new Dictionary<WorldInteractiveObject, string>();
        // how each door last stood still (Locked, Shut or Open): what it was before a change, as the game's own "before"
        // is only the moment in between (Interacting), so an unlock would look like a door shut
        private static readonly Dictionary<WorldInteractiveObject, EDoorState> DoorStood = new Dictionary<WorldInteractiveObject, EDoorState>();
        private const float DoorReach = 4f;

        // called with every report of a raid that's watched or recorded
        internal static void Tick()
        {
            var world = Singleton<GameWorld>.Instance;
            if (world == null || !World.Watched)
            {
                return;
            }

            if (world != _world)
            {
                Forget();
                _world = world;
                FindSwitches();
            }

            Orbit();
            Pickups.Flush();
            FikaSide.Look();
            PhobosField();
        }

        // Somebody playing is gone from the raid without dying: {"wk":their kind,"at":[..],"x":1 when Fika says they
        // extracted (else they only left: a disconnect, say)}
        internal static void PersonLeft(Player player, string name, string kind, Vector3 at)
        {
            try
            {
                var who = !ReferenceEquals(player, null) ? player.ProfileId : null;
                if (string.IsNullOrEmpty(who))
                {
                    return;
                }

                var extracted = FikaSide.Extracted(player);
                Events.Add("left", who, name, Time.realtimeSinceStartup, to =>
                {
                    to.Append("{\"wk\":");
                    World.Text(to, kind ?? "");
                    to.Append(extracted ? ",\"x\":1" : ",\"x\":0");
                    World.Spot(to, "at", at);
                    to.Append('}');
                });
            }
            catch (Exception)
            {
                // not told
            }
        }

        // ---- Phobos's field over the map, every two minutes: {"s":{GridCols, GridRows, WorldMinX, WorldMinZ,
        // CellSize, Advection:[{X,Y,Fx,Fz}], Convergence:[..], Zones:[{X,Y,Radius,Force,Decay}]}}, named as ORBIT's is
        private static float _phobosAt = -1000f;

        private static void PhobosField()
        {
            var now = Time.realtimeSinceStartup;
            if (World.BrainsOff || now - _phobosAt < 120f)
            {
                return;
            }

            _phobosAt = now;
            try
            {
                var system = Hooks.Get(Objectives.PhobosManager(), "LocationSystem");
                if (system == null || !(Hooks.Get(system, "GridSize") is Vector2Int grid) || !(Hooks.Get(system, "WorldMin") is Vector2 low))
                {
                    return;
                }

                var text = new StringBuilder(8192);
                text.Append("{\"GridCols\":").Append(grid.x).Append(",\"GridRows\":").Append(grid.y).Append(",\"WorldMinX\":");
                Number(text, low.x);
                text.Append(",\"WorldMinZ\":");
                Number(text, low.y);
                text.Append(",\"CellSize\":");
                Number(text, Hooks.Float(system, "CellSize"));
                text.Append(",\"Advection\":");
                Cells(text, Hooks.Get(system, "AdvectionField") as Array, grid);
                text.Append(",\"Convergence\":");
                Cells(text, Hooks.Get(system, "ConvergenceField") as Array, grid);
                text.Append(",\"Zones\":[");
                var count = 0;
                if (Hooks.Get(system, "Zones") is IEnumerable zones)
                {
                    foreach (var zone in zones)
                    {
                        if (zone == null || !(Hooks.Get(zone, "Coords") is Vector2Int at) || count >= 500)
                        {
                            continue;
                        }

                        text.Append(count++ > 0 ? "," : "").Append("{\"X\":").Append(at.x).Append(",\"Y\":").Append(at.y).Append(",\"Radius\":");
                        Number(text, Hooks.Float(zone, "Radius"));
                        text.Append(",\"Force\":");
                        Number(text, Hooks.Float(zone, "Force"));
                        text.Append(",\"Decay\":");
                        Number(text, Hooks.Float(zone, "Decay"));
                        text.Append('}');
                    }
                }

                text.Append("]}");
                if (text.Length > 300_000)
                {
                    return;
                }

                var said = text.ToString();
                Events.Add("phobos.field", null, null, now, to => to.Append("{\"s\":").Append(said).Append('}'));
            }
            catch (Exception)
            {
                // not this time
            }
        }

        private static void Cells(StringBuilder to, Array field, Vector2Int grid)
        {
            to.Append('[');
            var count = 0;
            if (field != null && field.Rank == 2)
            {
                for (var x = 0; x < grid.x && x < field.GetLength(0); x++)
                {
                    for (var y = 0; y < grid.y && y < field.GetLength(1); y++)
                    {
                        if (!(field.GetValue(x, y) is Vector2 v) || v.sqrMagnitude < 0.0001f || count >= 6000)
                        {
                            continue;
                        }

                        to.Append(count++ > 0 ? "," : "").Append("{\"X\":").Append(x).Append(",\"Y\":").Append(y).Append(",\"Fx\":");
                        Number(to, v.x);
                        to.Append(",\"Fz\":");
                        Number(to, v.y);
                        to.Append('}');
                    }
                }
            }

            to.Append(']');
        }

        // The player's raid is over: the switches and doors let go of at once, not when the next raid begins, so the
        // game's clean-up after the raid finds nothing of it held here. (The world is kept, so they aren't looked for
        // again in the raid that's ending.)
        internal static void Release()
        {
            Unhook(Switches, SwitchChanged);
            Unhook(Doors, DoorChanged);
            Things.Release();
        }

        private static void Unhook(Dictionary<WorldInteractiveObject, string> all, WorldInteractiveObjectInteract changed)
        {
            foreach (var one in all.Keys)
            {
                try
                {
                    if (one != null)
                    {
                        one.OnDoorStateChanged -= changed;
                    }
                }
                catch (Exception)
                {
                    // gone with its scene
                }
            }

            all.Clear();
        }

        internal static void Forget()
        {
            _phobosAt = -1000f;
            foreach (var one in Switches.Keys)
            {
                try
                {
                    if (one != null)
                    {
                        one.OnDoorStateChanged -= SwitchChanged;
                    }
                }
                catch (Exception)
                {
                    // gone with its scene
                }
            }

            Switches.Clear();
            foreach (var one in Doors.Keys)
            {
                try
                {
                    if (one != null)
                    {
                        one.OnDoorStateChanged -= DoorChanged;
                    }
                }
                catch (Exception)
                {
                    // gone with its scene
                }
            }

            Doors.Clear();
            DoorStood.Clear();
            _world = null;
            _mainRevision = int.MinValue;
            _fieldAt = -1000f;
        }

        // a room's light switch, by its id or name ("switch_custom_Light_00012"), as the page tells them too
        private static readonly System.Text.RegularExpressions.Regex LightSwitch =
            new System.Text.RegularExpressions.Regex("(^|[^a-z])lights?([^a-z]|$)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);

        private static void FindSwitches()
        {
            if (_switchesFailed)
            {
                return;
            }

            try
            {
                // (asked for by the type the game keeps them under: asked for as Switch, nothing comes back)
                foreach (var one in LocationScene.GetAllObjects<WorldInteractiveObject>(true))
                {
                    // a door: told only when somebody opens, shuts or unlocks it (at most 1500 a map)
                    if (one is Door && !Doors.ContainsKey(one) && Doors.Count < 1500)
                    {
                        Doors[one] = string.IsNullOrEmpty(one.Id) ? "i" + one.GetInstanceID() : one.Id;
                        DoorStood[one] = one.DoorState;
                        one.OnDoorStateChanged += DoorChanged;
                        continue;
                    }

                    if (!(one is Switch) || one == null || Switches.ContainsKey(one))
                    {
                        continue;
                    }

                    // (a room's light switch isn't one anybody looks for: Customs alone has 76. Only power switches, levers,
                    // extract and door switches, alarms and buttons, 150 at most)
                    var id = string.IsNullOrEmpty(one.Id) ? "i" + one.GetInstanceID() : one.Id;
                    if (LightSwitch.IsMatch(id) || LightSwitch.IsMatch(one.name ?? "") || Switches.Count >= 150)
                    {
                        continue;
                    }

                    Switches[one] = id;
                    one.OnDoorStateChanged += SwitchChanged;
                    Said(one, id, one.DoorState);
                }
            }
            catch (Exception e)
            {
                _switchesFailed = true;
                Plugin.Log.LogWarning($"Switches aren't recorded: {e.Message}");
            }
        }

        private static void SwitchChanged(WorldInteractiveObject one, EDoorState before, EDoorState after)
        {
            try
            {
                if (one != null && before != after && Switches.TryGetValue(one, out var id))
                {
                    Said(one, id, after);
                }
            }
            catch (Exception)
            {
                // not told
            }
        }

        private static void DoorChanged(WorldInteractiveObject one, EDoorState before, EDoorState after)
        {
            try
            {
                // (the moments in between, interacting and being breached, aren't told: only where it ends up, against
                // where it last stood: Locked to Shut or Open is an unlock)
                if (one == null || !Doors.TryGetValue(one, out var id) || _world == null)
                {
                    return;
                }

                if (after == EDoorState.Locked)
                {
                    DoorStood[one] = after;
                    return;
                }

                if (!(after == EDoorState.Open || after == EDoorState.Shut))
                {
                    return;
                }

                var stood = DoorStood.TryGetValue(one, out var last) ? last : before;
                DoorStood[one] = after;
                if (stood == after)
                {
                    return;
                }

                before = stood;

                var at = one.transform.position;
                string who = null;
                var best = DoorReach * DoorReach;
                foreach (var player in _world.AllAlivePlayersList)
                {
                    if (player == null)
                    {
                        continue;
                    }

                    var d = (player.Position - at).sqrMagnitude;
                    if (d < best)
                    {
                        best = d;
                        who = player.ProfileId;
                    }
                }

                // (nobody by it: the map moving its own doors, not news)
                if (who == null)
                {
                    return;
                }

                World.Names.TryGetValue(who, out var name);

                var doorName = one.name ?? "";
                var now = after.ToString();
                var was = before.ToString();
                Events.Add("door", who, name, Time.realtimeSinceStartup, to =>
                {
                    to.Append("{\"id\":");
                    World.Text(to, id);
                    to.Append(",\"nm\":");
                    World.Text(to, doorName);
                    to.Append(",\"st\":");
                    World.Text(to, now);
                    to.Append(",\"was\":");
                    World.Text(to, was);
                    World.Spot(to, "at", at);
                    to.Append('}');
                });
            }
            catch (Exception)
            {
                // not told
            }
        }

        private static void Said(WorldInteractiveObject one, string id, EDoorState state)
        {
            var at = one.transform.position;
            var name = one.name ?? "";
            var stands = state.ToString();
            Events.Add("switch", null, null, Time.realtimeSinceStartup, to =>
            {
                to.Append("{\"id\":");
                World.Text(to, id);
                to.Append(",\"nm\":");
                World.Text(to, name);
                to.Append(",\"st\":");
                World.Text(to, stands);
                World.Spot(to, "at", at);
                to.Append('}');
            });
        }

        // ---- the raid's end, and bots that leave it alive ----
        private static FieldInfo _leaver;

        internal static void Hook(Harmony harmony)
        {
            try
            {
                var sight = AccessTools.Method(typeof(EnemyInfo), nameof(EnemyInfo.SetVisible), new[] { typeof(bool) });
                harmony.Patch(sight, prefix: new HarmonyMethod(typeof(Recorded), nameof(BeforeSight)),
                    postfix: new HarmonyMethod(typeof(Recorded), nameof(AfterSight)));
            }
            catch (Exception e)
            {
                Plugin.Log.LogWarning($"Bot sightings are unavailable: {e.Message}");
            }

            try
            {
                var end = AccessTools.Method(typeof(Player), "OnGameSessionEnd");
                if (end != null)
                {
                    harmony.Patch(end, postfix: new HarmonyMethod(typeof(Recorded).GetMethod(nameof(Ended), Any)));
                }
            }
            catch (Exception)
            {
                // the raid's end isn't told
            }

            try
            {
                var leave = Types.Find("BotLeaveData") ?? Types.Find("EFT.BotLeaveData");
                var remove = leave != null ? AccessTools.Method(leave, "RemoveFromMap") : null;
                for (var type = leave; type != null && _leaver == null; type = type.BaseType)
                {
                    foreach (var field in type.GetFields(Any | BindingFlags.DeclaredOnly))
                    {
                        if (field.FieldType == typeof(BotOwner))
                        {
                            _leaver = field;
                            break;
                        }
                    }
                }

                if (remove != null && _leaver != null)
                {
                    harmony.Patch(remove, prefix: new HarmonyMethod(typeof(Recorded).GetMethod(nameof(Leaving), Any)));
                }
            }
            catch (Exception)
            {
                // bots that extract aren't told
            }
        }

        // Squad callouts, including reloads and requests for help. Excludes pain and death sounds.
        private static readonly HashSet<EPhraseTrigger> Callouts = new HashSet<EPhraseTrigger>
        {
            EPhraseTrigger.OnEnemyGrenade, EPhraseTrigger.OnGrenade, EPhraseTrigger.FollowMe,
            EPhraseTrigger.Gogogo, EPhraseTrigger.Suppress, EPhraseTrigger.Covering,
            EPhraseTrigger.Going, EPhraseTrigger.Regroup, EPhraseTrigger.Roger,
            EPhraseTrigger.Negative, EPhraseTrigger.GetInCover, EPhraseTrigger.GetBack,
            EPhraseTrigger.HoldPosition, EPhraseTrigger.OnYourOwn, EPhraseTrigger.Repeat,
            EPhraseTrigger.Stop, EPhraseTrigger.Ready, EPhraseTrigger.OnPosition,
            EPhraseTrigger.CoverMe, EPhraseTrigger.LostVisual, EPhraseTrigger.OnLostVisual,
            EPhraseTrigger.Rat, EPhraseTrigger.OnFirstContact, EPhraseTrigger.OnRepeatedContact,
            EPhraseTrigger.OnEnemyConversation, EPhraseTrigger.OnEnemyShot, EPhraseTrigger.SniperPhrase,
            EPhraseTrigger.EnemyDown, EPhraseTrigger.GoodWork, EPhraseTrigger.OnFriendlyDown,
            EPhraseTrigger.LootBody, EPhraseTrigger.LootGeneric, EPhraseTrigger.OnLoot,
            EPhraseTrigger.CheckHim, EPhraseTrigger.OnWeaponReload, EPhraseTrigger.NeedMedkit,
            EPhraseTrigger.NeedSniper, EPhraseTrigger.NeedHelp, EPhraseTrigger.OnSix,
            EPhraseTrigger.LeftFlank, EPhraseTrigger.RightFlank, EPhraseTrigger.InTheFront,
            EPhraseTrigger.NoisePhrase, EPhraseTrigger.OpenDoor, EPhraseTrigger.OnFight,
            EPhraseTrigger.GoForward, EPhraseTrigger.UnderFire, EPhraseTrigger.NeedAmmo,
            EPhraseTrigger.OnOutOfAmmo,
        };

        public static void VoicePlayed(object __instance, EPhraseTrigger __0, bool __runOriginal, bool __result)
        {
            if (!__runOriginal || !__result || !World.Watched || World.BrainsOff || Events.Raid.Length == 0
                || !Callouts.Contains(__0)) return;
            var player = Hooks.Get(__instance, "Player") as Player;
            if (player == null || (player.AIData?.BotOwner?.BotsGroup?.MembersCount ?? 0) < 2) return;
            Events.Add("bot.voice", player.ProfileId, player.Profile?.Nickname, Time.realtimeSinceStartup, to =>
            {
                to.Append("{\"phrase\":");
                World.Text(to, __0.ToString());
                to.Append('}');
            });
        }

        private static void BeforeSight(EnemyInfo __instance, bool __0, out bool __state)
        {
            __state = __0 && !__instance.IsVisible;
        }

        private static void AfterSight(EnemyInfo __instance, bool __state)
        {
            if (!__state || !__instance.IsVisible || !World.Watched || World.BrainsOff || Events.Raid.Length == 0) return;
            var target = __instance.Person;
            var observer = __instance.Owner;
            if (observer == null || target == null || !target.IsAI || string.IsNullOrEmpty(target.ProfileId)) return;
            ReportSight(observer.ProfileId, target.ProfileId);
        }

        private static void ReportSight(string observer, string target)
        {
            Events.Add("bot.sight", observer, null, Time.realtimeSinceStartup, to =>
            {
                to.Append("{\"target\":");
                World.Text(to, target);
                to.Append('}');
            });
        }

        // Player.OnGameSessionEnd(ExitStatus exitStatus, float pastTime, string locationId, string exitName)
        public static void Ended(Player __instance, object __0, string __2, string __3)
        {
            try
            {
                if (__instance == null || !__instance.IsYourPlayer || __2 == "hideout")
                {
                    return;
                }

                var status = Convert.ToString(__0);
                var exit = __3 ?? "";
                Release();
                var at = __instance.Position;
                // "inv": what they have on them now, [template, how many] (the server prices it: what they got out with)
                var had = new List<KeyValuePair<string, int>>();
                try
                {
                    Had(__instance.Inventory != null ? __instance.Inventory.Equipment : null, had, 0);
                }
                catch (Exception)
                {
                    had.Clear();
                }

                Events.Add("end", __instance.ProfileId, null, Time.realtimeSinceStartup, to =>
                {
                    to.Append("{\"st\":");
                    World.Text(to, status);
                    to.Append(",\"ex\":");
                    World.Text(to, exit);
                    World.Spot(to, "at", at);
                    if (had.Count > 0)
                    {
                        to.Append(",\"inv\":[");
                        for (var i = 0; i < had.Count; i++)
                        {
                            to.Append(i > 0 ? ",[" : "[");
                            World.Text(to, had[i].Key);
                            to.Append(',').Append(had[i].Value).Append(']');
                        }

                        to.Append(']');
                    }

                    to.Append('}');
                });
            }
            catch (Exception)
            {
                // not told
            }
        }

        // everything somebody has on them: what's worn in each slot (not the pockets themselves) and what's in it, the
        // secure container's too, a few bags deep
        private static void Had(EFT.InventoryLogic.CompoundItem holder, List<KeyValuePair<string, int>> into, int depth)
        {
            if (holder == null || depth > 4 || into.Count > 400)
            {
                return;
            }

            if (holder.Slots != null)
            {
                foreach (var slot in holder.Slots)
                {
                    var worn = slot != null ? slot.ContainedItem : null;
                    if (worn == null)
                    {
                        continue;
                    }

                    if (depth > 0 || (slot.ID != "Pockets" && slot.ID != "SecuredContainer"))
                    {
                        into.Add(new KeyValuePair<string, int>(worn.TemplateId.ToString(), Math.Max(1, worn.StackObjectsCount)));
                    }

                    if (depth == 0 && worn is EFT.InventoryLogic.CompoundItem bag)
                    {
                        Had(bag, into, depth + 1);
                    }
                }
            }

            if (holder.Grids == null)
            {
                return;
            }

            foreach (var grid in holder.Grids)
            {
                foreach (var item in grid.Items)
                {
                    into.Add(new KeyValuePair<string, int>(item.TemplateId.ToString(), Math.Max(1, item.StackObjectsCount)));
                    if (item is EFT.InventoryLogic.CompoundItem inner && inner.Grids != null && inner.Grids.Length > 0)
                    {
                        Had(inner, into, depth + 1);
                    }
                }
            }
        }

        // a bot taken off the map while it's alive: it extracted
        public static void Leaving(object __instance)
        {
            try
            {
                if (!World.Watched || _leaver == null)
                {
                    return;
                }

                var player = (_leaver.GetValue(__instance) as BotOwner)?.GetPlayer;
                if (player == null || player.HealthController == null || !player.HealthController.IsAlive)
                {
                    return;
                }

                var who = player.ProfileId;
                World.Names.TryGetValue(who, out var name);
                World.Kinds.TryGetValue(who, out var kind);
                var at = player.Position;
                Events.Add("left", who, name, Time.realtimeSinceStartup, to =>
                {
                    to.Append("{\"wk\":");
                    World.Text(to, kind ?? "");
                    World.Spot(to, "at", at);
                    to.Append('}');
                });
            }
            catch (Exception)
            {
                // not told
            }
        }

        // ---- ORBIT: what its squads are out to do, and its field ----
        private static bool _orbitLooked;
        private static PropertyInfo _available;
        private static PropertyInfo _revision;
        private static MethodInfo _main;
        private static MethodInfo _field;
        private static int _mainRevision = int.MinValue;
        private static float _mainAt = -1000f;
        private static float _fieldAt = -1000f;
        private static readonly StringBuilder Dumped = new StringBuilder(4096);

        private static void Orbit()
        {
            if (World.BrainsOff)
            {
                return;
            }

            if (!_orbitLooked)
            {
                _orbitLooked = true;
                try
                {
                    var telemetry = Types.Find("Orbit.Api.OrbitTelemetry");
                    const BindingFlags open = BindingFlags.Public | BindingFlags.Static;
                    _available = telemetry?.GetProperty("IsAvailable", open);
                    _revision = telemetry?.GetProperty("MainObjectivesRevision", open);
                    _main = telemetry?.GetMethod("GetMainObjectivesSnapshot", open, null, Type.EmptyTypes, null);
                    _field = telemetry?.GetMethod("GetFieldSnapshot", open, null, Type.EmptyTypes, null);
                }
                catch (Exception)
                {
                    // an ORBIT without them
                }
            }

            var now = Time.realtimeSinceStartup;
            try
            {
                if (_main == null && _field == null || (_available != null && !(_available.GetValue(null, null) is bool on && on)))
                {
                    return;
                }

                // what the squads are out to do: when ORBIT says it changed (or, from an ORBIT that doesn't say, every
                // ten seconds), and never more than once in two seconds
                if (_main != null && now - _mainAt >= 2f)
                {
                    var revision = _revision != null ? Convert.ToInt32(_revision.GetValue(null, null)) : (int)(now / 10f);
                    if (revision != _mainRevision)
                    {
                        _mainRevision = revision;
                        _mainAt = now;
                        Snapshot("orbit.main", _main.Invoke(null, null), now, 60_000);
                    }
                }

                if (_field != null && now - _fieldAt >= 120f)
                {
                    _fieldAt = now;
                    Snapshot("orbit.field", _field.Invoke(null, null), now, 200_000);
                }
            }
            catch (Exception)
            {
                // not this time
            }
        }

        private static void Snapshot(string kind, object what, float now, int most)
        {
            if (what == null)
            {
                return;
            }

            Dumped.Length = 0;
            Dump(Dumped, what, 0);
            if (Dumped.Length < 3 || Dumped.Length > most)
            {
                return;
            }

            var text = Dumped.ToString();
            Events.Add(kind, null, null, now, to => to.Append("{\"s\":").Append(text).Append('}'));
        }

        // anything as JSON: numbers, words, lists, and every public field and property of the rest, by its own name
        private static readonly Dictionary<Type, MemberInfo[]> Members = new Dictionary<Type, MemberInfo[]>();

        private static void Dump(StringBuilder to, object what, int depth)
        {
            if (what == null || depth > 7)
            {
                to.Append("null");
                return;
            }

            switch (what)
            {
                case string text:
                    World.Text(to, text);
                    return;
                case bool yes:
                    to.Append(yes ? "true" : "false");
                    return;
                case float f:
                    Number(to, f);
                    return;
                case double d:
                    Number(to, (float)d);
                    return;
                case Enum word:
                    World.Text(to, word.ToString());
                    return;
                case Vector3 v:
                    to.Append("{\"x\":");
                    Number(to, v.x);
                    to.Append(",\"y\":");
                    Number(to, v.y);
                    to.Append(",\"z\":");
                    Number(to, v.z);
                    to.Append('}');
                    return;
            }

            var type = what.GetType();
            if (type.IsPrimitive || what is decimal)
            {
                to.Append(Convert.ToString(what, System.Globalization.CultureInfo.InvariantCulture));
                return;
            }

            if (what is IDictionary map)
            {
                to.Append('{');
                var first = true;
                foreach (DictionaryEntry pair in map)
                {
                    if (!first)
                    {
                        to.Append(',');
                    }

                    first = false;
                    World.Text(to, Convert.ToString(pair.Key, System.Globalization.CultureInfo.InvariantCulture));
                    to.Append(':');
                    Dump(to, pair.Value, depth + 1);
                }

                to.Append('}');
                return;
            }

            if (what is IEnumerable list)
            {
                to.Append('[');
                var count = 0;
                foreach (var one in list)
                {
                    if (count >= 4000)
                    {
                        break;
                    }

                    if (count++ > 0)
                    {
                        to.Append(',');
                    }

                    Dump(to, one, depth + 1);
                }

                to.Append(']');
                return;
            }

            if (!Members.TryGetValue(type, out var members))
            {
                var found = new List<MemberInfo>();
                foreach (var field in type.GetFields(BindingFlags.Instance | BindingFlags.Public))
                {
                    found.Add(field);
                }

                foreach (var property in type.GetProperties(BindingFlags.Instance | BindingFlags.Public))
                {
                    if (property.CanRead && property.GetIndexParameters().Length == 0)
                    {
                        found.Add(property);
                    }
                }

                members = found.ToArray();
                Members[type] = members;
            }

            to.Append('{');
            var wrote = false;
            foreach (var member in members)
            {
                object value;
                try
                {
                    value = member is FieldInfo field ? field.GetValue(what) : ((PropertyInfo)member).GetValue(what, null);
                }
                catch (Exception)
                {
                    continue;
                }

                if (value == null)
                {
                    continue;
                }

                if (wrote)
                {
                    to.Append(',');
                }

                wrote = true;
                World.Text(to, member.Name);
                to.Append(':');
                Dump(to, value, depth + 1);
            }

            to.Append('}');
        }

        private static void Number(StringBuilder to, float value)
        {
            if (float.IsNaN(value) || float.IsInfinity(value))
            {
                to.Append("null");
                return;
            }

            World.Number(to, value);
        }
    }

    // Fika, when it's in the game, found by name: a player who is down (its revive system), who it says extracted,
    // and what the other players pick up (its copies of them tell that through a method of their own).
    internal static class FikaSide
    {
        private const BindingFlags Any = BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
        private static bool _looked;
        private static Type _player;
        private static PropertyInfo _downed;
        private static PropertyInfo _manager;

        internal static void Look()
        {
            if (_looked)
            {
                return;
            }

            _looked = true;
            try
            {
                _player = Types.Find("Fika.Core.Main.Players.FikaPlayer");
                var downed = _player?.GetProperty("Downed", Any);
                _downed = downed != null && downed.PropertyType == typeof(bool) ? downed : null;
                var manager = Types.Find("Fika.Core.Networking.IFikaNetworkManager");
                _manager = manager != null ? typeof(Singleton<>).MakeGenericType(manager).GetProperty("Instance", BindingFlags.Public | BindingFlags.Static) : null;
            }
            catch (Exception)
            {
                _downed = null;
            }

            try
            {
                var observed = Types.Find("Fika.Core.Main.Players.ObservedPlayer");
                var moved = observed?.GetMethod("OnItemAddedOrRemoved", Any | BindingFlags.DeclaredOnly);
                if (moved != null)
                {
                    new Harmony("com.fums.satellite.fika").Patch(moved, postfix: new HarmonyMethod(typeof(Pickups).GetMethod(nameof(Pickups.Moved), Any)));
                }
            }
            catch (Exception)
            {
                // the other players' pick-ups aren't told
            }
        }

        internal static bool Downed(Player player)
        {
            try
            {
                return _downed != null && _player.IsInstanceOfType(player) && _downed.GetValue(player, null) is bool down && down;
            }
            catch (Exception)
            {
                return false;
            }
        }

        internal static bool Extracted(Player player)
        {
            try
            {
                var handler = Hooks.Get(_manager?.GetValue(null, null), "CoopHandler");
                var id = Hooks.Get(player, "NetId");
                return id != null && Hooks.Get(handler, "ExtractedPlayers") is IList gone && gone.Contains(id);
            }
            catch (Exception)
            {
                return false;
            }
        }
    }
}
