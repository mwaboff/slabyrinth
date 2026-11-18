/** Version history pointer behaviour (UX §7.1–7.2) through the fake bridge, which uses core's history functions. */
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectSnapshot } from "../../../shared/ipc";
import { call, setBridge } from "../../bridge/client";
import { createFakeBridge } from "../../bridge/fake/fakeBridge";
import { historyRows, pointerState } from "./HistoryPanel";

async function snap(): Promise<ProjectSnapshot> {
  return call("project:snapshot", undefined);
}

describe("history pointer", () => {
  beforeEach(async () => {
    setBridge(createFakeBridge({ speed: 0 }));
    const list = await call("project:list", undefined);
    const abbey = list.find((p) => p.name === "The Drowned Abbey");
    if (!abbey) throw new Error("fixture project missing");
    await call("project:open", { path: abbey.path });
  });

  it("lists versions newest first with the head marked current", async () => {
    const s = await snap();
    const rows = historyRows(s);
    expect(rows.map((r) => r.v.number)).toEqual([4, 3, 2, 1]);
    expect(rows[0]).toMatchObject({ current: true, approved: false, undone: false });
    expect(pointerState(s)).toEqual({ canUndo: true, canRedo: false, redoTo: null });
  });

  it("undo moves the head back and marks the left version undone; redo returns to it", async () => {
    await call("plan:undo", undefined);
    let s = await snap();
    expect(s.head).toBe(3);
    expect(historyRows(s).find((r) => r.v.number === 4)).toMatchObject({ undone: true, current: false });
    expect(pointerState(s)).toMatchObject({ canUndo: true, canRedo: true, redoTo: 4 });
    await call("plan:redo", undefined);
    s = await snap();
    expect(s.head).toBe(4);
    expect(pointerState(s).canRedo).toBe(false);
  });

  it("a new version while the head is back keeps the undone one listed and takes the next number", async () => {
    await call("plan:undo", undefined);
    await call("plan:editText", { id: "guard", set: { notes: "Dice on the table." } });
    const s = await snap();
    expect(s.head).toBe(5);
    const rows = historyRows(s);
    expect(rows.map((r) => r.v.number)).toEqual([5, 4, 3, 2, 1]);
    expect(rows.find((r) => r.v.number === 4)?.undone).toBe(true);
    expect(s.versions.find((v) => v.number === 5)?.parentNumber).toBe(3);
    // v4 is no longer redoable: its parent (v3) is not the head
    expect(pointerState(s).canRedo).toBe(false);
  });

  it("restore creates a new version and never deletes", async () => {
    await call("plan:restore", { version: 1 });
    const s = await snap();
    expect(s.head).toBe(5);
    expect(s.versions.find((v) => v.number === 5)).toMatchObject({
      causeType: "restore",
      summary: "Restored v1",
    });
    expect(historyRows(s)).toHaveLength(5);
  });

  it("text edits to the same room within two minutes merge into one version", async () => {
    await call("plan:editText", { id: "guard", set: { notes: "One." } });
    await call("plan:editText", { id: "guard", set: { notes: "Two." } });
    const s = await snap();
    expect(s.head).toBe(5);
    expect(s.plan?.levels[0]?.areas.find((a) => a.id === "guard")?.notes).toBe("Two.");
  });
});
