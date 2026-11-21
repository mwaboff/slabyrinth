import { afterEach, describe, expect, it, vi } from "vitest";
import { DeadlineExceeded, withDeadline } from "./deadline";

afterEach(() => {
  vi.useRealTimers();
});

describe("withDeadline", () => {
  it("aborts with DeadlineExceeded after the time, not before", () => {
    vi.useFakeTimers();
    const s = withDeadline(undefined, 1_000);
    vi.advanceTimersByTime(999);
    expect(s.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(s.aborted).toBe(true);
    expect(s.reason).toBeInstanceOf(DeadlineExceeded);
  });

  it("aborts at once with the caller's reason when the caller's signal ends, and then never times out", () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const s = withDeadline(caller.signal, 1_000);
    caller.abort("stop");
    expect(s.aborted).toBe(true);
    expect(s.reason).toBe("stop");
    vi.advanceTimersByTime(5_000);
    expect(s.reason).toBe("stop");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an already ended signal gives an ended one", () => {
    const caller = new AbortController();
    caller.abort("gone");
    expect(withDeadline(caller.signal, 1_000).reason).toBe("gone");
  });
});
