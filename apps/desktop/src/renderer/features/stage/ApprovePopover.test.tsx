import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import type { MapPlan } from "@slabyrinth/core";
import type { ProjectSnapshot, Result, SlabyrinthApi } from "../../../shared/ipc";
import type { UiIssue } from "../../../shared/resolveCore";
import { setBridge } from "../../bridge/client";
import { useMap } from "../../stores/map";
import { useProject } from "../../stores/project";
import { ApprovePopover } from "./ApprovePopover";

const plan = {
  levels: [{ id: "l1", name: "Crypt", areas: [{ id: "vault", kind: "room", name: "Vault" }] }],
} as unknown as MapPlan;

function show(issues: UiIssue[]): void {
  useMap.setState({ issues });
  render(<ApprovePopover version={1} anchor={createRef<HTMLButtonElement>()} />);
}

beforeEach(() => {
  const invoke = vi.fn((): Promise<Result<unknown>> =>
    Promise.resolve({ ok: true, value: { estimatedChunks: 1 } }),
  );
  setBridge({ invoke, on: () => () => undefined, send: () => undefined } as unknown as SlabyrinthApi);
  useProject.setState({ snap: { plan } as unknown as ProjectSnapshot });
});

afterEach(() => {
  useProject.setState({ snap: null });
  useMap.setState({ issues: [] });
});

describe("ApprovePopover asks core's approve gate", () => {
  it("an unreachable warning blocks approval, as main's plan:approve does", () => {
    show([
      { severity: "warning", code: "unreachable", message: "Vault can't be reached from the entrance." },
    ]);
    expect(screen.getByText(/Fix the problems below/)).toBeTruthy();
    expect(screen.queryByText(/can be approved anyway/)).toBeNull();
    expect(screen.getByRole("button", { name: "Approve & build" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Approve only" })).toBeDisabled();
  });

  it("a warning the gate lets through can be approved anyway", () => {
    show([{ severity: "warning", code: "area_sealed", message: "Vault is walled in." }]);
    expect(screen.getByText(/can be approved anyway/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve & build" })).toBeEnabled();
  });

  it("an error blocks approval", () => {
    show([{ severity: "error", code: "opening_blocked", message: "The only door is blocked." }]);
    expect(screen.getByRole("button", { name: "Approve only" })).toBeDisabled();
  });
});
