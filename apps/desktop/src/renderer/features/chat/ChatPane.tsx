/** Chat pane (UX §5): pinned brief card, thread, composer. Collapses to a 56px rail (Ctrl+\). */
import "./chat.css";
import { Icon, Mark } from "../../ui/Icon";
import { useApp } from "../../stores/app";
import { useChat } from "../../stores/chat";
import { BriefCard } from "./BriefCard";
import { Thread } from "./Thread";
import { Composer } from "./Composer";
import { RunAnnouncer } from "./WorkingCard";

export function ChatPane() {
  const collapsed = useApp((s) => s.chatCollapsed);
  const toggle = useApp((s) => s.toggleChat);
  const busy = useChat((s) => s.live !== null);
  if (collapsed)
    return (
      <aside className="chat chat--rail" aria-label="Chat (collapsed)">
        <button
          className="iconbtn"
          aria-label="Show chat (/ or Ctrl+\)"
          title="Show chat (/)"
          onClick={() => {
            toggle(true);
          }}
        >
          <Icon name="right" />
        </button>
        <Mark size={22} />
        {busy && <span className="spinner" aria-label="Slabyrinth is working" />}
        <RunAnnouncer />
      </aside>
    );
  return (
    <aside className="chat" aria-label="Chat">
      <RunAnnouncer />
      <BriefCard />
      <Thread />
      <Composer />
    </aside>
  );
}
