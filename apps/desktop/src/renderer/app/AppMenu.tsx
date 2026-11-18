/** ☰ app menu (UX §3.1): File · Edit · View · Map · Help, keyboard navigable; Alt opens it on File. */
import { useEffect, useRef, useState, type RefObject } from "react";
import { useApp } from "../stores/app";
import { useDismiss } from "../ui/dismiss";
import { COMMANDS, type Command } from "./commands";

const GROUPS: Command["group"][] = ["File", "Edit", "View", "Map", "Help"];

export function AppMenu({ anchor }: { anchor: RefObject<HTMLButtonElement | null> }) {
  const setMenu = useApp((s) => s.setMenu);
  const [group, setGroup] = useState<Command["group"]>("File");
  const ref = useRef<HTMLDivElement>(null);
  const close = (): void => {
    setMenu(false);
  };
  useDismiss(true, [ref, anchor], close, anchor);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>(".menu__item:not(:disabled)")?.focus();
  }, [group]);
  const items = COMMANDS.filter((c) => c.group === group);
  const onKey = (e: React.KeyboardEvent): void => {
    const gi = GROUPS.indexOf(group);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      setGroup(GROUPS[(gi + (e.key === "ArrowRight" ? 1 : GROUPS.length - 1)) % GROUPS.length] ?? "File");
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const all = [...(ref.current?.querySelectorAll<HTMLButtonElement>(".menu__item:not(:disabled)") ?? [])];
      const i = all.indexOf(document.activeElement as HTMLButtonElement);
      all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
    }
  };
  return (
    <div ref={ref} className="popover appmenu" onKeyDown={onKey}>
      <div className="appmenu__bar" role="tablist" aria-label="Menu">
        {GROUPS.map((g) => (
          <button
            key={g}
            role="tab"
            className="appmenu__tab"
            aria-selected={g === group}
            tabIndex={-1}
            onClick={() => {
              setGroup(g);
            }}
          >
            {g}
          </button>
        ))}
      </div>
      <div className="appmenu__items" role="menu" aria-label={group}>
        {items.map((c) => (
          <button
            key={c.id}
            role="menuitem"
            className="menu__item"
            disabled={!(c.enabled?.() ?? true)}
            onClick={() => {
              close();
              c.run();
            }}
          >
            {c.label}
            {c.keys !== undefined && <span className="menu__accel">{c.keys}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
