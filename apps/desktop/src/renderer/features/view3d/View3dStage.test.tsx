/** The 3D tab against the fake main (real box scenes of the fixture plan): every state, every control, the readout. */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MapPlan } from "@slabyrinth/core";
import { call, setBridge } from "../../bridge/client";
import { createFakeBridge, type FakeScenario } from "../../bridge/fake/fakeBridge";
import { useApp } from "../../stores/app";
import { useChat } from "../../stores/chat";
import { useMap } from "../../stores/map";
import { useView3d } from "../../stores/view3d";
import { openProject } from "../../app/actions";
import { COMMANDS, useShortcuts } from "../../app/commands";
import { levelShort, orderedLevels, useProject } from "../../stores/project";
import { Stage } from "../stage/Stage";
import { fakeBackend, type FakeBackend } from "./engine/fakeBackend";
import type { PickInfo, View3dApi } from "./engine/engine";
import { memorySceneSource } from "./memorySceneSource";
import { assembleScene } from "@slabyrinth/scene3d";
import { syntheticLookup, syntheticMeshSource, townPieces } from "./synthetic";
import type { SceneHeader, SceneSource } from "./sceneSource";
import { Readout } from "./View3dPanels";
import { View3dStage, boxesNote } from "./View3dStage";

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

/** The tab's viewer, as the test-mode hook exposes it. */
const viewer = (): View3dApi | null =>
  (window as unknown as { __slabyrinthView3dTab?: { api: View3dApi | null } }).__slabyrinthView3dTab?.api ??
  null;

const masks = (b: FakeBackend) => b.last.uniforms?.masks;

beforeEach(() => {
  useApp.getState().closeSettings();
  useApp.getState().setRoute("boot");
  useApp.setState({
    banners: { tsMissing: false, offline: false, saveFailed: null },
    tsBannerDismissed: false,
  });
  useMap.getState().reset();
  useView3d.getState().resetView();
  useView3d.setState({ hintDismissed: false });
});

async function ready(backend: FakeBackend): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Frame all" })).toBeEnabled();
  });
  await waitFor(() => {
    expect(backend.last.uniforms).not.toBeNull();
  });
}

