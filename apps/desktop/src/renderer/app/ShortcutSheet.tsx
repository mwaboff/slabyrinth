import { useApp } from "../stores/app";
import { KEY_CONTROLS } from "../features/view3d/controls";
import { COMMANDS, EXTRA_KEYS } from "./commands";

function Rows({ rows }: { rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <div className="shortcuts__grid">
      {rows.map(([k, label]) => (
        <div key={`${k}-${label}`} className="shortcuts__row">
          <span>{label}</span>
          <span className="kbd">{k}</span>
        </div>
      ))}
    </div>
  );
}

export function ShortcutSheet() {
  const open = useApp((s) => s.shortcutsOpen);
  const close = (): void => {
    useApp.getState().setShortcuts(false);
  };
  if (!open) return null;
  const rows: Array<[string, string]> = [
    ...COMMANDS.filter((c) => c.keys !== undefined).map((c): [string, string] => [c.keys ?? "", c.label]),
    ...EXTRA_KEYS,
  ];
  return (
    <div
      className="scrim"
      onKeyDown={(e) => {
        if (e.key === "Escape") close();
      }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="dialog shortcuts" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <h2>Keyboard shortcuts</h2>
        <Rows rows={rows} />
        <h3 className="eyebrow shortcuts__h">3D view (click the view first)</h3>
        <Rows rows={KEY_CONTROLS.map((c) => [c.keys, c.does] as const)} />
        <div className="dialog__actions">
          <button className="btn btn--primary" autoFocus onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
