/**
 * The update notice: GitHub latest release (main only). The e2e TEST BUILD may inject a canned response file
 * (SLABYRINTH_E2E_UPDATE_RESPONSE, safe mode only); production bundles drop that branch at build time.
 */
import * as fsp from "node:fs/promises";
import type { Logger } from "../logger";
import type { EmitEvent } from "../services/events";
import type { SettingsStore } from "../services/settingsStore";
import { UpdateService, type FetchLike } from "../services/updateService";

export interface StartedUpdates {
  updates: UpdateService;
  /** Starts the background update check when it may run (packaged, not safe mode, daily, autoCheck on). */
  startUpdateCheck: (packaged: boolean) => void;
}

export function startUpdates(d: {
  appVersion: string;
  safeMode: boolean;
  settings: SettingsStore;
  logger: Logger;
  emit: EmitEvent;
}): StartedUpdates {
  let updateFetch: FetchLike | undefined;
  let forceUpdateCheck = false;
  if (__SLABYRINTH_TEST_BUILD__ && d.safeMode) {
    const canned = process.env["SLABYRINTH_E2E_UPDATE_RESPONSE"] ?? "";
    if (canned !== "") {
      updateFetch = async () =>
        new Response(await fsp.readFile(canned, "utf8"), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      forceUpdateCheck = true;
    }
  }
  const updates = new UpdateService({
    currentVersion: d.appVersion,
    settings: d.settings,
    logger: d.logger.child("updates"),
    ...(updateFetch ? { fetch: updateFetch } : {}),
    onAvailable: (status) => {
      d.emit("updates:available", status);
    },
  });
  return {
    updates,
    startUpdateCheck: (packaged) => {
      void updates
        .startupCheck({ packaged, safeMode: d.safeMode, force: forceUpdateCheck })
        .catch((err: unknown) => {
          d.logger.warn("update check failed", { error: err });
        });
    },
  };
}
