import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Area } from "@slabyrinth/core";
import type { Result, SlabyrinthApi } from "../../../shared/ipc";
import { setBridge } from "../../bridge/client";
import { RoomEditor, changedFields } from "./RoomKey";

const hall: Area = {
  id: "hall",
  kind: "room",
  name: "Hall of Pillars",
  key: "2",
  shape: { type: "rect", x: 8, y: 6, w: 16, h: 8 },
  notes: "Eight pillars.",
  readAloud: "Water drips.",
};

describe("changedFields", () => {
  it("sends only the fields that changed, trimmed; empty optional fields become null", () => {
    expect(
      changedFields(hall, {
        name: "Hall of Pillars",
        readAloud: "Water drips.",
        notes: "Eight pillars.",
        encounter: "",
      }),
    ).toEqual({});
    expect(
      changedFields(hall, {
        name: " Great Hall ",
        readAloud: "",
        notes: "Eight pillars. And a boss.",
        encounter: "3× Skeleton",
      }),
    ).toEqual({
      name: "Great Hall",
      readAloud: null,
      notes: "Eight pillars. And a boss.",
      encounter: "3× Skeleton",
    });
  });
  it("never clears a name", () => {
    expect(
      changedFields(hall, { name: "  ", readAloud: "Water drips.", notes: "Eight pillars.", encounter: "" }),
    ).toEqual({});
  });
});

describe("RoomEditor", () => {
  let invoke: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    invoke = vi.fn((): Promise<Result<unknown>> => Promise.resolve({ ok: true, value: { head: 5 } }));
    const api = { invoke, on: () => () => undefined, send: () => undefined } as unknown as SlabyrinthApi;
    setBridge(api);
  });

  it("saves edits with Ctrl+Enter through plan:editText (one version per edit)", async () => {
    const done = vi.fn();
    render(<RoomEditor area={hall} onDone={done} />);
    const name = screen.getByRole("textbox", { name: "Name" });
    expect(name).toHaveFocus();
    await userEvent.clear(name);
    await userEvent.type(name, "Great Hall");
    const notes = screen.getByRole("textbox", { name: "GM notes" });
    await userEvent.type(notes, " The boss waits here.");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(invoke).toHaveBeenCalledWith("plan:editText", {
      id: "hall",
      set: { name: "Great Hall", notes: "Eight pillars. The boss waits here." },
    });
    await vi.waitFor(() => {
      expect(done).toHaveBeenCalled();
    });
  });

  it("cancels with Escape without saving", async () => {
    const done = vi.fn();
    render(<RoomEditor area={hall} onDone={done} />);
    await userEvent.type(screen.getByRole("textbox", { name: "GM notes" }), " changed");
    await userEvent.keyboard("{Escape}");
    expect(done).toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("closes without a call when nothing changed", async () => {
    const done = vi.fn();
    render(<RoomEditor area={hall} onDone={done} />);
    await userEvent.click(screen.getByRole("button", { name: /Save/ }));
    expect(invoke).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalled();
  });
});
