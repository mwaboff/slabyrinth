/**
 * The quiet line in the chat when Claude looked at the map in 3D (its view_build_3d call, or the app's one look after
 * the first draft): "Claude looked at the map in 3D: the whole map, tap from the S", and "Show picture" opens the very
 * picture Claude got, from the tool result the chat already holds (no IPC). Once a newer version is built the picture
 * is no longer kept in the conversation; the line stays and says so.
 *
 * It reads the result as core's view3dTool writes it: a text block starting "3D PICTURE of plan vN" whose next lines
 * are the numbered captions, and the image after it (Look3dRow.test.ts holds the two together).
 */
import { useState } from "react";
import type { ChatItem } from "../../../main/agent/provider/types";

type ToolResult = Extract<ChatItem, { type: "tool_results" }>["results"][number];

export interface Look3d {
  version: number;
  /** Short words per view, in the sheet's order. */
  views: string[];
  /** The picture (base64 PNG), or null when it is no longer kept. */
  png: string | null;
}

const HEADER = /^3D PICTURE of plan v(\d+)\b/;

/** "The whole map from the south-west (boxes: 79)" → "the whole map from the south-west". */
export function viewWords(caption: string): string {
  const s = caption
    .replace(/^\d+\.\s*/, "")
    .replace(/ \(.*$/, "")
    .replace(/: (roofs|levels|everything)\b.*$/, "")
    .trim();
  return s.length > 0 ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/** The 3D look in a tool result, or null when it has none. */
export function look3dOf(result: ToolResult | undefined): Look3d | null {
  if (!result) return null;
  const at = result.content.findIndex((c) => c.type === "text" && HEADER.test(c.text));
  const head = result.content[at];
  if (at < 0 || head?.type !== "text") return null;
  const [first = "", ...captions] = head.text.split("\n");
  const version = Number(HEADER.exec(first)?.[1] ?? 0);
  const image = result.content.slice(at + 1).find((c) => c.type === "image");
  return {
    version,
    views: captions.filter((c) => /^\d+\./.test(c)).map(viewWords),
    png: image?.type === "image" ? image.dataBase64 : null,
  };
}

export function Look3dRow({ look }: { look: Look3d }) {
  const [open, setOpen] = useState(false);
  const what = look.views.length > 0 ? `: ${look.views.join(", ")}` : "";
  return (
    <div className="look3d">
      <p className="look3d__line">
        Claude looked at the map in 3D{what}.{" "}
        {look.png !== null ? (
          <button
            className="btn btn--link"
            aria-expanded={open}
            onClick={() => {
              setOpen((v) => !v);
            }}
          >
            {open ? "Hide picture" : "Show picture"}
          </button>
        ) : (
          <span>(The picture of v{look.version} is no longer kept.)</span>
        )}
      </p>
      {open && look.png !== null && (
        <img
          className="look3d__img"
          src={`data:image/png;base64,${look.png}`}
          alt={`What Claude saw in 3D of v${String(look.version)}${what}`}
        />
      )}
    </div>
  );
}
