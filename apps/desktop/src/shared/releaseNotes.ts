/**
 * Release notes (the "What's new" text of the update notice) — UNTRUSTED remote input.
 *
 * The text is the release body from GitHub (normally the CHANGELOG.md section). Anyone who can edit the
 * release, the changelog or the account can put anything in it, so rendering it must not give it any power:
 *
 *  - No HTML is ever produced. `parseReleaseNotes` turns the text into a small typed tree of an ALLOW-LISTED
 *    Markdown subset; the renderer maps that tree to fixed elements whose content is only React text nodes
 *    (renderer/features/updates/ReleaseNotes.tsx). Nothing from the text reaches an attribute.
 *  - Subset: headings (# … ####; ##### and ###### count as ####), "-", "*", "+" and "1." / "1)" list items
 *    with one level of nesting (deeper items join the nested level), paragraphs, and inline **bold**,
 *    *italic* / _italic_ and `code`. Everything else (raw HTML, entities, block quotes, fences, tables, …) is
 *    shown as the literal text it is.
 *  - Links are not clickable: `[text](url)` shows its text, `![alt](url)` its alt text (no request is ever
 *    made), `<https://…>` the bare URL, and bare URLs stay plain text. The Download button (URL built in main
 *    from the validated tag) is the only way out of the notice.
 *  - Bounded work: one linear pass over lines and characters. No regex runs over the text except anchored
 *    single-character classes; every search for a closing delimiter looks at most `MAX_SPAN` characters ahead,
 *    and inline nesting stops at `MAX_INLINE_DEPTH` (deeper delimiters are literal). Caps on characters, lines
 *    and line length cut the text with a visible "see the full notes on the release page" note.
 */

/** Main caps the notes to this before IPC (UpdateService); the renderer applies the same cap again. */
export const NOTES_MAX_CHARS = 20_000;
/** Lines parsed; further lines are cut (with the truncation note). */
export const NOTES_MAX_LINES = 400;
/** Characters per line; a longer line is cut with "…" (and the truncation note). */
export const NOTES_MAX_LINE_CHARS = 1_000;
/** **bold** inside *italic* inside **bold**: deeper delimiters are shown as literal text. */
export const MAX_INLINE_DEPTH = 3;
/** Furthest a closing delimiter (`, **, *, _, ], )) is looked for, so unbalanced input stays linear. */
export const MAX_SPAN = 500;
/** Main ends a cut text with this line; the parser turns it into the truncation note. */
export const TRUNCATION_MARK = "\n…";

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "code"; v: string };

export interface NoteItem {
  c: Inline[];
  /** The nested list under this item (one level; deeper items join it). */
  sub?: NoteList;
}

export interface NoteList {
  ordered: boolean;
  items: NoteItem[];
}

export type NoteBlock =
  | { t: "heading"; level: 1 | 2 | 3 | 4; c: Inline[] }
  | { t: "para"; c: Inline[] }
  | { t: "list"; list: NoteList };

export interface ReleaseNotesDoc {
  blocks: NoteBlock[];
  /** True when any cap cut the text (here or in main): the UI adds a plain-text note pointing to the release page. */
  truncated: boolean;
}

/**
 * Unicode hygiene, one pass over code points:
 *  - CRLF / CR, U+2028 and U+2029 become "\n"; a tab becomes four spaces (list indentation).
 *  - Removed: C0 controls except "\n" (NUL included), DEL and C1 controls; bidi embeddings, overrides and
 *    isolates (U+202A–U+202E, U+2066–U+2069) and marks (U+200E, U+200F, U+061C), which can make the text read
 *    differently from what it is; zero-width and invisible characters (U+200B–U+200D, U+2060–U+2064, U+FEFF,
 *    U+180E, U+00AD) that can hide or spoof words; tag characters (U+E0000–U+E007F, invisible "ASCII
 *    smuggling"); and noncharacters / lone surrogates (dropped by the code-point walk below).
 *  Visible characters (emoji, accents, any script) are kept. ZWJ removal splits joined emoji into their parts,
 *  which is an acceptable price in release notes.
 */
