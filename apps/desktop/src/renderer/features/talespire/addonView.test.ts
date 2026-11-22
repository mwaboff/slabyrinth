/**
 * Every state of the add-on and its link, in words: one table over what the store can hold, so no state falls through
 * to a blank or a raw error.
 */
import { describe, expect, it } from "vitest";
import type { AddonStatus, LinkStatus } from "../../../shared/ipc";
import { fakeAddonStatus, fakeLinkStatus } from "../../bridge/fake/talespireLink";
import {
  addonSummary,
  hotkeyRows,
  primaryAction,
  sendView,
  setupSteps,
  type Light,
  type SummaryKey,
} from "./addonView";
import { pasteSteps } from "./pasteSteps";

const A = fakeAddonStatus;
const L = fakeLinkStatus;
const none = L({ helper: "none" });
const connected = L({ helper: "connected" });
const server = (state: LinkStatus["server"]["state"]): LinkStatus => ({
  ...none,
  server: { state, port: 48731 },
});
const refused = (reason: NonNullable<LinkStatus["helper"]["reason"]>): LinkStatus => ({
  ...none,
  helper: { state: "refused", version: null, reason },
});
const placing = (phase: NonNullable<LinkStatus["set"]>["phase"]): LinkStatus =>
  L({ helper: "connected", placing: { name: "Keep", chunk: 3, total: 5, phase } });

const CASES: Array<[string, AddonStatus | null, LinkStatus | null, SummaryKey, Light, string, RegExp]> = [
  ["nothing loaded yet", null, null, "checking", "idle", "Checking add-on…", /Looking for/],
  [
    "port in use",
    A("installed"),
    server("port_in_use"),
    "port_in_use",
    "error",
    "Add-on link blocked",
    /port 48731/,
  ],
  ["listener failed", A("installed"), server("failed"), "link_failed", "error", "Add-on link off", /Restart/],
  ["no Symbiotes folder", A("not_found"), none, "not_found", "warn", "Add-on folder not found", /Choose it/],
  ["foreign folder", A("foreign"), none, "foreign", "warn", "Add-on folder taken", /Rename or remove/],
  [
    "refused: token",
    A("installed"),
    refused("token"),
    "refused",
    "warn",
    "Reinstall the add-on",
    /isn't paired/,
  ],
  [
    "refused: protocol",
    A("installed"),
    refused("protocol"),
    "refused",
    "warn",
    "Reinstall the add-on",
    /too old/,
  ],
  [
    "refused: origin",
    A("installed"),
    refused("origin"),
    "refused",
    "warn",
    "Connection refused",
    /Something other/,
  ],
  ["pairing mismatch", A("mismatch"), none, "mismatch", "warn", "Reinstall the add-on", /another copy/],
  [
    "placing",
    A("installed"),
    placing("inHand"),
    "placing",
    "busy",
    "Placing map · 3 of 5",
    /Keep: slab 3 of 5/,
  ],
  ["placing, loaded", A("installed"), placing("ready"), "placing", "busy", "Placing map · 3 of 5", /slab 3/],
  [
    "placing, failed",
    A("installed"),
    placing("failed"),
    "place_failed",
    "warn",
    "Slab 3 didn't place",
    /says why/,
  ],
  ["placed", A("installed"), placing("done"), "placed", "ok", "Map placed", /All 5 slabs of Keep/],
  ["out of date", A("outdated"), none, "outdated", "warn", "Update TaleSpire add-on", /0\.1\.0 is installed/],
  [
    "out of date, connected",
    A("outdated"),
    connected,
    "outdated",
    "warn",
    "Update TaleSpire add-on",
    /comes with/,
  ],
  ["not installed", A("missing"), none, "missing", "action", "Install TaleSpire add-on", /in your hand/],
  ["connected", A("installed"), connected, "connected", "ok", "Add-on connected", /open in TaleSpire/],
  [
    "installed, not connected",
    A("installed"),
    none,
    "waiting",
    "idle",
    "Add-on not connected",
    /Symbiotes panel/,
  ],
  [
    "listener starting",
    A("installed"),
    server("starting"),
    "waiting",
    "idle",
    "Add-on not connected",
    /panel/,
  ],
];

describe("the status light covers every state in words", () => {
  it.each(CASES)("%s", (_name, addon, link, key, light, label, detail) => {
    const s = addonSummary(addon, link);
    expect(s).toMatchObject({ key, light, label });
    expect(s.detail).toMatch(detail);
    expect(s.label.length).toBeLessThanOrEqual(26);
    expect(s.detail).toMatch(/\.$/);
  });

  it("each key the summary can give is in the table", () => {
    const keys = new Set(CASES.map((c) => c[3]));
    expect(keys.size).toBe(14);
  });
});

