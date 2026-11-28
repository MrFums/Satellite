using System;
using System.Collections.Generic;
using HarmonyLib;
using UnityEngine;

namespace Satellite.Client
{
    internal static class ContactSharing
    {
        private struct Report
        {
            public object Source;
            public bool Seen;
        }

        [ThreadStatic] private static Report _current;
        private static readonly Dictionary<(string from, string to, string target, bool seen), float> LastReceipt =
            new Dictionary<(string, string, string, bool), float>();

        internal static void Forget() => LastReceipt.Clear();

        internal static void Hook(Harmony harmony)
        {
            const string enemyTypes = "SAIN.SAINComponent.Classes.EnemyClasses.";
            var squad = Types.Find("SAIN.BotController.Classes.Squad");
            if (squad == null) return;
            try
            {
                var enemy = Types.Find(enemyTypes + "Enemy");
                var place = Types.Find(enemyTypes + "EnemyPlace");
                var places = Types.Find(enemyTypes + "EnemyKnownPlaces");
                var send = AccessTools.Method(squad, "ReportEnemyPosition", new[] { enemy, place, typeof(bool), typeof(float) });
                var accept = AccessTools.Method(places, "SetLastKnown", new[] { place, typeof(float) });
                if (send == null || accept == null) throw new MissingMethodException("SAIN contact reporting");
                harmony.Patch(accept, postfix: new HarmonyMethod(typeof(ContactSharing), nameof(Accepted)));
                harmony.Patch(send, prefix: new HarmonyMethod(typeof(ContactSharing), nameof(Begin)),
                    finalizer: new HarmonyMethod(typeof(ContactSharing), nameof(End)));
            }
            catch (Exception e) { Plugin.Log.LogWarning($"Squad contact sharing is unavailable: {e.Message}"); }
        }

        private static void Begin(object __0, bool __2, out Report __state)
        {
            __state = _current;
            _current = World.Watched && !World.BrainsOff && Events.Raid.Length != 0
                ? new Report { Source = __0, Seen = __2 } : default;
        }

        private static void End(Report __state) => _current = __state;

        private static void Accepted(object __instance, object __0, bool __runOriginal)
        {
            var report = _current;
            if (report.Source == null || !__runOriginal || __0 == null) return;
            // Direct sightings, already-visible enemies and reports declined by another mod are not deliveries.
            if (!ReferenceEquals(__0, Hooks.Get(__instance, report.Seen ? "LastSquadSeenPlace" : "LastSquadHeardPlace"))
                || !ReferenceEquals(__0, Hooks.Get(__instance, "LastKnownPlace"))) return;
            var enemy = Hooks.Get(__instance, "Enemy");
            var target = Hooks.Text(report.Source, "EnemyProfileId");
            if (target.Length == 0 || target != Hooks.Text(enemy, "EnemyProfileId")) return;
            var from = Hooks.Text(Hooks.Get(report.Source, "Bot"), "ProfileId");
            var to = Hooks.Text(Hooks.Get(enemy, "Bot"), "ProfileId");
            if (from.Length == 0 || to.Length == 0 || from == to) return;

            var key = (from, to, target, report.Seen);
            var now = Time.realtimeSinceStartup;
            var ongoing = LastReceipt.TryGetValue(key, out var last) && now - last < 4f;
            LastReceipt[key] = now;
            if (!ongoing) Write(from, to, target, report.Seen, now);
        }

        private static void Write(string from, string to, string target, bool seen, float now)
        {
            Events.Add("bot.share", from, null, now, json =>
            {
                json.Append("{\"to\":");
                World.Text(json, to);
                json.Append(",\"target\":");
                World.Text(json, target);
                json.Append(seen ? ",\"seen\":true}" : ",\"seen\":false}");
            });
        }
    }
}
