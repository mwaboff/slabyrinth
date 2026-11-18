import { app, type BrowserWindow } from "electron";

/**
 * Set SLABYRINTH_SMOKE=1 to boot, wait for the renderer, run the main-process self-checks,
 * print SMOKE_OK and exit 0 (SMOKE_FAIL <reason> and exit 1 otherwise).
 */
export const isSmokeRun = (): boolean => process.env["SLABYRINTH_SMOKE"] === "1";

const READY_PROBE = "document.documentElement.dataset['slabyrinthReady'] === 'true'";
const TIMEOUT_MS = 30_000;
const POLL_MS = 100;

/** A self-check returns an info line, or throws to fail the smoke run. */
export type SmokeCheck = () => Promise<string>;

/**
 * Polls the renderer until it reports ready (the React root sets
 * <html data-slabyrinth-ready="true"> after its first commit), runs the checks, then exits.
 */
export function runSmoke(win: BrowserWindow, checks: SmokeCheck[] = []): void {
  const started = Date.now();
  let finished = false;
  const fail = (reason: string): void => {
    if (finished) return;
    finished = true;
    process.stderr.write(`SMOKE_FAIL ${reason}\n`);
    app.exit(1);
  };

  win.webContents.on("did-fail-load", (_e, code, description) => {
    fail(`did-fail-load ${String(code)} ${description}`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    fail(`render-process-gone ${details.reason}`);
  });

  const runChecks = async (): Promise<void> => {
    for (const check of checks) {
      try {
        process.stdout.write(`SMOKE_INFO ${await check()}\n`);
      } catch (err) {
        fail(`check failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    if (finished) return;
    finished = true;
    process.stdout.write("SMOKE_OK\n");
    app.exit(0);
  };

  const poll = (): void => {
    if (finished) return;
    if (win.isDestroyed()) {
      fail("window destroyed");
      return;
    }
    win.webContents
      .executeJavaScript(READY_PROBE, false)
      .then((ready: unknown) => {
        if (ready === true) void runChecks();
        else if (Date.now() - started > TIMEOUT_MS) fail("timeout waiting for renderer ready");
        else setTimeout(poll, POLL_MS);
      })
      .catch(() => {
        // The page may still be loading; retry until the timeout.
        if (Date.now() - started > TIMEOUT_MS) fail("timeout (probe error)");
        else setTimeout(poll, POLL_MS);
      });
  };
  poll();
}