export function sanitizeNotes(input: string): string {
  let out = "";
  const n = input.length;
  for (let i = 0; i < n; i++) {
    const c = input.charCodeAt(i);
    // Surrogate pairs: keep a valid pair (minus tag characters), drop a lone half.
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < n ? input.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        const cp = (c - 0xd800) * 0x400 + (d - 0xdc00) + 0x10000;
        const nonchar = (cp & 0xfffe) === 0xfffe;
        if (!(cp >= 0xe0000 && cp <= 0xe007f) && !nonchar) out += input.charAt(i) + input.charAt(i + 1);
        i++;
      }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    if (c === 0x0d) {
      out += "\n";
      if (i + 1 < n && input.charCodeAt(i + 1) === 0x0a) i++;
      continue;
    }
    if (c === 0x0a || c === 0x2028 || c === 0x2029) {
      out += "\n";
      continue;
    }
    if (c === 0x09) {
      out += "    ";
      continue;
    }
    if (
      c < 0x20 ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0x00ad ||
      c === 0x061c ||
      c === 0x180e ||
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2060 && c <= 0x2069) ||
      c === 0xfeff ||
      (c >= 0xfdd0 && c <= 0xfdef) ||
      c === 0xfffe ||
      c === 0xffff
    )
      continue;
    out += input.charAt(i);
  }
  return out;
}

/**
 * Main's step before IPC: sanitize, collapse runs of blank lines, trim, and cap at `max` characters. A cut text
 * ends at a line break when there is one in the second half, followed by `TRUNCATION_MARK`.
 */
export function prepareNotes(body: string | null | undefined, max = NOTES_MAX_CHARS): string {
  if (body === null || body === undefined) return "";
  // Bound the work before sanitizing. Text past 2×max code units is dropped even when sanitizing would have
  // shrunk the rest under the cap (e.g. a flood of zero-width characters), so that cut is marked too.
  const rawCut = body.length > max * 2;
  const raw = rawCut ? body.slice(0, max * 2) : body;
  let text = collapseBlankLines(sanitizeNotes(raw)).trim();
  if (text.length > max - TRUNCATION_MARK.length && (rawCut || text.length > max)) {
    let cut = text.slice(0, max - TRUNCATION_MARK.length);
    const nl = cut.lastIndexOf("\n");
    if (nl > cut.length / 2) cut = cut.slice(0, nl);
    text = `${dropLoneHighSurrogate(cut).trimEnd()}${TRUNCATION_MARK}`;
  } else if (rawCut) {
    text = `${text}${TRUNCATION_MARK}`;
  }
  return text;
}

/** A cut can split a surrogate pair; drop the dangling high half rather than send it on. */
function dropLoneHighSurrogate(s: string): string {
  const c = s.charCodeAt(s.length - 1);
  return c >= 0xd800 && c <= 0xdbff ? s.slice(0, -1) : s;
}

function collapseBlankLines(s: string): string {
  const lines = s.split("\n");
  const out: string[] = [];
  let blank = 0;
  for (const l of lines) {
    const isBlank = l.trim() === "";
    blank = isBlank ? blank + 1 : 0;
    if (blank <= 1) out.push(isBlank ? "" : l.trimEnd());
  }
  return out.join("\n");
}

// ───────────────────────────── blocks ─────────────────────────────

interface Marker {
  indent: number;
  ordered: boolean;
  /** Index where the item text starts. */
  text: number;
}

function leadingSpaces(line: string): number {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 0x20) i++;
  return i;
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

/** "- x", "* x", "+ x", "1. x", "1) x" (up to 9 digits), or a lone marker at the end of the line. */
function listMarker(line: string): Marker | null {
  const indent = leadingSpaces(line);
  let i = indent;
  const c = line.charCodeAt(i);
  let ordered = false;
  if (c === 0x2d || c === 0x2a || c === 0x2b) {
    i++;
  } else if (isDigit(c)) {
    const start = i;
    while (i < line.length && isDigit(line.charCodeAt(i)) && i - start < 10) i++;
    if (i - start > 9) return null;
    const d = line.charCodeAt(i);
    if (d !== 0x2e && d !== 0x29) return null;
    i++;
    ordered = true;
  } else {
    return null;
  }
  if (i === line.length) return { indent, ordered, text: i };
  if (line.charCodeAt(i) !== 0x20) return null;
  return { indent, ordered, text: leadingSpaces(line.slice(i)) + i };
}