describe("the 3D tab", () => {
  it("says what it is and how to move, and the hint stays dismissed", async () => {
    await openAbbey();
    const backend = fakeBackend();
    const { unmount } = render(<View3dStage plan={plan} version={4} createBackend={() => backend} />);
    const bar = screen.getByRole("toolbar", { name: "3D view" });
    expect(bar).toHaveTextContent("v4 as TaleSpire will get it");
    const canvas = screen.getByRole("application", { name: "3D view of v4" });
    expect(canvas).toHaveAccessibleDescription(/Drag to turn, right-drag to move, wheel to zoom/);
    await ready(backend);
    const hint = screen.getByRole("region", { name: "About the 3D view" });
    expect(hint).toHaveTextContent("This is what TaleSpire will get");
    expect(hint).toHaveTextContent(
      /Drag to turn.*Right-drag to move.*Wheel to zoom.*Click a piece to see what it is/,
    );
    await userEvent.click(within(hint).getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("region", { name: "About the 3D view" })).toBeNull();
    unmount();
    // back on the tab later in the session: no hint
    render(<View3dStage plan={plan} version={4} createBackend={() => fakeBackend()} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Frame all" })).toBeEnabled();
    });
    expect(screen.queryByRole("region", { name: "About the 3D view" })).toBeNull();
  });

  it("the Controls card lists every move and key, and the hint opens it", async () => {
    await openAbbey();
    const backend = fakeBackend();
    render(<View3dStage plan={plan} version={4} createBackend={() => backend} />);
    await ready(backend);
    await userEvent.click(screen.getByRole("button", { name: "Keyboard controls" }));
    const card = screen.getByRole("dialog", { name: "3D controls" });
    expect(card).toHaveTextContent("W A S D");
    expect(card).toHaveTextContent("Roofs on or off");
    expect(card).toHaveTextContent("Right-drag or Shift+drag");
    const btn = screen.getByRole("button", { name: "Controls" });
    expect(btn).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(btn);
    expect(screen.queryByRole("dialog", { name: "3D controls" })).toBeNull();
  });

  it("says once why pieces are boxes, with a way to fix it unless the banner already offers one", async () => {
    await openAbbey();
    const backend = fakeBackend();
    const { unmount } = render(<View3dStage plan={plan} version={4} createBackend={() => backend} />);
    const status = await screen.findByRole("status", { name: "3D view status" });
    await waitFor(() => {
      expect(status).toHaveTextContent(/plain box of its real size: TaleSpire wasn't found on this PC/);
    });
    await userEvent.click(within(status).getByRole("button", { name: "Locate TaleSpire…" }));
    expect(useApp.getState().settingsOpen).toBe("talespire");
    unmount();

    // with the app's "TaleSpire wasn't found" banner on screen: the consequence only, no second button
    act(() => {
      useApp.getState().closeSettings();
      useApp.getState().setRoute("workspace");
      useApp.getState().setBanner({ tsMissing: true });
    });
    render(<View3dStage plan={plan} version={4} createBackend={() => fakeBackend()} />);
    const again = await screen.findByRole("status", { name: "3D view status" });
    await waitFor(() => {
      expect(again).toHaveTextContent(
        "Every piece is a plain box of its real size until TaleSpire is found.",
      );
    });
    expect(within(again).queryByRole("button")).toBeNull();
  });

  it("says when 3D pieces are turned off, with the setting to turn them on", async () => {
    await openAbbey({ meshes: "off" });
    render(<View3dStage plan={plan} version={4} createBackend={() => fakeBackend()} />);
    expect(await screen.findByText(/plain box because 3D pieces are turned off/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Turn on in Settings" }));
    expect(useApp.getState().settingsOpen).toBe("ai");
  });

  it("says TaleSpire's pieces are still being read, then shows the detailed scene", async () => {
    await openAbbey({ meshes: "reading" });
    render(<View3dStage plan={plan} version={4} createBackend={() => fakeBackend()} />);
    expect(await screen.findByText(/Reading TaleSpire's pieces/)).toBeInTheDocument();
    await waitFor(
      () => {
        expect(screen.queryByText(/Reading TaleSpire's pieces/)).toBeNull();
      },
      { timeout: 5000 },
    );
  });

  it("says plainly when there is no such version, and can try again", async () => {
    await openAbbey();
    render(<View3dStage plan={plan} version={99} createBackend={() => fakeBackend()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "There's no 3D view of this version of the map.",
    );
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no 3D view of this version/);
  });

  it("while laying out, says so with a Stop", async () => {
    await openAbbey();
    let release: () => void = () => undefined;
    const real = (await import("./ipcSceneSource")).ipcSceneSource();
    const slow: SceneSource = {
      ...real,
      open: (t) =>
        new Promise((r) => {
          release = () => {
            r(real.open(t));
          };
        }),
    };
    render(<View3dStage plan={plan} version={4} source={slow} createBackend={() => fakeBackend()} />);
    const card = await screen.findByText("Laying out v4 in 3D…");
    expect(card.closest("[role=status]")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Frame all" })).toBeDisabled();
    act(() => {
      release();
    });
    await waitFor(() => {
      expect(screen.queryByText("Laying out v4 in 3D…")).toBeNull();
    });
  });

  it("without 3D on this PC shows a still picture, in plain words", async () => {
    await openAbbey();
    // jsdom has no WebGL: the canvas cannot start, so the tab asks main for a picture
    render(<View3dStage plan={plan} version={4} />);
    expect(await screen.findByText(/graphics card can't show the 3D view on this PC/)).toBeInTheDocument();
    const img = await screen.findByRole("img", {}, { timeout: 5000 });
    expect(img.getAttribute("src")).toMatch(/^blob:/);
    expect(img).toHaveAttribute("alt", expect.stringMatching(/./));
    expect(screen.getByRole("button", { name: "Hide roofs" })).toBeDisabled();
    expect(screen.queryByRole("complementary", { name: "Colour key" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Move the view" })).toBeNull();
  });

  it("the colour key lists the kinds on this map and hides one; the status line says what is hidden", async () => {
    await openAbbey();
    const backend = fakeBackend();
    render(<View3dStage plan={plan} version={4} createBackend={() => backend} />);
    await ready(backend);
    const key = screen.getByRole("complementary", { name: "Colour key" });
    const wall = await within(key).findByRole("checkbox", { name: /Wall/ });
    expect(wall).toBeChecked();
    // the crypt has no roofs, alignment markers aside: nothing it does not have is listed
    expect(within(key).queryByRole("checkbox", { name: /Unknown piece/ })).toBeNull();
    await userEvent.click(wall);
    expect(wall).not.toBeChecked();
    expect(useView3d.getState().hiddenClasses).toEqual(["wall"]);
    await waitFor(() => {
      expect(masks(backend)?.classMask ?? 0).not.toBe(0);
    });
    const status = screen.getByRole("status", { name: "3D view status" });
    expect(status).toHaveTextContent("Hidden: wall.");
    await userEvent.click(within(status).getByRole("button", { name: "Show everything" }));
    expect(useView3d.getState().hiddenClasses).toEqual([]);
    await waitFor(() => {
      expect(masks(backend)?.classMask).toBe(0);
    });
    // a map without roofs: nothing to hide
    expect(screen.getByRole("button", { name: "Hide roofs" })).toBeDisabled();
    // collapsing the key leaves a rail that opens it again
    await userEvent.click(within(key).getByRole("button", { name: /Collapse colour key/ }));
    await userEvent.click(screen.getByRole("button", { name: /Show colour key/ }));
    expect(screen.getByRole("complementary", { name: "Colour key" })).toBeInTheDocument();
  });

  it("shows up to a level: the levels above are hidden, framed, and named in the status line", async () => {
    await openAbbey();
    const backend = fakeBackend();
    render(<View3dStage plan={plan} version={4} createBackend={() => backend} />);
    await ready(backend);
    if (plan.levels.length < 2) throw new Error("the fixture has two levels");
    const byElevation = [...plan.levels].sort((a, b) => a.elevation - b.elevation);
    const lowest = byElevation[0];
    const upper = byElevation[1];
    if (!lowest || !upper) throw new Error("two levels");
    const before = viewer()?.getCamera();
    act(() => {
      useView3d.getState().setCutLevel(lowest.id);
    });
    await waitFor(() => {
      expect([...(masks(backend)?.levelShown ?? [])]).toEqual([1, 0]);
    });
    await waitFor(() => {
      expect(viewer()?.getCamera()).not.toEqual(before);
    });
    expect(screen.getByRole("status", { name: "3D view status" })).toHaveTextContent(upper.name);
    act(() => {
      useView3d.getState().setCutLevel(null);
    });
    await waitFor(() => {
      expect([...(masks(backend)?.levelShown ?? [])]).toEqual([1, 1]);
    });
  });

  it("the move buttons and the toolbar move the camera", async () => {
    await openAbbey();
    const backend = fakeBackend();
    render(<View3dStage plan={plan} version={4} createBackend={() => backend} />);
    await ready(backend);
    const cam = () => viewer()?.getCamera();
    const nav = screen.getByRole("group", { name: "Move the view" });
    const c0 = cam();
    await userEvent.click(within(nav).getByRole("button", { name: "Zoom in (+)" }));
    expect(cam()?.distance).toBeLessThan(c0?.distance ?? 0);
    const c1 = cam();
    await userEvent.click(within(nav).getByRole("button", { name: "Turn left (←)" }));
    expect(cam()?.bearing).not.toBe(c1?.bearing);
    await userEvent.click(screen.getByRole("button", { name: "Top-down" }));
    await userEvent.click(screen.getByRole("button", { name: "Frame all" }));
  });
});

describe("roofs and cut height", () => {
  // jsdom lays nothing out: give the viewer a real size, so it wants (and loads) the town's pieces
  beforeEach(() => {
    const w = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    const h = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    return () => {
      w.mockRestore();
      h.mockRestore();
    };
  });

  it("hides the roofs (button and colour key agree) and then offers a cut height", async () => {
    await openAbbey();
    // the synthetic town, every storey on one level: a level taller than a storey and its roof
    const { pieces, levels } = townPieces({ side: 64, levels: 3 });
    for (const p of pieces) p.levelId = "l0";
    const town = await assembleScene(
      "build",
      pieces,
      levels.slice(0, 1),
      syntheticLookup,
      syntheticMeshSource(),
    );
    const mem = memorySceneSource(new Map([["town", town]]));
    const source: SceneSource = { ...mem, open: () => mem.open({ buildId: "town" }) };
    const backend = fakeBackend();
    render(<View3dStage plan={plan} version={4} source={source} createBackend={() => backend} />);
    await ready(backend);
    const roofs = screen.getByRole("button", { name: "Hide roofs" });
    await waitFor(() => {
      expect(roofs).toBeEnabled();
    });
    expect(roofs).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(roofs);
    expect(roofs).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => {
      expect(masks(backend)?.hideRoofs).toBe(true);
    });
    const key = screen.getByRole("complementary", { name: "Colour key" });
    const roofRow = within(key).getByRole("checkbox", { name: /Roof/ });
    expect(roofRow).not.toBeChecked();
    expect(screen.getByRole("status", { name: "3D view status" })).toHaveTextContent("Hidden: roofs.");
    // the town's top level is three storeys tall: a cut height is offered once the roofs are off
    const slider = screen.getByRole("slider", { name: /Cut height/ });
    expect(slider).toHaveAttribute("aria-valuetext", "Off");
    fireEvent.change(slider, { target: { value: String(Number(slider.getAttribute("min"))) } });
    expect(useView3d.getState().cutHeight).not.toBeNull();
    await waitFor(() => {
      expect(Number.isFinite(masks(backend)?.cutHeight ?? Infinity)).toBe(true);
    });
    await userEvent.click(roofRow);
    expect(roofs).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("slider", { name: /Cut height/ })).toBeNull();
    await waitFor(() => {
      expect(masks(backend)?.cutHeight).toBe(Infinity);
    });
  });
});

describe("the clicked piece", () => {
  const pickIn = (p: MapPlan, over: Partial<PickInfo> = {}): PickInfo => {
    const level = p.levels[0];
    const room = level?.areas.find((a) => a.name !== undefined);
    if (!level || !room) throw new Error("the fixture has a named room");
    return {
      id: 1,
      name: "iron_door_02",
      meshKey: "box:x",
      colourClass: "opening",
      classLabel: "Door, window, gate",
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
      ...over,
    };
  };

  it("says its kind, name, level, room and square", async () => {
    await openAbbey();
    const level = plan.levels[0];
    const room = level?.areas.find((a) => a.name !== undefined);
    let cleared = false;
    render(
      <Readout
        plan={plan}
        pick={pickIn(plan)}
        allBoxes={false}
        onClear={() => {
          cleared = true;
        }}
      />,
    );
    const r = screen.getByRole("region", { name: "Selected piece" });
    // the kind as the colour key names it, and the piece's name in words
    expect(r).toHaveTextContent("Door, window, gate");
    expect(r).toHaveTextContent("Iron door");
    expect(r).not.toHaveTextContent("iron_door");
    expect(r).toHaveTextContent(
      `${levelShort(plan, level?.id ?? "")} ${level?.name ?? ""} · ${room?.name ?? ""} · square H12`,
    );
    expect(r).toHaveTextContent("Shown as a box of its real size");
    await userEvent.click(screen.getByRole("button", { name: "Clear (Esc)" }));
    expect(cleared).toBe(true);
  });

  it("says nothing about boxes when every piece is one", async () => {
    await openAbbey();
    render(<Readout plan={plan} pick={pickIn(plan)} allBoxes onClear={() => undefined} />);
    expect(screen.getByRole("region", { name: "Selected piece" })).not.toHaveTextContent("Shown as a box");
  });

  it("Show on map selects its room on the Map; Mention in chat puts the room in the composer", async () => {
    await openAbbey();
    await openProject(abbeyPath);
    const pick = pickIn(plan);
    useMap.getState().setTab("3d");
    useChat.getState().clearRefs();
    render(<Readout plan={plan} pick={pick} allBoxes={false} onClear={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "Mention in chat" }));
    expect(useChat.getState().refs.map((r) => r.id)).toEqual([pick.elementId]);
    await userEvent.click(screen.getByRole("button", { name: "Show on map" }));
    expect(useMap.getState().tab).toBe("map");
    expect(useMap.getState().levelId).toBe(pick.levelId);
    expect(useMap.getState().sel.areaIds).toEqual([pick.elementId]);
  });

  it("a piece of no named element is mentioned by its kind and square", async () => {
    await openAbbey();
    useChat.getState().setDraft("");
    useChat.getState().clearRefs();
    render(
      <Readout
        plan={plan}
        pick={pickIn(plan, { elementId: null, role: "floor", colourClass: "floor", classLabel: "Floor" })}
        allBoxes={false}
        onClear={() => undefined}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Mention in chat" }));
    expect(useChat.getState().refs).toEqual([]);
    expect(useChat.getState().draft).toMatch(/^the floor at L\d square H12: $/);
  });
});

function Keys() {
  useShortcuts();
  return null;
}

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
    const tabs = within(screen.getByRole("tablist", { name: "Stage" })).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Map", "3D", "Build"]);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("title", "The map in 3D, as TaleSpire will get it (Ctrl+3)");
    expect(tabs[2]).toHaveAttribute("aria-disabled", String(!approved));
    expect(screen.getByRole("toolbar", { name: "3D view" })).toBeInTheDocument();
    // the status bar's main action is still there
    expect(
      screen.getByRole("button", { name: /Approve plan v|Build for TaleSpire|Open build/ }),
    ).toBeInTheDocument();
  });

  it("its level tabs are the one 'show up to' control, and PgUp/PgDn, Alt+n and R work on it", async () => {
    await openAbbey();
    await openProject(abbeyPath);
    act(() => {
      useApp.getState().setRoute("workspace");
      useMap.getState().setTab("3d");
    });
    render(
      <>
        <Keys />
        <Stage />
      </>,
    );
    const ordered = orderedLevels(plan);
    const levels = screen.getByRole("tablist", { name: "Levels shown in 3D" });
    const tabs = within(levels).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "All levels",
      ...ordered.map((l, i) => `L${String(i + 1)}${l.name}`),
    ]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("combobox")).toBeNull();
    const second = ordered[1];
    if (!second) throw new Error("two levels");
    await userEvent.click(tabs[2] as HTMLElement);
    expect(useView3d.getState().cutLevelId).toBe(second.id);
    expect(useMap.getState().levelId).toBe(second.id);
    expect(within(levels).getAllByRole("tab")[2]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(window, { key: "PageUp" });
    expect(useView3d.getState().cutLevelId).toBe(ordered[0]?.id);
    fireEvent.keyDown(window, { key: "PageUp" });
    expect(useView3d.getState().cutLevelId).toBeNull();
    fireEvent.keyDown(window, { key: "PageDown" });
    expect(useView3d.getState().cutLevelId).toBe(ordered[0]?.id);
    fireEvent.keyDown(window, { key: "2", altKey: true });
    expect(useView3d.getState().cutLevelId).toBe(second.id);
    fireEvent.keyDown(window, { key: "r" });
    expect(useView3d.getState().roofsHidden).toBe(true);
    fireEvent.keyDown(window, { key: "r" });
    expect(useView3d.getState().roofsHidden).toBe(false);
    // the Map tab keeps its own level tabs
    act(() => {
      useMap.getState().setTab("map");
    });
    expect(screen.getByRole("tablist", { name: "Levels" })).toBeInTheDocument();
  });
});

describe("the boxes note", () => {
  const header = (pendingDetail: number): SceneHeader =>
    ({
      pendingDetail,
      boxes: { pieces: 4, reasons: [{ reason: "not-read-yet", pieces: 4 }], note: "4 pieces are boxes." },
    }) as unknown as SceneHeader;

  it("says 'reading' only while main reads: pieces it already tried and could not read are plain boxes", () => {
    expect(boxesNote(header(4), () => undefined, false)?.id).toBe("reading");
    expect(boxesNote(header(0), () => undefined, false)).toMatchObject({
      id: "boxes",
      text: "4 pieces are boxes.",
    });
  });
});
