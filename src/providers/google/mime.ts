import { ProviderError } from "../errors.js";
import type { MailAddress, NewDraft } from "../types.js";

/**
 * Parsers for attacker-controlled mail (M4b decision 5). None of them throws on bad input, and each scans its input
 * once, so a hostile message costs linear time. `buildDraftMime`, at the end, is the one writer.
 */

const MAX_DEPTH = 10;
const MAX_PARTS = 200;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** The value of the first header called `name` (any case), or null. */
export function header(payload: unknown, name: string): string | null {
  if (!isObj(payload) || !Array.isArray(payload.headers)) return null;
  const wanted = name.toLowerCase();
  for (const h of payload.headers as unknown[]) {
    if (isObj(h) && typeof h.name === "string" && h.name.toLowerCase() === wanted) {
      return typeof h.value === "string" ? h.value : null;
    }
  }
  return null;
}

/** Bytes to text under a charset label; an unknown label is read as UTF-8. Invalid bytes become U+FFFD. */
function decodeBytes(bytes: Uint8Array, charset: string | null): string {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

const hexDigit = (c: number): number => {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
};

/** RFC 2047 Q encoding: `_` is a space and `=XX` a byte. The word pattern has already limited `s` to ASCII. */
function qBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 95) {
      out[n++] = 0x20;
    } else if (c === 61 && i + 2 < s.length && hexDigit(s.charCodeAt(i + 1)) >= 0 && hexDigit(s.charCodeAt(i + 2)) >= 0) {
      out[n++] = hexDigit(s.charCodeAt(i + 1)) * 16 + hexDigit(s.charCodeAt(i + 2));
      i += 2;
    } else {
      out[n++] = c;
    }
  }
  return out.subarray(0, n);
}

const WORD = String.raw`=\?[^?\s*]+(?:\*[^?\s]*)?\?[bBqQ]\?[\x21-\x3e\x40-\x7e]*\?=`;
/** One encoded word, plus the white space before a following encoded word (RFC 2047 says it is not displayed). */
const ENCODED_WORD = new RegExp(String.raw`=\?([^?\s*]+)(?:\*[^?\s]*)?\?([bBqQ])\?([\x21-\x3e\x40-\x7e]*)\?=(?:\s+(?=${WORD}))?`, "g");

/** Decodes RFC 2047 words. Anything that is not a well-formed word stays as written. */
export function decodeEncodedWords(s: string): string {
  return s.replace(ENCODED_WORD, (_m, charset: string, encoding: string, text: string) => {
    const bytes = encoding.toLowerCase() === "b" ? Buffer.from(text, "base64") : qBytes(text);
    return decodeBytes(bytes, charset);
  });
}

const ADDRESS = /^[^\s\p{Cc}@<>()[\],;:"\\]+@[^\s\p{Cc}@<>()[\],;:"\\]+$/u;

interface Entry {
  phrase: string;
  angle: string | null;
  quoted: boolean;
  bad: boolean;
}
const newEntry = (): Entry => ({ phrase: "", angle: null, quoted: false, bad: false });

function finishEntry(e: Entry): MailAddress | null {
  if (e.bad) return null;
  if (e.angle === null) {
    // A bare address cannot be quoted: `"a@example.com"` is a name with no address.
    const address = e.phrase.trim();
    return !e.quoted && ADDRESS.test(address) ? { address, name: "" } : null;
  }
  const address = e.angle.trim();
  if (!ADDRESS.test(address)) return null;
  return { address, name: decodeEncodedWords(e.phrase.replace(/\s+/g, " ").trim()) };
}

/** Index of the closing `"` of the string opening at `open`, or -1. */
function closeQuote(s: string, open: number): number {
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === '"') return i;
  }
  return -1;
}

