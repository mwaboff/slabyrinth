/**
 * resolve.worker (architecture §6.1): core resolvePlan + buildDisplayList per (plan, version, options),
 * off the UI thread. The same compute() runs in-thread where Worker is unavailable (jsdom tests).
 */
import { compute, type ResolveRequest } from "../map/resolveCore";

self.onmessage = (ev: MessageEvent<ResolveRequest>) => {
  const req = ev.data;
  try {
    const result = compute(req);
    self.postMessage({ id: req.id, ok: true, result });
  } catch (e) {
    self.postMessage({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
