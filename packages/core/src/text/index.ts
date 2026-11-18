/**
 * WP2 text views for the model (architecture §3.3): outline, ASCII (double resolution), changed-region ASCII.
 * Pure TypeScript: no electron, DOM or node:* imports here.
 */
export { outlineView, formatShape, formatOpeningEdge, truncate, type OutlineOptions } from "./outline";
export { asciiView, asciiLevel, OPENING_CHAR, type AsciiOptions } from "./ascii";
export {
  changedBBox,
  changedRegionViews,
  type ChangedView,
  type ChangedViewOptions,
  type CellRect,
} from "./changed";
