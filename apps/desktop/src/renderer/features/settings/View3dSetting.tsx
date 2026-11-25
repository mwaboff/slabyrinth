/**
 * Settings › AI › "3D view" (AppSettings.agent.view3d and maxPicturesPerTurn, design 4.4): whether Claude may look at
 * the map in 3D while revising, and how many 3D pictures it may take for one message. Off: nothing is read from
 * TaleSpire's pieces and every piece shows as a box. Saved as single fields through settings:update, like "Changes
 * per message". A list, not a number field, so a half-typed value is never saved.
 */
import { PICTURES_RANGE, agentSettings } from "../../../shared/agentSettings";
import type { AppSettings } from "../../../shared/project";
import { useSettings } from "../../stores/settings";
import { Check } from "./SettingsModal";

const CHOICES = Array.from(
  { length: PICTURES_RANGE.max - PICTURES_RANGE.min + 1 },
  (_, i) => PICTURES_RANGE.min + i,
);

export function View3dSetting({ s }: { s: AppSettings }) {
  const update = useSettings((x) => x.update);
  const { view3d, maxPicturesPerTurn } = agentSettings(s);
  return (
    <div className="revlimit">
      <Check
        on={view3d}
        onChange={(v) => {
          void update({ agent: { view3d: v } });
        }}
        label="Let Claude look at the map in 3D while revising"
        help="Uses the shapes of TaleSpire's pieces, read from your own install and kept on this PC. Off: every piece shows as a box and Claude gets no 3D pictures."
      />
      <label className="revlimit__line">
        <span>Up to</span>
        <select
          className="select"
          aria-label="3D pictures per message"
          aria-describedby="pictures-help"
          value={maxPicturesPerTurn}
          disabled={!view3d}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (n !== maxPicturesPerTurn) void update({ agent: { maxPicturesPerTurn: n } });
          }}
        >
          {CHOICES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span>{maxPicturesPerTurn === 1 ? "picture" : "pictures"} for each message you send.</span>
      </label>
      <small id="pictures-help" className="muted">
        Each picture sent to Claude adds a little to what a message costs. Pictures leave your PC like any map
        picture you send.
      </small>
    </div>
  );
}
