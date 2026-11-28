using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using EFT;
using EFT.InventoryLogic;
using HarmonyLib;
using UnityEngine;

namespace Satellite.Client
{
    // What the map shows beyond where everybody is: shots, what bots pick up, the airdrop's plane, health, what ORBIT's
    // ghosts get up to, where QuestingBots and Phobos send bots, and PBT's cheaters. Each is found by name when the
    // game starts; one that isn't there (another version of the game, a mod not installed) is left out and nothing
    // else is the worse for it. None of the mods is needed.

    // The game's own methods looked in on (nothing about them is changed): each only notes what happened.
    internal static class Hooks
    {
        private const BindingFlags Any = BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
        private static bool _done;

        internal static void Apply()
        {
            if (_done)
            {
                return;
            }

            _done = true;
            var harmony = new Harmony("com.fums.satellite.hooks");
            After(harmony, Types.Find("EFT.ClientGameWorld"), "ShotDelegate", typeof(Shots), nameof(Shots.Fired));
            After(harmony, typeof(Player), "OnItemAddedOrRemoved", typeof(Pickups), nameof(Pickups.Moved));
            foreach (var name in new[] { "ClientAirPlane", "ServerPlane" })
            {
                var plane = Types.Find("EFT.Airdrop." + name);
                After(harmony, plane, "ManualUpdate", typeof(Planes), nameof(Planes.Flew));
                After(harmony, plane, "ReturnToPool", typeof(Planes), nameof(Planes.Left));
            }

            Recorded.Hook(harmony);
            ContactSharing.Hook(harmony);
            After(harmony, Types.Find("SAIN.Components.PlayerComponentSpace.PlayerComponent"), "PlayVoiceLine",
                typeof(Recorded), nameof(Recorded.VoicePlayed));
            After(harmony, typeof(Grenade), nameof(Grenade.Explosion), typeof(Shots), nameof(Shots.Exploded));
        }

        private static void After(Harmony harmony, Type type, string method, Type mine, string with)
        {
            try
            {
                MethodInfo target = null;
                if (type != null)
                {
                    foreach (var one in type.GetMethods(Any))
                    {
                        if (one.Name == method && !one.IsAbstract)
                        {
                            target = one;
                            break;
                        }
                    }
                }

                if (target != null)
                {
                    harmony.Patch(target, postfix: new HarmonyMethod(mine.GetMethod(with, Any)));
                }
            }
            catch (Exception)
            {
                // that one isn't shown, then
            }
        }

        // a field or property of something, by name (the types are other mods', or the game keeps them to itself)
        // by type, then by name: looked up without making a key string each time, so a read leaves nothing to clear away
        private static readonly Dictionary<Type, Dictionary<string, MemberInfo>> Members = new Dictionary<Type, Dictionary<string, MemberInfo>>();

        internal static object Get(object from, string name)
        {
            if (from == null)
            {
                return null;
            }

            var type = from.GetType();
            if (!Members.TryGetValue(type, out var named))
            {
                named = new Dictionary<string, MemberInfo>();
                Members[type] = named;
            }

            if (!named.TryGetValue(name, out var member))
            {
                member = (MemberInfo)type.GetField(name, Any) ?? type.GetProperty(name, Any);
                named[name] = member;
            }

            try
            {
                return member is FieldInfo field ? field.GetValue(from) : member is PropertyInfo property ? property.GetValue(from, null) : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        internal static float Float(object from, string name)
        {
            var value = Get(from, name);
            try
            {
                return value == null ? 0f : Convert.ToSingle(value);
            }
            catch (Exception)
            {
                return 0f;
            }
        }

        internal static string Text(object from, string name)
        {
            return Get(from, name) as string ?? "";
        }

        // [east, north, height]
        internal static void Place(StringBuilder to, float x, float y, float z)
        {
            to.Append('[');
            World.Number(to, x);
            to.Append(',');
            World.Number(to, z);
            to.Append(',');
            World.Number(to, y);
            to.Append(']');
        }
    }

