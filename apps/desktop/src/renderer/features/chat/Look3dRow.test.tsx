/**
 * The chat's line when Claude looked at the map in 3D: read from the tool result exactly as core writes it, short
 * words per view, the picture on request, and a plain note once the picture is no longer kept.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { picturesContent, withoutPicture } from "@slabyrinth/core/agent";
import { Look3dRow, look3dOf, viewWords } from "./Look3dRow";

afterEach(cleanup);

const sheet = {
  png: new Uint8Array([137, 80, 78, 71]),
  captions: [
    "1. The whole map from the south-west (boxes: 79)",
    "2. inn from the S (the side its doors and windows face)",
    "3. Inside inn, storey 1: roofs and everything above hidden",
  ],
  suggestions: "Measured on the pieces in view: no gaps.",
};

const result = (content: ReturnType<typeof picturesContent>) => ({
  callId: "v1",
  name: "view_build_3d",
  isError: false,
  content,
});

describe("Claude looked at the map in 3D", () => {
  it("reads core's picture result: version, short words per view, the picture", () => {
    const look = look3dOf(result(picturesContent(4, sheet, "asked")));
    expect(look).toEqual({
      version: 4,
      views: ["the whole map from the south-west", "inn from the S", "inside inn, storey 1"],
      png: "iVBORw==",
    });
    // the first-draft look rides after a create_plan report
    const draft = look3dOf({
      ...result([
        { type: "text", text: '{"status":"applied"}' },
        ...picturesContent(1, sheet, "first_draft"),
      ]),
      name: "create_plan",
    });
    expect(draft?.version).toBe(1);
    expect(look3dOf(result([{ type: "text", text: "plain" }]))).toBeNull();
    expect(viewWords("1. Flagged by the review: room unlit at entry (Crypt; above and roofs hidden)")).toBe(
      "flagged by the review: room unlit at entry",
    );
  });

  it("a quiet line; the picture opens on request; a dropped picture says so", async () => {
    const look = look3dOf(result(picturesContent(4, sheet, "asked")));
    if (!look) throw new Error("no look");
    render(<Look3dRow look={look} />);
    expect(
      screen.getByText(/Claude looked at the map in 3D: the whole map from the south-west, inn from the S/),
    ).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show picture" }));
    expect(screen.getByRole("img").getAttribute("src")).toBe("data:image/png;base64,iVBORw==");
    cleanup();
    const gone = look3dOf(result(withoutPicture(picturesContent(4, sheet, "asked"))));
    if (!gone) throw new Error("no look");
    render(<Look3dRow look={gone} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/no longer kept/)).toBeTruthy();
  });
});
