/** Two-pane workspace (UX §3.2): chat pane (360–520 px, resizable, collapsible) + stage. */
import { useEffect, useRef, useState } from "react";
import "./workspace.css";
import { ChatPane } from "../chat/ChatPane";
import { Stage } from "../stage/Stage";
import { useApp } from "../../stores/app";
import { useMap } from "../../stores/map";
import { useProject } from "../../stores/project";

const MIN = 360;
const MAX = 520;
const DEF = 400;

export function Workspace() {
  const collapsed = useApp((s) => s.chatCollapsed);
  const resumeWidth = useProject((s) => s.resume.ui?.chatWidth);
  const saveUi = useProject((s) => s.saveUi);
  const [width, setWidth] = useState(resumeWidth ?? DEF);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const tab = useMap((s) => s.tab);
  const levelId = useMap((s) => s.levelId);
  const zoom = useMap((s) => s.zoom);
  const pan = useMap((s) => s.pan);

  // resume state (UX §8.9): tab, level, zoom/pan, chat width
  useEffect(() => {
    saveUi({
      tab,
      ...(levelId !== null ? { levelId } : {}),
      zoom,
      pan: [Math.round(pan[0]), Math.round(pan[1])],
      chatWidth: width,
    });
  }, [tab, levelId, zoom, pan, width, saveUi]);

  return (
    <div
      className="workspace"
      style={{ gridTemplateColumns: `${collapsed ? "var(--w-chat-rail)" : `${width}px`} minmax(0, 1fr)` }}
    >
      <ChatPane />
      {!collapsed && (
        <div
          className="resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat"
          aria-valuemin={MIN}
          aria-valuemax={MAX}
          aria-valuenow={width}
          tabIndex={0}
          style={{ left: width - 3 }}
          onPointerDown={(e) => {
            drag.current = { x: e.clientX, w: width };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (drag.current)
              setWidth(Math.max(MIN, Math.min(MAX, drag.current.w + e.clientX - drag.current.x)));
          }}
          onPointerUp={() => (drag.current = null)}
          onDoubleClick={() => {
            setWidth(DEF);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") setWidth(Math.max(MIN, width - 20));
            if (e.key === "ArrowRight") setWidth(Math.min(MAX, width + 20));
          }}
        />
      )}
      <Stage />
    </div>
  );
}
