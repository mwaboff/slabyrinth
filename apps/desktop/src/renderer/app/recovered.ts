/**
 * After main reloaded the window because its renderer died (main/wiring/rendererRecovery.ts adds `?recovered=`), say
 * so in plain words once. Project state lives in main, so nothing was lost.
 */
export function recoveredMessage(search: string): { lead: string; body: string } | null {
  const why = new URLSearchParams(search).get("recovered");
  if (why === "oom")
    return {
      lead: "Slabyrinth ran out of memory showing this map, so it reopened the window.",
      body: "Your work is saved. For maps this big, close other programs, or use a smaller Maximum map size in Settings for new maps.",
    };
  if (why === "crash")
    return {
      lead: "Slabyrinth's window stopped unexpectedly, so it reopened.",
      body: "Your work is saved.",
    };
  return null;
}

/** Shows the message once and takes the flag out of the address, so a later reload doesn't repeat it. */
export function announceRecovery(
  toast: (t: { lead: string; body: string; tone: "warn"; ms: number }) => void,
): void {
  const msg = recoveredMessage(window.location.search);
  if (!msg) return;
  toast({ ...msg, tone: "warn", ms: 20_000 });
  const url = new URL(window.location.href);
  url.searchParams.delete("recovered");
  window.history.replaceState(null, "", url.href);
}
