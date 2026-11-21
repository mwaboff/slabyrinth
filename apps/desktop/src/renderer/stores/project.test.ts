import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectSnapshot, SlabyrinthApi } from "../../shared/ipc";
import { setBridge } from "../bridge/client";
import { useProject } from "./project";

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
});