/** "# x" … "###### x" with up to 3 leading spaces; an optional closing run of "#" is dropped. */
function heading(line: string): { level: 1 | 2 | 3 | 4; text: string } | null {
  const indent = leadingSpaces(line);
  if (indent > 3) return null;
  let i = indent;
  while (i < line.length && line.charCodeAt(i) === 0x23 && i - indent < 7) i++;
  const hashes = i - indent;
  if (hashes < 1 || hashes > 6) return null;
  if (i < line.length && line.charCodeAt(i) !== 0x20) return null;
  let text = line.slice(i).trim();
  // Closing sequence: trailing "#"s preceded by a space (or the whole text).
  let j = text.length;
  while (j > 0 && text.charCodeAt(j - 1) === 0x23) j--;
  if (j === 0) text = "";
  else if (j < text.length && text.charCodeAt(j - 1) === 0x20) text = text.slice(0, j).trimEnd();
  return { level: Math.min(hashes, 4) as 1 | 2 | 3 | 4, text };
}

interface RawItem {
  text: string;
  sub: { ordered: boolean; items: string[] } | null;
}

interface RawList {
  ordered: boolean;
  indent: number;
  items: RawItem[];
}

/**
 * Parses untrusted release notes into the allow-listed tree. Never throws; the result only holds strings
 * (shown as text) and fixed structural fields.
 */
