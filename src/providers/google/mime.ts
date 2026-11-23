import type { MailAddress } from "../types.js";

/**
 * Parsers for attacker-controlled mail (M4b decision 5). None of them throws on bad input, and each scans its input
 * once, so a hostile message costs linear time.
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
 * or `<` drops everything after it, and a group with no closing `;` drops its members.
 */
export function parseAddressList(list: string): MailAddress[] {
  const out: MailAddress[] = [];
  let group: MailAddress[] | null = null;
  let e = newEntry();
  const flush = (): void => {
    const a = finishEntry(e);
    if (a !== null) (group ?? out).push(a);
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
  return out;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function codePoint(n: number): string {
  return n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? "\ufffd" : String.fromCodePoint(n);
}

/** One pass, so `&amp;lt;` is `&lt;` and never `<`. */
const decodeEntities = (s: string): string =>
  s.replace(/&(?:#(\d{1,8})|#[xX]([0-9a-fA-F]{1,8})|(amp|lt|gt|quot|apos|nbsp));/g, (_m, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED[name]!;
    return codePoint(dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex!, 16));
  });

/**
 * The `>` ending a tag. A quote opens an attribute value only right after `=`, as in the HTML tokenizer. If a quote
 * never closes, the first `>` ends the tag, so a broken attribute cannot hide the rest of the mail. -1 when no `>`.
 */
function tagEnd(html: string, from: number): number {
  let quote = "";
  let afterEquals = false;
  for (let i = from; i < html.length; i++) {
    const c = html[i]!;
    if (quote !== "") {
      if (c === quote) quote = "";
    } else if (c === ">") {
      return i;
    } else if ((c === '"' || c === "'") && afterEquals) {
      quote = c;
      afterEquals = false;
    } else if (c === "=") {
      afterEquals = true;
    } else if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r" && c !== "\f") {
      afterEquals = false;
    }
  }
  return html.indexOf(">", from);
}

const TAG_NAME = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/y;
const BREAKS = new Set(["br", "p", "div", "li", "tr"]);
const CLOSERS: Record<string, RegExp> = {
  script: /<\/script(?=[\s/>]|$)/gi,
  style: /<\/style(?=[\s/>]|$)/gi,
  title: /<\/title(?=[\s/>]|$)/gi,
};
/** Start tags that may appear in head; any other start tag ends an unclosed head. */
const HEAD_TAGS = new Set(["head", "title", "meta", "link", "base", "style", "script", "noscript", "template"]);

/** Mail HTML as readable text. Script, style, title and head content never comes through, however broken the markup. */
export function htmlToText(html: string): string {
  const parts: string[] = [];
  let inHead = false;
  let titleCloses = true; // false once a search found no `</title`, so repeated unclosed titles stay linear
  const emit = (s: string): void => {
    if (!inHead && s !== "") parts.push(decodeEntities(s));
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
      const end = html.indexOf("-->", lt + 4);
      if (end < 0) break;
      i = end + 3;
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
    const end = tagEnd(html, lt + m[0].length);
    if (end < 0) break;
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    i = end + 1;
    // Head content is dropped by state, not by a search for `</head`: a script inside it may hold that very text.
    if (name === "head") inHead = !closing;
    else if (!closing && !HEAD_TAGS.has(name)) inHead = false;
    const closer = closing ? undefined : CLOSERS[name];
    if (closer !== undefined) {
      closer.lastIndex = i;
      const close = name === "title" && !titleCloses ? null : closer.exec(html);
      if (close === null && name === "title") {
        // An unclosed title loses only its own text, up to the next tag, and not the rest of the mail.
        titleCloses = false;
        const next = html.indexOf("<", i);
        if (next < 0) break;
        i = next;
        continue;
      }
      if (close === null) break;
      const closeEnd = html.indexOf(">", close.index);
      if (closeEnd < 0) break;
      i = closeEnd + 1;
    } else if (BREAKS.has(name) && !inHead) {
      parts.push("\n");
    }
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
