/**
 * The build page's "Send to TaleSpire": the approved build goes to the add-on, which puts each slab in the GM's hand
 * in turn. The copy-the-slab route beside it stays as the manual way. The button turns on by itself the moment the
 * add-on connects (link:changed), even when TaleSpire is opened after this page.
 */
import type { ExportBundle } from "@slabyrinth/core";
import type { LinkStatus } from "../../../shared/ipc";
import { Icon } from "../../ui/Icon";
import { useTaleSpireLink } from "../../stores/talespireLink";
import { sendView } from "./addonView";
import { ActionError, HotkeyList, PrimaryButton, StatusLight } from "./AddonParts";
import { pasteSteps } from "./pasteSteps";

type Phase = NonNullable<LinkStatus["set"]>["phase"];
const of = (n: number, t: number): string => `${String(n)} of ${String(t)}`;
/** Our own words per phase (the add-on's sentence is shown only for a failure, where it carries the reason). */
const PLACING_HEAD: Record<Phase, (n: number, t: number) => string> = {
  ready: (n, t) => `Slab ${of(n, t)} is ready.`,
  sending: (n, t) => `Putting slab ${of(n, t)} in your hand…`,
  inHand: (n, t) => `Slab ${of(n, t)} is in your hand.`,
  failed: (n, t) => `Slab ${of(n, t)} didn't reach your hand.`,
  done: (_n, t) => `All ${String(t)} placed.`,
};
const PLACING_DO: Record<Phase, string> = {
  ready: "Press Next in TaleSpire to put it in your hand.",
  sending: "",
  inHand: "Click to place it in TaleSpire, then press Next.",
  failed: "",
  done: "",
};

function PasteSteps({ anchor }: { anchor: ExportBundle["pasteAnchor"] | null }) {
  const s = pasteSteps(anchor);
  return (
    <ol className="tspaste" aria-label="Placing a map of several slabs">
      <li>{s.plane}</li>
      <li>{s.spot}</li>
      <li>{s.pillars}</li>
    </ol>
  );
}

