/** Design review (advice for the model, never errors): see review.ts. */
export {
  type DesignNote,
  type DesignNoteCode,
  type ReviewOptions,
  type CliffCoverage,
  designReviewDelta,
  designReviewText,
  noteKey,
  reviewDesign,
  substitutionNotes,
} from "./review";
export { BRIEF_WORDS, briefCheckLine, briefNotes, briefWords } from "./brief";
export { NATURAL_FEATURES, NATURAL_MATERIALS, REVIEW } from "./thresholds";
export {
  boxFill,
  components,
  longestInnerStraight,
  longestStraight,
  outline,
  squareCorners,
} from "./metrics";
