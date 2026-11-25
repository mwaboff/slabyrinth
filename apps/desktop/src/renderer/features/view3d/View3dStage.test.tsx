/** The 3D tab against the fake main (real box scenes of the fixture plan): states, controls, readout, fallback. */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { MapPlan } from "@slabyrinth/core";
import { call, setBridge } from "../../bridge/client";
import { createFakeBridge, type FakeScenario } from "../../bridge/fake/fakeBridge";
import { useApp } from "../../stores/app";
import { useMap } from "../../stores/map";
import { openProject } from "../../app/actions";
import { COMMANDS } from "../../app/commands";
import { useProject } from "../../stores/project";
import { Stage } from "../stage/Stage";
import { fakeBackend, type FakeBackend } from "./engine/fakeBackend";
import type { PickInfo } from "./engine/engine";
import { Readout, View3dStage } from "./View3dStage";

let plan: MapPlan;
let abbeyPath = "";

async function openAbbey(scenario: FakeScenario = {}): Promise<void> {
  setBridge(createFakeBridge({ speed: 0, scenario }));
  const list = await call("project:list", undefined);
  const abbey = list.find((p) => p.name === "The Drowned Abbey");
  if (!abbey) throw new Error("fixture project missing");
  abbeyPath = abbey.path;
  const snap = await call("project:open", { path: abbey.path });
  if (!snap?.plan) throw new Error("the fixture has a plan");
  plan = snap.plan;
}

beforeEach(() => {
  useApp.getState().closeSettings();
  useMap.getState().reset();
});