export function SendToTaleSpire({
  buildId,
  multi,
  anchor,
  emptyChunk,
}: {
  buildId: string;
  /** More than one slab: the paste steps matter. */
  multi: boolean;
  /** From the bundle in memory; null when unknown (after a restart). */
  anchor: ExportBundle["pasteAnchor"] | null;
  emptyChunk: boolean;
}) {
  const addon = useTaleSpireLink((s) => s.addon);
  const link = useTaleSpireLink((s) => s.link);
  const busy = useTaleSpireLink((s) => s.busy);
  const st = useTaleSpireLink.getState();
  const v = sendView(addon, link, busy, buildId, emptyChunk);
  const send = (): void => {
    void st.send(buildId);
  };
  const sendBtn = (label: string, enabled: boolean, primary = true) => (
    <button
      className={`btn${primary ? " btn--primary" : ""} tssend__btn`}
      disabled={!enabled}
      aria-describedby="tssend-state"
      onClick={send}
    >
      <Icon name="send" size="sm" />
      {label}
    </button>
  );
  return (
    <section className="tssend" aria-labelledby="tssend-title" data-state={v.kind}>
      <div className="tssend__head">
        <h3 id="tssend-title">Send to TaleSpire</h3>
        <span className="muted">or copy the slab{multi ? "s" : ""} below by hand</span>
      </div>
      <div id="tssend-state" className="tssend__state" role="status" aria-live="polite">
        {v.kind === "setup" && (
          <p>
            The TaleSpire add-on puts each slab in your hand for you. Set it up once to send maps straight to
            TaleSpire.
          </p>
        )}
        {(v.kind === "fix" || v.kind === "blocked") && (
          <p className="tssend__line">
            <StatusLight light={v.summary.light} />
            <span>
              <b>{v.summary.label}.</b> {v.summary.detail}
            </span>
          </p>
        )}
        {v.kind === "waiting" && (
          <p className="tssend__line">
            <StatusLight light="idle" />
            <span>
              <b>Open the Slabyrinth panel in TaleSpire.</b> In the Symbiotes panel, choose Slabyrinth Helper.
              This button turns on by itself.
            </span>
          </p>
        )}
        {v.kind === "empty_chunk" && (
          <p className="tssend__line">
            <StatusLight light="warn" />
            <span>
              <b>This build can't be sent.</b> One of its slabs is empty, and TaleSpire crashes on an empty
              slab. Build again.
            </span>
          </p>
        )}
        {v.kind === "ready" && (
          <p className="tssend__line">
            <StatusLight light="ok" />
            <span>
              <b>The add-on is connected.</b>{" "}
              {v.other !== null
                ? `It has "${v.other}" loaded; sending replaces it.`
                : "Each slab goes to your hand in turn; place it, then press Next."}
            </span>
          </p>
        )}
        {v.kind === "sending" && (
          <p className="tssend__line">
            <span className="spinner" aria-hidden="true" />
            <span>Sending to the add-on…</span>
          </p>
        )}
        {v.kind === "placing" && (
          <>
            <p className="tssend__line">
              <StatusLight light={v.phase === "failed" ? "warn" : "busy"} />
              <span>
                <b>{PLACING_HEAD[v.phase](v.chunk, v.total)}</b>{" "}
                {v.phase === "failed" ? v.status : PLACING_DO[v.phase]}
              </span>
            </p>
            <div
              className="tsprog"
              role="progressbar"
              aria-label="Slabs placed"
              aria-valuemin={0}
              aria-valuemax={v.total}
              aria-valuenow={v.placed}
              aria-valuetext={`${String(v.placed)} of ${String(v.total)} placed`}
            >
              <i style={{ width: `${String(Math.round((v.placed / Math.max(1, v.total)) * 100))}%` }} />
            </div>
          </>
        )}
        {v.kind === "finished" && (
          <p className="tssend__line">
            <StatusLight light="ok" />
            <span>
              <b>All {v.total === 1 ? "of it is" : `${String(v.total)} slabs are`} placed.</b> Right-click in
              TaleSpire if a slab is still in your hand.
            </span>
          </p>
        )}
      </div>
      <div className="tsbtns">
        {v.kind === "setup" && (
          <button className="btn btn--primary" onClick={st.openDialog}>
            Set up the TaleSpire add-on
          </button>
        )}
        {v.kind === "fix" && (
          <>
            <PrimaryButton size="md" />
            <button className="btn btn--ghost" onClick={st.openDialog}>
              Details
            </button>
          </>
        )}
        {v.kind === "blocked" && (
          <button className="btn btn--ghost" onClick={st.openDialog}>
            Details
          </button>
        )}
        {(v.kind === "waiting" || v.kind === "empty_chunk" || v.kind === "sending") &&
          sendBtn(v.kind === "sending" ? "Sending…" : "Send to TaleSpire", false)}
        {v.kind === "waiting" && (
          <button className="btn btn--ghost" onClick={st.openDialog}>
            Help
          </button>
        )}
        {v.kind === "ready" && sendBtn("Send to TaleSpire", true)}
        {(v.kind === "placing" || v.kind === "finished") && (
          <>
            {v.kind === "finished" && sendBtn("Send again", busy === null)}
            <button className="btn" disabled={busy !== null} onClick={() => void st.stop()}>
              {v.kind === "placing" ? (
                <>
                  <Icon name="stop" size="sm" />
                  Stop
                </>
              ) : (
                "Clear the add-on"
              )}
            </button>
          </>
        )}
      </div>
      <ActionError actions={["send", "stop"]} />
      {link?.send.state === "failed" && link.send.error !== null && busy === null && (
        <p className="tserr" role="alert">
          <Icon name="error" size="sm" />
          <span>{link.send.error}</span>
        </p>
      )}
      {v.kind === "placing" && <HotkeyList compact />}
      {multi && (v.kind === "ready" || v.kind === "placing" || v.kind === "finished") && (
        <PasteSteps anchor={anchor} />
      )}
    </section>
  );
}
