/** Settings: the TaleSpire add-on's status, versions and folder; the dialog has the setup steps and hotkeys. */
import { useTaleSpireLink } from "../../stores/talespireLink";
import { FolderRow, StatusLight, VersionRow, useAddonSummary } from "./AddonParts";

export function AddonSettings() {
  const sum = useAddonSummary();
  const open = useTaleSpireLink((s) => s.openDialog);
  return (
    <div className="tssettings">
      <div className={`tsnow tsnow--${sum.light}`} role="status">
        <StatusLight light={sum.light} />
        <span>
          <b>{sum.label}</b> {sum.detail}
        </span>
      </div>
      <VersionRow />
      <FolderRow />
      <button className="btn btn--link" onClick={open}>
        Setup steps, installing by hand and hotkeys…
      </button>
    </div>
  );
}
