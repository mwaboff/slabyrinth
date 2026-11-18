import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import type { ChatItem, ModelSelection } from "../agent/provider/types";
import type { ProjectSnapshot } from "../../shared/ipc";
import {
  PROJECT_FORMAT,
  PROJECT_FORMAT_VERSION,
  type Conversation,
  type Phase,
  type ProjectFile,
} from "../../shared/project";
import { emptyUsage } from "../schemas/common";
import { AppFailure } from "../util/errors";
import { emptyHistory } from "./history";

/** `.slabyrinth` file I/O helpers: create, parse (gzip, version gate, migration hook), serialize, snapshot. */

export interface ConversationDefaults {
  systemPromptVersion: string;
  toolsVersion: string;
  imageToolEnabled: boolean;
  toolMode: Conversation["toolMode"];
}

export const UNKNOWN_CONVERSATION_DEFAULTS: ConversationDefaults = {
  systemPromptVersion: "sp-unset",
  toolsVersion: "tools-unset",
  imageToolEnabled: true,
  toolMode: "native",
};

export function newConversation(
  selection: ModelSelection,
  defaults: ConversationDefaults,
  now = new Date().toISOString(),
): Conversation {
  return {
    id: randomUUID(),
    createdAt: now,
    selection,
    selectionLog: [{ at: now, afterItemId: null, selection }],
    systemPromptVersion: defaults.systemPromptVersion,
    toolsVersion: defaults.toolsVersion,
    imageToolEnabled: defaults.imageToolEnabled,
    toolMode: defaults.toolMode,
    items: [],
    meta: {},
    modelSeen: { head: 0, briefHash: "" },
    totals: { usage: emptyUsage(), cost: null, turns: 0 },
    compactions: [],
    archived: false,
  };
}

export function newProjectFile(input: {
  name: string;
  selection: ModelSelection;
  appVersion: string;
  conversation: ConversationDefaults;
}): ProjectFile {
  const now = new Date().toISOString();
  const conversation = newConversation(input.selection, input.conversation, now);
  return {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FORMAT_VERSION,
    appVersion: input.appVersion,
    id: randomUUID(),
    name: input.name,
    createdAt: now,
    updatedAt: now,
    brief: {},
    plan: null,
    history: emptyHistory(),
    conversations: [conversation],
    activeConversationId: conversation.id,
    builds: [],
    spend: { usage: emptyUsage(), cost: null },
    blobs: {},
    stamps: {},
    ui: { tab: "map" },
  };
}

/** Structural gate for files we read: loose so unknown/extension keys survive a round trip. */
const projectShape = z.looseObject({
  format: z.literal(PROJECT_FORMAT),
  formatVersion: z.number().int().positive(),
  appVersion: z.string(),
  id: z.string().min(1),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  brief: z.record(z.string(), z.unknown()),
  plan: z.record(z.string(), z.unknown()).nullable(),
  history: z.looseObject({
    head: z.number().int().nonnegative(),
    versions: z.array(
      z.looseObject({ number: z.number().int().positive(), parentNumber: z.number().int().nonnegative() }),
    ),
    undone: z.array(z.number().int()),
    approvedVersion: z.number().int().nullable(),
  }),
  conversations: z
    .array(
      z.looseObject({ id: z.string(), items: z.array(z.looseObject({ type: z.string(), id: z.string() })) }),
    )
    .min(1),
  activeConversationId: z.string(),
  builds: z.array(z.record(z.string(), z.unknown())),
  spend: z.record(z.string(), z.unknown()),
  blobs: z.record(z.string(), z.unknown()),
  stamps: z.record(z.string(), z.unknown()),
  ui: z.record(z.string(), z.unknown()),
});

export type ParseOutcome =
  | { ok: true; project: ProjectFile; migratedFrom: number | null }
  | { ok: false; reason: "not_project" | "corrupt" | "newer" | "needs_migration"; message: string };

const GZIP = [0x1f, 0x8b];

/** Largest project file read from disk (compressed or not). */
export const PROJECT_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** Largest decompressed size of a gzip project (gzip-bomb guard). */
export const PROJECT_GUNZIP_MAX_BYTES = 256 * 1024 * 1024;

/** Reads a project file after a size check; larger files are refused as unreadable ("validation"). */
export async function readProjectBytes(file: string): Promise<Buffer> {
  const st = await fsp.stat(file);
  if (st.size > PROJECT_FILE_MAX_BYTES) {
    throw new AppFailure("validation", "That map file is too large to be a Slabyrinth project.");
  }
  return fsp.readFile(file);
}

