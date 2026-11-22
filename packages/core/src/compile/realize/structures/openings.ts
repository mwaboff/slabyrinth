/**
 * Realize, a building's openings by storey face: which face cells of which storey each ground opening (the level's
 * openings, ids in `ResolvedStructure.openingIds`) and each upper opening takes. The walk is resolve/structureFaces.ts,
 * shared with the detail anchors (resolve/anchors/), so the recipes frame the openings the courses build.
 */
export {
  GROUND_FACES,
  openingFace,
  openingsByStorey,
  storeyFaces,
  type StoreyOpening,
} from "../../../resolve/structureFaces";
