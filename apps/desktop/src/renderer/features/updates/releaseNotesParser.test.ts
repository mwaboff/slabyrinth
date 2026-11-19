/**
 * shared/releaseNotes.ts: the allow-listed Markdown subset for untrusted release notes. Lives with the renderer
 * tests because it reads CHANGELOG.md with Vite's ?raw import (the parser itself is shared with main).
 */
import { describe, expect, it } from "vitest";
import changelog from "../../../../../../CHANGELOG.md?raw";
import {
  MAX_INLINE_DEPTH,
  NOTES_MAX_CHARS,
  NOTES_MAX_LINE_CHARS,
  NOTES_MAX_LINES,
  inlineText,
  parseInline,
  parseReleaseNotes,
  prepareNotes,
  sanitizeNotes,
  type Inline,
  type NoteBlock,
  type ReleaseNotesDoc,
} from "../../../shared/releaseNotes";

/** The release body for a version, as scripts/release-notes.ts cuts it (section body, no link definitions). */
function section(version: string): string {
  const lines = changelog.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  expect(start).toBeGreaterThanOrEqual(0);
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith("## ")) break;
    if (/^\[[^\]]+\]:\s/.test(l)) continue;
    out.push(l);
  }
  return `${out.join("\n").trim()}\n`;
}

const text = (v: string): Inline => ({ t: "text", v });
const ul = (...items: string[]): NoteBlock => ({
  t: "list",
  list: { ordered: false, items: items.map((s) => ({ c: [text(s)] })) },
});
const h3 = (s: string): NoteBlock => ({ t: "heading", level: 3, c: [text(s)] });

/** Every string in the tree, concatenated (what the user can read). */
function allText(doc: ReleaseNotesDoc): string {
  const parts: string[] = [];
  for (const b of doc.blocks) {
    if (b.t === "list") {
      for (const it of b.list.items) {
        parts.push(inlineText(it.c));
        for (const s of it.sub?.items ?? []) parts.push(inlineText(s.c));
      }
    } else parts.push(inlineText(b.c));
  }
  return parts.join("\n");
}

/** Best of three runs, in ms (avoids flakiness from a single slow run). */
function bestOf3(fn: () => void): number {
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe("real CHANGELOG sections", () => {
  it("0.1.1", () => {
    const doc = parseReleaseNotes(prepareNotes(section("0.1.1")));
    expect(doc).toEqual({
      truncated: false,
      blocks: [
        h3("Changed"),
        ul(
          "The settings icon is now a gear, so it no longer looks like the theme toggle's sun.",
          "The app now uses the same logo as the website, and the icon is sharper at small sizes.",
        ),
        h3("Fixed"),
        ul(
          "On Linux, the app window and taskbar now show the Slabyrinth icon instead of a generic one.",
          "On Windows, the running app now groups with its pinned taskbar or Start menu shortcut. If you pinned Slabyrinth while using 0.1.0, you may need to unpin it and pin it again.",
        ),
      ],
    });
  });

  it("0.1.0 (wrapped list items join into one item)", () => {
    const doc = parseReleaseNotes(prepareNotes(section("0.1.0")));
    expect(doc.truncated).toBe(false);
    expect(doc.blocks.slice(0, 2)).toEqual([{ t: "para", c: [text("The first release.")] }, h3("Added")]);
    const list = doc.blocks[2];
    expect(doc.blocks).toHaveLength(3);
    if (list?.t !== "list") throw new Error("expected a list");
    expect(list.list.ordered).toBe(false);
    expect(list.list.items).toHaveLength(10);
    const items = list.list.items.map((i) => inlineText(i.c));
    expect(items[0]).toBe(
      "Describe a dungeon, crypt or tower by chatting with Claude, using your own Anthropic API key. Slabyrinth asks a few questions, keeps a design brief, and draws a first plan.",
    );
    expect(items[2]).toBe(
      'Approve a version and build it: Slabyrinth compiles the plan into TaleSpire slabs and guides you through pasting them, with "Copy & open TaleSpire".',
    );
    expect(items[8]).toBe(
      'An "Update available" notice: at most once a day the app asks GitHub, anonymously, whether a newer version exists, and links to its release page. You can turn the check off in Settings ▸ About.',
    );
    expect(items[9]).toBe(
      "Windows installer and portable build, Linux AppImage. The builds are not code-signed yet.",
    );
    for (const it of list.list.items) expect(it.c.every((n) => n.t === "text")).toBe(true);
  });
});

describe("supported subset", () => {
  it("headings, lists with one nesting level, paragraphs and inline styles", () => {
    const doc = parseReleaseNotes(
      [
        "# Title #",
        "#### Four",
        "###### Six",
        "#not a heading",
        "",
        "Para one",
        "continues **bold** and *it* and _it_ and `co*de*`.",
        "",
        "1. first",
        "2) second",
        "   - nested",
        "       - deeper flattens",
        "",
        "- other list",
      ].join("\n"),
    );
    expect(doc.blocks).toEqual([
      { t: "heading", level: 1, c: [text("Title")] },
      { t: "heading", level: 4, c: [text("Four")] },
      { t: "heading", level: 4, c: [text("Six")] },
      { t: "para", c: [text("#not a heading")] },
      {
        t: "para",
        c: [
          text("Para one continues "),
          { t: "strong", c: [text("bold")] },
          text(" and "),
          { t: "em", c: [text("it")] },
          text(" and "),
          { t: "em", c: [text("it")] },
          text(" and "),
          { t: "code", v: "co*de*" },
          text("."),
        ],
      },
      {
        t: "list",
        list: {
          ordered: true,
          items: [
            { c: [text("first")] },
            {
              c: [text("second")],
              sub: { ordered: false, items: [{ c: [text("nested")] }, { c: [text("deeper flattens")] }] },
            },
          ],
        },
      },
      ul("other list"),
    ]);
  });

  it("keeps snake_case, lone stars and escapes literal", () => {
    expect(parseInline("a_b_c 2 * 3 * 4 \\*x\\* **")).toEqual([text("a_b_c 2 * 3 * 4 *x* **")]);
    expect(parseInline("``a ` b``")).toEqual([{ t: "code", v: "a ` b" }]);
  });
});

const HOSTILE = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  '<a href="https://evil.example">x</a>',
  "<style>body{display:none}</style>",
  "<iframe src=https://evil.example></iframe>",
  "<svg onload=alert(1)>",
  "&lt;script&gt; &#x3c;b&#x3e; &amp;",
];

