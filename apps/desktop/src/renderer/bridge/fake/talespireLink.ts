/**
 * Example values of the TaleSpire add-on's install status and its link, as main sends them: the fake bridge starts
 * from these, and renderer tests use them to show each state (docs/internal/handoff-talespire-link.md).
 */
import type { AddonStatus, LinkStatus } from "../../../shared/ipc";

export const FAKE_BUNDLED_VERSION = "0.2.0";
export const FAKE_SYMBIOTES =
  "C:\\Users\\gm\\AppData\\LocalLow\\BouncyRock Entertainment\\TaleSpire\\Symbiotes";

export function fakeAddonStatus(
  state: AddonStatus["state"],
  opts: { autoUpdateFailed?: boolean; dismissed?: boolean } = {},
): AddonStatus {
  const found = state !== "not_found";
  const installedVersion =
    state === "outdated"
      ? "0.1.0"
      : state === "installed" || state === "mismatch"
        ? FAKE_BUNDLED_VERSION
        : null;
  const failed = state === "outdated" && opts.autoUpdateFailed === true;
  return {
    state,
    folder: found ? FAKE_SYMBIOTES : null,
    folderSource: found ? "default" : null,
    tried: [FAKE_SYMBIOTES],
    folderWarning: null,
    elsewhere: null,
    addonPath:
      installedVersion !== null || state === "foreign" ? `${FAKE_SYMBIOTES}\\slabyrinth-helper` : null,
    bundledVersion: FAKE_BUNDLED_VERSION,
    installedVersion,
    mismatch: state === "mismatch" ? ["token"] : [],
    update: failed
      ? {
          state: "failed",
          automatic: true,
          from: "0.1.0",
          to: FAKE_BUNDLED_VERSION,
          at: "2026-11-22T09:00:00.000Z",
          error: "A file of the add-on is in use. Close TaleSpire and try again.",
        }
      : { state: "none", automatic: false, from: null, to: null, at: null, error: null },
    prompt:
      state === "outdated" && opts.dismissed !== true
        ? {
            show: true,
            reason: failed
              ? "Updating it by itself failed: A file of the add-on is in use. Close TaleSpire and try again."
              : "An older copy was put in the Symbiotes folder after Slabyrinth started.",
          }
        : { show: false, reason: null },
    checkedAt: "2026-11-22T09:00:00.000Z",
  };
}

export function fakeLinkStatus(opts: {
  helper: LinkStatus["helper"]["state"];
  wayland?: boolean;
  placing?: { name: string; chunk: number; total: number; phase?: NonNullable<LinkStatus["set"]>["phase"] };
}): LinkStatus {
  const p = opts.placing;
  const phase = p?.phase ?? "inHand";
  const armed = p !== undefined && phase !== "done";
  const key = (combo: string): LinkStatus["hotkeys"]["actions"]["next"] => ({
    status: armed ? "active" : "standby",
    combo,
  });
  return {
    server: { state: "listening", port: 48731 },
    helper: {
      state: opts.helper,
      version: opts.helper === "connected" ? FAKE_BUNDLED_VERSION : null,
      reason: opts.helper === "refused" ? "token" : null,
    },
    set: p
      ? {
          name: p.name,
          chunk: p.chunk,
          total: p.total,
          phase,
          finished: phase === "done",
          status: `Chunk ${String(p.chunk)} of ${String(p.total)} is in your hand.`,
          cause: null,
        }
      : null,
    send: p
      ? { state: "loaded", buildId: "fake-build", chunks: p.total, error: null }
      : { state: "idle", buildId: null, chunks: 0, error: null },
    hotkeys: {
      state: armed ? "active" : "off",
      wayland: opts.wayland === true,
      actions: { next: key("Ctrl+Alt+D"), back: key("Ctrl+Alt+A"), again: key("Ctrl+Alt+S") },
    },
  };
}
