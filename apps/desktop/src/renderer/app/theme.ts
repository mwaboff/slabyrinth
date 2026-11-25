/** Applies the app theme (match system by default · dark · light) to <html data-theme>. */
import { useEffect, useState } from "react";
import { useSettings } from "../stores/settings";

export type ThemePref = "dark" | "light" | "system";

function systemDark(): boolean {
  return typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)").matches : true;
}

export function resolveTheme(pref: ThemePref): "dark" | "light" {
  if (pref === "system") return systemDark() ? "dark" : "light";
  return pref;
}

export function useAppliedTheme(): "dark" | "light" {
  const pref = useSettings((s) => s.settings?.ui.theme ?? "system");
  const [sysTick, setSysTick] = useState(0);
  useEffect(() => {
    if (pref !== "system" || typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = (): void => {
      setSysTick((t) => t + 1);
    };
    mq.addEventListener("change", on);
    return () => {
      mq.removeEventListener("change", on);
    };
  }, [pref]);
  const theme = resolveTheme(pref);
  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
  }, [theme, sysTick]);
  return theme;
}

/** Current resolved theme without subscribing (for canvas code). */
export function currentTheme(): "dark" | "light" {
  return document.documentElement.dataset["theme"] === "light" ? "light" : "dark";
}

/** Reads a CSS custom property from :root (map overlays, canvas text). */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The "Switch theme" command: Dark ↔ Light (Match system lives in Settings ▸ Appearance). */
export function toggleTheme(): void {
  const s = useSettings.getState().settings;
  if (!s) return;
  const next = resolveTheme(s.ui.theme) === "dark" ? "light" : "dark";
  void useSettings.getState().update({ ui: { theme: next } });
}