    // Every bullet: from where to where, and whose. Sent with each report (ten a second), not kept: ,"sh":[[who,
    // east, north, east, north],...] (who: the shooter's marker, 0 when it has none).
    internal static class Shots
    {
        private const int Most = 80;

        private struct One
        {
            public string Shooter;
            public Vector3 From;
            public Vector3 To;
            // whoever it hit, by profile id (nobody: null)
            public string Hit;
        }

        private static readonly List<One> Waiting = new List<One>();

        public static void Exploded(bool __runOriginal, object __1, Vector3 __2, string __3)
        {
            if (!__runOriginal || !World.Watched || Events.Raid.Length == 0) return;
            // The explosive itself is authoritative, including for a launcher carrying different rounds.
            var item = __1 as Item;
            string name = null;
            try { if (item != null) name = RichText.Plain(item.LocalizedShortName()); }
            catch (Exception) { /* The blast still has a position when an addon's item has no name. */ }
            Events.Add("grenade.blast", __3, null, Time.realtimeSinceStartup, to =>
            {
                to.Append("{\"at\":");
                Hooks.Place(to, __2.x, __2.y, __2.z);
                if (!string.IsNullOrWhiteSpace(name))
                {
                    to.Append(",\"i\":");
                    World.Text(to, name);
                }
                to.Append('}');
            });
        }

        public static void Fired(object __0)
        {
            if (!World.Watched || __0 == null)
            {
                return;
            }

            try
            {
                if (!(Hooks.Get(__0, "MasterOrigin") is Vector3 from) || !(Hooks.Get(__0, "HitPoint") is Vector3 to)
                    || (to - from).sqrMagnitude < 1f || to == Vector3.zero)
                {
                    return;
                }

                if (Waiting.Count >= Most)
                {
                    Waiting.RemoveAt(0);
                }

                string hit = null;
                try
                {
                    var struck = Hooks.Get(__0, "HittedBallisticCollider") as Component;
                    var body = struck != null ? struck.GetComponentInParent<Player>() : null;
                    hit = body != null ? body.ProfileId : null;
                }
                catch (Exception)
                {
                    // a miss, as far as the map knows
                }

                Waiting.Add(new One { Shooter = Hooks.Get(__0, "PlayerProfileID") as string, From = from, To = to, Hit = hit });
            }
            catch (Exception)
            {
                // not drawn
            }
        }

        internal static void Forget()
        {
            Waiting.Clear();
        }

        internal static void Take(StringBuilder to)
        {
            if (Waiting.Count == 0)
            {
                return;
            }

            to.Append(",\"sh\":[");
            for (var i = 0; i < Waiting.Count; i++)
            {
                var shot = Waiting[i];
                if (i > 0)
                {
                    to.Append(',');
                }

                long who = 0;
                if (!string.IsNullOrEmpty(shot.Shooter))
                {
                    World.Ids.TryGetValue(shot.Shooter, out who);
                }

                to.Append('[').Append(who).Append(',');
                World.Number(to, shot.From.x);
                to.Append(',');
                World.Number(to, shot.From.z);
                to.Append(',');
                World.Number(to, shot.To.x);
                to.Append(',');
                World.Number(to, shot.To.z);
                // whoever it hit: their marker (0: it's not on the map), only when somebody was
                if (!string.IsNullOrEmpty(shot.Hit))
                {
                    long struck = 0;
                    World.Ids.TryGetValue(shot.Hit, out struck);
                    to.Append(',').Append(struck);
                }

                to.Append(']');
            }

            to.Append(']');
            Waiting.Clear();
        }
    }

    // What somebody picks up: an event ("loot") each, {"tpl":template,"i":its short name,"q":how many,"qi":1 for a
    // quest item,"wk":what kind the one picking it up is,"at":[east,north,height] where they stood}. Not what a bot spawns with, not rounds pushed into a
    // magazine, and not a thing moved from one pocket to another (taken out and put back in the same moment).
    // What leaves somebody's hands for good is a "drop", told the same way ("g":1 when it's a grenade: a throw).
    internal static class Pickups
    {
        private struct Gone
        {
            public float At;
            public string Who;
            public string Template;
            public string Said;
            public int Count;
            public bool Grenade;
            public Vector3 Where;
        }

