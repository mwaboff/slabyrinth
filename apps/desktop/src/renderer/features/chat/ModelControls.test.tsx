import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ModelDescriptor } from "../../../main/agent/provider/types";
import { FAKE_MODELS } from "../../bridge/fake/models";
import { EffortControl, ModelList, capsOf, effortLevels, snapEffort } from "./ModelControls";

const opus = FAKE_MODELS.find((m) => m.modelId === "claude-opus-5-5") as ModelDescriptor;
const limited: ModelDescriptor = {
  ...opus,
  modelId: "claude-limited",
  displayName: "Limited 1",
  effort: { supported: true, levels: ["medium", "high"], default: "high" },
};
const noEffort: ModelDescriptor = {
  ...opus,
  modelId: "local-qwen",
  displayName: "qwen2.5-32b",
  effort: { supported: false },
  costTier: undefined,
  speedTier: undefined,
  guidance: undefined,
  pricing: null,
} as unknown as ModelDescriptor;

describe("ModelList", () => {
  it("shows guidance, Recommended, and cost/speed tiers with screen-reader text", () => {
    render(
      <ModelList
        models={FAKE_MODELS}
        value="claude-opus-5-5"
        onPick={() => undefined}
        caps={{ hasCost: true, hasSpeed: true }}
      />,
    );
    const opusRow = screen.getByRole("radio", { name: /Opus/ });
    expect(opusRow).toHaveAttribute("aria-checked", "true");
    expect(within(opusRow).getByText("Recommended")).toBeInTheDocument();
    expect(within(opusRow).getByRole("img", { name: "Cost: high" })).toBeInTheDocument();
    expect(within(opusRow).getByRole("img", { name: "Speed: medium" })).toBeInTheDocument();
  });

  it("hides cost and speed when the provider has none (not applicable, never disabled)", () => {
    render(
      <ModelList
        models={FAKE_MODELS}
        value="claude-opus-5-5"
        onPick={() => undefined}
        caps={capsOf({ hasCost: false, hasSpeedGuidance: false })}
      />,
    );
    expect(screen.queryByRole("img", { name: /Cost/ })).toBeNull();
    expect(screen.queryByRole("img", { name: /Speed/ })).toBeNull();
  });

  it("lists models without guidance under Other models with 'No guidance yet'", () => {
    render(
      <ModelList
        models={[opus, noEffort]}
        value="claude-opus-5-5"
        onPick={() => undefined}
        caps={{ hasCost: true, hasSpeed: true }}
      />,
    );
    expect(screen.getByText("Other models")).toBeInTheDocument();
    expect(screen.getByText("No guidance yet")).toBeInTheDocument();
  });

  it("picks with the mouse and with arrow keys", async () => {
    const onPick = vi.fn();
    render(
      <ModelList
        models={FAKE_MODELS}
        value="claude-opus-5-5"
        onPick={onPick}
        caps={{ hasCost: true, hasSpeed: true }}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: /Haiku/ }));
    expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({ modelId: "claude-haiku-5-5" }));
    screen.getByRole("radio", { name: /Opus/ }).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(onPick).toHaveBeenLastCalledWith(expect.objectContaining({ modelId: "claude-fable-5-2" }));
  });
});

describe("EffortControl", () => {
  it("offers plain names for every supported level with the API value in the tooltip", () => {
    render(<EffortControl model={opus} value="high" onChange={() => undefined} />);
    const group = screen.getByRole("radiogroup", { name: "Effort" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((b) => b.textContent),
    ).toEqual(["Quick", "Balanced", "Thorough", "Extra", "Max"]);
    expect(within(group).getByRole("radio", { name: "Thorough" })).toHaveAttribute("title", "API: high");
    expect(within(group).getByRole("radio", { name: "Thorough" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/Worth it for a first plan/)).toBeInTheDocument();
  });

  it("hides levels the model does not offer", () => {
    render(<EffortControl model={limited} value="medium" onChange={() => undefined} />);
    expect(screen.getAllByRole("radio").map((b) => b.textContent)).toEqual(["Balanced", "Thorough"]);
  });

  it("renders nothing when the model has no effort control", () => {
    const { container } = render(<EffortControl model={noEffort} value={null} onChange={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says when an effort snapped to the model's default", () => {
    render(<EffortControl model={limited} value="high" snappedFrom="low" onChange={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent("Limited doesn't offer Quick — using Thorough.");
  });

  it("moves with arrow keys", async () => {
    const onChange = vi.fn();
    render(<EffortControl model={opus} value="medium" onChange={onChange} />);
    screen.getByRole("radio", { name: "Balanced" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith("high");
  });
});

describe("capability helpers", () => {
  it("snaps an unsupported effort to the model default and keeps a supported one", () => {
    expect(snapEffort(limited, "low")).toEqual({ effort: "high", snapped: true });
    expect(snapEffort(limited, "medium")).toEqual({ effort: "medium", snapped: false });
    expect(snapEffort(noEffort, "high")).toEqual({ effort: null, snapped: false });
    expect(effortLevels(noEffort)).toEqual([]);
  });
});
