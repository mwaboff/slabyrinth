import { randomUUID } from "node:crypto";
import type { IpcSends } from "../../shared/ipc";
import type { ImageRequest } from "../ports/engine";
import { AppFailure } from "../util/errors";
import type { EmitEvent } from "./events";

/**
 * Image bridge (architecture §5.5 step 4): main asks the renderer to rasterize a level with the
 * same drawDisplayList routine as the screen (event render:requestImage); the renderer replies
 * with a one-way render:imageResult. Used by the engine's view_map_image and for Home thumbnails.
 */
interface Pending {
  resolve: (png: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const PNG_MAGIC = "iVBORw0KGgo"; // base64 of \x89PNG\r\n\x1a\n

export class ImageBridge {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly emit: EmitEvent,
    private readonly timeoutMs = 20_000,
  ) {}

  request(req: ImageRequest, signal?: AbortSignal): Promise<string> {
    const requestId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const done = (): void => {
        const p = this.pending.get(requestId);
        if (p) clearTimeout(p.timer);
        this.pending.delete(requestId);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        done();
        reject(new AppFailure("cancelled", "Image request cancelled."));
      };
      if (signal?.aborted === true) {
        reject(new AppFailure("cancelled", "Image request cancelled."));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        done();
        reject(new AppFailure("internal", "The map image wasn't rendered in time."));
      }, this.timeoutMs);
      this.pending.set(requestId, {
        resolve: (png) => {
          done();
          resolve(png);
        },
        reject: (err) => {
          done();
          reject(err);
        },
        timer,
      });
      this.emit("render:requestImage", { requestId, ...req });
    });
  }

  /** Called with an already-validated render:imageResult payload. Unknown ids are ignored. */
  handleResult(result: IpcSends["render:imageResult"]): void {
    const p = this.pending.get(result.requestId);
    if (!p) return;
    if (result.ok) {
      if (!result.pngBase64.startsWith(PNG_MAGIC))
        p.reject(new AppFailure("validation", "The renderer returned something that isn't a PNG."));
      else p.resolve(result.pngBase64);
    } else {
      p.reject(
        new AppFailure("internal", `The map image couldn't be rendered: ${result.error.slice(0, 200)}`),
      );
    }
  }

  cancelAll(): void {
    for (const [, p] of this.pending) p.reject(new AppFailure("cancelled", "Image request cancelled."));
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
