/**
 * WP2 2D model: buildDisplayList, pure hitTest / selection, symbol catalogue, legend entries.
 * No drawing here (drawing lives in @slabyrinth/render-canvas). Pure TypeScript: no electron, DOM or node:*.
 */
export {
  buildDisplayList,
  buildPlanDisplayList,
  contentViewBox,
  levelLabels,
  levelTabOrder,
  LAYER_ORDER,
  DEFAULT_DISPLAY_OPTIONS,
  type DisplayContext,
} from "./displayList";
export { hitTest, selectRect, selectionItems, type HitContext } from "./hitTest";
export { SYMBOLS, symbolInfo, type SymbolInfo } from "./symbols";
export { legendEntries, type LegendEntry } from "./legend";
