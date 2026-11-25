import { describe, expect, it } from "vitest";
import { MeshResidency, MeshState } from "./residency";

/** A scripted path: each frame wants some meshes at some distances; arrivals come back the next frame. */
function run(
  meshCount: number,
  bytesOf: (m: number) => number,
  budget: number,
  frames: Array<Array<[mesh: number, dist: number]>>,
): { residency: MeshResidency; peak: number; evictions: number } {
  const r = new MeshResidency(
    Array.from({ length: meshCount }, () => false),
    { budgetBytes: budget, maxInFlight: 4 },
  );
  const out = new Int32Array(16);
  const evicted = new Int32Array(64);
  let pending: number[] = [];
  let peak = 0;
  let evictions = 0;
  frames.forEach((wants, i) => {
    const frame = i + 1;
    for (const m of pending) {
      const a = r.admit(m, bytesOf(m), frame, evicted);
      evictions += a.evictedCount;
      peak = Math.max(peak, r.usedBytes);
    }
    pending = [];
    for (const [m, d] of wants) r.want(m, d, frame);
    r.retryOverBudget();
    const n = r.takeRequests(out);
    for (let k = 0; k < n; k++) pending.push(out[k] ?? 0);
  });
  return { residency: r, peak, evictions };
}

describe("mesh residency", () => {
  it("asks for the nearest meshes first, a few at a time", () => {
    const r = new MeshResidency([false, false, false, false, false, false], {
      budgetBytes: 1e9,
      maxInFlight: 2,
    });
    [50, 10, 40, 5, 30, 20].forEach((d, m) => r.want(m, d, 1));
    const out = new Int32Array(8);
    expect(r.takeRequests(out)).toBe(2);
    expect([...out.subarray(0, 2)]).toEqual([3, 1]);
    expect(r.state[3]).toBe(MeshState.Requested);
  });

  it("never asks for stand-ins", () => {
    const r = new MeshResidency([true, false], { budgetBytes: 1e9 });
    expect(r.want(0, 1, 1)).toBe(false);
    r.want(1, 2, 1);
    const out = new Int32Array(8);
    expect(r.takeRequests(out)).toBe(1);
    expect(out[0]).toBe(1);
  });

  it("never passes its byte budget on a long camera path", () => {
    const meshes = 400;
    const bytesOf = (m: number): number => 20_000 + (m % 7) * 9_000;
    const budget = 1_000_000;
    // a camera sweeping across the map: each frame wants a window of 30 meshes that slides by 3
    const frames = Array.from({ length: 200 }, (_, f) =>
      Array.from({ length: 30 }, (_, k): [number, number] => [(f * 3 + k) % meshes, k]),
    );
    const { residency, peak, evictions } = run(meshes, bytesOf, budget, frames);
    expect(peak).toBeLessThanOrEqual(budget);
    expect(residency.usedBytes).toBeLessThanOrEqual(budget);
    expect(evictions).toBeGreaterThan(0);
    expect(residency.residentCount()).toBeGreaterThan(10);
  });

  it("keeps what this frame draws and refuses a mesh that cannot fit", () => {
    const r = new MeshResidency([false, false, false], { budgetBytes: 100 });
    const ev = new Int32Array(8);
    r.want(0, 1, 1);
    r.want(1, 1, 1);
    r.takeRequests(new Int32Array(8));
    expect(r.admit(0, 60, 1, ev).ok).toBe(true);
    // mesh 0 was drawn this frame: 1 cannot evict it
    const a = r.admit(1, 60, 1, ev);
    expect(a.ok).toBe(false);
    expect(r.state[1]).toBe(MeshState.OverBudget);
    expect(r.limited).toBe(true);
    // next frame 0 is not drawn: 2 may take its place
    r.want(2, 1, 2);
    r.takeRequests(new Int32Array(8));
    const b = r.admit(2, 60, 3, ev);
    expect(b.ok).toBe(true);
    expect(b.evictedCount).toBe(1);
    expect(ev[0]).toBe(0);
    expect(r.usedBytes).toBe(60);
  });

  it("forgets everything when the GPU context is lost", () => {
    const r = new MeshResidency([false, false], { budgetBytes: 100 });
    r.want(0, 1, 1);
    r.takeRequests(new Int32Array(8));
    r.admit(0, 10, 1, new Int32Array(4));
    r.reset();
    expect(r.usedBytes).toBe(0);
    expect(r.state[0]).toBe(MeshState.Absent);
  });
});
