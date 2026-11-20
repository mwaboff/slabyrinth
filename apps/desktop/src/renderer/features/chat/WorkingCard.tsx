/** The "working" card at the end of the thread while a run is active, and the polite announcer for run start/end. */
import { useEffect, useRef, useState } from "react";
import { Mark } from "../../ui/Icon";
import { useChat } from "../../stores/chat";
import { useProject } from "../../stores/project";
import { duration } from "../../lib/format";
import type { TurnState } from "../../stores/chatReducer";
import { headline, runAnnouncement, runPhase, stepLine, useRunPhase } from "./activity";

const SLOW_SECONDS = 60;
const VERY_SLOW_SECONDS = 180;

export function WorkingCard({ turn }: { turn: TurnState }) {
  const [now, setNow] = useState(() => Date.now());
  const stop = useChat((s) => s.stop);
  const head = useProject((s) => s.snap?.head ?? 0);
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(t);
    };
  }, []);
  const seconds = Math.max(0, Math.floor((now - turn.startedAt) / 1000));
  const phase = runPhase(turn);
  const title = headline(phase, head, turn.newVersions.length);
  const step =
    seconds >= VERY_SLOW_SECONDS
      ? "Still working. Large plans can take a while; you can stop and ask for a smaller map."
      : seconds >= SLOW_SECONDS
        ? `${stepLine(turn)} · large plans can take up to 2 minutes`
        : stepLine(turn);
  return (
    <div className="working" data-phase={phase}>
      <Mark size={22} className="working__mark" />
      <div className="working__body">
        <div className="working__title">{title}</div>
        <div className="working__step" title={step}>
          {step}
        </div>
      </div>
      <span className="working__time" aria-label={`Running for ${duration(seconds * 1000)}`}>
        {duration(seconds * 1000)}
      </span>
      <button className="btn btn--sm" title="Stop this revision (Esc)" onClick={() => void stop()}>
        Stop
      </button>
      <span className="working__bar" aria-hidden="true" />
    </div>
  );
}

/** Says "working" when a run starts and how it ended when it stops. Always mounted, so the region exists first. */
export function RunAnnouncer() {
  const phase = useRunPhase();
  const status = useChat((s) => s.last?.status ?? null);
  const head = useProject((s) => s.snap?.head ?? 0);
  const [text, setText] = useState("");
  const wasBusy = useRef(false);
  useEffect(() => {
    const busy = phase !== "idle";
    if (busy && !wasBusy.current) setText(runAnnouncement(phase, null, head, true));
    else if (!busy && wasBusy.current)
      setText(runAnnouncement("idle", status === null ? null : { status }, head, true));
    wasBusy.current = busy;
  }, [phase, status, head]);
  return (
    <span className="sr-only" role="status" aria-live="polite">
      {text}
    </span>
  );
}
