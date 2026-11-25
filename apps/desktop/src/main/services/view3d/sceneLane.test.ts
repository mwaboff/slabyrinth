/**
 * One owner's scene worker: deadlines count running time, a queued job cancelled is skipped without touching the
 * worker, and a running job that must stop costs this lane only, with every request behind it told its scene is gone.
 * The worker is the real queue (sceneLoop) in-process over a scripted handler.
 */
import { describe, expect, it } from "vitest";
import { memoryLogger } from "../../logger";
import { sceneWorkerLoop } from "../../workers/sceneLoop";
import type {
  SceneWorkerMessage,
  SceneWorkerRequest,
  SceneWorkerResponse,
} from "../../workers/sceneProtocol";
import { inProcessPort } from "../testing/view3dRig";
import { LANE_RESTARTED, SceneLane } from "./sceneLane";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** "release" answers after `ms` of its scene id ("forever": never); every job run is recorded. */
function lane(): {
  lane: SceneLane;
  ran: string[];
  ports: Array<{ terminated: boolean }>;
  drops: { n: number };
} {
  const ran: string[] = [];
  const ports: Array<{ terminated: boolean }> = [];
  const drops = { n: 0 };
  const handle = async (msg: SceneWorkerRequest, post: (r: SceneWorkerResponse) => void): Promise<void> => {
    if (msg.type !== "release") return;
    ran.push(msg.sceneId);
    if (msg.sceneId === "forever") return new Promise<void>(() => undefined);
    await sleep(Number(msg.sceneId));
    post({ type: "released", id: msg.id });
  };
  const l = new SceneLane(
    "test",
    () => {
      const p = inProcessPort<SceneWorkerMessage, SceneWorkerResponse>(sceneWorkerLoop(handle));
      ports.push(p);
      return p;
    },
    memoryLogger(),
    () => {
      drops.n++;
    },
  );
  return { lane: l, ran, ports, drops };
}

const job = (ms: number | "forever"): { type: "release"; sceneId: string } => ({
  type: "release",
  sceneId: String(ms),
});

describe("scene lane", () => {
  it("counts a deadline from when the job starts, not from when it was queued", async () => {
    const t = lane();
    const long = t.lane.request(job(120), 1_000);
    const short = t.lane.request(job(1), 50);
    await expect(long).resolves.toMatchObject({ type: "released" });
    await expect(short).resolves.toMatchObject({ type: "released" });
    expect(t.ports.map((p) => p.terminated)).toEqual([false]);
  });

  it("a job cancelled while queued is skipped; the worker and the job running are untouched", async () => {
    const t = lane();
    const stop = new AbortController();
    const first = t.lane.request(job(40), 1_000);
    const queued = t.lane.request(job(2), 1_000, stop.signal);
    await sleep(5);
    stop.abort();
    await expect(queued).rejects.toMatchObject({ code: "cancelled" });
    await expect(first).resolves.toMatchObject({ type: "released" });
    await sleep(10);
    expect(t.ran).toEqual(["40"]);
    expect(t.ports.map((p) => p.terminated)).toEqual([false]);
    expect(t.drops.n).toBe(0);
  });

  it("a running job past its deadline stops this worker: those behind it are told their scene is gone", async () => {
    const t = lane();
    const stuck = t.lane.request(job("forever"), 40);
    const behind = t.lane.request(job(1), 1_000);
    await expect(stuck).rejects.toMatchObject({ code: "internal", message: /didn't answer in time/ });
    await expect(behind).rejects.toMatchObject({ code: "not_found", message: LANE_RESTARTED });
    expect(t.ports[0]?.terminated).toBe(true);
    expect(t.drops.n).toBe(1);
    // the next request starts a new worker
    await expect(t.lane.request(job(1), 1_000)).resolves.toMatchObject({ type: "released" });
    expect(t.ports).toHaveLength(2);
  });

  it("the owner's cancel of a running job stops the worker (the last resort) and says 'cancelled'", async () => {
    const t = lane();
    const stop = new AbortController();
    const stuck = t.lane.request(job("forever"), 10_000, stop.signal);
    await sleep(10);
    stop.abort();
    await expect(stuck).rejects.toMatchObject({ code: "cancelled" });
    expect(t.ports[0]?.terminated).toBe(true);
  });
});