describe("hostile input stays literal text", () => {
  it.each(HOSTILE)("%s", (s) => {
    const doc = parseReleaseNotes(s);
    expect(doc.blocks).toEqual([{ t: "para", c: [text(s)] }]);
  });

  it("links show their text only; the URL is never kept", () => {
    const cases: Array<[string, string]> = [
      ["[click](javascript:alert(1))", "click"],
      ["[x](file:///c:/windows)", "x"],
      ["[x](data:text/html,<script>alert(1)</script>)", "x"],
      ["![t](https://evil.example/pixel.png)", "t"],
      ["<https://evil.example>", "https://evil.example"],
      ["see https://evil.example/login now", "see https://evil.example/login now"],
      ["[**bold** link](https://evil.example)", "bold link"],
    ];
    for (const [input, shown] of cases) {
      const doc = parseReleaseNotes(input);
      expect(allText(doc)).toBe(shown);
      const json = JSON.stringify(doc);
      if (!shown.includes("evil.example")) expect(json).not.toContain("evil.example");
      expect(json).not.toContain("javascript:");
      expect(json).not.toContain("file:");
      expect(json).not.toContain("data:");
    }
    // Only the fixed node kinds exist (no link/image/html node types at all).
    const kinds = new Set<string>();
    const walk = (ns: Inline[]): void => {
      for (const n of ns) {
        kinds.add(n.t);
        if (n.t === "strong" || n.t === "em") walk(n.c);
      }
    };
    walk(parseInline("[a](b) ![c](d) <e:f> **g** *h* `i`"));
    expect([...kinds].sort()).toEqual(["code", "em", "strong", "text"]);
  });

  it("unbalanced delimiters are literal and nothing is lost", () => {
    for (const s of ["**open", "`open", "[open", "(open", "[a](open", "*a **b", "a ** b **", "<https://x"]) {
      expect(allText(parseReleaseNotes(s))).toBe(s);
    }
  });

  it("deep nesting attempts are bounded and keep their text", () => {
    const stars = "*".repeat(10_000);
    expect(allText(parseReleaseNotes(stars)).length).toBeGreaterThan(0);
    const brackets = "[".repeat(10_000);
    expect(allText(parseReleaseNotes(brackets))).toBe(brackets.slice(0, NOTES_MAX_LINE_CHARS - 1) + "…");
    const quotes = "> ".repeat(5_000);
    expect(parseReleaseNotes(quotes).blocks[0]?.t).toBe("para");
    // Alternating emphasis nests at most MAX_INLINE_DEPTH levels.
    const nested = "**a *b **c *d **e** d* c** b* a**";
    let depth = 0;
    const measure = (ns: Inline[], d: number): void => {
      for (const n of ns) {
        if (n.t === "strong" || n.t === "em") {
          depth = Math.max(depth, d + 1);
          measure(n.c, d + 1);
        }
      }
    };
    measure(parseInline(nested), 0);
    expect(depth).toBeLessThanOrEqual(MAX_INLINE_DEPTH);
    expect(depth).toBeGreaterThan(0);
  });

  it("caps characters, lines and line length with the truncation flag", () => {
    const longLine = parseReleaseNotes("x".repeat(1024 * 1024));
    expect(longLine.truncated).toBe(true);
    expect(allText(longLine).length).toBe(NOTES_MAX_LINE_CHARS);
    const many = parseReleaseNotes("- a\n".repeat(100_000));
    expect(many.truncated).toBe(true);
    const list = many.blocks[0];
    if (list?.t !== "list") throw new Error("expected a list");
    expect(list.list.items.length).toBeLessThanOrEqual(NOTES_MAX_LINES);
    expect(parseReleaseNotes("a\n".repeat(NOTES_MAX_CHARS)).truncated).toBe(true);
    // Main's cut marker becomes the note, not a visible "…" line.
    const cut = parseReleaseNotes(prepareNotes("- item\n".repeat(10_000)));
    expect(cut.truncated).toBe(true);
    expect(allText(cut)).not.toContain("…");
    expect(parseReleaseNotes("short").truncated).toBe(false);
  });

  it("stays fast on pathological input (best of three, generous budget)", () => {
    const inputs = [
      "x".repeat(1024 * 1024),
      "- a\n".repeat(100_000),
      "*a ".repeat(10_000),
      "**a ".repeat(10_000),
      "_a ".repeat(10_000),
      "`` ` ".repeat(10_000),
      "[a](".repeat(10_000),
      "![".repeat(10_000),
      "<a:".repeat(10_000),
      `${"[".repeat(900)}\n`.repeat(400),
      `${"*a ".repeat(330)}\n`.repeat(400),
      "\\".repeat(1024 * 1024),
      "\u202e\u200b\u0000".repeat(300_000),
    ];
    for (const input of inputs) {
      const ms = bestOf3(() => {
        parseReleaseNotes(prepareNotes(input));
        parseReleaseNotes(input);
      });
      expect(ms).toBeLessThan(500);
    }
  });
});

