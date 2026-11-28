#if RECORDING
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Satellite.Server;

// Read the existing gzip sidecar. The cursor is the row in recording order, so events with
// the same timestamp, late events and configuration definitions cannot move between pages.
internal static class CometDebugPage
{
    internal const int PageSize = 24;

    internal static async Task<JsonObject> Read(StreamReader reader, string profile, string filter, long at,
        int cursor, bool reports, CancellationToken token)
    {
        var definitions = new Dictionary<int, string>();
        var rows = new JsonArray();
        int ordinal = 0, unresolved = 0, malformed = 0;
        int? next = null;
        bool partial = false;
        try
        {
            while (await reader.ReadLineAsync(token) is { } line)
            {
                if (line.StartsWith("c\t", StringComparison.Ordinal))
                {
                    int end = line.IndexOf('\t', 2);
                    if (end > 2 && int.TryParse(line.AsSpan(2, end - 2), out int key))
                        definitions[key] = line[(end + 1)..];
                    continue;
                }
                int row = ordinal++;
                if (row < cursor) continue;
                int a = line.IndexOf('\t'), b = a < 0 ? -1 : line.IndexOf('\t', a + 1);
                int c = b < 0 ? -1 : line.IndexOf('\t', b + 1), d = c < 0 ? -1 : line.IndexOf('\t', c + 1);
                if (d < 0 || !long.TryParse(line.AsSpan(0, a), out long time)) { malformed++; continue; }
                if (time < at || profile.Length > 0 && !line.AsSpan(a + 1, b - a - 1).SequenceEqual(profile)) continue;
                var summary = line.AsSpan(c + 1, d - c - 1).SequenceEqual("summary");
                if (summary != reports) continue;
                if (filter.Length > 0 && !line.Contains(filter, StringComparison.OrdinalIgnoreCase) && !line.Contains('\\')) continue;
                try
                {
                    if (JsonNode.Parse(line[(d + 1)..]) is not JsonObject data) { malformed++; continue; }
                    if (filter.Length > 0 && !line.AsSpan(a + 1, b - a - 1).Contains(filter, StringComparison.OrdinalIgnoreCase) &&
                        !new[] { "feature", "stage", "decision", "reason", "profileId", "name" }
                        .Any(k => data[k]?.ToString().Contains(filter, StringComparison.OrdinalIgnoreCase) == true)) continue;
                    if (!reports && rows.Count == PageSize) { next = row; break; }
                    foreach (var (key, value) in data.ToArray())
                    {
                        if (!key.EndsWith("Config", StringComparison.Ordinal) || value is not JsonObject obj ||
                            obj["$c"] is not JsonValue reference || !reference.TryGetValue<int>(out var index)) continue;
                        if (definitions.TryGetValue(index, out var definition)) data[key] = JsonNode.Parse(definition);
                        else unresolved++;
                    }
                    rows.Add(new JsonObject { ["t"] = time, ["p"] = line[(a + 1)..b], ["d"] = data });
                }
                catch (JsonException) { malformed++; }
            }
        }
        catch (IOException) { partial = true; }
        catch (InvalidDataException) { partial = true; }
        return new JsonObject { ["ev"] = rows, ["next"] = next, ["partial"] = partial,
            ["unresolved"] = unresolved, ["malformed"] = malformed };
    }
}
#endif
