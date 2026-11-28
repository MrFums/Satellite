using System.Text;
using System.Text.Json.Nodes;
using Satellite.Server;

static async Task<JsonObject> Page(string archive, int cursor = 0, bool reports = false, string filter = "", string profile = "", long at = 0)
{
    using var reader = new StreamReader(new MemoryStream(Encoding.UTF8.GetBytes(archive)));
    return await CometDebugPage.Read(reader, profile, filter, at, cursor, reports, default);
}
static void Check(bool condition, string message)
{
    if (!condition) throw new InvalidDataException(message);
}

const string definition = "c\t7\t{\"count\":0,\"enabled\":false}";
var events = Enumerable.Range(0, 26).Select(i => "50\tp\tA02\tselected\t" +
    "{\"feature\":\"A02\",\"stage\":\"selected\",\"profileId\":\"p\",\"reason\":\"T\\u00e9st\",\"sequence\":" + i + ",\"moveConfig\":{\"$c\":7}}");
var archive = string.Join('\n', new[] { definition }.Concat(events)
    .Append("10\t\tC13\tcleanup\t{\"feature\":\"C13\"}")
    .Append("60\t\tT02\tsummary\t{\"feature\":\"T02\",\"stage\":\"summary\",\"reportConfig\":{\"$c\":7}}"));
var first = await Page(archive, filter: "tést", profile: "p", at: 50);
var second = await Page(archive, cursor: (int)first["next"]!, filter: "tést", profile: "p", at: 50);
var all = first["ev"]!.AsArray().Concat(second["ev"]!.AsArray()).ToArray();
Check(all.Length == 26 && second["next"] == null, "Page boundary lost records.");
for (int i = 0; i < all.Length; i++) {
    var data = all[i]!["d"]!;
    Check((int)data["sequence"]! == i && (int)data["moveConfig"]!["count"]! == 0 &&
        !(bool)data["moveConfig"]!["enabled"]!, "Order, shared configuration or zero value changed.");
}
var report = await Page(archive, reports: true);
Check(report["ev"]!.AsArray().Count == 1 && (int)report["unresolved"]! == 0 &&
    (int)report["ev"]![0]!["d"]!["reportConfig"]!["count"]! == 0, "Summary lost its shared configuration.");
Check((await Page(archive, filter: "C13"))["ev"]!.AsArray().Count == 1, "Raid event without profile was lost.");
Check((await Page(archive, filter: "C13", at: 20))["ev"]!.AsArray().Count == 0, "Late event ignored the time filter.");
var corrupt = await Page("bad line\n"+events.First());
Check((int)corrupt["malformed"]! == 1 && (int)corrupt["unresolved"]! == 1, "Partial archive appeared complete.");
var compact = await Page("10\tp\tA02\tstarted\t{\"feature\":\"A02\",\"decision\":\"Hold\"}", filter: "p");
Check((string?)compact["ev"]?[0]?["p"] == "p" && compact["ev"]?[0]?["d"]?["candidates"] == null, "Invented debug fields on an Essential recording.");
Console.WriteLine("Passed COMET debug archive checks.");
