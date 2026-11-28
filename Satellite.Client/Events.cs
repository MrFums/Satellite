using System;
using System.Collections.Generic;
using System.Text;
using UnityEngine;

namespace Satellite.Client
{
    // Things that happen in a raid, each said once, beside the report of where everybody is (which only says how the
    // raid is now). Every one has the raid it belongs to, its number in that raid, when on the raid's clock it
    // happened, its kind and whose it is: {"n":12,"t":83400,"k":"comet.squad","p":"<profile id>","nm":"<name>","d":{...}}.
    // They ride the next full report (",\"rid\":\"...\",\"clk\":83950,\"ev\":[...]") and the server keeps the raid's
    // latest for a page opened later. Nothing is kept here while nobody is looking.
    internal static class Events
    {
        private const int Most = 200;

        private static readonly List<string> Waiting = new List<string>();
        private static readonly StringBuilder One = new StringBuilder(256);
        private static string _raid = "";
        private static float _began;
        private static long _number;
        private static bool _in;
        // the raid just left, and what was still waiting to be told of it
        private static readonly List<string> _last = new List<string>();
        private static string _lastRaid = "";
        private static long _lastClock;
        private static float _lastBegan;

        // the raid these belong to: a new id each raid, empty out of one
        internal static string Raid => _raid;

        // told at every report whether the game is in a raid: a raid's id and clock start when it's first seen in one
        internal static void Tick(bool raid)
        {
            if (raid == _in)
            {
                return;
            }

            if (!raid && !World.BrainsOff) Brains.Sort();
            _in = raid;
            // out of the raid: what happened in its last moments (how it ended) still goes out, with the next report.
            // The raid left is kept even with nothing waiting: the game may say how it ended a moment after
            _last.Clear();
            _lastRaid = raid ? "" : _raid;
            if (!raid)
            {
                _last.AddRange(Waiting);
                _lastClock = Clock(Time.realtimeSinceStartup);
                _lastBegan = _began;
            }

            Waiting.Clear();
            _number = 0;
            _raid = raid ? Guid.NewGuid().ToString("N") : "";
            _began = Time.realtimeSinceStartup;
            Brains.Forget();
            ContactSharing.Forget();
            if (raid) CometLog.RaidStarted(_raid, _began);
            else
            {
                CometLog.RaidLeft();
            }
        }

        // the raid things said now belong to, and when its clock began: the one going on, else the one just left
        internal static bool ClockOf(out string raid, out float began)
        {
            raid = _raid.Length > 0 ? _raid : _lastRaid;
            began = _raid.Length > 0 ? _began : _lastBegan;
            return !string.IsNullOrEmpty(raid);
        }

        // milliseconds on the raid's clock at a moment of the game's own (Time.realtimeSinceStartup)
        private static long Clock(float realtime)
        {
            return Math.Max(0L, (long)((realtime - _began) * 1000f));
        }

        // detail writes the event's own part, a JSON object
        internal static void Add(string kind, string profileId, string name, float realtime, Action<StringBuilder> detail)
        {
            // how the raid ended, told by the game just after the raid was left: it goes with the raid left
            var late = !_in && kind == "end" && _lastRaid.Length > 0;
            if ((!_in && !late) || detail == null)
            {
                return;
            }

            One.Length = 0;
            One.Append("{\"n\":").Append(++_number).Append(",\"t\":").Append(late ? Math.Max(0L, (long)((realtime - _lastBegan) * 1000f)) : Clock(realtime)).Append(",\"k\":");
            World.Text(One, kind);
            if (!string.IsNullOrEmpty(profileId))
            {
                One.Append(",\"p\":");
                World.Text(One, profileId);
            }

            if (!string.IsNullOrEmpty(name))
            {
                One.Append(",\"nm\":");
                World.Text(One, name);
            }

            One.Append(",\"d\":");
            detail(One);
            One.Append('}');
            if (late)
            {
                _last.Add(One.ToString());
                return;
            }

            if (Waiting.Count >= Most)
            {
                Waiting.RemoveAt(0);
            }

            Waiting.Add(One.ToString());
        }

        // whether the raid just left has something still to tell (how it ended): sent in a full report even while
        // nobody watches, as the raid's recording keeps it
        internal static bool Unsaid => !_in && _last.Count > 0;

        // into a full report: the raid, its clock now, and what happened since the last one
        internal static void Take(StringBuilder to)
        {
            if (!_in)
            {
                // the raid just left: ",\"rid\":its id,\"clk\",\"ev\":[...]" once, in a report that says "raid":false
                if (_last.Count > 0)
                {
                    to.Append(",\"rid\":");
                    World.Text(to, _lastRaid);
                    to.Append(",\"clk\":").Append(_lastClock).Append(",\"ev\":[");
                    for (var i = 0; i < _last.Count; i++)
                    {
                        if (i > 0)
                        {
                            to.Append(',');
                        }

                        to.Append(_last[i]);
                    }

                    to.Append(']');
                    _last.Clear();
                    _lastRaid = "";
                }

                return;
            }

            to.Append(",\"rid\":");
            World.Text(to, _raid);
            to.Append(",\"clk\":").Append(Clock(Time.realtimeSinceStartup));
            if (Waiting.Count == 0)
            {
                return;
            }

            to.Append(",\"ev\":[");
            for (var i = 0; i < Waiting.Count; i++)
            {
                if (i > 0)
                {
                    to.Append(',');
                }

                to.Append(Waiting[i]);
            }

            to.Append(']');
            Waiting.Clear();
        }
    }
}
