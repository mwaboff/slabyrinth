/**
 * Settings › AI › "3D view" (AppSettings.agent.view3d and maxPicturesPerTurn, design 4.4). The one switch does two
 * things a GM sees, so its words say both: the 3D tab shows TaleSpire's real piece shapes, and Claude may look at the
 * map in 3D while revising (how many pictures per message is the line under it). Off: nothing is read from TaleSpire's
 * pieces, every piece is a box and Claude gets no 3D pictures. Saved as single fields through settings:update, like
 * "Changes per message". A list, not a number field, so a half-typed value is never saved.
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
        label="Use TaleSpire's 3D pieces"
        help="The 3D tab shows each piece's real shape, and Claude can look at the map in 3D while revising. The shapes are read from your own TaleSpire install and kept on this PC. Off: every piece is a plain box and Claude gets no 3D pictures."
      />
      <label className="revlimit__line">
        <span>Claude may take up to</span>
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
        <span>3D {maxPicturesPerTurn === 1 ? "picture" : "pictures"} for each message you send.</span>
      </label>
      <small id="pictures-help" className="muted">
        Each picture adds a little to what a message costs, and leaves your PC like any map picture you send.
      </small>
    </div>
  );
}