describe("the main button", () => {
  it.each([
    ["missing", "Install"],
    ["outdated", "Update now"],
    ["mismatch", "Reinstall"],
    ["not_found", "Choose folder…"],
    ["foreign", "Open folder"],
  ] as const)("%s: %s", (state, label) => {
    expect(primaryAction(A(state), none)?.label).toBe(label);
  });

  it("installed: nothing to press; a refused connection offers Reinstall", () => {
    expect(primaryAction(A("installed"), connected)).toBeNull();
    expect(primaryAction(A("installed"), refused("token"))?.label).toBe("Reinstall");
  });
});

describe("the setup steps turn to done by themselves", () => {
  it("not installed → installed → connected", () => {
    expect(setupSteps(A("missing"), none)).toEqual({ enable: "first", install: "current", open: "todo" });
    expect(setupSteps(A("installed"), none)).toEqual({ enable: "current", install: "done", open: "current" });
    expect(setupSteps(A("installed"), connected)).toEqual({ enable: "done", install: "done", open: "done" });
    expect(setupSteps(A("installed"), refused("token")).install).toBe("current");
  });
});

describe("hotkeys", () => {
  it("names each key and its state", () => {
    expect(hotkeyRows(none).map((r) => [r.name, r.combo, r.state])).toEqual([
      ["Next", "Ctrl+Alt+D", "Turns on while a map is placed"],
      ["Back", "Ctrl+Alt+A", "Turns on while a map is placed"],
      ["Again", "Ctrl+Alt+S", "Turns on while a map is placed"],
    ]);
    const link = placing("inHand");
    link.hotkeys.actions.back = {
      status: "refused",
      combo: null,
      wanted: "Ctrl+Alt+A",
      reason: "taken by another program",
    };
    expect(hotkeyRows(link)[0]?.state).toBe("On");
    expect(hotkeyRows(link)[1]).toMatchObject({
      combo: "Ctrl+Alt+A",
      ok: false,
      state: "Not available: taken by another program",
    });
  });
});

describe("Send to TaleSpire", () => {
  const view = (
    addon: AddonStatus | null,
    link: LinkStatus | null,
    empty = false,
    busy: "send" | null = null,
  ) => sendView(addon, link, busy, "fake-build", empty).kind;

  it("follows the add-on from not installed to placed", () => {
    expect(view(A("missing"), none)).toBe("setup");
    expect(view(A("not_found"), none)).toBe("setup");
    expect(view(A("foreign"), none)).toBe("setup");
    expect(view(A("outdated"), none)).toBe("fix");
    expect(view(A("mismatch"), none)).toBe("fix");
    expect(view(A("installed"), refused("token"))).toBe("fix");
    expect(view(A("installed"), server("port_in_use"))).toBe("blocked");
    expect(view(null, null)).toBe("blocked");
    expect(view(A("installed"), none)).toBe("waiting");
    expect(view(A("installed"), connected)).toBe("ready");
    expect(view(A("outdated"), connected)).toBe("ready");
    expect(view(A("installed"), connected, false, "send")).toBe("sending");
    expect(view(A("installed"), placing("inHand"))).toBe("placing");
    expect(view(A("installed"), placing("done"))).toBe("finished");
  });

  it("refuses a build with an empty slab, and offers to replace another map", () => {
    expect(view(A("installed"), connected, true)).toBe("empty_chunk");
    const other = { ...placing("inHand"), send: { ...placing("inHand").send, buildId: "another" } };
    expect(sendView(A("installed"), other, null, "fake-build", false)).toEqual({
      kind: "ready",
      other: "Keep",
    });
  });

  it("placing: progress from the add-on's state", () => {
    expect(sendView(A("installed"), placing("inHand"), null, "fake-build", false)).toMatchObject({
      kind: "placing",
      chunk: 3,
      total: 5,
      placed: 2,
      phase: "inHand",
    });
  });
});

describe("paste steps", () => {
  it("say where the cursor goes and where the pillars are, from the anchor", () => {
    const s = pasteSteps({ side: "south", clearanceCells: 4, farMarkerCells: 31 });
    expect(s.plane).toMatch(/press G/);
    expect(s.spot).toBe(
      "Put the cursor just outside the middle of where the map's south edge will be: the map lands north of it, about 5 cells away. Click that same spot for every slab.",
    );
    expect(s.pillars).toBe(
      "When every slab is placed, delete the two alignment pillars: one just past the map's north-east corner, and one about 31 cells south of the map.",
    );
    expect(pasteSteps(null).spot).toMatch(/same spot/);
  });
});
