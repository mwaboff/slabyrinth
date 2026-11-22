/**
 * The TaleSpire add-on in the real app (test mode): it looks only at the test Symbiotes folder, listens on an
 * ephemeral port (never 48731), registers no real hotkey (a memory registrar), updates an installed older copy at
 * start, installs and uninstalls on request, and pairs with the add-on's own protocol code.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { DEFAULT_LINK_PORT, LINK_CONFIG_FILE } from "../src/main/services/talespire/link/protocol";
import { connectAddon } from "../src/main/services/talespire/link/testing/fakeAddon";
import { cleanRun, invoke, launch, newRun, unwrap } from "./helpers";

const HELPER = fileURLToPath(new URL("../../../symbiotes/slabyrinth-helper/", import.meta.url));

test("updates an older copy at start, pairs, sends nothing without a build, uninstalls", async () => {
  const run = newRun("slab-addon-", []);
  const symbiotes = path.join(run.dir, "Symbiotes");
  const addonDir = path.join(symbiotes, "slabyrinth-helper");
  mkdirSync(symbiotes, { recursive: true });
  // an older copy of ours, as a user would have from an earlier Slabyrinth
  cpSync(HELPER, addonDir, { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(addonDir, "manifest.json"), "utf8")) as {
    version: string;
  };
  const bundled = manifest.version;
  writeFileSync(path.join(addonDir, "manifest.json"), JSON.stringify({ ...manifest, version: "0.0.1" }));
  mkdirSync(path.join(symbiotes, "someone-elses-addon"));
  writeFileSync(path.join(symbiotes, "someone-elses-addon", "manifest.json"), "{}");

  const { app, page } = await launch(run, { SLABYRINTH_TEST_SYMBIOTES_DIR: symbiotes });
  try {
    // automatic update at start: the older copy is now the bundled one, and says so
    await expect
      .poll(async () => unwrap(await invoke(page, "addon:status", undefined)).update.state)
      .toBe("updated");
    const status = unwrap(await invoke(page, "addon:status", undefined));
    expect(status).toMatchObject({
      folder: symbiotes,
      installedVersion: bundled,
      update: { automatic: true, from: "0.0.1", to: bundled },
      prompt: { show: false },
    });

    // the listener: ephemeral, never the real port; nothing connected; no hotkeys held
    const link = unwrap(await invoke(page, "link:status", undefined));
    expect(link.server.state).toBe("listening");
    expect(link.server.port).not.toBe(DEFAULT_LINK_PORT);
    expect(link.hotkeys.state).toBe("off");

    // install by hand writes the pairing file (the automatic update kept the old one, which had none)
    const installed = unwrap(await invoke(page, "addon:install", undefined));
    expect(installed.state).toBe("installed");
    const pairing = JSON.parse(readFileSync(path.join(addonDir, LINK_CONFIG_FILE), "utf8")) as {
      port: number;
      token: string;
    };
    expect(pairing.port).toBe(link.server.port);

    // the add-on's own code pairs with the app
    const addon = await connectAddon(pairing.port, pairing.token, { version: bundled });
    await expect
      .poll(async () => unwrap(await invoke(page, "link:status", undefined)).helper)
      .toEqual({ state: "connected", version: bundled, reason: null });
    const send = await invoke(page, "link:send", { buildId: "nope" });
    expect(send.ok).toBe(false);
    const registered = await app.evaluate(
      () =>
        (globalThis as { __slabyrinthHotkeys?: { registered: Map<string, unknown> } }).__slabyrinthHotkeys
          ?.registered.size,
    );
    expect(registered).toBe(0);

    // uninstall: our folder only; the link drops
    const removed = unwrap(await invoke(page, "addon:uninstall", {}));
    expect(removed.state).toBe("missing");
    expect(existsSync(addonDir)).toBe(false);
    expect(readdirSync(symbiotes)).toEqual(["someone-elses-addon"]);
    expect(await addon.ws.closed()).toBe(1000);
    await expect
      .poll(async () => unwrap(await invoke(page, "link:status", undefined)).helper.state)
      .toBe("none");
  } finally {
    await app.close();
    cleanRun(run);
  }
});
