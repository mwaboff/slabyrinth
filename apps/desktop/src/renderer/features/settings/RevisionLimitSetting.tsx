/**
 * Settings › AI › "Changes per message" (AppSettings.agent.maxRevisionsPerTurn, design 4.3): how many times Claude may
 * change the map for one message before the app stops and asks (the chat's revision-limit card). Every conversation
 * and generator follows it from the next message; nothing the model is told changes. A list, not a number field, so a
 * half-typed value ("3" on the way to "30") is never saved.
 */
import { REVISION_LIMIT_RANGE, agentSettings } from "../../../shared/agentSettings";
import type { AppSettings } from "../../../shared/project";
import { useSettings } from "../../stores/settings";

const CHOICES = Array.from(
  { length: REVISION_LIMIT_RANGE.max - REVISION_LIMIT_RANGE.min + 1 },
  (_, i) => REVISION_LIMIT_RANGE.min + i,
);

export function RevisionLimitSetting({ s }: { s: AppSettings }) {
  const update = useSettings((x) => x.update);
  const value = agentSettings(s).maxRevisionsPerTurn;
  return (
    <div className="revlimit">
      <label className="revlimit__line">
        <span>Claude may change the map up to</span>
        <select
          className="select"
          aria-label="Changes per message"
          aria-describedby="revlimit-help"
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (n !== value) void update({ agent: { maxRevisionsPerTurn: n } });
          }}
        >
          {CHOICES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span>
          {value === 1 ? "time" : "times"} for each message you send, then asks you before going on.
        </span>
      </label>
      <small id="revlimit-help" className="muted">
        Every change is kept, whether you go on or stop there.
      </small>
    </div>
  );
}