describe("the 3D tab", () => {
  it("shows the version in 3D, says why pieces are boxes with what to do, and its controls drive the view", async () => {
    await openAbbey();
    const backend: FakeBackend = fakeBackend();
    render(<View3dStage plan={plan} version={4} createBackend={() => backend} />);
    expect(screen.getByRole("toolbar", { name: "3D view" })).toHaveTextContent("3D of v4");
    const canvas = screen.getByRole("application", { name: "3D view of the map" });
    expect(canvas).toHaveAccessibleDescription(/Drag to turn .* WASD to move/);
    // the layout state, then the boxes note
    const status = await screen.findByRole("status", { name: "3D view status" });
    await waitFor(() => {
      expect(status).toHaveTextContent(/Showing boxes because TaleSpire was not found on this PC/);
    });
    const frameAll = screen.getByRole("button", { name: "Frame all" });
    await waitFor(() => {
      expect(frameAll).toBeEnabled();
    });
    await userEvent.click(screen.getByRole("button", { name: "Open TaleSpire settings" }));
    expect(useApp.getState().settingsOpen).toBe("talespire");
    await userEvent.click(frameAll);
    await userEvent.click(screen.getByRole("button", { name: "Top-down" }));

    // roofs: the button and R on the focused canvas
    const roofs = screen.getByRole("button", { name: "Roofs" });
    expect(roofs).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(roofs);
    expect(roofs).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => {
      expect(backend.last.uniforms?.masks.hideRoofs).toBe(true);
    });
    canvas.focus();
    fireEvent.keyDown(canvas, { key: "r" });
    expect(roofs).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => {
      expect(backend.last.uniforms?.masks.hideRoofs).toBe(false);
    });

    // show up to a level: the levels above it are not drawn
    const levels = screen.getByRole("combobox", { name: "Show up to" });
    const options = [...(levels as HTMLSelectElement).options].map((o) => o.text);
    expect(options[0]).toBe("All levels");
    expect(options.length).toBe(plan.levels.length + 1);
    if (plan.levels.length > 1) {
      await userEvent.selectOptions(levels, "0");
      await waitFor(() => {
        expect([...(backend.last.uniforms?.masks.levelShown ?? [])].slice(1).every((v) => v === 0)).toBe(
          true,
        );
      });
      // a level tab on the stage bar moves the cut too (to a level above the lowest)
      const lowest = [...plan.levels].sort((a, b) => a.elevation - b.elevation)[0]?.id;
      const higher = plan.levels.find((l) => l.id !== lowest)?.id ?? "";
      act(() => {
        useMap.getState().setLevel(higher);
      });
      await waitFor(() => {
        expect((levels as HTMLSelectElement).value).not.toBe("0");
      });
      await userEvent.selectOptions(levels, "");
      await waitFor(() => {
        expect([...(backend.last.uniforms?.masks.levelShown ?? [])].every((v) => v === 1)).toBe(true);
      });
    }
  });

  it("says when the 3D view is off, with the setting to turn it on", async () => {
    await openAbbey({ meshes: "off" });
    render(<View3dStage plan={plan} version={4} createBackend={() => fakeBackend()} />);
    expect(await screen.findByText(/Showing boxes because the 3D view is off/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open AI settings" }));
    expect(useApp.getState().settingsOpen).toBe("ai");
  });

  it("says 3D pieces are still being read, then shows the detailed scene", async () => {
    await openAbbey({ meshes: "reading" });
    render(<View3dStage plan={plan} version={4} createBackend={() => fakeBackend()} />);
    expect(await screen.findByText(/3D pieces are still being read/)).toBeInTheDocument();
    await waitFor(
      () => {
        expect(screen.queryByText(/3D pieces are still being read/)).toBeNull();
      },
      { timeout: 5000 },
    );
  });

  it("says plainly when there is no such version, and can try again", async () => {
    await openAbbey();
    render(<View3dStage plan={plan} version={99} createBackend={() => fakeBackend()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/no 3D scene for this version/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("without WebGL2 shows a still picture of the map from main", async () => {
    await openAbbey();
    // jsdom has no WebGL: the canvas cannot start, so the tab asks main for a picture
    render(<View3dStage plan={plan} version={4} />);
    expect(await screen.findByText(/graphics acceleration, which isn't available here/)).toBeInTheDocument();
    const img = await screen.findByRole("img", {}, { timeout: 5000 });
    expect(img.getAttribute("src")).toMatch(/^blob:/);
    expect(img).toHaveAttribute("alt", expect.stringMatching(/./));
    expect(screen.getByRole("button", { name: "Roofs" })).toBeDisabled();
  });

  it("a clicked piece says its role, level, plan element and square", async () => {
    await openAbbey();
    const level = plan.levels[0];
    const room = level?.areas.find((a) => a.name !== undefined);
    if (!level || !room) throw new Error("the fixture has a named room");
    const pick: PickInfo = {
      id: 1,
      name: "Stone wall",
      meshKey: "box:x",
      colourClass: "wall",
      classLabel: "Wall",
      levelId: level.id,
      levelIndex: 0,
      levelName: level.name,
      layer: "site",
      elementId: room.id,
      role: "opening",
      cell: [level.bounds.x + 7, level.bounds.y + 11],
      stand: "box",
      point: { x: 0, y: 0, z: 0 },
      box: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    };
    let cleared = false;
    render(
      <Readout
        plan={plan}
        pick={pick}
        onClear={() => {
          cleared = true;
        }}
      />,
    );
    const r = screen.getByRole("region", { name: "Selected piece" });
    expect(r).toHaveTextContent("Door, window or gate · Stone wall");
    expect(r).toHaveTextContent(`L1 ${level.name} · ${room.name ?? ""} · square H12`);
    expect(r).toHaveTextContent("Shown as a box of its real size");
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(cleared).toBe(true);
  });
});

describe("the stage's 3D tab", () => {
  it("sits between Map and Build, opens with Ctrl+3, and leaves Build as it was", async () => {
    await openAbbey();
    await openProject(abbeyPath);
    const approved = useProject.getState().snap?.approvedVersion !== null;
    const ctrl3 = COMMANDS.find((c) => c.keys === "Ctrl+3");
    expect(ctrl3?.enabled?.()).toBe(true);
    act(() => {
      ctrl3?.run();
    });
    expect(useMap.getState().tab).toBe("3d");
    render(<Stage />);
    const tabs = screen.getAllByRole("tab").slice(0, 3);
    expect(tabs.map((t) => t.textContent)).toEqual(["Map", "3D", "Build"]);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("title", "3D (Ctrl+3)");
    expect(tabs[2]).toHaveAttribute("aria-disabled", String(!approved));
    expect(screen.getByRole("toolbar", { name: "3D view" })).toBeInTheDocument();
  });
});
