/**
 * `--check`: the scene checks over a render (scene3d checks/), their findings for index.json, one marked picture per
 * cluster of findings, and the plain tables the command prints: per render (code, count, faults, worst example) and
 * for a batch (findings per input per code).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CHECK_CODES,
  clusterFindings,
  clusterShot,
  encodePng,
  markedPicture,
  planFacts,
  runChecks,
  type CheckCode,
  type Finding,
  type ObjectPlan,
  type Scene,
} from "@slabyrinth/scene3d";
import { maxOf, type ResolvedPlan } from "@slabyrinth/core";

/** Findings as index.json keeps them (pieces by name and element, not by scene index). */
export interface FindingRecord {
  code: CheckCode;
  severity: Finding["severity"];
  level: string;
  box: { min: [number, number, number]; max: [number, number, number] };
  cells: Array<readonly [number, number]>;
  element: string | null;
  pieces: Array<{ name: string; uuid: string; element: string | null }>;
  measure: Record<string, number>;
  message: string;
  /** The marked picture that shows it (relative to the run folder), when one was drawn. */
  picture?: string;
}

export interface ChecksRecord {
  counts: Partial<Record<CheckCode, number>>;
  faults: number;
  ms: Record<string, number>;
  skipped: CheckCode[];
  findings: FindingRecord[];
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

export function findingRecord(f: Finding): FindingRecord {
  const b = f.where.box;
  return {
    code: f.code,
    severity: f.severity,
    level: f.where.levelId,
    box: { min: [r3(b.min.x), r3(b.min.y), r3(b.min.z)], max: [r3(b.max.x), r3(b.max.y), r3(b.max.z)] },
    cells: f.where.cells,
    element: f.where.elementId,
    pieces: f.pieces.map((p) => ({ name: p.name, uuid: p.uuid, element: p.elementId })),
    measure: f.measure,
    message: f.message,
  };
}

/** Runs the checks on a built scene and draws a marked picture per cluster (at most `pictures`). */
export function checkScene(
  scene: Scene,
  resolved: ResolvedPlan | null,
  objects: readonly ObjectPlan[],
  o: {
    folder: string;
    /** Relative path of the folder from the run's out folder (for the records). */
    rel: string;
    pictures: number;
    size: { width: number; height: number };
  },
): { record: ChecksRecord; findings: Finding[] } {
  const plan = resolved ? planFacts(resolved, scene, { objects }) : null;
  const report = runChecks(scene, plan, { now: () => performance.now() });
  const records = report.findings.map(findingRecord);
  const clusters = clusterFindings(report.findings, o.pictures);
  clusters.forEach((c, k) => {
    const spec = clusterShot(scene, report.findings, c, k + 1, o.size);
    const img = markedPicture(scene, report.findings, c, spec);
    const file = `${spec.id}.png`;
    writeFileSync(join(o.folder, file), encodePng(img));
    for (const i of c.findings) {
      const r = records[i];
      if (r) r.picture = o.rel ? `${o.rel}/${file}` : file;
    }
  });
  const counts: Partial<Record<CheckCode, number>> = {};
  for (const f of report.findings) counts[f.code] = (counts[f.code] ?? 0) + 1;
  return {
    record: {
      counts,
      faults: report.findings.filter((f) => f.severity === "fault").length,
      ms: report.ms,
      skipped: report.skipped,
      findings: records,
    },
    findings: report.findings,
  };
}

const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));

/** The table of one render's findings: code, count, faults, worst example. */
export function findingsTable(title: string, findings: readonly FindingRecord[]): string {
  if (findings.length === 0) return `${title}: no findings`;
  const lines = [
    `${title}: ${String(findings.length)} finding(s)`,
    `  ${pad("code", 16)}${pad("count", 7)}${pad("faults", 8)}worst`,
  ];
  for (const code of CHECK_CODES) {
    const fs = findings.filter((f) => f.code === code);
    if (fs.length === 0) continue;
    const worst = fs.find((f) => f.severity === "fault") ?? fs[0];
    const faults = fs.filter((f) => f.severity === "fault").length;
    const ex = worst ? `${worst.message}${worst.picture ? ` [${worst.picture}]` : ""}` : "";
    lines.push(`  ${pad(code, 16)}${pad(String(fs.length), 7)}${pad(String(faults), 8)}${ex.slice(0, 140)}`);
  }
  return lines.join("\n");
}

/** The batch summary: one row per render, one column per code (faults/total), the codes with any finding only. */
export function summaryTable(
  rows: ReadonlyArray<{ name: string; findings: readonly FindingRecord[] }>,
): string {
  const codes = CHECK_CODES.filter((c) => rows.some((r) => r.findings.some((f) => f.code === c)));
  if (codes.length === 0) return "no findings in any render";
  const w = Math.max(10, maxOf(rows.map((r) => r.name.length + 2)));
  const col = (c: string): number => Math.max(c.length + 2, 9);
  const out = [pad("render", w) + codes.map((c) => pad(c, col(c))).join("") + "faults"];
  const total = new Map<string, [number, number]>();
  for (const r of rows) {
    let faults = 0;
    const cells = codes.map((c) => {
      const fs = r.findings.filter((f) => f.code === c);
      const n = fs.filter((f) => f.severity === "fault").length;
      faults += n;
      const t = total.get(c) ?? [0, 0];
      total.set(c, [t[0] + n, t[1] + fs.length]);
      return pad(fs.length === 0 ? "." : `${String(n)}/${String(fs.length)}`, col(c));
    });
    out.push(pad(r.name, w) + cells.join("") + String(faults));
  }
  out.push(
    pad("all", w) +
      codes
        .map((c) => {
          const t = total.get(c) ?? [0, 0];
          return pad(`${String(t[0])}/${String(t[1])}`, col(c));
        })
        .join(""),
  );
  out.push("(faults/findings per code; '.' none)");
  return out.join("\n");
}
