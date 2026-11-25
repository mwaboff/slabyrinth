/**
 * Rewrites the generator-5 golden on purpose: `npm run test:golden:gen5:update` (from the repo root or packages/core).
 * Rebuilds every run, prints what changed per plan (hash fields `field: was -> now`, then the detail lines that went
 * `-` and came `+`, quality meter lines marked so), and writes __golden__/generator5.txt, generator5.detail.txt and
 * generator5.quality.txt (the quality meter's baseline of the generator-5 runs). Commit them together with the
 * change that moved them, and give one line of reason per changed plan in the commit message.
 *
 * It refuses (and writes nothing) when a run at a released generator changes its build (resolved hash, slab, asset
 * count or diagnostic counts): that output is frozen, and the change belongs behind a switch of the open generator.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { detailDiff, goldenRecord, lineDiff } from "../goldenRecord";
import {
  changesReleasedOutput,
  DETAIL_FILE,
  GOLDEN_FILE,
  goldenRuns,
  metered,
  QUALITY_FILE,
  readDetail,
  readGolden,
  readQuality,
} from "./runs";

const before = readGolden();
const beforeDetail = readDetail();
const beforeQuality = readQuality();
const runs = goldenRuns();
const records = runs.map((r) => ({ name: r.name, ...goldenRecord(r, { quality: metered(r) }) }));
const after = new Map(records.map((r) => [r.name, r]));

let changed = 0;
const frozen: string[] = [];
for (const name of new Set([...before.keys(), ...after.keys()])) {
  const was = before.get(name);
  const now = after.get(name);
  const moved = [
    ...detailDiff(beforeDetail.get(name), now?.detail),
    ...detailDiff(beforeQuality.get(name), now?.quality).map((d) => `${d} (quality)`),
  ];
  if (was === now?.line && moved.length === 0) continue;
  changed++;
  if (was === undefined) console.log(`ADDED   ${now?.line ?? ""}`);
  else if (now === undefined) console.log(`REMOVED ${was}`);
  else {
    console.log(`CHANGED ${name}`);
    for (const d of lineDiff(was, now.line)) console.log(`    ${d}`);
    if (changesReleasedOutput(was, now.line)) frozen.push(name);
  }
  for (const d of moved) console.log(`      ${d}`);
}

if (frozen.length) {
  console.error(
    `\nRefusing to write: ${String(frozen.length)} run(s) at a released generator changed their build ` +
      `(${frozen.join(", ")}). Released output is frozen; put the change behind a switch of the open generator ` +
      `(src/plan/generator.ts).`,
  );
  process.exitCode = 1;
} else if (changed === 0) {
  console.log(`generator-5 golden unchanged (${String(records.length)} runs)`);
} else {
  mkdirSync(new URL(".", GOLDEN_FILE), { recursive: true });
  writeFileSync(GOLDEN_FILE, records.map((r) => r.line).join("\n") + "\n");
  writeFileSync(DETAIL_FILE, records.flatMap((r) => r.detail).join("\n") + "\n");
  writeFileSync(QUALITY_FILE, records.flatMap((r) => r.quality ?? []).join("\n") + "\n");
  console.log(
    `\n${String(changed)} of ${String(records.length)} runs changed; wrote ${fileURLToPath(GOLDEN_FILE)}, ` +
      `${fileURLToPath(DETAIL_FILE)} and ${fileURLToPath(QUALITY_FILE)}. Review the diff above and commit them with ` +
      `the change that caused it.`,
  );
}
