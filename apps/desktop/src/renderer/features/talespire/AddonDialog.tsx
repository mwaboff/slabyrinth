/**
 * The TaleSpire add-on dialog: the install guide and the management page in one. Live: each step turns to done by
 * itself as main reports the install and the connection (TaleSpire picks up new add-ons while it runs).
 */
import { useRef } from "react";
import { Icon } from "../../ui/Icon";
import { useModal } from "../../ui/modal";
import { useTaleSpireLink } from "../../stores/talespireLink";
import { setupSteps, type StepState } from "./addonView";
import {
  ActionError,
  FolderRow,
  HotkeyList,
  ManualInstall,
  PrimaryButton,
  StatusLight,
  VersionRow,
  useAddonSummary,
} from "./AddonParts";

function Step({
  n,
  state,
  title,
  children,
}: {
  n: number;
  state: StepState;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className={`tsstep tsstep--${state}`} aria-current={state === "current" ? "step" : undefined}>
      <span className="tsstep__dot" aria-hidden="true">
        {state === "done" ? <Icon name="check" size="xs" /> : n}
      </span>
      <div className="tsstep__body">
        <b>
          {title}
          {state === "done" && <span className="sr-only"> (done)</span>}
        </b>
        {children}
      </div>
    </li>
  );
}

export function AddonDialog() {
  const open = useTaleSpireLink((s) => s.dialogOpen);
  if (!open) return null;
  return <AddonDialogBody />;
}

function AddonDialogBody() {
  const addon = useTaleSpireLink((s) => s.addon);
  const link = useTaleSpireLink((s) => s.link);
  const close = useTaleSpireLink((s) => s.closeDialog);
  const sum = useAddonSummary();
  const dialog = useRef<HTMLDivElement>(null);
  useModal(dialog, close);
  const steps = setupSteps(addon, link);
  const error = useTaleSpireLink((s) => s.error);
  const installFailed = error?.action === "install";
  return (
    <div
      className="scrim"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialog}
        className="dialog tsdialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tsdialog-title"
        tabIndex={-1}
      >
        <div className="tsdialog__head">
          <h2 id="tsdialog-title">TaleSpire add-on</h2>
          <button className="iconbtn iconbtn--sm" aria-label="Close" onClick={close} data-autofocus>
            <Icon name="x" />
          </button>
        </div>
        <p className="tsdialog__lead">
          Slabyrinth Helper is a small add-on for TaleSpire. It puts each slab of a big map in your hand, one
          at a time, so you only click to place them.
        </p>
        <div className={`tsnow tsnow--${sum.light}`} role="status" aria-live="polite">
          <StatusLight light={sum.light} />
          <span>
            <b>{sum.label}</b> {sum.detail}
          </span>
        </div>
        <div className="tsdialog__scroll">
          <ol className="tssteps" aria-label="Set it up">
            <Step n={1} state={steps.enable} title="Turn on Symbiotes in TaleSpire">
              <p>
                Do this first: TaleSpire shows add-ons only once Symbiotes are turned on in its settings. A
                Symbiotes tab then appears on the right edge of the screen.
              </p>
            </Step>
            <Step n={2} state={steps.install} title="Install the add-on">
              {steps.install === "done" ? (
                <p>Installed in TaleSpire's Symbiotes folder (version {addon?.installedVersion ?? "?"}).</p>
              ) : (
                <>
                  <p>One click copies it into TaleSpire's Symbiotes folder. TaleSpire can stay open.</p>
                  <div className="tsbtns">
                    <PrimaryButton size="md" />
                  </div>
                  <ActionError actions={["install", "chooseFolder"]} />
                  {installFailed && <ManualInstall open />}
                </>
              )}
            </Step>
            <Step n={3} state={steps.open} title="Open it in TaleSpire">
              {steps.open === "done" ? (
                <p>
                  Connected
                  {link?.helper.version !== null && link?.helper.version !== undefined
                    ? ` (version ${link.helper.version})`
                    : ""}
                  . You can send maps from the build page.
                </p>
              ) : (
                <p>
                  Open the Symbiotes panel and choose Slabyrinth Helper. This step turns to Connected by
                  itself; no restart needed.
                </p>
              )}
            </Step>
          </ol>

          <section className="tssec" aria-labelledby="ts-folder">
            <h3 id="ts-folder">Folder</h3>
            <FolderRow />
            {!installFailed && <ManualInstall />}
          </section>

          <section className="tssec" aria-labelledby="ts-version">
            <h3 id="ts-version">Version</h3>
            <VersionRow showPrimary={false} />
          </section>

          <section className="tssec" aria-labelledby="ts-keys">
            <h3 id="ts-keys">Hotkeys</h3>
            <p className="tsnote">
              While a map is being placed, these keys work in TaleSpire. Change them in the add-on panel.
            </p>
            <HotkeyList />
          </section>
        </div>
        <div className="dialog__actions">
          <button className="btn" onClick={() => void useTaleSpireLink.getState().recheck()}>
            <Icon name="retry" size="sm" />
            Check again
          </button>
          <button className="btn btn--primary" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
