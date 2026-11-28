using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace Satellite.Client
{
    // Every decision COMET makes, for the raid's recording (the replay's "why" for each bot): COMET says each one as a
    // line of JSON (Comet.Api.Decisions.Published). Each is only put by as it's said (COMET gives a listener a
    // millisecond), and once a second the lot goes to the server on a link of its own (api/link/comet), never with the
    // reports the pages are sent. Only while the server records the raid and asks for them (the push answer's "cm":
    // 1, each decision without its settings, the "...Config" parts; 2, all of it, and COMET's reports of the whole raid
    // as it's cleaned up, T01-T04: history.cometDebug). Nothing is kept while it's off.
    internal static class CometLog
    {
        // a decision longer than this is left out (COMET's own cap is 32 KiB)
        private const int MostLength = 32768;
        // what may wait for the link at most (a link that's down a long while): the oldest go
        private const int MostWaiting = 20000;
        // a message to the server at most this long (it takes 4 MB)
        private const int MostMessage = 1_500_000;

        // 0: none asked for; 1: decisions without their settings; 2: everything (see above). As the server asks now:
        // out of a raid it asks for none, but what COMET says of the raid just left (as it's cleaned up, its reports
        // of the whole raid) can arrive later. Each queue keeps its own raid id, clock and capture mode.
        internal static volatile int Mode;
        private const int AfterRaid = 120_000;
        private sealed class RaidQueue
        {
            internal readonly string Id;
            internal readonly float Began;
            internal List<string> Lines = new List<string>();
            internal string Session, SessionField;
            internal int CaptureMode, End;
            internal RaidQueue(string id, float began) { Id = id; Began = began; }
        }
        private static readonly object Gate = new object();
        private static RaidQueue _current;
        private static volatile RaidQueue _previous;
        private static volatile bool _hasLines;
        private static readonly Link Linked = new Link("comet");
        private static Delegate _listener;
        private static Delegate _summaryListener;
        private static Action _flushPending;
        private static bool _bound;
        private static volatile bool _sending;
        private static float _next;
        private static int _dropped;
        private static bool _saidDropped;

        internal static void Bind(Type decisions)
        {
            if (_bound || decisions == null)
            {
                return;
            }

            try
            {
                // (only the version of what it says that's known)
                var schema = decisions.GetField("SchemaVersion", BindingFlags.Public | BindingFlags.Static);
                var published = decisions.GetEvent("Published", BindingFlags.Public | BindingFlags.Static);
                if (published == null || schema == null || !(schema.GetRawConstantValue() is int version) || version != 1)
                {
                    return;
                }

                Action<string> hear = Hear;
                _listener = hear;
                published.AddEventHandler(null, _listener);
                // the reports of the whole raid, said once it's cleaned up (an older COMET has none)
                var summaries = decisions.GetEvent("SummaryPublished", BindingFlags.Public | BindingFlags.Static);
                if (summaries != null)
                {
                    Action<string> summary = HearSummary;
                    _summaryListener = summary;
                    summaries.AddEventHandler(null, _summaryListener);
                }

                var flush = decisions.GetMethod("FlushPending", BindingFlags.Public | BindingFlags.Static, null, Type.EmptyTypes, null);
                if (flush != null)
                {
                    _flushPending = (Action)Delegate.CreateDelegate(typeof(Action), flush);
                }

                _bound = true;
            }
            catch (Exception)
            {
                // without, then
            }
        }

        // On COMET's thread: put by, nothing more
        private static void Hear(string json)
        {
            if (json == null || json.Length > MostLength)
            {
                return;
            }

            Put(json);
        }

        // (on whichever thread COMET writes its reports from)
        private static void HearSummary(string json)
        {
            if (json == null || json.Length > MostLength)
            {
                return;
            }

            Put(json, true);
        }

        private static void Put(string json, bool summary = false)
        {
            var retired = _previous;
            if (Mode == 0 && (retired == null || retired.CaptureMode == 0 || unchecked(Environment.TickCount - retired.End) >= 0)) return;
            lock (Gate)
            {
                // A report can arrive after the final map packet, or even after another raid has started.
                // COMET puts the session near the front of each compact JSON object.
                var previous = _previous;
                bool grace = previous != null && unchecked(Environment.TickCount - previous.End) < 0;
                var target = _current;
                if (previous?.SessionField != null && (grace || summary) && json.IndexOf(previous.SessionField, 0,
                    Math.Min(192, json.Length), StringComparison.Ordinal) >= 0)
                {
                    if (!grace) return;
                    target = previous;
                }
                else if (target == null && grace && previous.Session == null)
                    target = previous;
                else if (grace && target?.SessionField != null && json.IndexOf(target.SessionField, 0,
                    Math.Min(192, json.Length), StringComparison.Ordinal) < 0)
                    return;
                if (target == null) return;
                int mode = target == _current ? Mode : target.CaptureMode;
                if (mode == 0 || summary && mode != 2) return;
                if (target.Session == null)
                {
                    var session = Peek(json, "session");
                    if (session.Length == 0) return;
                    target.Session = session;
                    target.SessionField = "\"session\":\"" + session + "\"";
                }
                target.CaptureMode = mode;
                if (target.Lines.Count >= MostWaiting)
                {
                    target.Lines.RemoveAt(0);
                    _dropped++;
                }
                target.Lines.Add(json);
                _hasLines = true;
            }
        }

        internal static void RaidStarted(string id, float began)
        {
            lock (Gate) _current = new RaidQueue(id, began);
        }

        internal static void RaidLeft()
        {
            lock (Gate)
            {
                if (_current == null) return;
                _previous = _current;
                _current = null;
                _previous.End = unchecked(Environment.TickCount + AfterRaid);
                if (Mode != 0) _previous.CaptureMode = Mode;
            }
            if (_previous.CaptureMode == 2 && _flushPending != null)
            {
                try { _flushPending(); }
                catch (Exception) { /* COMET may already have shut down. */ }
            }
        }

        // Drain the queue against the clock captured for that raid, even after Events.Take sent its final packet.
        internal static void Tick(float delta)
        {
            if (!_bound || !_hasLines && !_sending) return;
            Linked.Tick(delta);
            _next -= delta;
            if (!_hasLines || _next > 0f || _sending || !Linked.Open) return;
            _next = 1f;
            List<string> lines;
            RaidQueue target;
            lock (Gate)
            {
                target = _previous != null && _previous.Lines.Count > 0 ? _previous : _current;
                if (target == null || target.Lines.Count == 0) return;
                lines = target.Lines;
                target.Lines = new List<string>();
                _hasLines = (_current?.Lines.Count ?? 0) > 0 || (_previous?.Lines.Count ?? 0) > 0;
            }
            if (_dropped > 0 && !_saidDropped)
            {
                _saidDropped = true;
                Plugin.Log?.LogWarning($"COMET said more than Satellite could send to the server: {_dropped} of its decisions were left out of the raid's recording.");
            }
            var raid = target.Id;
            var began = target.Began;
            var full = target.CaptureMode == 2;
            _sending = true;
            Task.Run(() =>
            {
                try
                {
                    Send(lines, raid, began, full, 0);
                }
                catch (Exception)
                {
                    _sending = false;
                }
            });
        }

        // lines[from..] as messages of up to MostMessage, one after another (each waits for the last's answer)
        private static void Send(List<string> lines, string raid, float began, bool full, int from)
        {
            var to = new StringBuilder(64 * 1024);
            to.Append("{\"rid\":").Append(JsonConvert.ToString(raid)).Append(",\"ev\":[");
            var first = true;
            var i = from;
            for (; i < lines.Count && to.Length < MostMessage; i++)
            {
                var line = Line(lines[i], raid, began, full);
                if (line == null)
                {
                    continue;
                }

                if (!first)
                {
                    to.Append(',');
                }

                first = false;
                to.Append(line);
            }

            to.Append("]}");
            var bytes = Encoding.UTF8.GetBytes(to.ToString());
            var next = i;
            var sent = Linked.Send(bytes, bytes.Length, (ok, answer) =>
            {
                if (next < lines.Count)
                {
                    try
                    {
                        Send(lines, raid, began, full, next);
                        return;
                    }
                    catch (Exception)
                    {
                        // the rest are left out
                    }
                }

                _sending = false;
            });
            if (!sent)
            {
                _sending = false;
            }
        }

        // What the replay's Why panel reads, kept when not everything is asked for (about a twentieth of what COMET
        // says): its moves (A01-A13) as chosen, begun and let go, with each option weighed; its squads' plans
        // (S01-S11); what a move taught it, when it went well or badly (E04); its medical choices (H01); giving up a
        // search (P09); quick reloads (W04); and who's in control of the bot (T04), only when that changes.
        // Told by a look at the line's start, so the rest are never read.
        private static bool Wanted(string feature, string stage)
        {
            if (feature.Length != 3 || !char.IsDigit(feature[1]) || !char.IsDigit(feature[2]))
            {
                return false;
            }

            switch (feature[0])
            {
                case 'A':
                    return stage == "selected" || stage == "started" || stage == "released";
                case 'S':
                    return stage == "evaluated";
                default:
                    return stage == "evaluated" && (feature == "E04" || feature == "H01" || feature == "P09" || feature == "T04" || feature == "W04");
            }
        }

        // a text field's value, found without reading the line ("feature", "stage": near its start)
        private static string Peek(string json, string name)
        {
            var key = "\"" + name + "\":\"";
            var at = json.IndexOf(key, StringComparison.Ordinal);
            if (at < 0)
            {
                return "";
            }

            at += key.Length;
            var end = json.IndexOf('"', at);
            return end > at && end - at <= 64 ? json.Substring(at, end - at) : "";
        }

        // who was in control of each bot as last kept (T04), and of which raid
        private static readonly Dictionary<string, string> Control = new Dictionary<string, string>();
        private static readonly CometActionSamples ActionSamples = new CometActionSamples();
        private static string _controlRaid = "";

        // One decision as {"t":<ms on the raid's clock>,"p":whose (profile id),"f":feature,"s":stage,"d":{...}}: unless
        // full, only what the replay's Why tab shows (Wanted, Kept); null: left out
        private static string Line(string json, string raid, float began, bool full)
        {
            string feature = null, stage = null, trace = null;
            if (!full)
            {
                feature = Peek(json, "feature");
                stage = Peek(json, "stage");
                trace = stage == "evaluated" ? CometActionSamples.Trace(feature) : null;
                if (trace != null && Brains.GestureEvents) return null; // Confirmed actions ride the main recording.
                if (!Wanted(feature, stage) && (trace == null || json.IndexOf("\"" + trace + "\":", StringComparison.Ordinal) < 0))
                {
                    return null;
                }
            }

            if (trace != null && !ActionSamples.NeedsSample(raid, Peek(json, "profileId"), feature, json)) return null;

            JObject said;
            try
            {
                said = JObject.Parse(json);
            }
            catch (JsonException)
            {
                return null;
            }

            JObject action = null;
            if (trace != null)
            {
                try
                {
                    action = ActionSamples.Changed(Word(said, "profileId"), feature, trace, said);
                }
                catch (Exception ex) when (ex is FormatException || ex is InvalidCastException || ex is ArgumentException || ex is OverflowException)
                {
                    // A differently shaped trace from another COMET version must not discard the rest of the batch.
                    return null;
                }
                if (action == null) return null;
            }
            var realtime = said.Value<double?>("realtime");
            var t = realtime.HasValue ? Math.Max(0L, (long)((realtime.Value - began) * 1000.0)) : 0L;
            var head = "{\"t\":" + t + ",\"p\":" + JsonConvert.ToString(Word(said, "profileId")) + ",\"f\":" + JsonConvert.ToString(Word(said, "feature"))
                + ",\"s\":" + JsonConvert.ToString(Word(said, "stage")) + ",\"d\":";
            if (full)
            {
                return head + json + "}";
            }

            if (action != null) return head + action.ToString(Formatting.None) + "}";
            if (feature == "E04")
            {
                // (only a move that went well or badly: most come to nothing either way)
                var result = said["tacticalOutcome"]?["result"]?.ToString();
                if (result == null || result == "pending" || result == "neutral")
                {
                    return null;
                }
            }
            else if (feature == "T04")
            {
                // (who's in control, only when that changes)
                if (raid != _controlRaid)
                {
                    Control.Clear();
                    _controlRaid = raid;
                }

                var owner = said["controlJournal"]?["owner"]?.ToString() ?? "";
                var layer = said["controlJournal"]?["layer"]?.ToString() ?? "";
                var who = Word(said, "profileId");
                if (Control.TryGetValue(who, out var was) && was == owner + "|" + layer)
                {
                    return null;
                }

                Control[who] = owner + "|" + layer;
                return head + "{\"feature\":\"T04\",\"stage\":\"evaluated\",\"controlJournal\":{\"owner\":" + JsonConvert.ToString(owner)
                    + ",\"layer\":" + JsonConvert.ToString(layer) + "}}}";
            }

            return head + Kept(feature, stage, said).ToString(Formatting.None) + "}";
        }

        // Of a decision, only what the replay's Why tab shows (all the rest is COMET's own working: 20 times the size)
        private static JObject Kept(string feature, string stage, JObject said)
        {
            var kept = new JObject { ["feature"] = feature, ["stage"] = stage };
            Copy(said, kept, "decision", "reason");
            if (feature[0] == 'A')
            {
                // its options as weighed, once (when chosen; begun and let go say only what and why)
                if (stage == "selected" && said["candidates"] is JArray options && options.Count > 0)
                {
                    var list = new JArray();
                    foreach (var option in options)
                    {
                        if (option is JObject one)
                        {
                            var each = new JObject();
                            Copy(one, each, "decision", "score", "eligible", "reason");
                            list.Add(each);
                        }
                    }

                    kept["candidates"] = list;
                }

                // (a worse option picked on purpose, as its personality allows: which was best)
                var mistake = said["mixing"]?["mistake"] as JObject;
                if (stage == "selected" && mistake != null && mistake.Value<string>("state") == "mistake-selected")
                {
                    var why = new JObject();
                    Copy(mistake, why, "state", "best");
                    kept["mixing"] = new JObject { ["mistake"] = why };
                }
            }
            else if (feature[0] == 'S')
            {
                // its squad's plan: how far along it is
                foreach (var part in said.Properties())
                {
                    if (part.Value is JObject plan && (plan["state"] != null || plan["execution"] != null))
                    {
                        var each = new JObject();
                        Copy(plan, each, "state", "execution");
                        kept[part.Name] = each;
                    }
                }
            }
            else
            {
                string part = null;
                string[] fields = null;
                switch (feature)
                {
                    case "H01": part = "medicalChoice"; fields = new[] { "choice", "reason" }; break;
                    case "W04": part = "quickReload"; fields = new[] { "choice", "reason" }; break;
                    case "P09": part = "searchAbandonment"; fields = new[] { "state", "reason" }; break;
                    case "E04": part = "tacticalOutcome"; fields = new[] { "action", "result" }; break;
                }

                if (part != null && said[part] is JObject from)
                {
                    var each = new JObject();
                    Copy(from, each, fields);
                    kept[part] = each;
                }
            }

            return kept;
        }

        // the fields named that it has, and that say something (nothing, "" and false left out; a score of 0 kept)
        private static void Copy(JObject from, JObject to, params string[] names)
        {
            foreach (var name in names)
            {
                var v = from[name];
                if (v == null || v.Type == JTokenType.Null || v.Type == JTokenType.String && ((string)v).Length == 0 || v.Type == JTokenType.Boolean && !(bool)v)
                {
                    continue;
                }

                to[name] = v.Type == JTokenType.Float ? new JValue(Math.Round((double)v, 2)) : v.DeepClone();
            }
        }

        // a text field of it, without tabs or line ends (the server writes these as columns)
        private static string Word(JObject said, string name)
        {
            var value = said[name] as JValue;
            var text = value != null && value.Type == JTokenType.String ? (string)value : "";
            return (text.Length > 64 ? text.Substring(0, 64) : text).Replace('\t', ' ').Replace('\n', ' ').Replace('\r', ' ');
        }
    }
}
