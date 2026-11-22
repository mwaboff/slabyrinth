/** Settings > Experimental > Maximum map size, and the fake main holding plans to it. */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { validatePlan, type MapPlan } from "@slabyrinth/core";
import { setBridge } from "../../bridge/client";
import { createFakeBridge } from "../../bridge/fake/fakeBridge";
import { fakeRules } from "../../bridge/fake/rules";
import { Banners } from "../../app/Banners";
import { useApp } from "../../stores/app";
import { useProject } from "../../stores/project";
import { useSettings } from "../../stores/settings";
import type { ProjectSnapshot } from "../../../shared/ipc";
import type { AppSettings } from "../../../shared/project";
import { MapSizeSetting } from "./MapSizeSetting";

const wide = (w: number): MapPlan =>
  ({
    schema: "slabyrinth/plan@1",
    generator: 4,
    id: "p1",
    seed: 1,
    title: "Long Road",
    kind: "dungeon",
    theme: "stone_dungeon",
    levels: [
      {
        id: "l1",
        name: "Road",
        elevation: 0,
        bounds: { x: 0, y: 0, w, h: 10 },
        base: { type: "solid" },
        areas: [{ id: "a", kind: "room", name: "Hall", shape: { type: "rect", x: 1, y: 1, w: 6, h: 5 } }],
        openings: [],
        features: [],
        walls: [],
        terrain: [],
        labels: [],
      },
    ],
    links: [],
  }) as unknown as MapPlan;

function current(): AppSettings {
  const s = useSettings.getState().settings;
  if (!s) throw new Error("settings not loaded");
  return s;
}

afterEach(() => {
  useProject.setState({ snap: null });
  useApp.setState({ route: "boot" });
});

describe("Maximum map size", () => {
  it("saves the choice, says what a larger size costs, and the fake main validates at it", async () => {
    setBridge(createFakeBridge({ speed: 0 }));
    await useSettings.getState().load();
    const { rerender } = render(<MapSizeSetting s={current()} />);
    expect(screen.getByRole("radio", { name: "Standard (320 × 320)" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userEvent.click(screen.getByRole("radio", { name: "1024 × 1024" }));
    expect(useSettings.getState().settings?.mapSize).toBe("large-1024");
    rerender(<MapSizeSetting s={current()} />);
    expect(screen.getByRole("note")).toHaveTextContent(/2\.6 GB of memory, and more slabs to paste/);
    // the fake main's rules follow its settings
    const sizeIssue = (p: MapPlan) =>
      validatePlan(p, fakeRules()).issues.some((i) => i.code === "bounds_exceeded");
    expect(sizeIssue(wide(1000))).toBe(false);
    await useSettings.getState().update({ mapSize: "standard" });
    expect(sizeIssue(wide(1000))).toBe(true);
  });

  it("a map larger than the setting opens, with one line saying so", () => {
    useSettings.setState({ settings: { ...current(), mapSize: "standard" } });
    useApp.setState({ route: "workspace" });
    render(<Banners />);
    expect(screen.queryByText(/experimental/)).toBeNull();
    act(() => {
      useProject.setState({ snap: { plan: wide(600) } as unknown as ProjectSnapshot });
    });
    expect(screen.getByText("This map uses the experimental 768 × 768 size.")).toBeInTheDocument();
  });
});
