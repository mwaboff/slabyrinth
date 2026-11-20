import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ChatEvent } from "../../../shared/ipc";
import { chatReducer, emptyChat, type TurnState } from "../../stores/chatReducer";
import { useChat } from "../../stores/chat";
import { useProject } from "../../stores/project";
import { RunAnnouncer, WorkingCard } from "./WorkingCard";
import { headline, runAnnouncement, runPhase, stepLine, verb } from "./activity";

const sel = { providerId: "anthropic", modelId: "m", effort: null };
const started: ChatEvent = { type: "turn_started", turnId: "t1", selection: sel };
const planCall: ChatEvent = {
  type: "tool_call_started",
  turnId: "t1",
  step: 0,
  callId: "c1",
  name: "edit_plan",
};
const viewCall: ChatEvent = {
  type: "tool_call_started",
  turnId: "t1",
  step: 0,
  callId: "v",
  name: "view_plan",
};

function play(events: ChatEvent[]) {
  let state = emptyChat();
  for (const e of events) state = chatReducer(state, e, Date.now());
  return state;
}
function liveOf(events: ChatEvent[]): TurnState {
  const live = play(events).live;
  if (live === null) throw new Error("no live turn");
  return live;
}
function setHead(head: number): void {
  useProject.setState({ snap: { head } as never });
}

afterEach(() => {
  cleanup();
  useChat.setState({ live: null, last: null });
});

describe("activity", () => {
  it("is idle with no run, thinking until a plan tool starts, then writing", () => {
    expect(runPhase(null)).toBe("idle");
    expect(runPhase(liveOf([started]))).toBe("thinking");
    expect(runPhase(liveOf([started, planCall]))).toBe("writing");
  });

  it("words the headline for a revision and for the first plan", () => {
    expect(headline("thinking", 3, 0)).toBe("Working on plan v3");
    expect(headline("writing", 3, 0)).toBe("Revising plan v3 → v4");
    // the new version has already landed: head moved to 4
    expect(headline("writing", 4, 1)).toBe("Revising plan v3 → v4");
    expect(headline("writing", 0, 0)).toBe("Drawing the first plan");
    expect(verb("writing", 0)).toBe("Drawing");
    expect(verb("writing", 3)).toBe("Revising");
    expect(verb("thinking", 3)).toBe("Working");
  });

  it("describes the newest step: progress label, open tools, reply text, then a fallback", () => {
    expect(stepLine(liveOf([started]))).toBe("Starting");
    expect(stepLine(liveOf([started, viewCall]))).toBe("Reading the plan");
    expect(stepLine(liveOf([started, planCall]))).toBe("Applying changes to the plan");
    expect(
      stepLine(
        liveOf([
          started,
          planCall,
          { type: "progress", turnId: "t1", step: "furnishing", label: "Furnishing" },
        ]),
      ),
    ).toBe("Furnishing");
    expect(stepLine(liveOf([started, { type: "text_delta", turnId: "t1", step: 0, text: "Hi" }]))).toBe(
      "Writing a reply",
    );
  });

  it("announces the start and how the run ended", () => {
    expect(runAnnouncement("writing", null, 3, true)).toBe("Slabyrinth is working on plan v3.");
    expect(runAnnouncement("idle", { status: "stopped" }, 3, true)).toBe("Stopped.");
    expect(runAnnouncement("idle", { status: "failed" }, 3, true)).toMatch(/failed/);
    expect(runAnnouncement("idle", { status: "finished" }, 4, true)).toMatch(/plan v4/);
    expect(runAnnouncement("idle", null, 4, false)).toBe("");
  });
});

describe("WorkingCard", () => {
  it("shows the headline, the live step and the elapsed time with a labelled Stop", () => {
    setHead(3);
    const live = liveOf([
      started,
      planCall,
      { type: "progress", turnId: "t1", step: "placing_openings", label: "Placing doors and stairs" },
    ]);
    render(<WorkingCard turn={live} />);
    expect(screen.getByText("Revising plan v3 → v4")).toBeInTheDocument();
    expect(screen.getByText("Placing doors and stairs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Running for/)).toBeInTheDocument();
  });

  it("words a first plan differently", () => {
    setHead(0);
    render(<WorkingCard turn={liveOf([started, planCall])} />);
    expect(screen.getByText("Drawing the first plan")).toBeInTheDocument();
  });
});

describe("RunAnnouncer", () => {
  it("says when a run starts and ends, and says Stopped for a stopped run", () => {
    setHead(3);
    render(<RunAnnouncer />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveTextContent("");
    act(() => {
      useChat.setState({ ...play([started]) });
    });
    expect(region).toHaveTextContent("Slabyrinth is working on plan v3.");
    act(() => {
      useChat.setState({
        ...chatReducer(useChat.getState(), {
          type: "turn_finished",
          turnId: "t1",
          stopReason: "cancelled",
          canRetry: true,
          canContinue: false,
        }),
      });
    });
    expect(region).toHaveTextContent("Stopped.");
  });
});