describe("Unicode hygiene", () => {
  it("strips controls, NUL, bidi, zero-width and tag characters; normalizes line breaks", () => {
    const evil =
      "a\u0000b\u0007c\u001bd\u007fe\u0085f\u202eg\u2066h\u2069i\u200bj\u200dk\ufeffl\u00adm\u{e0041}n";
    expect(sanitizeNotes(evil)).toBe("abcdefghijklmn");
    expect(sanitizeNotes("a\r\nb\rc\u2028d\u2029e")).toBe("a\nb\nc\nd\ne");
    expect(sanitizeNotes("\ttab")).toBe("    tab");
    expect(sanitizeNotes("lone \ud800 half \udc00 ok 😀 é 漢")).toBe("lone  half  ok 😀 é 漢");
    expect(parseReleaseNotes("### Fix\u202eed\r\n- a\u0000b\r\n").blocks).toEqual([h3("Fixed"), ul("ab")]);
  });

  it("text dropped unread behind a flood of stripped characters still shows the truncation note", () => {
    const flood = `${"\u200b".repeat(NOTES_MAX_CHARS * 2)}- hidden item`;
    const prepared = prepareNotes(flood);
    expect(prepared).not.toContain("hidden");
    expect(parseReleaseNotes(prepared).truncated).toBe(true);
    expect(parseReleaseNotes(flood).truncated).toBe(true);
    // Just under the cap after stripping, but cut before it: the marker still fits within the cap.
    const near = `${"a".repeat(NOTES_MAX_CHARS - 1)}${"\u200b".repeat(NOTES_MAX_CHARS + 10)}tail`;
    const nearPrepared = prepareNotes(near);
    expect(nearPrepared.length).toBeLessThanOrEqual(NOTES_MAX_CHARS);
    expect(parseReleaseNotes(nearPrepared).truncated).toBe(true);
  });

  it("a cut never leaves half a surrogate pair", () => {
    const emoji = `a${"\ud83d\ude00".repeat(NOTES_MAX_CHARS)}`;
    const prepared = prepareNotes(emoji);
    expect(prepared.length).toBeLessThanOrEqual(NOTES_MAX_CHARS);
    expect(prepared).toBe(sanitizeNotes(prepared));
    expect(prepared.endsWith("\ud83d\ude00\n\u2026")).toBe(true);
  });
});
