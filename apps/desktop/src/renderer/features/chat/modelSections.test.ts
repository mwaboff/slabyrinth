import { describe, expect, it } from "vitest";
import type { ModelDescriptor } from "../../../main/agent/provider/types";
import { FAKE_MODELS } from "../../bridge/fake/models";
import { buildModelSections, modelBaseId, otherModelLabel } from "./modelSections";

const base: ModelDescriptor = { ...(FAKE_MODELS[0] as ModelDescriptor) };
delete base.guidance;
delete base.costTier;
delete base.speedTier;

function api(modelId: string, displayName: string, createdAt: string): ModelDescriptor {
  return {
    ...base,
    modelId,
    displayName,
    createdAt,
    status: "available",
    source: "api",
  };
}
function curated(modelId: string, displayName: string): ModelDescriptor {
  return { ...base, modelId, displayName, guidance: "Curated.", costTier: 2, speedTier: 2, status: "available" };
}

// Realistic Models API shape: dated snapshot ids, several versions per family, an alias/dated pair.
const FIXTURE: ModelDescriptor[] = [
  curated("claude-opus-9-1", "Claude Opus 9.1"),
  curated("claude-sonnet-9-1", "Claude Sonnet 9.1"),
  { ...curated("claude-haiku-9-1", "Claude Haiku 9.1"), status: "unavailable" },
  api("claude-opus-9-1-20260301", "Claude Opus 9.1", "2026-03-01T00:00:00Z"), // dated snapshot of curated
  api("claude-sonnet-9-1-20260301", "Claude Sonnet 9.1", "2026-03-01T00:00:00Z"), // dated snapshot of curated
  api("claude-opus-9-20251001", "Claude Opus 9", "2025-10-01T00:00:00Z"),
  api("claude-opus-8-1-20250805", "Claude Opus 8.1", "2025-08-05T00:00:00Z"),
  api("claude-opus-8-1", "Claude Opus 8.1", "2025-08-05T00:00:00Z"), // alias of the line above
  api("claude-opus-8-20250522", "Claude Opus 8", "2025-05-22T00:00:00Z"),
  api("claude-sonnet-8-20250522", "Claude Sonnet 8", "2025-05-22T00:00:00Z"),
  api("claude-haiku-8-20250301", "Claude Haiku 8", "2025-03-01T00:00:00Z"),
  api("claude-haiku-9-1-20260301", "Claude Haiku 9.1", "2026-03-01T00:00:00Z"), // curated one is unavailable
];

describe("modelBaseId", () => {
  it("treats alias, dated and latest ids of one model as the same", () => {
    expect(modelBaseId("claude-opus-8-1-20250805")).toBe("claude-opus-8-1");
    expect(modelBaseId("claude-opus-8-1")).toBe("claude-opus-8-1");
    expect(modelBaseId("claude-opus-8-1-latest")).toBe("claude-opus-8-1");
    expect(modelBaseId("claude-opus-8")).toBe("claude-opus-8");
  });
});

describe("buildModelSections", () => {
  const { curated: cur, other } = buildModelSections(FIXTURE);

  it("keeps curated models in the curated section and hides unavailable ones", () => {
    expect(cur.map((m) => m.modelId)).toEqual(["claude-opus-9-1", "claude-sonnet-9-1"]);
  });

  it("does not repeat a curated model as a dated snapshot", () => {
    expect(other.map((m) => m.modelId)).not.toContain("claude-opus-9-1-20260301");
    expect(other.map((m) => m.modelId)).not.toContain("claude-sonnet-9-1-20260301");
  });

  it("lists an alias/dated pair once", () => {
    expect(other.filter((m) => modelBaseId(m.modelId) === "claude-opus-8-1")).toHaveLength(1);
  });

  it("orders newest first", () => {
    expect(other.map((m) => m.modelId)).toEqual([
      "claude-haiku-9-1-20260301",
      "claude-opus-9-20251001",
      "claude-opus-8-1",
      "claude-opus-8-20250522",
      "claude-sonnet-8-20250522",
      "claude-haiku-8-20250301",
    ]);
  });

  it("gives every other row a unique, version-bearing label (never the bare family)", () => {
    const labels = other.map(otherModelLabel);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((l) => /\d/.test(l))).toBe(true);
  });

  it("works for model ids it has never seen", () => {
    const r = buildModelSections([curated("x-1", "X 1"), api("x-1-20300101", "X 1", "2030-01-01T00:00:00Z"), api("y-2", "Y 2", "2030-02-01T00:00:00Z")]);
    expect(r.other.map((m) => m.modelId)).toEqual(["y-2"]);
  });
});
