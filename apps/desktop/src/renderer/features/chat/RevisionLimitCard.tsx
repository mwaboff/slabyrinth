/**
 * The revision-limit card (design 4.3): Claude changed the map as many times as Settings › AI › Changes per message
 * allows for one message and wanted to go on, so the app stopped between steps (every change is kept) and asks.
 * "Keep going" grants another allowance of the same size; "That's enough" closes the card and hands the GM the composer.
 * The count and the cost run from the GM's own message, across earlier "Keep going"s (chatStore.carried).
 */
import { useState } from "react";
import { agentSettings } from "../../../shared/agentSettings";
import { useApp } from "../../stores/app";
import { useChat } from "../../stores/chat";
import { addCosts, type TurnState } from "../../stores/chatReducer";
import { useSettings } from "../../stores/settings";
import { money } from "../../lib/format";
import { Icon } from "../../ui/Icon";

/** "once", "twice", "4 times". */
export function timesWord(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}

export function RevisionLimitCard({ turn }: { turn: TurnState }) {
  const [closed, setClosed] = useState(false);
  const carried = useChat((s) => s.carried);
  const inFlight = useChat((s) => s.inFlight);
  const allowance = useSettings((s) => agentSettings(s.settings).maxRevisionsPerTurn);
  if (closed || turn.stopReason !== "revision_limit") return null;
  const changes = (carried?.changes ?? 0) + turn.newVersions.length;
  const cost = addCosts(carried?.cost, turn.turnCost);
  return (
    <div className="msg-ai">
      <span aria-hidden="true" />
      <div className="card limitcard" role="status" aria-label="Claude is waiting for you">
        <div className="upd__h">
          <Icon name="info" className="limitcard__icon" />
          <span className="upd__t">
            Claude has changed the map {timesWord(changes)} for this message and wants to keep going.
          </span>
        </div>
        <p className="limitcard__body">
          {cost !== null && `This message has cost about ${money(cost.amount)} so far. `}
          Every change so far is kept.
        </p>
        <div className="card-actions">
          <button
            className="btn btn--sm"
            disabled={inFlight}
            onClick={() => void useChat.getState().continueTurn(allowance)}
          >
            Keep going (up to {allowance} more change{allowance === 1 ? "" : "s"})
          </button>
          <button
            className="btn btn--sm"
            onClick={() => {
              setClosed(true);
              useChat.getState().focusComposer();
            }}
          >
            That&apos;s enough
          </button>
          <button
            className="btn btn--sm btn--link limitcard__settings"
            onClick={() => {
              useApp.getState().openSettings("ai");
            }}
          >
            Change how many…
          </button>
        </div>
      </div>
    </div>
  );
}