export function parseReleaseNotes(input: string): ReleaseNotesDoc {
  // Text past 2×max is dropped unread (bounded work), which is a cut even if sanitizing shrinks the rest.
  let truncated = input.length > NOTES_MAX_CHARS * 2;
  let text = truncated ? input.slice(0, NOTES_MAX_CHARS * 2) : input;
  text = sanitizeNotes(text);
  if (text.length > NOTES_MAX_CHARS) {
    text = text.slice(0, NOTES_MAX_CHARS);
    truncated = true;
  }
  const trimmed = text.trimEnd();
  if (trimmed.endsWith(TRUNCATION_MARK)) {
    // Main cut the text. (Release text can forge this; the only effect is the same harmless note.)
    text = trimmed.slice(0, -TRUNCATION_MARK.length);
    truncated = true;
  }
  let lines = text.split("\n");
  if (lines.length > NOTES_MAX_LINES) {
    lines = lines.slice(0, NOTES_MAX_LINES);
    truncated = true;
  }

  const blocks: NoteBlock[] = [];
  let para: string[] = [];
  let list: RawList | null = null;
  /** A blank line was seen inside the open list (the list continues only with another item or an indented line). */
  let listGap = false;

  const flushPara = (): void => {
    if (para.length > 0) blocks.push({ t: "para", c: parseInline(para.join(" ")) });
    para = [];
  };
  const flushList = (): void => {
    if (list !== null) blocks.push({ t: "list", list: buildList(list) });
    list = null;
    listGap = false;
  };
  const appendToLastItem = (l: RawList, more: string): void => {
    const item = l.items[l.items.length - 1];
    if (item === undefined) return;
    const subItems = item.sub?.items;
    if (subItems !== undefined && subItems.length > 0) {
      subItems[subItems.length - 1] = joinText(subItems[subItems.length - 1] ?? "", more);
    } else {
      item.text = joinText(item.text, more);
    }
  };

  for (let raw of lines) {
    if (raw.length > NOTES_MAX_LINE_CHARS) {
      raw = `${raw.slice(0, NOTES_MAX_LINE_CHARS - 1)}…`;
      truncated = true;
    }
    const line = raw.trimEnd();
    if (line.trim() === "") {
      flushPara();
      if (list !== null) listGap = true;
      continue;
    }
    const h = heading(line);
    if (h !== null) {
      flushPara();
      flushList();
      blocks.push({ t: "heading", level: h.level, c: parseInline(h.text) });
      continue;
    }
    const m = listMarker(line);
    if (m !== null) {
      flushPara();
      const itemText = line.slice(m.text);
      const open: RawList | null = list;
      const last = open?.items[open.items.length - 1];
      if (open !== null && last !== undefined && m.indent >= open.indent + 2) {
        // Nested (any depth beyond the first nesting level joins it).
        last.sub ??= { ordered: m.ordered, items: [] };
        last.sub.items.push(itemText);
      } else if (open !== null && open.ordered === m.ordered) {
        open.items.push({ text: itemText, sub: null });
      } else {
        flushList();
        list = { ordered: m.ordered, indent: m.indent, items: [{ text: itemText, sub: null }] };
      }
      listGap = false;
      continue;
    }
    if (list !== null) {
      // A wrapped line of the last item (Keep a Changelog wraps long items with an indent), or after a blank
      // line an indented continuation paragraph; an unindented line after a blank ends the list.
      if (!listGap || leadingSpaces(line) >= 2) {
        appendToLastItem(list, line.trim());
        listGap = false;
        continue;
      }
      flushList();
    }
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return { blocks, truncated };
}

function joinText(a: string, b: string): string {
  return a === "" ? b : `${a} ${b}`;
}

function buildList(l: RawList): NoteList {
  return {
    ordered: l.ordered,
    items: l.items.map((it) => {
      const item: NoteItem = { c: parseInline(it.text) };
      if (it.sub !== null)
        item.sub = { ordered: it.sub.ordered, items: it.sub.items.map((s) => ({ c: parseInline(s) })) };
      return item;
    }),
  };
}

// ───────────────────────────── inline ─────────────────────────────

const BACKSLASH_ESCAPABLE = "\\`*_[]()<>#+-.!{}|~";

function isSpace(c: number): boolean {
  return c === 0x20 || Number.isNaN(c);
}

function isWordChar(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c > 0x7f;
}

/** First index ≥ from (and < from + MAX_SPAN) where `delim` closes: preceded by a non-space, not part of a longer run. */
function findClose(s: string, from: number, delim: string): number {
  const end = Math.min(s.length, from + MAX_SPAN);
  const ch = delim.charCodeAt(0);
  for (let j = from; j + delim.length <= end; j++) {
    if (s.charCodeAt(j) !== ch || !s.startsWith(delim, j)) continue;
    const before = s.charCodeAt(j - 1);
    const after = s.charCodeAt(j + delim.length);
    if (j === from || isSpace(before) || before === ch) continue;
    if (after === ch) {
      // Part of a longer run (e.g. "***"): let the run's end close it instead.
      continue;
    }
    if (delim === "_" && isWordChar(after)) continue;
    return j;
  }
  return -1;
}

/** Index of `ch` in s[from, from + MAX_SPAN), or -1. */
function findChar(s: string, from: number, ch: string): number {
  const end = Math.min(s.length, from + MAX_SPAN);
  const code = ch.charCodeAt(0);
  for (let j = from; j < end; j++) if (s.charCodeAt(j) === code) return j;
  return -1;
}

/** `[text](url)` / `![alt](url)` at `i` (pointing at "["): the text and where it ends, or null. */
function linkAt(s: string, i: number): { text: string; end: number } | null {
  const close = findChar(s, i + 1, "]");
  if (close < 0 || s.charCodeAt(close + 1) !== 0x28) return null;
  // The destination ends at the ")" that balances its "(" (URLs like "alert(1)"); it is skipped, never kept.
  const end = Math.min(s.length, close + 2 + MAX_SPAN);
  let depth = 0;
  for (let j = close + 2; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 0x28) depth++;
    else if (c === 0x29) {
      if (depth === 0) return { text: s.slice(i + 1, close), end: j + 1 };
      depth--;
    }
  }
  return null;
}

/** `<scheme:…>` autolink at `i`: the URL text and where it ends, or null (then "<" is literal). */
function autolinkAt(s: string, i: number): { text: string; end: number } | null {
  let j = i + 1;
  const end = Math.min(s.length, i + MAX_SPAN);
  const first = s.charCodeAt(j);
  if (!((first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a))) return null;
  while (j < end) {
    const c = s.charCodeAt(j);
    if (c === 0x3a) break;
    const ok =
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      isDigit(c) ||
      c === 0x2b ||
      c === 0x2e ||
      c === 0x2d;
    if (!ok || j - i > 32) return null;
    j++;
  }
  if (s.charCodeAt(j) !== 0x3a || j - i < 3) return null;
  for (j++; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 0x3e) return { text: s.slice(i + 1, j), end: j + 1 };
    if (c === 0x20 || c === 0x3c) return null;
  }
  return null;
}