        private static readonly Dictionary<string, Gone> Out = new Dictionary<string, Gone>();
        // how long a thing taken out may be gone and still be one's own put back, not dropped and picked up (a
        // reload's magazine is out for two or three seconds): a drop is told this long after
        private const float BackWithin = 6f;

        // rounds (not a box or pack of them): what a gun's magazines are filled with
        private static bool IsRounds(Item item)
        {
            return item is EFT.InventoryLogic.Ammo;
        }
        private static readonly List<string> Due = new List<string>();
        // the last one told, so a thing the game tells twice (Fika's copy of a player does) is told once
        private static string _lastKey;
        private static float _lastAt;

        public static void Moved(Player __instance, Item item, object location, bool added)
        {
            if (!World.Watched || __instance == null || item == null || string.IsNullOrEmpty(__instance.ProfileId))
            {
                return;
            }

            try
            {
                var who = __instance.ProfileId;
                var now = Time.realtimeSinceStartup;
                // not what it came into the raid with
                if (!World.Born.TryGetValue(who, out var born) || now - born < 10f)
                {
                    return;
                }

                if (Hooks.Text(Hooks.Get(location, "Container"), "ID") == "cartridges")
                {
                    return;
                }

                // A bot's rounds come and go as it reloads and as the game tops its ammo up: not a pick-up or a drop
                // (rounds a bot takes off a body or out of a box come with what it takes, the rest isn't news)
                if (IsRounds(item) && World.IsBot(__instance))
                {
                    return;
                }

                var key = who + "|" + item.Id;
                var told = key + (added ? "+" : "-");
                if (told == _lastKey && now - _lastAt < 0.03f)
                {
                    return;
                }

                _lastKey = told;
                _lastAt = now;
                if (!added)
                {
                    if (Out.Count > 400)
                    {
                        Out.Clear();
                    }

                    var type = item.GetType().Name;
                    Out[key] = new Gone
                    {
                        At = now, Who = who, Template = item.TemplateId.ToString(), Said = RichText.Plain(item.LocalizedShortName()), Count = item.StackObjectsCount,
                        Grenade = type.IndexOf("ThrowWeap", StringComparison.OrdinalIgnoreCase) >= 0 || type.IndexOf("Grenade", StringComparison.OrdinalIgnoreCase) >= 0,
                        Where = __instance.Position
                    };
                    return;
                }

                // its own thing put back (a magazine into the gun or back into the rig as it reloads, a thing moved from
                // a pocket to a bag): not a pick-up, nor was taking it out a drop
                if (Out.TryGetValue(key, out var left))
                {
                    Out.Remove(key);
                    if (now - left.At <= BackWithin)
                    {
                        return;
                    }
                }

                World.Names.TryGetValue(who, out var name);
                World.Kinds.TryGetValue(who, out var kind);
                var template = item.TemplateId.ToString();
                var said = RichText.Plain(item.LocalizedShortName());
                var count = item.StackObjectsCount;
                var quest = item.QuestItem;
                var where = __instance.Position;
                var into = SlotOf(location);
                Events.Add("loot", who, name, now, to =>
                {
                    to.Append("{\"tpl\":");
                    World.Text(to, template);
                    to.Append(",\"i\":");
                    World.Text(to, said);
                    if (count > 1)
                    {
                        to.Append(",\"q\":").Append(count);
                    }

                    if (quest)
                    {
                        to.Append(",\"qi\":1");
                    }

                    if (!string.IsNullOrEmpty(kind))
                    {
                        to.Append(",\"wk\":");
                        World.Text(to, kind);
                    }

                    // what it went into: the slot it's worn in, or the one holding the bag, rig or pocket it was put in
                    if (!string.IsNullOrEmpty(into))
                    {
                        to.Append(",\"in\":");
                        World.Text(to, into);
                    }

                    // where they stood
                    World.Spot(to, "at", where);
                    to.Append('}');
                });
            }
            catch (Exception)
            {
                // not told
            }
        }

