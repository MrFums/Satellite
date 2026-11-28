using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;

namespace Satellite.Client
{
    // The normal recorder only needs the evidence that can change an action label. Full recording keeps the original.
    // This runs on CometLog's single send worker. Reset samples separate two actions at the same door or in the same fight.
    internal sealed class CometActionSamples
    {
        private readonly Dictionary<string, JObject> _last = new Dictionary<string, JObject>();
        private string _raid;

        internal static string Trace(string feature)
        {
            switch (feature)
            {
                case "M03": return "cornerPeek";
                case "M06": return "cornerPrefire";
                case "M11": return "retreatWeave";
                case "M12": return "tacticalJump";
                case "M14": return "coverFeint";
                case "D02": return "doorJumpPeek";
                case "D04": return "doorStepPeek";
                case "D05": return "doorFakeGrenade";
                case "D06": return "doorFakeMedical";
                case "D07": case "D08": return "doorRoomClear";
                default: return null;
            }
        }

        // COMET publishes minified JSON. Skip negative observations before parsing the accompanying settings.
        // When the previous sample was positive, read the next one so the replay also gets the end of that run.
        internal bool NeedsSample(string raid, string pid, string feature, string json)
        {
            if (_raid != raid) { _last.Clear(); _raid = raid; }
            if (_last.Count != 0 && _last.ContainsKey(pid + "|" + feature)) return true;
            string mark;
            switch (feature)
            {
                case "M03": mark = "\"openObserved\":true"; break;
                case "M11": mark = "\"moveRequested\":true"; break;
                case "M12": case "D02": mark = "\"takeoffObserved\":true"; break;
                case "M14": return json.Contains("\"animationObserved\":true") || json.Contains("\"exposedObserved\":true");
                case "D04": mark = "\"looking\":true"; break;
                case "D05": case "D06": mark = "\"handsObserved\":true"; break;
                case "D07": case "D08": mark = "\"thresholdCrossed\":true"; break;
                default: return true;
            }
            return json.IndexOf(mark, StringComparison.Ordinal) >= 0;
        }

        private static void Copy(JObject dest, JObject src, params string[] names)
        {
            foreach (var name in names)
            {
                if (src[name] is JValue v && v.Type != JTokenType.Null) dest[name] = v;
            }
        }

        // Only the direction of lateral travel matters. Keep speed and yaw noise out of the recording.
        private static int Turn(double angle) => Math.Abs(angle) >= 5 && Math.Abs(angle) <= 85 ? Math.Sign(angle) * 45 : 0;

        internal JObject Changed(string pid, string feature, string key, JObject data)
        {
            if (pid.Length == 0 || !(data[key] is JObject src)) return null;
            var s = new JObject();
            switch (feature)
            {
                case "M03":
                    if ((bool?)src["openObserved"] == true && (int?)src["peeks"] > 0)
                        Copy(s, src, "episode", "peeks", "openObserved");
                    break;
                case "M06":
                    if ((int?)src["actualShots"] > 0) Copy(s, src, "episode", "actualShots");
                    break;
                case "M11":
                    if ((bool?)src["moveRequested"] == true && (string)src["state"] == "evading" && (double?)src["speed"] > 0)
                    {
                        var yaw = Turn((double?)src["yaw"] ?? 0);
                        if (yaw != 0 && Turn((double?)src["observedYaw"] ?? 0) == yaw)
                        {
                            Copy(s, src, "context", "state", "moveRequested");
                            s["yaw"] = s["observedYaw"] = yaw;
                            s["speed"] = 1;
                        }
                    }
                    break;
                case "M12":
                    if ((bool?)src["takeoffObserved"] == true) Copy(s, src, "attempt", "sourceFeature", "takeoffObserved");
                    break;
                case "M14":
                    if ((bool?)src["animationObserved"] == true || (bool?)src["exposedObserved"] == true)
                        Copy(s, src, "episode", "animationObserved", "magazineAccepted", "movementObserved", "exposedObserved");
                    break;
                case "D02":
                    if ((bool?)src["takeoffObserved"] == true) Copy(s, src, "door", "target", "takeoffObserved");
                    break;
                case "D04":
                    if ((bool?)src["arrived"] == true && (bool?)src["looking"] == true) Copy(s, src, "door", "target", "peek", "arrived", "looking");
                    break;
                case "D05": case "D06":
                    if ((string)src["state"] == "completed" && (bool?)src["handsObserved"] == true)
                    {
                        Copy(s, src, "opportunity", "state", "handsObserved");
                        if (src["medical"] is JObject med)
                        {
                            var result = new JObject();
                            Copy(result, med, "consumptionObserved", "medicalHandoff");
                            s["medical"] = result;
                        }
                    }
                    break;
                case "D07": case "D08":
                    if ((bool?)src["movementObserved"] == true && (bool?)src["thresholdCrossed"] == true)
                        Copy(s, src, "door", "target", "movementObserved", "thresholdCrossed");
                    break;
            }

            var who = pid + "|" + feature;
            _last.TryGetValue(who, out var before);
            if (!s.HasValues)
            {
                if (before == null) return null;
                _last.Remove(who);
            }
            else
            {
                if (JToken.DeepEquals(before, s)) return null;
                _last[who] = s;
            }
            return new JObject { ["feature"] = feature, ["stage"] = "evaluated", [key] = s };
        }
    }
}