/** Inline parse of one block's text (bounded by the caps above; see the module comment). */
export function parseInline(s: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const pushText = (): void => {
    if (buf === "") return;
    const last = out[out.length - 1];
    if (last?.t === "text") last.v += buf;
    else out.push({ t: "text", v: buf });
    buf = "";
  };
  const pushNodes = (nodes: Inline[]): void => {
    for (const node of nodes) {
      if (node.t === "text") buf += node.v;
      else {
        pushText();
        out.push(node);
      }
    }
  };
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    // \* etc.: the punctuation itself, literally.
    if (c === 0x5c && i + 1 < s.length && BACKSLASH_ESCAPABLE.includes(s.charAt(i + 1))) {
      buf += s.charAt(i + 1);
      i += 2;
      continue;
    }
    if (c === 0x60) {
      // `code`: a run of N backticks closes with the next run of exactly N.
      let n = 1;
      while (s.charCodeAt(i + n) === 0x60) n++;
      const run = "`".repeat(n);
      let close = -1;
      const end = Math.min(s.length, i + n + MAX_SPAN);
      for (let k = i + n; k < end;) {
        if (s.charCodeAt(k) !== 0x60) {
          k++;
          continue;
        }
        let m = k;
        while (s.charCodeAt(m) === 0x60) m++;
        if (m - k === n) {
          close = k;
          break;
        }
        k = m;
      }
      if (close > i + n) {
        pushText();
        let code = s.slice(i + n, close);
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ")) code = code.slice(1, -1);
        out.push({ t: "code", v: code });
        i = close + n;
      } else {
        buf += run;
        i += n;
      }
      continue;
    }
    if (c === 0x21 && s.charCodeAt(i + 1) === 0x5b) {
      // ![alt](url): the alt text only; the URL is never used.
      const link = linkAt(s, i + 1);
      if (link !== null) {
        pushNodes(
          depth < MAX_INLINE_DEPTH ? parseInline(link.text, depth + 1) : [{ t: "text", v: link.text }],
        );
        i = link.end;
        continue;
      }
    }
    if (c === 0x5b) {
      // [text](url): the text only, not a link.
      const link = linkAt(s, i);
      if (link !== null) {
        pushNodes(
          depth < MAX_INLINE_DEPTH ? parseInline(link.text, depth + 1) : [{ t: "text", v: link.text }],
        );
        i = link.end;
        continue;
      }
    }
    if (c === 0x3c) {
      const auto = autolinkAt(s, i);
      if (auto !== null) {
        buf += auto.text;
        i = auto.end;
        continue;
      }
    }
    if ((c === 0x2a || c === 0x5f) && depth < MAX_INLINE_DEPTH) {
      const ch = s.charAt(i);
      const double = s.charCodeAt(i + 1) === c;
      const delim = double && c === 0x2a ? "**" : ch;
      const open = i + delim.length;
      const leftOk =
        !isSpace(s.charCodeAt(open)) && open < s.length && !(c === 0x5f && isWordChar(s.charCodeAt(i - 1)));
      if (leftOk && !(delim.length === 1 && s.charCodeAt(open) === c)) {
        const close = findClose(s, open, delim);
        if (close > open) {
          pushText();
          const inner = parseInline(s.slice(open, close), depth + 1);
          out.push(delim === "**" ? { t: "strong", c: inner } : { t: "em", c: inner });
          i = close + delim.length;
          continue;
        }
      }
      buf += delim;
      i += delim.length;
      continue;
    }
    buf += s.charAt(i);
    i++;
  }
  pushText();
  return out;
}

/** The plain text of a tree (tests, accessibility checks). */
export function inlineText(nodes: Inline[]): string {
  return nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : inlineText(n.c))).join("");
}