        // the slots of somebody's gear
        private static readonly HashSet<string> GearSlots = new HashSet<string>(StringComparer.Ordinal)
        {
            "FirstPrimaryWeapon", "SecondPrimaryWeapon", "Holster", "Scabbard", "Headwear", "Earpiece", "FaceCover", "Eyewear", "ArmorVest",
            "TacticalVest", "Backpack", "Pockets", "SecuredContainer", "ArmBand", "SpecialSlot1", "SpecialSlot2", "SpecialSlot3", "Dogtag"
        };

        // The slot of somebody's gear a thing went into, however deep: "Backpack", "TacticalVest", "Pockets",
        // "SecuredContainer", "FirstPrimaryWeapon" (a part on a gun)... Up from where it was put, container by
        // container (a grid's or slot's item, and where that item is), the last of them that's a slot of the gear.
        // Null when it can't be told.
        private static string SlotOf(object location)
        {
            string found = null;
            try
            {
                var container = Hooks.Get(location, "Container");
                for (var i = 0; i < 10 && container != null; i++)
                {
                    var id = Hooks.Text(container, "ID");
                    if (id != null && GearSlots.Contains(id))
                    {
                        found = id;
                    }

                    var parent = Hooks.Get(container, "ParentItem");
                    var address = parent != null ? Hooks.Get(parent, "CurrentAddress") : null;
                    container = address != null ? Hooks.Get(address, "Container") : null;
                }
            }
            catch (Exception)
            {
                // as far as it got
            }

            return found;
        }

        // with every report: what was taken out and hasn't come back is a drop
        internal static void Flush()
        {
            if (Out.Count == 0)
            {
                return;
            }

            try
            {
                var now = Time.realtimeSinceStartup;
                Due.Clear();
                foreach (var pair in Out)
                {
                    if (now - pair.Value.At > BackWithin)
                    {
                        Due.Add(pair.Key);
                    }
                }

                foreach (var key in Due)
                {
                    var gone = Out[key];
                    Out.Remove(key);
                    World.Names.TryGetValue(gone.Who, out var name);
                    World.Kinds.TryGetValue(gone.Who, out var kind);
                    Events.Add("drop", gone.Who, name, gone.At, to =>
                    {
                        to.Append("{\"tpl\":");
                        World.Text(to, gone.Template);
                        to.Append(",\"i\":");
                        World.Text(to, gone.Said);
                        if (gone.Count > 1)
                        {
                            to.Append(",\"q\":").Append(gone.Count);
                        }

                        if (gone.Grenade)
                        {
                            to.Append(",\"g\":1");
                        }

                        if (!string.IsNullOrEmpty(kind))
                        {
                            to.Append(",\"wk\":");
                            World.Text(to, kind);
                        }

                        World.Spot(to, "at", gone.Where);
                        to.Append('}');
                    });
                }
            }
            catch (Exception)
            {
                Out.Clear();
            }
        }

        internal static void Forget()
        {
            Out.Clear();
        }
    }

    // The airdrop's plane: where it is, which way it flies and the way it has come, while it's in the air.
    // ,"plane":{"p":[east,north,height],"r":heading,"path":[east,north,east,north,...]}
    internal static class Planes
    {
        private static readonly List<Vector2> Path = new List<Vector2>();
        private static Vector3 _at;
        private static float _yaw;
        private static float _seen = -100f;
        private static float _next;

        public static void Flew(object __instance)
        {
            try
            {
                var body = Hooks.Get(__instance, "_syncObject") as Component ?? __instance as Component;
                if (body == null)
                {
                    return;
                }

                var now = Time.realtimeSinceStartup;
                // a new flight: the last one's way is forgotten
                if (now - _seen > 5f)
                {
                    Path.Clear();
                    _next = 0f;
                }

                _at = body.transform.position;
                _yaw = body.transform.eulerAngles.y;
                _seen = now;
                if (now >= _next && Path.Count < 400)
                {
                    _next = now + 0.5f;
                    Path.Add(new Vector2(_at.x, _at.z));
                }
            }
            catch (Exception)
            {
                // not shown
            }
        }

