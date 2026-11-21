import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectSnapshot, SlabyrinthApi } from "../../shared/ipc";
import { setBridge } from "../bridge/client";
import { switchProject, useProject } from "./project";

afterEach(() => {
  vi.useRealTimers();
  useProject.getState().setSnapshot(null);
});

const snap = (projectId: string): ProjectSnapshot => ({ projectId }) as unknown as ProjectSnapshot;

describe("resume state (saveUi)", () => {
  it("is saved to the project it was made in, and dropped when another project opens first", async () => {
    vi.useFakeTimers();
    const invoke = vi.fn(() => Promise.resolve({ ok: true, value: undefined }));
    setBridge({ invoke, on: () => () => undefined, send: () => undefined } as unknown as SlabyrinthApi);
    useProject.getState().setSnapshot(snap("A"));
    useProject.getState().saveUi({ zoom: 2 });
    useProject.getState().setSnapshot(snap("B"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(invoke).not.toHaveBeenCalled();
    useProject.getState().saveUi({ zoom: 3 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(invoke).toHaveBeenCalledWith("project:setUiState", { ui: { zoom: 3 } });
  });

  it("is sent before a project switch, and none is sent while the switch is in flight", async () => {
    vi.useFakeTimers();
    const sent: Array<[string, unknown]> = [];
    let finishOpen: (v: unknown) => void = () => undefined;
    const invoke = vi.fn((channel: string, req: unknown) => {
      sent.push([channel, req]);
      if (channel === "project:open")
        return new Promise((r) => {
          finishOpen = r;
        });
      return Promise.resolve({ ok: true, value: undefined });
    });
    setBridge({ invoke, on: () => () => undefined, send: () => undefined } as unknown as SlabyrinthApi);
    useProject.getState().setSnapshot(snap("A"));
    useProject.getState().saveUi({ zoom: 2 });
    const opening = switchProject(() => invoke("project:open", { path: "B" }));
    // A's pending view state went first, before the open
    expect(sent).toEqual([
      ["project:setUiState", { ui: { zoom: 2 } }],
      ["project:open", { path: "B" }],
    ]);
    // a save while the open is in flight would reach main after the switch: it is not sent
    useProject.getState().savePasteGuide({ buildId: "b", currentStep: 1 });
    useProject.getState().saveUi({ zoom: 4 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(2);
    finishOpen({ ok: true, value: snap("B") });
    await opening;
  });
});
