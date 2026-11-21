/**
 * The 2D preview, the agent and the build resolve a plan against the same palettes, so what the GM and the model see
 * is what gets built: a generator-4
 * plan with a user palette that changes its layout gives one resolved hash through each entry point.
 *  - build: the compile worker's backend (ports/compile.ts), from the raw user palette files;
 *  - agent: the executor's resolve port with the palettes the engine puts in every tool context
 *    (EngineHost.getBuildPalettes, which app.ts wires to services/buildPalettes.ts);
 *  - preview: the renderer's resolve step (shared/resolveCore.ts) on the palettes data main sends over IPC.
 */
import { describe, expect, it } from "vitest";
import { defaultExecutorPorts } from "@slabyrinth/core/agent";
import type { Palette } from "@slabyrinth/core/contracts/compiler";
import { bundledPalettes } from "@slabyrinth/core/palette";
import { resolvePlan } from "@slabyrinth/core/resolve";
import { loadPlan } from "../../../../packages/core/test/fixtures";
import { NO_STALL_CANOPY } from "../../../../packages/core/test/fixtures/userPalettes";
import { compute, palettesFromData } from "../shared/resolveCore";
import { createCoreCompileBackend, type CompileInput } from "./ports/compile";
import { BuildPalettes } from "./services/buildPalettes";

describe("one plan, one map: preview, agent and build resolve alike", () => {
  const plan = loadPlan("stall-lineup-v1");
  const userPalettes = [NO_STALL_CANOPY];
  const effective: Palette[] = [];
  const buildPalettes = new BuildPalettes({
    palettes: {
      palettes: () => effective,
      compileInputs: () => ({
        palettes: effective,
        userPalettes,
        orientation: null,
        orientationOverride: null,
      }),
    },
    catalog: { current: () => null },
  });

  const input: CompileInput = {
    plan,
    options: {},
    palettes: effective,
    userPalettes,
    orientation: null,
    orientationOverride: null,
    availability: null,
  };
  const build = createCoreCompileBackend().compile(input, () => undefined).resolvedHash;

  it("the user palette changes the generator-4 layout (so the test can tell the palettes apart)", () => {
    expect(plan.generator).toBe(4);
    expect(build).not.toBe("");
    expect(build).not.toBe(resolvePlan(plan, bundledPalettes()).hash);
  });

  it("the agent resolves the plan the build compiles", () => {
    const agent = defaultExecutorPorts.resolvePlan?.(plan, buildPalettes.current(), 0);
    expect(agent?.hash).toBe(build);
  });

  it("the preview resolves the plan the build compiles, from the palettes data sent over IPC", () => {
    const data = structuredClone(buildPalettes.data());
    const options = {
      grid: true,
      roomNumbers: true,
      roomNames: true,
      furniture: true,
      gmLayer: true,
      legend: false,
    };
    const preview = compute({ id: 1, plan, version: 0, options }, palettesFromData(data));
    expect(preview.resolved.hash).toBe(build);
  });
});