        public static void Left(object __instance)
        {
            _seen = -100f;
        }

        internal static void Forget()
        {
            Path.Clear();
            _seen = -100f;
        }

        internal static void Take(StringBuilder to)
        {
            if (Time.realtimeSinceStartup - _seen > 2f)
            {
                return;
            }

            to.Append(",\"plane\":{\"p\":");
            Hooks.Place(to, _at.x, _at.y, _at.z);
            to.Append(",\"r\":");
            World.Number(to, _yaw);
            to.Append(",\"path\":[");
            for (var i = 0; i < Path.Count; i++)
            {
                if (i > 0)
                {
                    to.Append(',');
                }

                World.Number(to, Path[i].x);
                to.Append(',');
                World.Number(to, Path[i].y);
            }

            to.Append("]}");
        }
    }

    // How hurt somebody is: all of their body's health together, and what it is when whole.
    internal static class Health
    {
        internal static bool Of(Player player, out int now, out int whole)
        {
            now = whole = 0;
            try
            {
                var health = player != null ? player.HealthController : null;
                if (health == null)
                {
                    return false;
                }

                var all = health.GetBodyPartHealth(EBodyPart.Common, true);
                now = Mathf.RoundToInt(all.Current);
                whole = Mathf.RoundToInt(all.Maximum);
                return whole > 0;
            }
            catch (Exception)
            {
                return false;
            }
        }

        // the body's parts in the order the page names them: head, chest, stomach, left arm, right arm, left leg, right leg
        internal static readonly EBodyPart[] Parts =
        {
            EBodyPart.Head, EBodyPart.Chest, EBodyPart.Stomach, EBodyPart.LeftArm, EBodyPart.RightArm, EBodyPart.LeftLeg, EBodyPart.RightLeg
        };

