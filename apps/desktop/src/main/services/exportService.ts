import * as path from "node:path";
import type { MapPlan, PngExportOptions } from "@slabyrinth/core";
import type { IpcRequests } from "../../shared/ipc";
import type { Logger } from "../logger";
import { writeFileAtomic } from "../util/atomicWrite";
import { AppFailure } from "../util/errors";
import type { ClipboardService } from "./clipboardService";
import type { Dialogs } from "./dialogs";
import { sanitizeFileName, type ProjectService } from "./projectService";

/**
 * ExportService (architecture §5.5): the renderer rasterizes PNGs (OffscreenCanvas) and hands the
 * bytes over; main shows the native dialog (one file, or a folder for all levels named
 * `<project>-<level>.png`) and writes atomically. Also the room key as Markdown.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(base64: string): Buffer {
  const buf = Buffer.from(base64, "base64");
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE))
    throw new AppFailure("validation", "That image isn't a PNG.");
  return buf;
}

export interface ExportServiceDeps {
  projects: ProjectService;
  dialogs: Dialogs;
  clipboard: ClipboardService;
  logger: Logger;
  documentsFolder: () => string;
}

export class ExportService {
  constructor(private readonly deps: ExportServiceDeps) {}

  async savePng(req: IpcRequests["export:savePng"]["req"]): Promise<{ paths: string[] } | null> {
    if (req.files.length === 0) throw new AppFailure("validation", "Nothing to export.");
    const decoded = req.files.map((f) => ({ levelId: f.levelId, bytes: decodePng(f.pngBase64) }));
    const base = sanitizeFileName(req.suggestedName.replace(/\.png$/i, ""));
    const folder = this.deps.projects.filePath
      ? path.dirname(this.deps.projects.filePath)
      : this.deps.documentsFolder();
    let targets: Array<{ file: string; bytes: Buffer }>;
    const first = decoded[0];
    if (decoded.length === 1 && first) {
      const file = await this.deps.dialogs.saveFile({
        title: "Export map as PNG",
        defaultPath: path.join(folder, `${base}.png`),
        filters: [{ name: "PNG image", extensions: ["png"] }],
      });
      if (file === null) return null;
      targets = [{ file, bytes: first.bytes }];
    } else {
      const dir = await this.deps.dialogs.chooseFolder({
        title: "Choose a folder for the level images",
        defaultPath: folder,
      });
      if (dir === null) return null;
      targets = decoded.map((d) => ({
        file: path.join(dir, `${base}-${sanitizeFileName(d.levelId)}.png`),
        bytes: d.bytes,
      }));
    }
    for (const t of targets) await writeFileAtomic(t.file, t.bytes);
    if (this.deps.projects.isOpen) this.deps.projects.setPngExport(toProjectPngExport(req.options));
    this.deps.logger.info("png exported", { files: targets.length });
    return { paths: targets.map((t) => t.file) };
  }

  async roomKeyMarkdown(req: { copyToClipboard: boolean }): Promise<{ markdown: string; path?: string }> {
    const project = this.deps.projects.getProject();
    if (!project) throw new AppFailure("no_project", "No map is open.");
    const plan = this.deps.projects.getPlan();
    if (!plan) throw new AppFailure("validation", "There's no plan yet.");
    const markdown = roomKeyMarkdown(plan);
    if (req.copyToClipboard) {
      this.deps.clipboard.writeText(markdown);
      return { markdown };
    }
    const file = await this.deps.dialogs.saveFile({
      title: "Save room key",
      defaultPath: path.join(
        this.deps.projects.filePath ? path.dirname(this.deps.projects.filePath) : this.deps.documentsFolder(),
        `${sanitizeFileName(project.name)} room key.md`,
      ),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (file === null) return { markdown };
    await writeFileAtomic(file, markdown);
    return { markdown, path: file };
  }
}

export function toProjectPngExport(
  o: PngExportOptions,
): NonNullable<import("../../shared/project").ProjectFile["pngExport"]> {
  const out: NonNullable<import("../../shared/project").ProjectFile["pngExport"]> = {
    scope: o.levels === "all" ? "all" : "level",
    style: o.mapThemeId,
    pxPerSquare: o.pxPerCell,
    grid: o.display.grid,
    numbers: o.display.roomNumbers,
    names: o.display.roomNames,
    gmLayer: o.display.gmLayer,
    keyPanel: o.keyPanel,
  };
  if (o.version !== undefined) out.version = o.version;
  return out;
}

const keyOrder = (a?: string, b?: string): number => {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return (a ?? "").localeCompare(b ?? "");
};

/** Plain-text room key (model text is untrusted: no HTML is produced, only Markdown text). */
export function roomKeyMarkdown(plan: MapPlan): string {
  const esc = (s: string): string => s.replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"));
  const lines: string[] = [`# ${esc(plan.title)}`, ""];
  if (plan.summary) lines.push(esc(plan.summary), "");
  const levels = [...plan.levels].sort((a, b) => a.elevation - b.elevation);
  for (const level of levels) {
    lines.push(`## ${esc(level.name)}`, "");
    const keyed = level.areas
      .filter((a) => a.key !== undefined || a.name !== undefined)
      .sort((a, b) => keyOrder(a.key, b.key));
    for (const a of keyed) {
      lines.push(`### ${a.key !== undefined ? `${esc(a.key)}. ` : ""}${esc(a.name ?? a.id)}`, "");
      if (a.readAloud) lines.push(...a.readAloud.split("\n").map((l) => `> ${esc(l)}`), "");
      if (a.notes) lines.push(esc(a.notes), "");
      if (a.encounter) lines.push(`**Encounter:** ${esc(a.encounter)}`, "");
    }
  }
  if (plan.notes) lines.push("## Notes", "", esc(plan.notes), "");
  return `${lines.join("\n").trimEnd()}\n`;
}
