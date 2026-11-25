/**
 * The model's 3D pictures in the conversation: what one costs (an estimate) and how long it is kept.
 *
 * Cost. A picture is one 1024 × 768 PNG sheet (shared/view3dPictures.ts SHEET_SIZE). Anthropic documents image input
 * as about width × height / 750 tokens for an image within the model's size limit (1,568 px on the long edge before
 * Opus 4.7 and Sonnet 5, 2,576 px from them; a sheet is under both, so it is never scaled): ≈ 1,049 input tokens per
 * sheet. This is an ESTIMATE for the pre-send cost line; what is billed and shown as spent is the usage the API
 * reports for each step, which already includes the pictures.
 *
 * Keeping. A picture is useful while it shows the head version. Once the head moves on (a newer version, or an undo),
 * a picture of another version is replaced in the transcript by its captions and findings (core `withoutPicture`), so pictures never pile up for the
 * life of a conversation. Editing an earlier transcript item changes the request prefix from that item on: the
 * prompt cache from there is written again (about 1.25× instead of 0.1× for that tail, once) and preserved thinking
 * after it is dropped by the API (the request sends `drop_block`). So the trim runs only at the start of a message,
 * never mid-turn, and only when it costs nothing extra or the stale pictures pile up:
 *  - the conversation's cache has gone cold (no request for CACHE_COLD_MS; after a restart it is always cold): every
 *    stale picture goes;
 *  - otherwise, while it is warm, at most KEEP_STALE_WARM stale pictures stay; beyond that the oldest go.
 */
import { pictureVersionOf, withoutPicture } from "@slabyrinth/core/agent";
import type { ChatItem } from "./provider/types";

/** The sheet's size (shared/view3dPictures.ts SHEET_SIZE; kept here so main's engine does not import the renderer's). */
export const SHEET_PX = { width: 1024, height: 768 } as const;

/** Estimated input tokens of an image (Anthropic's documented rule: width × height / 750, within the size limit). */
export function imageTokens(width: number, height: number): number {
  return Math.ceil((width * height) / 750);
}

/** Estimated input tokens of one 3D picture (≈ 1,049). */
export const SHEET_TOKENS = imageTokens(SHEET_PX.width, SHEET_PX.height);

/** The prompt cache counts as cold after this long without a request (the shorter of the two TTLs the app uses). */
export const CACHE_COLD_MS = 5 * 60 * 1000;
/** Stale pictures kept while the cache is warm. */
export const KEEP_STALE_WARM = 4;

/** A picture in the transcript: where it is and the version it shows. */
interface PictureAt {
  item: number;
  result: number;
  version: number;
}

function picturesIn(items: readonly ChatItem[]): PictureAt[] {
  const out: PictureAt[] = [];
  items.forEach((it, item) => {
    if (it.type !== "tool_results") return;
    it.results.forEach((r, result) => {
      if (!r.content.some((c) => c.type === "image")) return;
      const version = pictureVersionOf(r.content);
      if (version !== null) out.push({ item, result, version });
    });
  });
  return out;
}

/**
 * Whether the transcript still holds a picture of another version than `head`: an older one, or after an undo a newer
 * one the plan has moved back from (stale either way: it no longer shows the map).
 */
export function hasStalePictures(items: readonly ChatItem[], head: number): boolean {
  return picturesIn(items).some((p) => p.version !== head);
}

/**
 * Replaces, in place, the stale 3D pictures that should go (see the file comment); returns how many went. `items` is
 * the conversation's own list (call it inside the host's updateConversation).
 */
export function trimStalePictures(items: ChatItem[], head: number, cacheCold: boolean): number {
  const stale = picturesIn(items).filter((p) => p.version !== head);
  const drop = cacheCold ? stale : stale.slice(0, Math.max(0, stale.length - KEEP_STALE_WARM));
  for (const p of drop) {
    const it = items[p.item];
    if (it?.type !== "tool_results") continue;
    const r = it.results[p.result];
    if (!r) continue;
    it.results[p.result] = { ...r, content: withoutPicture(r.content) };
  }
  return drop.length;
}

/** The conversation has already had its first draft (a create_plan call that was applied). */
export function hadFirstDraft(items: readonly ChatItem[]): boolean {
  return items.some(
    (it) => it.type === "tool_results" && it.results.some((r) => r.name === "create_plan" && !r.isError),
  );
}