/** Index of the `)` closing the (nestable) comment opening at `open`, or -1. */
function closeComment(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/**
 * An RFC 5322 address list: quoted strings, comments, `<...>` and groups. Names are decoded after the list is split,
 * so an encoded comma cannot add an address. An entry that does not parse is dropped; an unterminated quote, comment
 * or `<` drops everything after it, and a group with no closing `;` drops its members. `clean` is false when anything
 * was dropped or the list used a group, which `buildDraftMime` never writes.
 */
function scanAddressList(list: string): { addresses: MailAddress[]; clean: boolean } {
  const out: MailAddress[] = [];
  let group: MailAddress[] | null = null;
  let clean = true;
  let e = newEntry();
  const flush = (): void => {
    const a = finishEntry(e);
    if (a !== null) (group ?? out).push(a);
    else if (e.bad || e.quoted || e.angle !== null || e.phrase.trim() !== "") clean = false;
    e = newEntry();
  };
  let i = 0;
  while (i < list.length) {
    const c = list[i]!;
    if (c === '"') {
      const end = closeQuote(list, i);
      if (end < 0) {
        e.bad = true;
        break;
      }
      if (e.angle !== null) e.bad = true;
      e.phrase += list.slice(i + 1, end).replace(/\\([\s\S])/g, "$1");
      e.quoted = true;
      i = end + 1;
    } else if (c === "(") {
      const end = closeComment(list, i);
      if (end < 0) {
        e.bad = true;
        break;
      }
      // A space, so a comment inside an address breaks it instead of joining its halves.
      if (e.angle === null) e.phrase += " ";
      i = end + 1;
    } else if (c === "<") {
      const end = list.indexOf(">", i);
      if (end < 0) {
        e.bad = true;
        break;
      }
      if (e.angle !== null) e.bad = true;
      e.angle = list.slice(i + 1, end);
      i = end + 1;
    } else if (c === ",") {
      flush();
      i++;
    } else if (c === ";") {
      flush();
      if (group !== null) out.push(...group);
      group = null;
      i++;
    } else if (c === ":") {
      clean = false;
      if (group === null && e.angle === null && !e.bad && e.phrase.trim() !== "") {
        group = [];
        e = newEntry();
      } else {
        e.bad = true;
      }
      i++;
    } else {
      if (e.angle === null) e.phrase += c;
      else if (!/\s/.test(c)) e.bad = true;
      i++;
    }
  }
  flush();
  return { addresses: out, clean };
}

/** The lenient reader for received mail: what parses, and nothing else. */
export const parseAddressList = (list: string): MailAddress[] => scanAddressList(list).addresses;

/**
 * A stored draft's recipients under one header name, for comparing with an approved plan. Null when the header is
 * repeated, is not text, or holds anything the lenient reader would drop: a recipient the approver never saw must not
 * vanish from the comparison. A missing header is an empty list.
 */
export function strictRecipients(payload: unknown, name: string): string[] | null {
  if (!isObj(payload) || !Array.isArray(payload.headers)) return [];
  const wanted = name.toLowerCase();
  const found = (payload.headers as unknown[]).filter(
    (h): h is Obj => isObj(h) && typeof h.name === "string" && h.name.toLowerCase() === wanted,
  );
  if (found.length === 0) return [];
  const value = found[0]!.value;
  if (found.length > 1 || typeof value !== "string") return null;
  const { addresses, clean } = scanAddressList(value);
  return clean ? addresses.map((a) => a.address) : null;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function codePoint(n: number): string {
  return n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? "\ufffd" : String.fromCodePoint(n);
}

/** One pass, so `&amp;lt;` is `&lt;` and never `<`. */
export const decodeEntities = (s: string): string =>
  s.replace(/&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,8})|(amp|lt|gt|quot|apos|nbsp));/g, (_m, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED[name]!;
    return codePoint(dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex!, 16));
  });

/** The tokenizer's position inside a tag: outside a value, just after `=`, or in a quoted value. */
const OUTSIDE = 0;
const AFTER_EQUALS = 1;
const IN_DOUBLE = 2;
const IN_SINGLE = 3;

