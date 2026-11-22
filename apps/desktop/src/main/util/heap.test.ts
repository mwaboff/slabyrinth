import { describe, expect, it } from "vitest";
import { memoryLogger } from "../logger";
import { heapWarning, logMainHeap } from "./heap";

describe("main's heap against the map size setting", () => {
  it("warns only when an experimental size meets a heap under 4 GB", () => {
    expect(heapWarning(2048, "standard")).toBeNull();
    expect(heapWarning(4080, "large-1024")).toBeNull();
    expect(heapWarning(2048, "large-512")).toMatch(
      /2048 MB is below the 4096 MB the large-512 map size needs/,
    );
  });

  it("logs the limit, as a warning when it is too small", () => {
    const log = memoryLogger();
    logMainHeap(log, "large-768", 2048);
    logMainHeap(log, "standard", 2048);
    expect(log.records.map((e) => e.level)).toEqual(["warn", "info"]);
  });
});
