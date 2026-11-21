/**
 * Everything one level holds while it resolves: the grid every stage works on, and the records the stages leave for
 * each other, each owned by the one module that writes it.
 *
 * The ownership rule: a record is written only by its owner module; resolve/level.ts hands the owner the record itself
 * and every other stage `ReadOnly<record>` (resolve/level/grid.ts), so the compiler refuses a write from anyone else.
 * A hand-off used only by the next stage is not stored here at all: the stage returns it and resolve/level.ts passes
 * it on (the routes, the cells the under-layer terrain touched). The grid's cell and edge arrays are the one thing every
 * stage writes; the stage order in resolve/level.ts is what makes a cell final.
 *
 *   record          owner (writes)                                        read by
 *   chasms          chasms.ts (terrain op)                                bridges, feature placement, output
 *   relief          relief.ts (terrain ops)                               feature placement, output
 *   paths           terrain.ts queues path ops; paths.ts finishes them    outline, features, market, output
 *   floorOpenings   floorOpenings.ts (op, rims, link to the level below)  rooms, output
 *   bridges         bridges.ts (bridge pass)                              edges, railings, rubble, output
 *   openings        openings.ts                                           rooms, market, output
 *   features        features.ts FeatureWork (every phase-2 stage adds)    output
 *   lines           market.ts                                             output
 */
import type { ResolvedLine, ResolvedOpening } from "../../contracts/resolved";
import { BridgeRecords } from "./bridges";
import { ChasmRecords } from "./chasms";
import { FeatureWork } from "./features";
import { FloorOpeningRecords } from "./floorOpenings";
import { type LevelContext, ResolveGrid } from "./grid";
import { PathRecords } from "./paths";
import { ReliefRecords } from "./relief";

export class ResolveLevelState {
  /** Cells, edges and areas: written by every stage in its turn (resolve/level/grid.ts). */
  readonly grid: ResolveGrid;
  readonly chasms = new ChasmRecords();
  readonly relief = new ReliefRecords();
  readonly paths = new PathRecords();
  readonly floorOpenings = new FloorOpeningRecords();
  readonly bridges: BridgeRecords;
  /** The level's openings (one ResolvedOpening each), placed by resolve/level/openings.ts. */
  readonly openings: ResolvedOpening[] = [];
  readonly features: FeatureWork;
  /** Overhead lines that found both anchors (ResolvedLevel.lines), placed by resolve/level/market.ts. */
  readonly lines: ResolvedLine[] = [];

  constructor(ctx: LevelContext) {
    this.grid = new ResolveGrid(ctx);
    this.bridges = new BridgeRecords(this.grid.n);
    this.features = new FeatureWork(this.grid, {
      paths: this.paths,
      relief: this.relief,
      chasms: this.chasms,
    });
  }
}
