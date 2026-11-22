/**
 * Builders for the small plans tests write inline: one level at the origin, everything a level needs set to empty, so
 * a test states only what it is about (the generator, the board size, the areas or structures).
 *
 *   townPlan({ generator: 3, w: 30, h: 30, structures: [cottage] })     a ground level with one zone over the board
 *   dungeonPlan({ generator: 4, w: 16, h: 13, areas, openings })        a solid level the areas are carved from
 *   oneLevelPlan({ ... })                                                any other one-level plan
 */
import type {
  Area,
  GeneratorVersion,
  Level,
  LevelLink,
  MapKind,
  MapPlan,
  Opening,
  Structure,
} from "../../src/contracts/plan";

export interface OneLevelSpec {
  generator: GeneratorVersion;
  /** Board size; the level's bounds start at (0, 0). */
  w: number;
  h: number;
  /** Plan id; also the title unless `title` is given. */
  id?: string;
  title?: string;
  kind?: MapKind;
  seed?: number;
  theme?: string;
  summary?: string;
  links?: LevelLink[];
  /** Level id; also its name unless the level fields name it. */
  levelId?: string;
  /** Ground (grass) unless given. */
  base?: Level["base"];
  /** Any other level fields (areas, features, terrain, structures, elevation...). */
  level?: Partial<Level>;
}

/** A plan of one level at the origin, with every list the level does not set empty. */
export function oneLevelPlan(spec: OneLevelSpec): MapPlan {
  const id = spec.id ?? "test";
  const levelId = spec.levelId ?? "g";
  return {
    schema: "slabyrinth/plan@1",
    generator: spec.generator,
    id,
    title: spec.title ?? id,
    kind: spec.kind ?? "outdoor",
    seed: spec.seed ?? 1,
    theme: spec.theme ?? "outdoor",
    ...(spec.summary === undefined ? {} : { summary: spec.summary }),
    links: spec.links ?? [],
    levels: [
      {
        id: levelId,
        name: levelId,
        elevation: 0,
        bounds: { x: 0, y: 0, w: spec.w, h: spec.h },
        base: spec.base ?? { type: "ground", material: "grass" },
        areas: [],
        openings: [],
        walls: [],
        features: [],
        terrain: [],
        labels: [],
        ...spec.level,
      },
    ],
  };
}

export interface TownSpec extends OneLevelSpec {
  /** The buildings and enclosures on the level. */
  structures?: Structure[];
  /** Id of the zone that covers the whole board ("lot" unless given). */
  lot?: string;
}

/** A ground level (grass unless `base` says otherwise) with one zone over the whole board, and its structures. */
export function townPlan(spec: TownSpec): MapPlan {
  const { structures = [], lot = "lot", level, ...rest } = spec;
  return oneLevelPlan({
    ...rest,
    level: {
      areas: [{ id: lot, kind: "zone", shape: { type: "rect", x: 0, y: 0, w: spec.w, h: spec.h } }],
      structures,
      ...level,
    },
  });
}

export interface DungeonSpec extends OneLevelSpec {
  areas: Area[];
  openings?: Opening[];
}

/** A solid level the areas are carved from (kind "dungeon", theme stone_dungeon unless given). */
export function dungeonPlan(spec: DungeonSpec): MapPlan {
  const { areas, openings = [], level, ...rest } = spec;
  return oneLevelPlan({
    kind: "dungeon",
    theme: "stone_dungeon",
    base: { type: "solid" },
    ...rest,
    level: { areas, openings, ...level },
  });
}
