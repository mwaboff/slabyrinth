/** Native folder pickers (dialog:pickFolder) for the TaleSpire install and the projects folder. */
import { call } from "../bridge/client";
import { useApp } from "../stores/app";
import { useSettings } from "../stores/settings";

export type PickOutcome = { ok: true; path: string } | { ok: false; message: string } | null;

/** null = cancelled (nothing saved). On a valid pick the path is saved with talespire:setPath. */
export async function pickTaleSpireFolder(): Promise<PickOutcome> {
  const r = await call("dialog:pickFolder", { purpose: "talespire" });
  if (r === null) return null;
  if (!r.valid) return { ok: false, message: r.message };
  const set = await call("talespire:setPath", { path: r.path });
  if (!set.valid)
    return {
      ok: false,
      message:
        set.reason ??
        "That folder doesn't look like a TaleSpire install — pick the folder that contains TaleSpire.exe.",
    };
  useApp.getState().setBanner({ tsMissing: false });
  await useSettings.getState().refreshCatalog();
  await useSettings.getState().load();
  return { ok: true, path: r.path };
}

export async function pickProjectsFolder(): Promise<PickOutcome> {
  const r = await call("dialog:pickFolder", { purpose: "projects" });
  if (r === null) return null;
  if (!r.valid) return { ok: false, message: r.message };
  const s = useSettings.getState().settings;
  if (s) await useSettings.getState().update({ projects: { ...s.projects, folder: r.path } });
  return { ok: true, path: r.path };
}
