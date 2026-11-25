/** Cross-store user actions (each one IPC call + store updates). Components call these, never IPC directly. */
import type { IpcRequests, ProjectSnapshot } from "../../shared/ipc";
import { call, errorMessage, tryCall, type Req, type Res } from "../bridge/client";
import { useApp } from "../stores/app";
import { useBuild } from "../stores/build";
import { useChat } from "../stores/chat";
import { useMap } from "../stores/map";
import { orderedLevels, phaseOf, switchProject, useProject } from "../stores/project";
import { useView3d } from "../stores/view3d";

function fail(lead: string, e: unknown): void {
  useApp.getState().toast({ lead, body: errorMessage(e), tone: "error", ms: 6000 });
}

/**
 * An IPC call fired from a click or an effect: `then` gets the value; a failure is shown to the GM as a toast led by
 * `failLead` and never becomes an unhandled rejection. The renderer lint refuses `void call(...)`: use this (or
 * `tryCall`, which returns a Result) instead.
 */
export function run<C extends keyof IpcRequests>(
  channel: C,
  req: Req<C>,
  failLead: string,
  then?: (value: Res<C>) => void,
): Promise<void> {
  return call(channel, req).then(
    (value) => {
      then?.(value);
    },
    (e: unknown) => {
      fail(failLead, e);
    },
  );
}

/** Whatever rejects without a handler is logged and shown, never silent (installed once by app/boot.ts). */
export function reportUnhandled(e: unknown): void {
  console.error("[slabyrinth] unhandled failure", e);
  fail("Something didn't work.", e);
}

export function openSnapshot(snap: ProjectSnapshot): void {
  useMap.getState().reset();
  useView3d.getState().resetView();
  useBuild.getState().reset();
  useProject.getState().setSnapshot(snap);
  useChat
    .getState()
    .hydrate(
      snap.conversation.items,
      snap.conversation.meta,
      snap.conversation.selection,
      snap.busy?.turnId ?? null,
    );
  const resume = useProject.getState().resume.ui;
  const levels = orderedLevels(snap.plan);
  const levelId =
    resume?.levelId !== undefined && levels.some((l) => l.id === resume.levelId)
      ? resume.levelId
      : levels[0]?.id;
  if (levelId !== undefined) useMap.getState().setLevel(levelId);
  const phase = phaseOf(snap);
  useMap
    .getState()
    .setTab(
      resume?.tab ??
        (phase === "build" && snap.builds.length > 0 && snap.approvedVersion === snap.head ? "build" : "map"),
    );
  if (resume?.composerDraft) useChat.getState().setDraft(resume.composerDraft.text);
  useBuild.getState().syncFromSnapshot();
  useApp.getState().setRoute("workspace");
}

export async function openProject(path?: string): Promise<void> {
  try {
    const snap = await switchProject(() => call("project:open", path !== undefined ? { path } : {}));
    if (snap) openSnapshot(snap);
  } catch (e) {
    fail("Couldn't open that project.", e);
  }
}

export async function newProject(prompt?: string): Promise<void> {
  try {
    const snap = await switchProject(() => call("project:new", {}));
    openSnapshot(snap);
    if (prompt !== undefined) {
      useChat.getState().setDraft(prompt);
      useChat.getState().focusComposer();
    }
  } catch (e) {
    fail("Couldn't create a project.", e);
  }
}

export async function goHome(): Promise<void> {
  if (useProject.getState().snap) {
    const draft = useChat.getState().draft;
    useProject.getState().saveUi({ composerDraft: { text: draft, references: [] } });
    await switchProject(() => tryCall("project:close", {}));
  }
  useProject.getState().setSnapshot(null);
  useApp.getState().setRoute("home");
  await useProject.getState().loadList();
}

export async function undo(): Promise<void> {
  const r = await tryCall("plan:undo", undefined);
  if (r.ok) useApp.getState().toast({ lead: `Undid that change · back to v${r.value.head}` });
}

export async function redo(): Promise<void> {
  const r = await tryCall("plan:redo", undefined);
  if (r.ok) useApp.getState().toast({ lead: `Redid · now v${r.value.head}` });
}

export async function restoreVersion(v: number): Promise<void> {
  try {
    const r = await call("plan:restore", { version: v });
    useMap.getState().preview(null);
    useApp.getState().toast({ lead: `Restored v${v} as v${r.head}.` });
  } catch (e) {
    fail("Couldn't restore that version.", e);
  }
}

export async function approve(
  version: number,
  andBuild: boolean,
): Promise<{ blocking: string[]; warnings: string[] } | null> {
  try {
    const r = await call("plan:approve", { version });
    if (!r.approved) return { blocking: r.blocking, warnings: r.warnings };
    await useProject.getState().refresh();
    useMap.getState().setApprove(false);
    if (andBuild) {
      useMap.getState().setTab("build");
      await useBuild.getState().run(version);
    } else
      useApp.getState().toast({ lead: `Approved v${version}.`, body: "Build it whenever you're ready." });
    return null;
  } catch (e) {
    fail("Couldn't approve.", e);
    return null;
  }
}

export async function editRoomText(id: string, set: Record<string, string | null>): Promise<boolean> {
  try {
    await call("plan:editText", { id, set });
    return true;
  } catch (e) {
    fail("Couldn't save that edit.", e);
    return false;
  }
}

export async function renameProject(name: string): Promise<void> {
  const clean = name.trim().slice(0, 60);
  if (clean === "") return;
  try {
    await call("project:rename", { name: clean });
    const snap = useProject.getState().snap;
    if (snap) useProject.getState().setSnapshot({ ...snap, name: clean });
  } catch (e) {
    fail("Couldn't rename the project.", e);
  }
}

export async function copyRoomKey(): Promise<void> {
  try {
    await call("export:roomKeyMarkdown", { copyToClipboard: true });
    useApp
      .getState()
      .toast({ lead: "Room key copied.", body: "Markdown for every level is on your clipboard." });
  } catch (e) {
    fail("Couldn't copy the room key.", e);
  }
}

/** Sends a prepared message (e.g. "Ask Slabyrinth to fix"), bypassing the composer draft. */
export async function sendPrepared(text: string, intent: "chat" | "plan" | "auto" = "plan"): Promise<void> {
  try {
    await useChat.getState().send({ text, intent });
  } catch (e) {
    fail("Couldn't send that.", e);
  }
}