/** Throws (caught by parseProject → "corrupt") when a gzip file inflates beyond the cap. */
export function decodeProjectBytes(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const raw =
    buf[0] === GZIP[0] && buf[1] === GZIP[1]
      ? gunzipSync(buf, { maxOutputLength: PROJECT_GUNZIP_MAX_BYTES })
      : buf;
  // Strip a UTF-8 BOM if an editor added one.
  const text = raw.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseProject(bytes: Uint8Array, migrate: (json: unknown) => unknown): ParseOutcome {
  let json: unknown;
  try {
    json = JSON.parse(decodeProjectBytes(bytes));
  } catch {
    return {
      ok: false,
      reason: "corrupt",
      message: "That project file is damaged (it isn't complete JSON).",
    };
  }
  if (typeof json !== "object" || json === null || (json as { format?: unknown }).format !== PROJECT_FORMAT) {
    return { ok: false, reason: "not_project", message: "That file isn't a Slabyrinth project." };
  }
  const version = (json as { formatVersion?: unknown }).formatVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return { ok: false, reason: "not_project", message: "That file isn't a Slabyrinth project." };
  }
  if (version > PROJECT_FORMAT_VERSION) {
    return {
      ok: false,
      reason: "newer",
      message: "This project was made with a newer version of Slabyrinth. Update the app to open it.",
    };
  }
  let migratedFrom: number | null = null;
  if (version < PROJECT_FORMAT_VERSION) {
    const upgraded = migrate(json);
    if (upgraded === null || upgraded === undefined) {
      return {
        ok: false,
        reason: "needs_migration",
        message: "This project uses an older format that this build can't upgrade.",
      };
    }
    json = upgraded;
    migratedFrom = version;
  }
  const parsed = projectShape.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: "not_project", message: "That file isn't a valid Slabyrinth project." };
  }
  const project = json as ProjectFile;
  if (!project.conversations.some((c) => c.id === project.activeConversationId)) {
    project.activeConversationId =
      project.conversations[project.conversations.length - 1]?.id ?? project.activeConversationId;
  }
  return { ok: true, project, migratedFrom };
}

export function serializeProject(p: ProjectFile): string {
  return JSON.stringify(p);
}

export function derivePhase(p: Pick<ProjectFile, "history">): Phase {
  if (p.history.approvedVersion !== null) return "build";
  return p.history.versions.length > 0 ? "plan" : "brief";
}

export function activeConversation(p: ProjectFile): Conversation {
  const c =
    p.conversations.find((x) => x.id === p.activeConversationId) ??
    p.conversations[p.conversations.length - 1];
  if (!c) throw new AppFailure("internal", "Project has no conversation.");
  return c;
}

export function stripProviderState(item: ChatItem): ChatItem {
  if (item.type !== "assistant" || item.providerState === undefined) return item;
  const rest = { ...item };
  delete rest.providerState;
  return rest;
}

export function versionSummary(
  v: ProjectFile["history"]["versions"][number],
): ProjectSnapshot["versions"][number] {
  const rest: Partial<typeof v> = { ...v };
  delete rest.snapshot;
  delete rest.cause;
  return { ...(rest as Omit<typeof v, "snapshot" | "cause">), causeType: v.cause.type };
}

export function buildSnapshot(
  p: ProjectFile,
  filePath: string | null,
  dirty: boolean,
  busy: { turnId: string } | null,
): ProjectSnapshot {
  const c = activeConversation(p);
  return {
    projectId: p.id,
    name: p.name,
    filePath,
    dirty,
    plan: p.plan,
    head: p.history.head,
    versions: p.history.versions.map(versionSummary),
    undone: [...p.history.undone],
    approvedVersion: p.history.approvedVersion,
    brief: p.brief,
    builds: p.builds,
    conversation: {
      id: c.id,
      selection: c.selection,
      phase: derivePhase(p),
      items: c.items.map(stripProviderState),
      meta: c.meta,
      totals: c.totals,
      toolMode: c.toolMode,
    },
    busy,
    ui: structuredClone(p.ui),
    pasteGuide: p.pasteGuide ? { ...p.pasteGuide } : null,
    pngExport: p.pngExport ? { ...p.pngExport } : null,
  };
}

/** Count of keyed rooms (room/cave/building/courtyard areas) for Home cards. */
export function countRooms(p: Pick<ProjectFile, "plan">): number {
  if (!p.plan) return 0;
  let n = 0;
  for (const l of p.plan.levels)
    for (const a of l.areas) if (a.kind !== "corridor" && a.kind !== "zone") n += 1;
  return n;
}
