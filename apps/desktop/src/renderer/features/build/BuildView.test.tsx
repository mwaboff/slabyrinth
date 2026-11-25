/**
 * The build page's states a GM must be able to read: a failed build says so and offers Build again, a build the plan
 * has moved past stops offering the gold copy, build problems sit above the paste-guide button, and the loading
 * and changing-layout moments say what is happening.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MapPlan } from "@slabyrinth/core";
import type { ProjectSnapshot, SlabyrinthApi } from "../../../shared/ipc";
import { setBridge } from "../../bridge/client";
import { useApp } from "../../stores/app";
import { useBuild } from "../../stores/build";
import { useMap } from "../../stores/map";
import { useProject } from "../../stores/project";
import { useSettings } from "../../stores/settings";
import { BuildToolbar, BuildView } from "./BuildView";

vi.mock("../../map/resolveClient", () => ({
  useResolved: () => ({ data: null }),
}));

const plan = {
  levels: [{ id: "l1", name: "Crypt", areas: [] }],
} as unknown as MapPlan;

function chunk(id: string, step: number, pasted = false) {
  return {
    id,
    levelIds: ["l1"],
    index: step - 1,
    globalStep: step,
    label: `Part ${String(step)}`,
    region: { x0: step * 10, y0: 0, x1: step * 10 + 9, y1: 9 },
    sizeBytes: 1000,
    limitBytes: 30720,
    contentHash: `h${String(step)}`,
    offset: { x: 0, y: 0, z: 0 },
    pasted,
  };
}

function record(chunks: number, pasted = false) {
  return {
    id: "b1",
    versionNumber: 2,
    createdAt: "2026-11-24T10:00:00.000Z",
    catalogVersion: "c",
    assetSource: "install",
    settings: {
      stacking: "stacked",
      gapSq: 1,
      markers: "multi-chunk",
      copyFormat: "plain",
      orientationHash: "o",
      paletteHash: "p",
    },
    levels: [
      {
        levelId: "l1",
        pasteOrder: 0,
        placement: { kind: "ground" },
        chunks: Array.from({ length: chunks }, (_, i) => chunk(`c${String(i + 1)}`, i + 1, pasted)),
      },
    ],
    substitutions: [],
    unmatchedAssets: [],
    diagnosticsSummary: { errors: 0, warnings: 0 },
  };
}

function snapshot(over: { head?: number; builds?: unknown[]; approvedVersion?: number | null }) {
  return {
    plan,
    head: 2,
    approvedVersion: 2,
    builds: [],
    ...over,
  } as unknown as ProjectSnapshot;
}

beforeEach(() => {
  setBridge({
    invoke: (channel: string) =>
      Promise.resolve({ ok: true, value: channel === "plan:getVersion" ? plan : undefined }),
    on: () => () => undefined,
    send: () => undefined,
  } as unknown as SlabyrinthApi);
  useSettings.setState({ catalog: null });
});

afterEach(() => {
  useBuild.getState().reset();
  useSettings.setState({ settings: null });
  useProject.setState({ snap: null });
  useApp.setState({ confirm: null });
  useMap.setState({ tab: "build" });
});

describe("a build that failed", () => {
  it("is shown with the reason and a Build again button, with nothing built yet", async () => {
    const run = vi.fn(() => Promise.resolve());
    useProject.setState({ snap: snapshot({}) });
    useBuild.setState({ error: "The compiler stopped: out of memory.", run });
    render(<BuildView />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The build didn't finish.");
    expect(alert).toHaveTextContent("out of memory");
    await userEvent.click(within(alert).getByRole("button", { name: "Build again" }));
    expect(run).toHaveBeenCalledWith(2);
  });

  it("is shown above the last good build, which stays readable", () => {
    useProject.setState({ snap: snapshot({ builds: [record(1)] }) });
    useBuild.setState({ error: "The compiler stopped: out of memory." });
    render(<BuildView />);
    expect(screen.getByRole("alert")).toHaveTextContent("last one that worked");
    expect(screen.getByRole("heading", { name: "Built from v2" })).toBeTruthy();
  });

  it("is not shown when the build worked", () => {
    useProject.setState({ snap: snapshot({ builds: [record(1)] }) });
    render(<BuildView />);
    expect(screen.queryByText("The build didn't finish.")).toBeNull();
  });
});

describe("a build the plan has moved past", () => {
  it("makes Approve and rebuild the main action and the copy a named second choice", async () => {
    useProject.setState({ snap: snapshot({ head: 3, builds: [record(1)] }) });
    render(<BuildView />);
    const rebuild = screen.getByRole("button", { name: "Approve v3 & rebuild" });
    expect(rebuild).toHaveClass("btn--primary");
    const copy = await screen.findByRole("button", { name: /Copy v2.* anyway/ });
    expect(copy).not.toHaveClass("btn--primary");
    expect(screen.queryByRole("button", { name: "Copy & open TaleSpire" })).toBeNull();
  });

  it("keeps the gold copy when the build is current", () => {
    useProject.setState({ snap: snapshot({ builds: [record(1)] }) });
    render(<BuildView />);
    expect(screen.getByRole("button", { name: "Copy & open TaleSpire" })).toHaveClass("btn--primary");
    expect(screen.queryByRole("button", { name: /Approve v/ })).toBeNull();
  });
});

describe("loading the built version", () => {
  it("says which version is loading", () => {
    useProject.setState({ snap: snapshot({ head: 3, builds: [record(1)] }) });
    render(<BuildView />);
    expect(screen.getByRole("status", { name: "Loading v2…" })).toBeTruthy();
  });
});

describe("building", () => {
  it("shows progress as a labelled bar and a normal Cancel button", () => {
    useProject.setState({ snap: snapshot({}) });
    useBuild.setState({ building: true, progress: { stage: "realize", done: 1, total: 4 } });
    render(<BuildView />);
    expect(screen.getByRole("progressbar", { name: "Build progress" })).toHaveAttribute(
      "aria-valuenow",
      "25",
    );
    expect(screen.getByRole("button", { name: "Cancel" })).not.toHaveClass("btn--ghost");
  });
});

describe("the options bar", () => {
  const twoLevels = {
    ...snapshot({ builds: [record(1)] }),
    plan: { levels: [{ id: "l1" }, { id: "l2" }] },
  } as unknown as ProjectSnapshot;

  it("does not show a Copy as setting that cannot be changed", () => {
    useProject.setState({ snap: twoLevels });
    useSettings.setState({
      settings: { talespire: { levelLayout: "stacked" } } as never,
    });
    render(<BuildToolbar />);
    expect(screen.queryByText(/Copy as/)).toBeNull();
  });

  it("asks before changing the layout when a slab is ticked as pasted", async () => {
    const update = vi.fn(() => Promise.resolve());
    useProject.setState({ snap: { ...twoLevels, builds: [record(1, true)] } as unknown as ProjectSnapshot });
    useSettings.setState({
      settings: { talespire: { levelLayout: "stacked" } } as never,
      update: update,
    });
    useBuild.setState({ run: vi.fn(() => Promise.resolve()) });
    render(<BuildToolbar />);
    await userEvent.click(screen.getByRole("button", { name: /Change/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Side by side" }));
    expect(update).not.toHaveBeenCalled();
    const ask = useApp.getState().confirm;
    expect(ask?.title).toMatch(/Change the layout/);
    await act(async () => {
      ask?.onConfirm();
      await Promise.resolve();
    });
    expect(update).toHaveBeenCalled();
  });

  it("changes the layout at once when nothing is ticked", async () => {
    const update = vi.fn(() => Promise.resolve());
    useProject.setState({ snap: twoLevels });
    useSettings.setState({
      settings: { talespire: { levelLayout: "stacked" } } as never,
      update: update,
    });
    render(<BuildToolbar />);
    await userEvent.click(screen.getByRole("button", { name: /Change/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Side by side" }));
    expect(update).toHaveBeenCalled();
    expect(useApp.getState().confirm).toBeNull();
  });
});

describe("a build in several slabs with problems", () => {
  const withErrors = () => {
    useProject.setState({ snap: snapshot({ builds: [record(2)] }) });
    useBuild.setState({
      bundle: {
        planVersion: 2,
        chunks: [],
        diagnostics: [{ code: "x", stage: "verify", severity: "error", message: "A wall has a gap." }],
      } as never,
    });
  };

  it("lists the problems above the paste guide button, and the button says anyway", () => {
    withErrors();
    render(<BuildView />);
    const problems = screen.getByText(/The build check found 1 problem/);
    const guide = screen.getByRole("button", { name: "Start paste guide anyway" });
    expect(guide).not.toHaveClass("btn--primary");
    expect(problems.compareDocumentPosition(guide) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the plain button when the build is clean", () => {
    useProject.setState({ snap: snapshot({ builds: [record(2)] }) });
    render(<BuildView />);
    expect(screen.getByRole("button", { name: "Start paste guide" })).toHaveClass("btn--primary");
  });
});
