import { describe, expect, it, vi } from "vitest";
import { announceRecovery, recoveredMessage } from "./recovered";

describe("after the window was reloaded because its renderer died", () => {
  it("says why in plain words, and that the work is saved", () => {
    expect(recoveredMessage("?recovered=oom")?.lead).toBe(
      "Slabyrinth ran out of memory showing this map, so it reopened the window.",
    );
    expect(recoveredMessage("?recovered=oom")?.body).toMatch(/Your work is saved\..*Maximum map size/);
    expect(recoveredMessage("?recovered=crash")?.body).toBe("Your work is saved.");
    expect(recoveredMessage("")).toBeNull();
  });

  it("shows it once and takes the flag out of the address", () => {
    window.history.replaceState(null, "", "/index.html?recovered=oom");
    const toast = vi.fn();
    announceRecovery(toast);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: "warn" }));
    expect(window.location.search).toBe("");
    announceRecovery(toast);
    expect(toast).toHaveBeenCalledTimes(1);
  });
});
