/**
 * The build store asks main for a build without chunk options of its own: main's BuildService.defaultOptions turns the
 * TaleSpire settings into them. The store once sent alignment "none" whenever "Add alignment pillars to single-slab
 * builds" was off (the default), so every split build came without its pillars and each slab landed centred on the
 * cursor (owner, 0.3.0).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { SlabyrinthApi } from "../../shared/ipc";
import type { AppSettings } from "../../shared/project";
import { setBridge } from "../bridge/client";
import { useBuild } from "./build";
import { useSettings } from "./settings";

afterEach(() => {
  useBuild.getState().reset();
  useSettings.setState({ settings: null });
});

/** A bridge that records every compile:run request and refuses it (the store reports the refusal). */
function recordingBridge(): unknown[] {
  const seen: unknown[] = [];
  const api: SlabyrinthApi = {
    invoke: (channel, req) => {
      if (channel === "compile:run") seen.push(req);
      return Promise.resolve({ ok: false, error: { code: "validation", message: "stop here" } });
    },
    on: () => () => undefined,
    send: () => undefined,
  };
  setBridge(api);
  return seen;
}

describe("build store: compile:run", () => {
  for (const alignmentMarkers of [false, true])
    it(`never asks for alignment "none" (pillars on single slabs: ${String(alignmentMarkers)})`, async () => {
      const seen = recordingBridge();
      useSettings.setState({
        settings: { talespire: { levelLayout: "stacked", alignmentMarkers } } as unknown as AppSettings,
      });
      await useBuild.getState().run(3);
      expect(seen).toEqual([{ version: 3 }]);
      expect(useBuild.getState().error).toBe("stop here");
    });
});

describe("build store: a stopped build", () => {
  it("is not reported as a failed build", async () => {
    setBridge({
      invoke: () => Promise.resolve({ ok: false, error: { code: "cancelled", message: "Stopped." } }),
      on: () => () => undefined,
      send: () => undefined,
    } as unknown as SlabyrinthApi);
    await useBuild.getState().run(3);
    expect(useBuild.getState().error).toBeNull();
    expect(useBuild.getState().building).toBe(false);
  });
});