/**
 * The `>` ending a tag. A quote opens an attribute value only right after `=`, as in the HTML tokenizer. If a quote
 * never closes, the first `>` ends the tag, so a broken attribute cannot hide the rest of the mail. -1 when no `>`.
 *
 * `seen` holds, per position, the states an earlier scan of this text passed through. A scan that ended at a `>` moved
 * the parser past everything it saw, so meeting a seen state means that earlier scan ran off the end, and this one
 * would too. Each position is scanned at most once per state, which keeps a whole document linear.
 */
function tagEnd(html: string, from: number, seen: Uint8Array): number {
  let state = OUTSIDE;
  for (let i = from; i < html.length; i++) {
    const bit = 1 << state;
    if ((seen[i]! & bit) !== 0) break;
    seen[i]! |= bit;
    const c = html[i]!;
    if (state === IN_DOUBLE || state === IN_SINGLE) {
      if (c === (state === IN_DOUBLE ? '"' : "'")) state = OUTSIDE;
    } else if (c === ">") {
      return i;
    } else if (state === AFTER_EQUALS && c === '"') {
      state = IN_DOUBLE;
    } else if (state === AFTER_EQUALS && c === "'") {
      state = IN_SINGLE;
    } else if (c === "=") {
      state = AFTER_EQUALS;
    } else if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r" && c !== "\f") {
      state = OUTSIDE;
    }
  }
  return html.indexOf(">", from);
}

/** As in the HTML tokenizer: a tag name runs until HTML whitespace, `/` or `>`. */
const TAG_NAME = /<(\/?)([a-zA-Z][^\t\n\f\r />]*)/y;
const COMMENT_END = /--!?>/g;
const BREAKS = new Set(["br", "p", "div", "li", "tr"]);
const SCRIPT_TOKEN = /<!--|-->|<\/?script(?=[\t\n\f\r />])/gi;

/**
 * Where a script's end tag starts, or -1, following the HTML script-data states. After `<!--` the script is escaped; a
 * `<script` there makes it double-escaped, where `</script` only steps back to escaped; `-->` leaves both.
 */
function scriptEnd(html: string, from: number): number {
  let state: "data" | "escaped" | "double" = "data";
  SCRIPT_TOKEN.lastIndex = from;
  for (let m = SCRIPT_TOKEN.exec(html); m !== null; m = SCRIPT_TOKEN.exec(html)) {
    const token = m[0].toLowerCase();
    if (token === "<!--") {
      if (state === "data") state = "escaped";
      // Its two dashes can also begin the `-->` that ends the escape: `<!-->`.
      SCRIPT_TOKEN.lastIndex = m.index + 2;
    } else if (token === "-->") {
      state = "data";
    } else if (token === "<script") {
      if (state === "escaped") state = "double";
    } else if (state === "double") {
      state = "escaped";
    } else {
      return m.index;
    }
  }
  return -1;
}

/** Finds the element's end tag: only HTML whitespace, `/` or `>` (or the end of the text) may follow its name. */
function endTagFinder(name: string): (html: string, from: number) => number {
  const closer = new RegExp(`</${name}(?=[\\t\\n\\f\\r />]|$)`, "gi");
  return (html, from) => {
    closer.lastIndex = from;
    return closer.exec(html)?.index ?? -1;
  };
}

/** Elements whose content the HTML parser does not read as markup, each with how to find its end tag. */
const RAW_TEXT = new Map<string, (html: string, from: number) => number>([
  ["script", scriptEnd],
  ...["style", "title", "iframe", "noembed", "noframes", "xmp", "textarea"].map((n): [string, (html: string, from: number) => number] => [n, endTagFinder(n)]),
]);
/** Raw-text elements a mail client shows, as literal text. `textarea` still decodes entities; `xmp` does not. */
const SHOWN_RAW = new Map<string, (s: string) => string>([
  ["xmp", (s) => s],
  ["textarea", decodeEntities],
]);

/**
 * Mail HTML as readable text. Script, style and title text and the content of iframe, noembed and noframes never come
 * through, however broken the markup. Head is not a hiding place: as in the HTML parser, text inside it ends it, so its
 * tags are simply dropped. CSS and the `hidden` attribute are not evaluated (docs/SECURITY.md).
 */
