/**
 * The runs the generator-5 golden pins, and where its files are. Shared by generator5.test.ts (which only reads the
 * golden) and update.ts (the one thing that writes it); the record each run is reduced to is ../goldenRecord.ts. See
 * the header of generator5.test.ts.
 */
import type { GeneratorVersion } from "../../../src/contracts/plan";
import {
  changesBuild,
  lineGenerator,
  readDetailFile,
  readGoldenFile,
  storedRuns,
  type Run,
} from "../goldenRecord";

/** The newest generator: the one this golden follows while it is open (see the header of generator5.test.ts). */
export const OPEN_GENERATOR: GeneratorVersion = 5;
/**
 * The newest released generator: runs at it or below have frozen builds (FROZEN_FIELDS in ../goldenRecord.ts), which
 * the test reports as frozen and the update script refuses to rewrite.
 */
export const RELEASED_GENERATOR = 4;

export const GOLDEN_FILE = new URL("__golden__/generator5.txt", import.meta.url);
/** The readable sidecar: what each run built, one fact per line, each line starting with the run's name. */
export const DETAIL_FILE = new URL("__golden__/generator5.detail.txt", import.meta.url);

/**
 * The quality meter's baseline (src/review/qualityMetrics.ts): every metric of every run at the open generator, one
 * `<run> <metric> <value>` line each, so a package that changes how generator 5 builds shows what it moved as a diff.
 */
export const QUALITY_FILE = new URL("__golden__/generator5.quality.txt", import.meta.url);

/** Every stored plan at its own generator, and every plan of a released generator forced to the open one too. */
export const goldenRuns = (): Run[] => storedRuns(OPEN_GENERATOR);

/** Does the run build at the open generator (so its quality meter is in the baseline)? */
export const metered = (run: Run): boolean => run.plan.generator === OPEN_GENERATOR;

/** The committed quality lines, by run name. */
export const readQuality = (): Map<string, string[]> => readDetailFile(QUALITY_FILE);

/** The committed golden lines, by run name (empty when the file does not exist yet). */
export const readGolden = (): Map<string, string> => readGoldenFile(GOLDEN_FILE);

/** The committed detail lines, by run name. */
export const readDetail = (): Map<string, string[]> => readDetailFile(DETAIL_FILE);

/** True when the run is at a released generator and a field of its frozen output differs. */
export const changesReleasedOutput = (was: string, now: string): boolean =>
  lineGenerator(was) <= RELEASED_GENERATOR && changesBuild(was, now);
