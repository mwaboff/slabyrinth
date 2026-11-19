import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ReleaseNotes } from "./ReleaseNotes";

const DANGEROUS =
  "a, img, script, iframe, style, object, embed, form, svg, link, meta, base, video, audio, source, input";

/** Every attribute inside the notes container must be one of ours (the container's own are fixed). */
function badAttributes(root: Element): string[] {
  const bad: string[] = [];
  for (const el of root.querySelectorAll("*")) {
    for (const attr of el.getAttributeNames()) {
      const n = attr.toLowerCase();
      if (n !== "class" || n.startsWith("on")) bad.push(`${el.tagName}[${attr}]`);
    }
  }
  return bad;
}

const HOSTILE_LINES = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  '<a href="https://evil.example/login">Download the update</a>',
  "<style>body{display:none}</style>",
  "<iframe src=https://evil.example></iframe>",
  "<object data=x></object><embed src=x>",
  '<form action="https://evil.example"><input name=key></form>',
  "<svg onload=alert(1)></svg>",
  "&lt;script&gt;alert(1)&lt;/script&gt; &#x3c;b&#x3e;",
  'Text with " quotes \' and class="evil" style="color:red"',
];

const HOSTILE_MD = [
  "### Hostile <img src=x onerror=alert(1)>",
  "- [click](javascript:alert(1))",
  "- [x](file:///c:/windows)",
  "- [x](data:text/html,<script>alert(1)</script>)",
  "- ![t](https://evil.example/pixel.png)",
  "- <https://evil.example>",
  "- bare https://evil.example/login",
  "- **bold <script>x</script>** and `<img src=y>`",
  "> > > quoted",
  "**unbalanced `code [link(",
  "bidi \u202egnp.exe\u202c and zero\u200bwidth and NUL\u0000.",
].join("\n");

describe("ReleaseNotes (untrusted input)", () => {
  it("renders the hostile corpus as text only: no dangerous elements, no attributes from the input", () => {
    const { container } = render(<ReleaseNotes notes={`${HOSTILE_LINES.join("\n\n")}\n\n${HOSTILE_MD}`} />);
    const notes = container.querySelector(".upd__notes");
    if (notes === null) throw new Error("no notes container");
    expect(notes.querySelectorAll(DANGEROUS)).toHaveLength(0);
    expect(badAttributes(notes)).toEqual([]);
    // Only our fixed tags exist.
    const tags = new Set([...notes.querySelectorAll("*")].map((e) => e.tagName.toLowerCase()));
    for (const t of tags)
      expect(["h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "strong", "em", "code"]).toContain(t);
    // Class names are ours.
    for (const el of notes.querySelectorAll("[class]"))
      expect(el.className).toMatch(/^(upd-md__[a-z0-9-]+ ?)+$/);
    // The hostile strings are visible as text.
    const text = notes.textContent;
    for (const line of HOSTILE_LINES) expect(text).toContain(line);
    expect(text).toContain("Hostile <img src=x onerror=alert(1)>");
    expect(text).toContain("click");
    expect(text).toContain("https://evil.example");
    expect(text).toContain("bare https://evil.example/login");
    expect(text).toContain("bold <script>x</script>");
    expect(text).toContain("<img src=y>");
    expect(text).toContain("> > > quoted");
    expect(text).toContain("**unbalanced `code [link(");
    expect(text).not.toContain("javascript:");
    expect(text).not.toContain("file:///");
    expect(text).not.toContain("pixel.png");
    expect(text).toContain("bidi gnp.exe and zerowidth and NUL.");
    for (const ch of ["\u0000", "\u200b", "\u202a", "\u202c", "\u202e", "\u2066", "\u2069"]) {
      expect(text).not.toContain(ch);
    }
  });

  it("formats headings, lists, bold, italic and code with static classes", () => {
    const { container } = render(
      <ReleaseNotes
        notes={"### Added\n\n- **Stamps** for *rooms*\n  - nested `code`\n\n1. one\n\nParagraph."}
      />,
    );
    const notes = container.firstElementChild;
    expect(notes?.querySelector("h5.upd-md__h--3")).toHaveTextContent("Added");
    expect(notes?.querySelector("ul.upd-md__list > li > strong")).toHaveTextContent("Stamps");
    expect(notes?.querySelector("li em")).toHaveTextContent("rooms");
    expect(notes?.querySelector("ul.upd-md__list--sub code.upd-md__code")).toHaveTextContent("code");
    expect(notes?.querySelector("ol > li")).toHaveTextContent("one");
    expect(notes?.querySelector("ol")?.hasAttribute("start")).toBe(false);
    expect(notes?.querySelector("p.upd-md__p")).toHaveTextContent("Paragraph.");
  });
});