export function htmlToText(html: string): string {
  const parts: string[] = [];
  const seen = new Uint8Array(html.length);
  let titleCloses = true; // false once a search found no `</title`, so repeated unclosed titles stay linear
  const emit = (s: string): void => {
    if (s !== "") parts.push(decodeEntities(s));
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      emit(html.slice(i));
      break;
    }
    emit(html.slice(i, lt));
    // `<!-->` and `<!--->` are complete empty comments in HTML.
    if (html.startsWith("<!-->", lt)) {
      i = lt + 5;
      continue;
    }
    if (html.startsWith("<!--->", lt)) {
      i = lt + 6;
      continue;
    }
    if (html.startsWith("<!--", lt)) {
      COMMENT_END.lastIndex = lt + 4;
      const close = COMMENT_END.exec(html);
      if (close === null) break;
      i = close.index + close[0].length;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    TAG_NAME.lastIndex = lt;
    const m = TAG_NAME.exec(html);
    if (m === null) {
      emit("<");
      i = lt + 1;
      continue;
    }
    const end = tagEnd(html, lt + m[0].length, seen);
    if (end < 0) break;
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    i = end + 1;
    if (!closing && name === "plaintext") {
      // Nothing ends plaintext: the rest of the mail is literal text.
      parts.push(html.slice(i));
      break;
    }
    const findEnd = closing ? undefined : RAW_TEXT.get(name);
    if (findEnd === undefined) {
      if (BREAKS.has(name)) parts.push("\n");
      continue;
    }
    const shown = SHOWN_RAW.get(name);
    const close = name === "title" && !titleCloses ? -1 : findEnd(html, i);
    if (close < 0) {
      if (name === "title") {
        // An unclosed title loses only its own text, up to the next tag, and not the rest of the mail.
        titleCloses = false;
        const next = html.indexOf("<", i);
        if (next < 0) break;
        i = next;
        continue;
      }
      if (shown !== undefined) parts.push(shown(html.slice(i)));
      break;
    }
    if (shown !== undefined) parts.push(shown(html.slice(i, close)));
    const closeEnd = tagEnd(html, close + 2 + name.length, seen);
    if (closeEnd < 0) break;
    i = closeEnd + 1;
  }
  return parts
    .join("")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const CHARSET = /;\s*charset\s*=\s*(?:"([^"]*)"|([^\s;]+))/i;

const mimeType = (part: Obj): string => (typeof part.mimeType === "string" ? part.mimeType.trim().toLowerCase() : "");

function isAttachment(part: Obj): boolean {
  if (typeof part.filename === "string" && part.filename !== "") return true;
  if (isObj(part.body) && typeof part.body.attachmentId === "string") return true;
  return /^\s*attachment/i.test(header(part, "Content-Disposition") ?? "");
}

const inlineData = (part: Obj): string | null =>
  isObj(part.body) && typeof part.body.data === "string" && part.body.data !== "" ? part.body.data : null;

/** The part's text. Gmail has already undone the transfer encoding. */
function partText(part: Obj): string {
  const m = CHARSET.exec(header(part, "Content-Type") ?? "");
  return decodeBytes(Buffer.from(inlineData(part) ?? "", "base64url"), m ? (m[1] ?? m[2] ?? null) : null);
}

/** At most `max` UTF-16 units, never ending in half a surrogate pair. */
function cut(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  const last = s.charCodeAt(max - 1);
  return { text: s.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max), truncated: true };
}

/**
 * The body: the first text/plain or text/html leaf in document order. Inside a multipart/alternative, a text/plain
 * anywhere in that alternative's subtree wins over its text/html. Attachments and message/rfc822 are never entered,
 * and a part with no data is not a body. At most 10 MIME levels and 200 parts are read (the root is level 1 and part
 * 1); what lies beyond is cut, not an error.
 */
