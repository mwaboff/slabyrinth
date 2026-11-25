import { createRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Scene } from "@slabyrinth/scene3d";
import { View3dCanvas } from "./View3dCanvas";
import { memorySceneSource } from "./memorySceneSource";
import { syntheticTown } from "./synthetic";
import { fakeBackend } from "./engine/fakeBackend";
import type { View3dApi, View3dState } from "./engine/engine";

let town: Scene;
beforeAll(async () => {
  town = await syntheticTown({ side: 64 });
});

describe("View3dCanvas", () => {
  it("says plainly when WebGL2 is not available (and hides the canvas)", () => {
    // jsdom has no WebGL
    const spy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const onError = vi.fn();
    render(<View3dCanvas source={memorySceneSource(new Map())} buildId="b" onError={onError} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/graphics acceleration/);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "no-webgl2" }));
    expect(screen.queryByRole("application")).toBeNull();
    spy.mockRestore();
  });

  it("is a focusable, named canvas whose ref is the viewer API", async () => {
    const ref = createRef<View3dApi | null>();
    const states: View3dState["kind"][] = [];
    render(
      <View3dCanvas
        ref={ref}
        source={memorySceneSource(new Map([["b1", town]]))}
        buildId="b1"
        createBackend={() => fakeBackend()}
        onState={(s) => states.push(s.kind)}
      />,
    );
    const canvas = screen.getByRole("application", { name: "3D view of the map" });
    expect(canvas.tabIndex).toBe(0);
    canvas.focus();
    expect(document.activeElement).toBe(canvas);
    await waitFor(() => {
      expect(states).toContain("ready");
    });
    expect(ref.current?.header?.chunks.length).toBeGreaterThan(0);
    expect(typeof ref.current?.frameAll).toBe("function");
  });

  it("reports a source failure as text", async () => {
    render(
      <View3dCanvas
        source={memorySceneSource(new Map())}
        buildId="missing"
        createBackend={() => fakeBackend()}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/no 3D scene/);
  });
});