        // what each part of the body has left, into `into` (as long as Parts); false when it can't be told
        internal static bool PartsOf(Player player, int[] into)
        {
            try
            {
                var health = player != null ? player.HealthController : null;
                if (health == null)
                {
                    return false;
                }

                for (var i = 0; i < Parts.Length; i++)
                {
                    into[i] = Mathf.RoundToInt(health.GetBodyPartHealth(Parts[i], true).Current);
                }

                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        // a person's energy and water, as the game shows them
        internal static bool UpkeepOf(Player player, out int energy, out int water)
        {
            energy = water = 0;
            try
            {
                var health = player != null ? player.HealthController : null;
                if (health == null)
                {
                    return false;
                }

                energy = Mathf.RoundToInt(health.Energy.Current);
                water = Mathf.RoundToInt(health.Hydration.Current);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }
    }

    // ORBIT's ghosts (bots it has parked far from every player and moves along as numbers): the fights it works out
    // between them, what wakes one, and what one hears. ORBIT keeps each until somebody takes it, and gives it once:
    // with Raid Review installed as well, each mod gets only what the other left. Events "orbit.fight" {"a":[..],
    // "b":[..],"s":seconds,"n":dead}, "orbit.wake" {"c":cause,"dt":detail,"by":who,"m":how far} and "orbit.hear"
    // {"s":[where the noise was],"l":[where the listener was],"r":how far it hears,"m":how far off,"sh":shots,"inv":1}.
    internal static class Ghosts
    {
        private static bool _looked;
        private static MethodInfo _fights;
        private static MethodInfo _wakes;
        private static MethodInfo _hearing;

        // looked for before a raid (see Plugin), so the first report of a raid doesn't pay for it
        internal static void Warm()
        {
            Look();
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
                var telemetry = Types.Find("Orbit.Api.OrbitTelemetry");
                const BindingFlags open = BindingFlags.Public | BindingFlags.Static;
                _fights = telemetry?.GetMethod("DrainGhostFights", open, null, Type.EmptyTypes, null);
                _wakes = telemetry?.GetMethod("DrainGhostWakes", open, null, Type.EmptyTypes, null);
                _hearing = telemetry?.GetMethod("DrainGhostHearing", open, null, Type.EmptyTypes, null);
            }
            catch (Exception)
            {
                // an ORBIT without them
            }
        }

        private static IEnumerable Taken(ref MethodInfo from)
        {
            if (from == null)
            {
                return null;
            }

            try
            {
                return from.Invoke(null, null) as IEnumerable;
            }
            catch (Exception)
            {
                // not asked again
                from = null;
                return null;
            }
        }

        // called before each full report while a page is open
        internal static void Tick()
        {
            Look();
            var now = Time.realtimeSinceStartup;
            var told = 0;
            var fights = Taken(ref _fights);
            if (fights != null)
            {
                foreach (var f in fights)
                {
                    if (f == null || ++told > 20)
                    {
                        continue;
                    }

                    var fight = f;
                    Events.Add("orbit.fight", null, null, now, to =>
                    {
                        to.Append("{\"a\":");
                        Hooks.Place(to, Hooks.Float(fight, "AX"), Hooks.Float(fight, "AY"), Hooks.Float(fight, "AZ"));
                        to.Append(",\"b\":");
                        Hooks.Place(to, Hooks.Float(fight, "BX"), Hooks.Float(fight, "BY"), Hooks.Float(fight, "BZ"));
                        to.Append(",\"s\":").Append(Mathf.RoundToInt(Hooks.Float(fight, "Duration")));
                        to.Append(",\"n\":").Append(Mathf.RoundToInt(Hooks.Float(fight, "Casualties"))).Append('}');
                    });
                }
            }

            told = 0;
            var wakes = Taken(ref _wakes);
            if (wakes != null)
            {
                foreach (var w in wakes)
                {
                    // what happened while nobody was looking is old news
                    if (w == null || now - Hooks.Float(w, "RecordedAt") > 15f || ++told > 20)
                    {
                        continue;
                    }

                    var wake = w;
                    Events.Add("orbit.wake", Hooks.Text(wake, "ProfileId"), Hooks.Text(wake, "Name"), Hooks.Float(wake, "RecordedAt"), to =>
                    {
                        to.Append("{\"c\":");
                        World.Text(to, Hooks.Text(wake, "Cause"));
                        to.Append(",\"dt\":");
                        World.Text(to, Hooks.Text(wake, "Detail"));
                        to.Append(",\"by\":");
                        World.Text(to, Hooks.Text(wake, "TriggerName"));
                        to.Append(",\"m\":").Append(Mathf.RoundToInt(Hooks.Float(wake, "Distance"))).Append('}');
                    });
                }
            }

            told = 0;
            var heard = Taken(ref _hearing);
            if (heard != null)
            {
                foreach (var h in heard)
                {
                    if (h == null || now - Hooks.Float(h, "RecordedAt") > 15f || ++told > 30)
                    {
                        continue;
                    }

                    var one = h;
                    var who = Hooks.Text(one, "ProfileId");
                    World.Names.TryGetValue(who, out var name);
                    Events.Add("orbit.hear", who, name, Hooks.Float(one, "RecordedAt"), to =>
                    {
                        to.Append("{\"s\":");
                        Hooks.Place(to, Hooks.Float(one, "SourceX"), Hooks.Float(one, "SourceY"), Hooks.Float(one, "SourceZ"));
                        to.Append(",\"l\":");
                        Hooks.Place(to, Hooks.Float(one, "ListenerX"), Hooks.Float(one, "ListenerY"), Hooks.Float(one, "ListenerZ"));
                        to.Append(",\"r\":").Append(Mathf.RoundToInt(Hooks.Float(one, "Range")));
                        to.Append(",\"m\":").Append(Mathf.RoundToInt(Hooks.Float(one, "Distance")));
                        to.Append(",\"sh\":").Append(Mathf.RoundToInt(Hooks.Float(one, "Shots")));
                        if (Hooks.Get(one, "Investigate") is bool goes && goes)
                        {
                            to.Append(",\"inv\":1");
                        }

                        to.Append('}');
                    });
                }
            }
        }
    }

    // Where QuestingBots and Phobos send a bot, for the bots ORBIT says nothing about: what it's after, and the place.
    internal static class Objectives
    {
        private static bool _looked;
        // QuestingBots says through its own doorway (QuestingBotsExternal)
        private static MethodInfo _questName;
        private static MethodInfo _questPlace;
        // Phobos keeps its agents in its manager: read where they are
        private static PropertyInfo _phobos;
        private static readonly Dictionary<string, object> Agents = new Dictionary<string, object>();
        private static float _agentsAt = -100f;
        // the one argument QuestingBots is asked with, used again (only ever from the game's own thread)
        private static readonly object[] Arg = new object[1];

        private static void Look()
        {
            if (_looked)
            {
                return;
            }

            _looked = true;
            try
            {
                var questing = Types.Find("QuestingBots.QuestingBotsExternal");
                _questName = questing != null ? AccessTools.Method(questing, "GetCurrentQuestName") : null;
                _questPlace = questing != null ? AccessTools.Method(questing, "GetCurrentQuestLocation") : null;
            }
            catch (Exception)
            {
                _questName = _questPlace = null;
            }

            try
            {
                var manager = Types.Find("Phobos.Orchestration.PhobosManager");
                _phobos = manager != null
                    ? typeof(Comfort.Common.Singleton<>).MakeGenericType(manager).GetProperty("Instance", BindingFlags.Public | BindingFlags.Static)
                    : null;
            }
            catch (Exception)
            {
                _phobos = null;
            }
        }

        // the mods of these two that are here
        internal static bool Questing
        {
            get
            {
                Look();
                return _questName != null;
            }
        }

        // Phobos's manager, while it has one
        internal static object PhobosManager()
        {
            Look();
            try
            {
                return _phobos != null ? _phobos.GetValue(null, null) : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        internal static bool Phobos
        {
            get
            {
                Look();
                return _phobos != null;
            }
        }

        // by: "QuestingBots" or "Phobos"
        internal static bool Of(Player player, BotOwner bot, out string by, out string what, out Vector3 place, out bool placed)
        {
            by = what = null;
            place = Vector3.zero;
            placed = false;
            Look();
            if (player == null || bot == null)
            {
                return false;
            }

            if (_questName != null)
            {
                try
                {
                    Arg[0] = bot;
                    what = _questName.Invoke(null, Arg) as string;
                    if (!string.IsNullOrEmpty(what))
                    {
                        by = "QuestingBots";
                        Arg[0] = bot;
                        if (_questPlace != null && _questPlace.Invoke(null, Arg) is Vector3 at && at != Vector3.zero)
                        {
                            place = at;
                            placed = true;
                        }

                        return true;
                    }
                }
                catch (Exception)
                {
                    // on to Phobos
                }
            }

            if (_phobos == null)
            {
                return false;
            }

            try
            {
                var now = Time.realtimeSinceStartup;
                if (now - _agentsAt > 1f)
                {
                    _agentsAt = now;
                    Agents.Clear();
                    var entities = Hooks.Get(Hooks.Get(_phobos.GetValue(null, null), "AgentData"), "Entities");
                    if (Hooks.Get(entities, "Values") is IEnumerable all)
                    {
                        foreach (var agent in all)
                        {
                            if (Hooks.Get(agent, "Player") is Player whose && !string.IsNullOrEmpty(whose.ProfileId))
                            {
                                Agents[whose.ProfileId] = agent;
                            }
                        }
                    }
                }

                if (!Agents.TryGetValue(player.ProfileId, out var mine) || (Hooks.Get(mine, "IsActive") is bool active && !active))
                {
                    return false;
                }

                var objective = Hooks.Get(mine, "Objective");
                var location = Hooks.Get(objective, "Location");
                if (objective == null || location == null)
                {
                    return false;
                }

                var category = Convert.ToString(Hooks.Get(location, "Category"));
                var status = Convert.ToString(Hooks.Get(objective, "Status"));
                by = "Phobos";
                what = string.IsNullOrEmpty(category) ? status : string.IsNullOrEmpty(status) ? category : category + " (" + status + ")";
                if (Hooks.Get(location, "Position") is Vector3 at && at != Vector3.zero)
                {
                    place = at;
                    placed = true;
                }

                return !string.IsNullOrEmpty(what);
            }
            catch (Exception)
            {
                return false;
            }
        }
    }

    // PBT's cheaters: the bots it has made one, read from its own list (asking PBT itself could make it roll one).
    internal static class Types
    {
        internal static Type Find(string fullName)
        {
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    var found = assembly.GetType(fullName, false);
                    if (found != null)
                    {
                        return found;
                    }
                }
                catch (Exception)
                {
                    // an assembly that can't be asked: the next one
                }
            }

            return null;
        }
    }

    internal static class Cheaters
    {
        // looked for before a raid (see Plugin), so the first bot of a raid doesn't pay for it
        internal static void Warm()
        {
            Is(null, null);
        }

        private static bool _looked;
        private static FieldInfo _accounts, _rolled, _forced;
        private static PropertyInfo _personality, _cheats, _forcedValue;
        private static Type _cheatType;

        private static void Look()
        {
            if (_looked)
            {
                return;
            }

            _looked = true;
            try
            {
                const BindingFlags all = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
                var roster = Types.Find("PBT.Client.Cheaters.CheaterRoster");
                _accounts = roster?.GetField("accounts", all);
                // what it rolled for each: its personality and its cheats (read, never asked for: asking can roll one)
                _rolled = roster?.GetField("rolled", all);
                _forced = roster?.GetField("forced", all);
                var args = _rolled?.FieldType.GetGenericArguments();
                var entry = args != null && args.Length == 2 ? args[1] : null;
                _personality = entry?.GetProperty("Type");
                _cheats = entry?.GetProperty("Cheats");
                _cheatType = _cheats?.PropertyType;
                _forcedValue = _forced?.FieldType.GetProperty("Value");
            }
            catch (Exception)
            {
                _accounts = null;
            }
        }

        // "personality|cheat,cheat" for one of PBT's cheaters, as PBT rolled it; null while it hasn't yet (asked
        // again later), "" when it can't be told (an older PBT)
        internal static string Detail(Player player)
        {
            Look();
            try
            {
                if (_rolled == null || _personality == null || _cheats == null || _cheatType == null || !_cheatType.IsEnum
                    || player?.Profile == null || !int.TryParse(player.Profile.AccountId, out var account))
                {
                    return "";
                }

                var entries = _rolled.GetValue(null) as System.Collections.IDictionary;
                var entry = entries != null && entries.Contains(account) ? entries[account] : null;
                if (entry == null)
                {
                    return null;
                }

                var bits = Convert.ToUInt64(_cheats.GetValue(entry, null));
                var config = _forced?.GetValue(null);
                if (config != null && _forcedValue != null)
                {
                    bits |= Convert.ToUInt64(_forcedValue.GetValue(config, null));
                }

                var names = new System.Collections.Generic.List<string>();
                foreach (var value in Enum.GetValues(_cheatType))
                {
                    var bit = Convert.ToUInt64(value);
                    if (bit != 0 && (bit & (bit - 1)) == 0 && (bits & bit) != 0)
                    {
                        names.Add(Enum.GetName(_cheatType, value));
                    }
                }

                return (_personality.GetValue(entry, null)?.ToString() ?? "") + "|" + string.Join(",", names);
            }
            catch (Exception)
            {
                return "";
            }
        }

        internal static bool Is(Player player, string layer)
        {
            if (layer == "PbtCheater")
            {
                return true;
            }

            Look();

            try
            {
                return _accounts != null && player?.Profile != null && int.TryParse(player.Profile.AccountId, out var account)
                    && _accounts.GetValue(null) is HashSet<int> known && known.Contains(account);
            }
            catch (Exception)
            {
                return false;
            }
        }
    }
}
