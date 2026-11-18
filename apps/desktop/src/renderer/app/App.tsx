import { useEffect, useState } from "react";
import "./shell.css";
import { boot } from "./boot";
import { useAppliedTheme } from "./theme";
import { useShortcuts } from "./commands";
import { useApp } from "../stores/app";
import { TitleBar } from "./TitleBar";
import { Banners } from "./Banners";
import { Toasts } from "./Toasts";
import { ConfirmDialog } from "./ConfirmDialog";
import { ShortcutSheet } from "./ShortcutSheet";
import { Home } from "../features/projects/Home";
import { Setup } from "../features/setup/Setup";
import { Workspace } from "../features/workspace/Workspace";
import { SettingsModal } from "../features/settings/SettingsModal";
import { errorMessage } from "../bridge/client";

export function App() {
  useAppliedTheme();
  useShortcuts();
  const route = useApp((s) => s.route);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    boot()
      .catch((e: unknown) => {
        setBootError(errorMessage(e));
      })
      .finally(() => {
        // Ready signal read by the main-process smoke run and e2e tests.
        document.documentElement.dataset["slabyrinthReady"] = "true";
      });
  }, []);

  return (
    <div className="app">
      <TitleBar />
      <Banners />
      <div className="app__body">
        {bootError !== null ? (
          <div className="boot-error" role="alert">
            <h1>Slabyrinth could not start</h1>
            <p>{bootError}</p>
          </div>
        ) : route === "home" ? (
          <Home />
        ) : route === "workspace" ? (
          <Workspace />
        ) : route === "setup" ? (
          <>
            <div className="app__ghost" aria-hidden="true" />
            <Setup />
          </>
        ) : (
          <div className="app__ghost" aria-busy="true" />
        )}
      </div>
      {settingsOpen !== null && <SettingsModal />}
      <ShortcutSheet />
      <ConfirmDialog />
      <Toasts />
    </div>
  );
}
