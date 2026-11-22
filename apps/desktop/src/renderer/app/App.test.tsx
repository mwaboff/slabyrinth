import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App";

// Boots against the fake bridge (no window.slabyrinth in jsdom) and lands on Home with the fixture projects.
describe("App", () => {
  it("boots on Home, following the system theme (dark in jsdom), and reports ready", async () => {
    render(<App />);
    expect(await screen.findByRole("region", { name: "Continue" }, { timeout: 6000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue/ })).toBeInTheDocument();
    expect(await screen.findByText("The Drowned Abbey")).toBeInTheDocument();
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(document.documentElement.dataset["slabyrinthReady"]).toBe("true");
  });
});
