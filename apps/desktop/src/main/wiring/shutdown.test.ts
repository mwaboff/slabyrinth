import { describe, expect, it } from "vitest";
import { memoryLogger } from "../logger";
import { runShutdown } from "./shutdown";

const never = (): Promise<never> => new Promise<never>(() => undefined);

describe("the quit sequence", () => {
  it("saves first, then runs every other step even when one never finishes or throws", async () => {
    const order: string[] = [];
    const t0 = Date.now();
    await runShutdown({
      halt: [() => order.push("halt")],
      save: async () => {
        order.push("save");
        await Promise.resolve();
      },
      releaseLock: () => order.push("releaseLock"),
      steps: [
        {
          name: "link with a socket left open",
          run: () => {
            order.push("link");
            return never();
          },
        },
        {
          name: "engine",
          run: () => {
            order.push("engine");
            throw new Error("boom");
          },
        },
        { name: "none", run: () => undefined },
      ],
      logger: memoryLogger(),
      stepLimitMs: 100,
    });
    expect(order).toEqual(["halt", "save", "link", "engine"]);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("a save that fails or hangs releases the project lock and the quit goes on", async () => {
    for (const save of [() => Promise.reject(new Error("disk full")), never]) {
      const order: string[] = [];
      await runShutdown({
        halt: [],
        save,
        releaseLock: () => order.push("releaseLock"),
        steps: [{ name: "after", run: () => void order.push("after") }],
        logger: memoryLogger(),
        saveLimitMs: 100,
      });
      expect(order).toEqual(["releaseLock", "after"]);
    }
  });
});
