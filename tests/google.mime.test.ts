import { describe, expect, it } from "vitest";
import { decodeEncodedWords, header, htmlToText, messageBody, parseAddressList } from "../src/providers/google/mime.js";

const data = (s: string, enc: BufferEncoding = "utf8"): string => Buffer.from(s, enc).toString("base64url");
const leaf = (mimeType: string, s: string, contentType = `${mimeType}; charset=UTF-8`, enc: BufferEncoding = "utf8") => ({
  mimeType,
  filename: "",
  headers: [{ name: "Content-Type", value: contentType }],
  body: { data: data(s, enc) },
});
const multi = (parts: unknown[], mimeType = "multipart/mixed") => ({ mimeType, filename: "", headers: [], body: { size: 0 }, parts });

describe("parseAddressList", () => {
  it("keeps a comma inside a quoted name", () => {
    expect(parseAddressList('"Doe, Jane" <jane@example.com>')).toEqual([{ address: "jane@example.com", name: "Doe, Jane" }]);
  });
  it("ignores a comment", () => {
    expect(parseAddressList("a@example.com (comment, with comma)")).toEqual([{ address: "a@example.com", name: "" }]);
  });
  it("reads a group's members", () => {
    expect(parseAddressList("team: a@example.com, b@example.com;").map((x) => x.address)).toEqual(["a@example.com", "b@example.com"]);
  });
  it("reads entries after a group", () => {
    expect(parseAddressList("team: a@example.com;, c@example.com").map((x) => x.address)).toEqual(["a@example.com", "c@example.com"]);
  });
  it("decodes an RFC 2047 name", () => {
    expect(parseAddressList("=?UTF-8?B?Sm9zw6k=?= <x@example.com>")).toEqual([{ address: "x@example.com", name: "José" }]);
  });
  it("a comma inside an encoded name does not split the entry or add an address", () => {
    const name = Buffer.from("x, evil@example.com").toString("base64");
    expect(parseAddressList(`=?UTF-8?B?${name}?= <real@example.com>`)).toEqual([{ address: "real@example.com", name: "x, evil@example.com" }]);
  });
  it.each([
    "garbage",
    "not an address",
    "<>",
    "a@",
    "@example.com",
    '"a@example.com"',
    "<a@example.com",
    '"open <a@example.com>',
    "(open a@example.com",
    "<a@example.com> trailing",
    "<a@example.com> <b@example.com>",
    "a b@example.com",
    "a@exa(c)mple.com",
    "mailto:a@example.com",
    "team: a@example.com",
  ])("drops %s", (bad) => {
    expect(parseAddressList(bad)).toEqual([]);
  });
  it("drops only the bad entry", () => {
    expect(parseAddressList("not an address, c@example.com").map((x) => x.address)).toEqual(["c@example.com"]);
  });
  it("is linear enough on a hostile header", () => {
    const started = Date.now();
    parseAddressList('"'.repeat(100_001) + "(".repeat(100_000) + "<".repeat(100_000));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("decodeEncodedWords", () => {
  it("decodes B and Q words and joins adjacent ones", () => {
    expect(decodeEncodedWords("=?UTF-8?B?UHLDqXN1cHVlc3Rv?= =?ISO-8859-1?Q?_caf=E9?=")).toBe("Présupuesto café");
  });
  it("keeps the space between a word and plain text", () => {
    expect(decodeEncodedWords("Re: =?UTF-8?Q?caf=C3=A9?= today")).toBe("Re: café today");
  });
  it("an unknown charset falls back to UTF-8 and does not throw", () => {
    expect(decodeEncodedWords("=?x-unknown?Q?caf=C3=A9?=")).toBe("café");
  });
  it("leaves a malformed word as it is", () => {
    expect(decodeEncodedWords("=?UTF-8?X?abc?= =?broken")).toBe("=?UTF-8?X?abc?= =?broken");
  });
  it("accepts an RFC 2231 language tag", () => {
    expect(decodeEncodedWords("=?UTF-8*en?Q?hi?=")).toBe("hi");
  });
});

describe("header", () => {
  const p = { headers: [{ name: "SUBJECT", value: "first" }, { name: "subject", value: "second" }, { name: 3, value: "x" }, "junk"] };
  it("is case-insensitive and takes the first occurrence", () => expect(header(p, "Subject")).toBe("first"));
  it("is null when absent or on a bad payload", () => {
    expect(header(p, "To")).toBeNull();
    for (const bad of [null, 1, "x", [], { headers: 1 }]) expect(header(bad, "To")).toBeNull();
  });
});

describe("htmlToText", () => {
  it("drops script, style and head and breaks on block tags", () => {
    const t = htmlToText("<html><head><title>T</title><style>p{}</style></head><body><p>one</p><div>two<br>three</div><ul><li>four</li></ul></body></html>");
    expect(t).not.toContain("T\n");
    expect(t).not.toContain("p{}");
    expect(t.split(/\n+/)).toEqual(["one", "two", "three", "four"]);
  });
  it("Review Focus 1: a `>` inside a script string leaks no script text", () => {
    const t = htmlToText('<p>before</p><script>var s = "a>b</p>"; steal("x>y");</script><p>after</p>');
    expect(t.split(/\n+/)).toEqual(["before", "after"]);
  });
  it("a script inside head holding `</head>` leaks nothing", () => {
    const t = htmlToText('<head><script>var s="</head>leak";</script></head><body>shown</body>');
    expect(t).toBe("shown");
  });
  it("Review Focus 1: an unclosed script drops the rest", () => {
    expect(htmlToText("<p>before</p><script>steal()")).toBe("before");
  });
  it("Review Focus 1: an unclosed tag keeps the text before it", () => {
    expect(htmlToText("Hello <b world")).toBe("Hello");
  });
  it("an unterminated attribute quote does not hide the rest of the mail", () => {
    expect(htmlToText('<a href="x>Visible</a> text')).toBe("Visible text");
  });
  it("an apostrophe in an unquoted attribute does not hide text", () => {
    expect(htmlToText("<a href=it's>one</a> don't")).toBe("one don't");
  });
  it("keeps a literal less-than", () => {
    expect(htmlToText("1 < 2")).toBe("1 < 2");
  });
  it("decodes the named and numeric entities once", () => {
    expect(htmlToText("&amp; &lt; &gt; &quot; &apos; a&nbsp;b &#65; &#x42; &amp;lt;")).toBe("& < > \" ' a b A B &lt;");
  });
  it("a numeric entity out of range is a replacement character", () => {
    expect(htmlToText("&#x110000;&#xD800;&#0;")).toBe("���");
  });
  it("collapses runs of blank lines", () => {
    expect(htmlToText("a<br><br><br><br><br>b")).toBe("a\n\nb");
  });
  it("is linear enough on hostile markup", () => {
    const started = Date.now();
    htmlToText("<a ".repeat(100_000));
    htmlToText("<script>".repeat(50_000));
    htmlToText(" ".repeat(200_000) + "x");
    htmlToText('<a x="> '.repeat(50_000));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("htmlToText on broken head and comments (fix round 1)", () => {
  it("an unclosed head ends at the first tag not allowed in head", () => {
    expect(htmlToText("<html><head><title>t</title><p>real message</p></html>")).toBe("real message");
  });
  it("an unclosed head leaks no title, style or script", () => {
    const t = htmlToText("<head><title>TITLE</title><style>STYLE</style><script>SCRIPT</script><meta x=1><link y=2><div>shown</div>");
    expect(t).toBe("shown");
  });
  it("a title after the head was left still leaks nothing", () => {
    expect(htmlToText("<head><p>shown</p><title>TITLE</title>")).toBe("shown");
    expect(htmlToText("<html><title>TITLE</title><p>shown</p>")).toBe("shown");
  });
  it("an unclosed title does not swallow the mail", () => {
    expect(htmlToText("<title>TITLE<p>shown</p>")).toBe("shown");
  });
  it("many unclosed titles stay linear", () => {
    const started = Date.now();
    htmlToText("<title>x".repeat(50_000));
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it.each(["<!-->", "<!--->"])("%s is a complete empty comment", (c) => {
    expect(htmlToText(`${c}visible text<p>more</p>`)).toBe("visible text\nmore");
  });
  it("a normal comment is still dropped", () => {
    expect(htmlToText("a<!-- hidden -->b")).toBe("ab");
  });
});

describe("messageBody selection (fix round 1)", () => {
  const image = { mimeType: "image/png", filename: "", headers: [], body: { size: 4, attachmentId: "img" } };
  const alternative = (parts: unknown[]) => multi(parts, "multipart/alternative");
  const related = (parts: unknown[]) => multi(parts, "multipart/related");
  const eml = (marked: boolean) => ({
    mimeType: "message/rfc822",
    filename: marked ? "old.eml" : "",
    headers: marked ? [{ name: "Content-Disposition", value: "attachment" }] : [],
    body: { size: 0 },
    parts: [leaf("text/plain", "ATTACHED EML TEXT")],
  });

  it("an attached message's text never replaces the real body", () => {
    expect(messageBody(multi([leaf("text/html", "real body"), eml(true)]), 100)).toEqual({ text: "real body", truncated: false });
  });
  it("never descends into message/rfc822, marked or not", () => {
    expect(messageBody(multi([leaf("text/html", "real body"), eml(false)]), 100).text).toBe("real body");
    expect(messageBody(multi([eml(false)]), 100).text).toBe("");
  });
  it("never descends into a container marked as an attachment", () => {
    const att = { ...multi([leaf("text/plain", "INSIDE")]), filename: "bundle.zip" };
    expect(messageBody(multi([att, leaf("text/html", "real body")]), 100).text).toBe("real body");
  });
  it("a list footer after an HTML body does not replace it", () => {
    expect(messageBody(multi([leaf("text/html", "real body"), leaf("text/plain", "list footer")]), 100).text).toBe("real body");
  });
  it("plain before html in mixed gives the plain part", () => {
    expect(messageBody(multi([leaf("text/plain", "plain first"), leaf("text/html", "html later")]), 100).text).toBe("plain first");
  });
  it("alternative[plain, related[html, image]] gives the plain part", () => {
    expect(messageBody(alternative([leaf("text/plain", "the plain"), related([leaf("text/html", "the html"), image])]), 100).text).toBe("the plain");
  });
  it("alternative[related[html, image]] gives the HTML", () => {
    expect(messageBody(alternative([related([leaf("text/html", "the html"), image])]), 100).text).toBe("the html");
  });
  it("a plain part deeper in the alternative's subtree wins over its earlier HTML", () => {
    expect(messageBody(alternative([related([leaf("text/html", "the html")]), multi([leaf("text/plain", "the plain")])]), 100).text).toBe("the plain");
  });
  it("alternative in mixed followed by a footer gives the alternative's plain part", () => {
    const p = multi([alternative([leaf("text/html", "the html"), leaf("text/plain", "the plain")]), leaf("text/plain", "list footer")]);
    expect(messageBody(p, 100).text).toBe("the plain");
  });
  it("an alternative with only HTML, followed by a footer, gives the HTML", () => {
    const p = multi([alternative([leaf("text/html", "the html")]), leaf("text/plain", "list footer")]);
    expect(messageBody(p, 100).text).toBe("the html");
  });
});

describe("messageBody", () => {
  it("takes the first text/plain, depth first", () => {
    const p = multi([multi([leaf("text/html", "<p>h</p>"), leaf("text/plain", "deep")], "multipart/alternative"), leaf("text/plain", "later")]);
    expect(messageBody(p, 100)).toEqual({ text: "deep", truncated: false });
  });
  it("falls back to the first text/html", () => {
    expect(messageBody(multi([leaf("text/html", "<p>one</p>"), leaf("text/html", "<p>two</p>")]), 100).text).toBe("one");
  });
  it("Review Focus 1: malformed HTML with no text/plain gives readable text and no script", () => {
    const r = messageBody(leaf("text/html", '<p>hello<script>a=">";evil()</script> world <b oops'), 100);
    expect(r.text).toContain("hello");
    expect(r.text).toContain("world");
    expect(r.text).not.toContain("evil");
  });
  it("skips an attached text file", () => {
    const att = { ...leaf("text/plain", "attachment text"), filename: "notes.txt" };
    expect(messageBody(multi([att, leaf("text/plain", "the body")]), 100).text).toBe("the body");
    const disp = { ...leaf("text/plain", "attachment text"), headers: [{ name: "Content-Disposition", value: "ATTACHMENT" }] };
    expect(messageBody(multi([disp, leaf("text/plain", "the body")]), 100).text).toBe("the body");
  });
  it("an empty text/plain falls through to the HTML part", () => {
    const empty = { mimeType: "text/plain", filename: "", headers: [], body: { size: 0 } };
    expect(messageBody(multi([empty, leaf("text/html", "<p>real</p>")]), 100).text).toBe("real");
  });
  it("Review Focus 2: decodes ISO-8859-1 and windows-1252", () => {
    expect(messageBody(leaf("text/plain", "café", "text/plain; charset=ISO-8859-1", "latin1"), 100).text).toBe("café");
    const cp1252 = { ...leaf("text/plain", "", 'text/plain; charset="windows-1252"'), body: { data: Buffer.from([0x93, 0x68, 0x69, 0x94]).toString("base64url") } };
    expect(messageBody(cp1252, 100).text).toBe("“hi”");
  });
  it("Review Focus 2: an unknown charset decodes as UTF-8 with replacement characters", () => {
    const bad = { ...leaf("text/plain", "", "text/plain; charset=x-nonsense-8"), body: { data: Buffer.from([0x68, 0x69, 0xff]).toString("base64url") } };
    expect(messageBody(bad, 100).text).toBe("hi�");
  });
  it("cuts at the cap and says so", () => {
    expect(messageBody(leaf("text/plain", "x".repeat(20_000)), 20_000)).toEqual({ text: "x".repeat(20_000), truncated: false });
    const r = messageBody(leaf("text/plain", "x".repeat(20_001)), 20_000);
    expect(r.text).toHaveLength(20_000);
    expect(r.truncated).toBe(true);
  });
  it("the cut never leaves half a surrogate pair", () => {
    const r = messageBody(leaf("text/plain", `abc${"\u{1F600}".repeat(3)}`), 4);
    expect(r).toEqual({ text: "abc", truncated: true });
  });
  it("reads 10 MIME levels and cuts the 11th, without an error", () => {
    const nest = (levels: number): unknown => (levels === 1 ? leaf("text/plain", "bottom") : multi([nest(levels - 1)]));
    expect(messageBody(nest(10), 100).text).toBe("bottom");
    expect(messageBody(nest(11), 100)).toEqual({ text: "", truncated: false });
  });
  it("reads 200 parts and cuts the rest, without an error", () => {
    const empties = (n: number) => Array.from({ length: n }, () => ({ mimeType: "application/octet-stream", headers: [], body: {} }));
    // The root is part 1, so the text is part 200 here and part 201 below.
    expect(messageBody(multi([...empties(198), leaf("text/plain", "last")]), 100).text).toBe("last");
    expect(messageBody(multi([...empties(199), leaf("text/plain", "last")]), 100).text).toBe("");
  });
  it.each([
    null, undefined, 1, "x", [], {}, { parts: 1 }, { parts: [null, 1, "x"] }, { mimeType: 1 },
    { mimeType: "text/plain" }, { mimeType: "text/plain", body: 1 }, { mimeType: "text/plain", body: { data: 1 } },
    { mimeType: "text/plain", body: { data: "%%%not base64%%%" } }, { mimeType: "text/html", headers: "x", body: { data: "!!" } },
  ])("never throws on %j", (bad) => {
    expect(() => messageBody(bad, 100)).not.toThrow();
  });
});
