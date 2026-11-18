/**
 * Markdown subset for AI messages (UX §5.2): paragraphs, **bold**, *emphasis*, bullet and numbered lists.
 * Room references (① … ⑳, "#4") become inline gold reference badges that select the room on the map.
 * No HTML is ever interpreted (text only, rendered as React nodes).
 */
import type { ReactNode } from "react";
import { selectRoomByKey } from "../stage/selectRoom";

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
const REF_RE = /([①-⑳])|(?<![\w&])#([A-Za-z]?\d{1,3})\b/gu;

export function RoomRef({ k }: { k: string }) {
  return (
    <button
      type="button"
      className="nref"
      aria-label={`Room ${k}`}
      title={`Show room ${k} on the map`}
      onClick={() => {
        selectRoomByKey(k);
      }}
    >
      {k}
    </button>
  );
}

/** Inline text with room references. */
export function withRefs(text: string, keyPrefix = "r"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(REF_RE)) {
    const at = m.index;
    if (at > last) out.push(text.slice(last, at));
    const k = m[1] !== undefined ? String(CIRCLED.indexOf(m[1]) + 1) : (m[2] ?? "");
    out.push(<RoomRef key={`${keyPrefix}${i++}`} k={k} />);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function inline(text: string, kp: string): ReactNode[] {
  // **bold** and *em* (rendered roman: the skin has no italics)
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(...withRefs(text.slice(last, m.index), `${kp}t${i}`));
    if (m[1] !== undefined) out.push(<strong key={`${kp}b${i}`}>{withRefs(m[1], `${kp}bb${i}`)}</strong>);
    else out.push(<em key={`${kp}e${i}`}>{withRefs(m[2] ?? "", `${kp}ee${i}`)}</em>);
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) out.push(...withRefs(text.slice(last), `${kp}t${i}`));
  return out;
}

export function RichText({ text }: { text: string }) {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  return (
    <>
      {blocks.map((b, bi) => {
        const lines = b.split("\n").filter((l) => l.trim() !== "");
        if (lines.length > 0 && lines.every((l) => /^\s*[-*•]\s+/.test(l)))
          return (
            <ul key={bi}>
              {lines.map((l, li) => (
                <li key={li}>{inline(l.replace(/^\s*[-*•]\s+/, ""), `${bi}-${li}`)}</li>
              ))}
            </ul>
          );
        if (lines.length > 0 && lines.every((l) => /^\s*\d+[.)]\s+/.test(l)))
          return (
            <ol key={bi}>
              {lines.map((l, li) => (
                <li key={li}>{inline(l.replace(/^\s*\d+[.)]\s+/, ""), `${bi}-${li}`)}</li>
              ))}
            </ol>
          );
        return (
          <p key={bi}>
            {lines.map((l, li) => (
              <span key={li}>
                {li > 0 && <br />}
                {inline(l, `${bi}-${li}`)}
              </span>
            ))}
          </p>
        );
      })}
    </>
  );
}
