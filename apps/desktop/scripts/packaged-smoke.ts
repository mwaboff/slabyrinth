/**
 * Runs the unpacked packaged app (electron-builder --dir output) once with SLABYRINTH_SMOKE=1:
 * hidden window, throwaway userData, inert outside effects. Passes when the app prints SMOKE_OK
 * (renderer ready, real engine and compiler wired, no test-only code in the bundle, compile worker
 * loads from the asar, IPC answers, chat answers no_api_key).
 * Usage: npm run smoke:packaged -w @slabyrinth/desktop   (Linux CI: wrap in xvfb-run -a)
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exe =
  process.platform === "win32"
    ? path.join(root, "release", "win-unpacked", "Slabyrinth.exe")
    : path.join(root, "release", "linux-unpacked", "slabyrinth");

if (!existsSync(exe)) {
  process.stderr.write(`packaged app not found: ${exe} (run: npx electron-builder --dir)\n`);
  process.exit(2);
}

// Licence notices that must travel with every copy (electron-builder.yml extraFiles; Electron's own).
const notices = ["THIRD-PARTY-NOTICES.txt", "LICENSE.electron.txt", "LICENSES.chromium.html"];
const missingNotices = notices.filter((f) => !existsSync(path.join(path.dirname(exe), f)));
if (missingNotices.length > 0) {
  process.stderr.write(`SMOKE_FAIL licence files missing next to the app: ${missingNotices.join(", ")}\n`);
  process.exit(1);
}

const TIMEOUT_MS = 90_000;
const child = spawn(exe, [], {
  env: { ...process.env, SLABYRINTH_SMOKE: "1" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let out = "";
child.stdout.on("data", (d: Buffer) => {
  out += d.toString();
  process.stdout.write(d);
});
child.stderr.on("data", (d: Buffer) => {
  process.stderr.write(d);
});
const timer = setTimeout(() => {
  process.stderr.write("packaged smoke: timeout\n");
  child.kill("SIGKILL");
}, TIMEOUT_MS);
child.on("exit", (code) => {
  clearTimeout(timer);
  const ok =
    code === 0 &&
    out.includes("SMOKE_OK") &&
    out.includes("test-code=absent") &&
    out.includes("engine=real") &&
    out.includes("scene3d=ok");
  process.stdout.write(ok ? "packaged smoke: PASS\n" : `packaged smoke: FAIL (exit ${String(code)})\n`);
  process.exit(ok ? 0 : 1);
});
