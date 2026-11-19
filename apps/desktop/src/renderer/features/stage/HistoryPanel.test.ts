/** Version history pointer behaviour (UX §7.1–7.2) through the fake bridge, which uses core's history functions. */
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectSnapshot } from "../../../shared/ipc";
import { call, setBridge } from "../../bridge/client";
import { createFakeBridge } from "../../bridge/fake/fakeBridge";
import { historyRows, pointerState } from "./HistoryPanel";
import { versionCosts } from "../../stores/project";

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

describe("version costs", () => {
  const usd = (amount: number) => ({ currency: "USD" as const, amount });
  // two turns: three versions in the first, three in the second; costs are stored as the turn's running cost
  const items = [
    { type: "user", id: "u1" },
    { type: "assistant", id: "m1", turnId: "t1" },
    { type: "assistant", id: "m2", turnId: "t1" },
    { type: "assistant", id: "m3", turnId: "t1" },
    { type: "assistant", id: "m3b", turnId: "t1" },
    { type: "user", id: "u2" },
    { type: "assistant", id: "m4", turnId: "t2" },
    { type: "assistant", id: "m5", turnId: "t2" },
    { type: "assistant", id: "m6", turnId: "t2" },
    { type: "assistant", id: "m6b", turnId: "t2" },
  ];
  const versions = [
    { number: 1, author: "ai" as const, messageId: "m1", cost: usd(0.91) },
    { number: 2, author: "ai" as const, messageId: "m2", cost: usd(0.97) },
    { number: 3, author: "ai" as const, messageId: "m3", cost: usd(1.0) },
    { number: 4, author: "ai" as const, messageId: "m4", cost: usd(0.17) },
    { number: 5, author: "ai" as const, messageId: "m5", cost: usd(0.2) },
    { number: 6, author: "ai" as const, messageId: "m6", cost: usd(0.22) },
    { number: 7, author: "user" as const, cost: null },
  ];

  it("attributes the turn's cost since the previous version of that turn, never more than the total", () => {
    const c = versionCosts(versions, items);
    const r = (n: number) => Math.round((c.get(n) ?? -1) * 100) / 100;
    expect([1, 2, 3, 4, 5, 6].map(r)).toEqual([0.91, 0.06, 0.03, 0.17, 0.03, 0.02]);
    expect(c.has(7)).toBe(false);
    const sum = [...c.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual(1.03 + 0.25); // the two turn totals (final replies included)
  });

  it("works for versions whose messages are no longer in the conversation (old/archived)", () => {
    const c = versionCosts(versions, []);
    const r = (n: number) => Math.round((c.get(n) ?? -1) * 100) / 100;
    expect([1, 2, 3, 4, 5, 6].map(r)).toEqual([0.91, 0.06, 0.03, 0.17, 0.03, 0.02]);
  });
});
