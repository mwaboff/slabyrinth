/**
 * @slabyrinth/core public entry.
 *
 * Re-exports the type contracts (verbatim copies of docs/contracts/*.ts; changes go
 * through the lead). Work packages add their own public exports below their marker.
 * Deep imports are also available: "@slabyrinth/core/contracts/plan",
 * "@slabyrinth/core/agent/tools", "@slabyrinth/core/<module>" (module index.ts).
 */
export * from "./contracts/plan";
export * from "./contracts/ops";
export * from "./contracts/resolved";
export * from "./contracts/compiler";

// WP1 exports (plan, ops, history, util).
export * from "./plan";
export * from "./ops";
export * from "./history";
export * from "./util";
// WP2 exports (resolve, gen, render, text).
export * from "./resolve";
export * from "./gen";
export * from "./render";
export * from "./text";
// WP3 exports (slab, palette, catalog, compile).
export * from "./slab";
export * from "./palette";
export * from "./catalog";
export * from "./compile";
// Design review (advice for the model).
export { type DesignNote, type DesignNoteCode, REVIEW, designReviewText, reviewDesign } from "./review";
// WP4 exports (agent; includes the tools contract).
export * from "./agent";