export function messageBody(payload: unknown, maxChars: number): { text: string; truncated: boolean } {
  let seen = 0;
  let alternatives = 0;
  /** Body candidates in document order; `alt` numbers the outermost alternative holding the leaf. */
  const leaves: { part: Obj; plain: boolean; alt: number | null }[] = [];
  const visit = (part: unknown, depth: number, alt: number | null): void => {
    if (depth > MAX_DEPTH || seen >= MAX_PARTS) return;
    seen++;
    if (!isObj(part) || isAttachment(part)) return;
    const type = mimeType(part);
    if (type === "message/rfc822") return;
    if ((type === "text/plain" || type === "text/html") && inlineData(part) !== null) {
      leaves.push({ part, plain: type === "text/plain", alt });
    }
    if (depth === MAX_DEPTH || !Array.isArray(part.parts)) return;
    const childAlt = alt ?? (type === "multipart/alternative" ? alternatives++ : null);
    for (const child of part.parts as unknown[]) {
      if (seen >= MAX_PARTS) return;
      visit(child, depth + 1, childAlt);
    }
  };
  visit(payload, 1, null);
  const first = leaves[0];
  if (first === undefined) return { text: "", truncated: false };
  const chosen = first.plain || first.alt === null ? first : (leaves.find((l) => l.plain && l.alt === first.alt) ?? first);
  const text = partText(chosen.part);
  return cut(chosen.plain ? text : htmlToText(text), maxChars);
}

const CRLF = "\r\n";
const FOLD_AT = 76;
/** Bytes of UTF-8 in one encoded word: `=?UTF-8?B?` + 60 base64 characters + `?=` is 72, within RFC 2047's 75. */
const WORD_BYTES = 45;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

function checkedHeader(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new ProviderError("google gmail", "createDraft", { phrase: "invalid header value" });
  return value;
}

/** RFC 2047 B words of whole characters, folded. */
function encodedSubject(subject: string): string {
  const words: string[] = [];
  let chunk = "";
  let bytes = 0;
  const flush = (): void => {
    words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
    chunk = "";
    bytes = 0;
  };
  for (const ch of subject) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > WORD_BYTES) flush();
    chunk += ch;
    bytes += size;
  }
  flush();
  return words.join(`${CRLF} `);
}

/**
 * As written when printable ASCII. Text holding `=?` is encoded too: a mail client would otherwise decode it as an
 * encoded word and show something other than what the owner approved.
 */
const subjectValue = (subject: string): string =>
  PRINTABLE_ASCII.test(subject) && !subject.includes("=?") ? subject : encodedSubject(subject);

/** `Name: a, b` (or space-separated), folded between values so a long list stays under the line limit. */
function listHeader(name: string, values: readonly string[], separator: "," | ""): string {
  let line = `${name}: ${checkedHeader(values[0]!)}`;
  const lines: string[] = [];
  for (const raw of values.slice(1)) {
    const v = checkedHeader(raw);
    if (line.length + separator.length + 1 + v.length > FOLD_AT) {
      lines.push(`${line}${separator}`);
      line = ` ${v}`;
    } else {
      line += `${separator} ${v}`;
    }
  }
  lines.push(line);
  return lines.join(CRLF);
}

/**
 * The draft as RFC 5322 text (M4b decision 4). No From header: Gmail sets the account address. No Message-ID either:
 * Gmail replaces a client-supplied one with its own (M4b live check, 2026-11-25), so the draft is identified by its id.
 */
export function buildDraftMime(d: NewDraft): string {
  const headers = [
    ...(d.inReplyTo === null ? [] : [`In-Reply-To: ${checkedHeader(d.inReplyTo)}`]),
    ...(d.references.length > 0 ? [listHeader("References", d.references, "")] : []),
    listHeader("To", d.to, ","),
    ...(d.cc.length > 0 ? [listHeader("Cc", d.cc, ",")] : []),
    ...(d.bcc.length > 0 ? [listHeader("Bcc", d.bcc, ",")] : []),
    `Subject: ${subjectValue(checkedHeader(d.subject))}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  const encoded = Buffer.from(d.body.replace(/\n/g, CRLF), "utf8").toString("base64");
  const body = (encoded.match(/.{1,76}/g) ?? []).join(CRLF);
  return `${headers.join(CRLF)}${CRLF}${CRLF}${body}`;
}
