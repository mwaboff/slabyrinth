import { describe, expect, it } from "vitest";
import { HotkeyManager } from "./hotkeys";

function setup(taken: string[] = []) {
  const registered = new Map<string, () => void>();
  const pressed: string[] = [];
  const m = new HotkeyManager(
    {
      register: (acc, cb) => {
        if (taken.includes(acc) || registered.has(acc)) return false;
        registered.set(acc, cb);
        return true;
      },
      unregister: (acc) => {
        registered.delete(acc);
      },
    },
    (a) => pressed.push(a),
  );
  return { m, registered, pressed };
}

describe("hotkeys held only while a map is being placed", () => {
  it("registers nothing until armed, reports the chosen keys on standby, and releases them on disarm", () => {
    const { m, registered, pressed } = setup();
    expect(m.state().next).toEqual({ status: "standby", combo: "Ctrl+Alt+D" });
    expect(m.summary()).toBe("off");
    expect(registered.size).toBe(0);
    expect(m.arm().next).toEqual({ status: "active", combo: "Ctrl+Alt+D" });
    expect(m.summary()).toBe("active");
    expect([...registered.keys()].sort()).toEqual(["Control+Alt+A", "Control+Alt+D", "Control+Alt+S"]);
    registered.get("Control+Alt+A")?.();
    expect(pressed).toEqual(["back"]);
    m.disarm();
    expect(registered.size).toBe(0);
    expect(m.summary()).toBe("off");
  });

  it("reports a key another program holds when arming (partial), and none at all (failed)", () => {
    const one = setup(["Control+Alt+D"]);
    expect(one.m.arm().next).toEqual({
      status: "refused",
      combo: null,
      wanted: "Ctrl+Alt+D",
      reason: "taken by another program",
    });
    expect(one.m.summary()).toBe("partial");
    const all = setup(["Control+Alt+D", "Control+Alt+A", "Control+Alt+S"]);
    all.m.arm();
    expect(all.m.summary()).toBe("failed");
  });

  it("takes the GM's choice on standby, refusing invalid keys and duplicates", () => {
    const { m, registered } = setup();
    const r = m.request({ next: "Alt+Ctrl+F", back: "Shift+D" });
    expect(r.next).toEqual({ status: "standby", combo: "Ctrl+Alt+F" });
    expect(r.back).toMatchObject({ status: "refused", combo: "Ctrl+Alt+A", wanted: "Shift+D" });
    expect(m.request({ again: "Ctrl+Alt+F" }).again).toMatchObject({
      status: "refused",
      combo: "Ctrl+Alt+S",
      reason: "the same key as next",
    });
    expect(registered.size).toBe(0);
    m.arm();
    expect(registered.has("Control+Alt+F")).toBe(true);
  });

  it("while armed: swaps two keys, and keeps the old key when the new one is taken", () => {
    const { m, registered } = setup(["Control+Alt+J"]);
    m.arm();
    const s = m.request({ next: "Ctrl+Alt+A", back: "Ctrl+Alt+D" });
    expect(s.next).toEqual({ status: "active", combo: "Ctrl+Alt+A" });
    expect(s.back).toEqual({ status: "active", combo: "Ctrl+Alt+D" });
    expect(registered.size).toBe(3);
    const t = m.request({ next: "Ctrl+Alt+J" });
    expect(t.next).toEqual({
      status: "refused",
      combo: "Ctrl+Alt+A",
      wanted: "Ctrl+Alt+J",
      reason: "taken by another program",
    });
    expect(registered.has("Control+Alt+A")).toBe(true);
    // the refusal is said once; afterwards the key reads active again
    expect(m.state().next).toEqual({ status: "active", combo: "Ctrl+Alt+A" });
  });

  it("never turns a socket string into an accelerator outside the allow-list", () => {
    const { m, registered } = setup();
    m.arm();
    for (const bad of ["CommandOrControl+Q", "Ctrl+Alt+d", "Super+D", "Ctrl+Alt+D\nX", "Ctrl+Alt+Plus"])
      expect(m.request({ next: bad }).next.status).toBe("refused");
    expect([...registered.keys()].sort()).toEqual(["Control+Alt+A", "Control+Alt+D", "Control+Alt+S"]);
  });
});
