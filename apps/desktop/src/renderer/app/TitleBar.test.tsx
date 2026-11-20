import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectSnapshot } from "../../shared/ipc";
import { useProject } from "../stores/project";
import { renameProject } from "./actions";
import { ProjectName } from "./TitleBar";

vi.mock("./actions", () => ({ renameProject: vi.fn(() => Promise.resolve()) }));

const OLD = "Hearthfather Fight";

function openEditor() {
  render(<ProjectName />);
  return screen.getByRole("button", { name: OLD });
}

beforeEach(() => {
  useProject.setState({ snap: { name: OLD } as unknown as ProjectSnapshot });
  vi.mocked(renameProject).mockClear();
});

afterEach(() => {
  useProject.setState({ snap: null });
});

describe("ProjectName", () => {
  it("blur saves a changed name", async () => {
    await userEvent.click(openEditor());
    const input = screen.getByRole("textbox", { name: "Project name" });
    await userEvent.clear(input);
    await userEvent.type(input, "Ash Crown");
    await userEvent.click(document.body);
    expect(renameProject).toHaveBeenCalledTimes(1);
    expect(renameProject).toHaveBeenCalledWith("Ash Crown");
    expect(screen.queryByRole("textbox", { name: "Project name" })).toBeNull();
  });

  it("Enter saves once and leaves edit mode", async () => {
    await userEvent.click(openEditor());
    const input = screen.getByRole("textbox", { name: "Project name" });
    await userEvent.clear(input);
    await userEvent.type(input, "Ash Crown{Enter}");
    expect(renameProject).toHaveBeenCalledTimes(1);
    expect(renameProject).toHaveBeenCalledWith("Ash Crown");
    expect(screen.queryByRole("textbox", { name: "Project name" })).toBeNull();
  });

  it("Escape cancels: restores the old name and does not save", async () => {
    await userEvent.click(openEditor());
    const input = screen.getByRole("textbox", { name: "Project name" });
    await userEvent.clear(input);
    await userEvent.type(input, "Ash Crown{Escape}");
    expect(renameProject).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Project name" })).toBeNull();
    expect(screen.getByRole("button", { name: OLD })).toBeInTheDocument();
  });

  it("blur with unchanged text does nothing", async () => {
    await userEvent.click(openEditor());
    await userEvent.click(document.body);
    expect(renameProject).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: OLD })).toBeInTheDocument();
  });

  it("blur with empty or whitespace-only text restores the old name", async () => {
    await userEvent.click(openEditor());
    const input = screen.getByRole("textbox", { name: "Project name" });
    await userEvent.clear(input);
    await userEvent.type(input, "   ");
    await userEvent.click(document.body);
    expect(renameProject).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: OLD })).toBeInTheDocument();
  });
});
