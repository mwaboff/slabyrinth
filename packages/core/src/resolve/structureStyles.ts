/**
 * Building style profiles (data, 2026-11-20). A profile holds the rules a kind of building follows — wall courses,
 * storey height, window rhythm, roof strategy and kit, door lights — and the palette roles (facade.<style>,
 * roof.<kit>.*, chimney.*, wall_light.*…) supply the assets. A new kind of building is a new entry here plus palette
 * roles; the resolver and compiler read only these fields. Every field can be overridden per building in the plan.
 */
import type { Material, RoofType, WallStyle } from "../contracts/plan";
import type { DesignSpace } from "./structureVariety";

export type WindowDensity = "none" | "sparse" | "regular" | "dense";

export interface StructureStyleProfile {
  id: string;
  /** One line for the prompt / tool descriptions. */
  summary: string;
  /** Ground-storey wall style and the style of the storeys above. */
  walls: WallStyle;
  upperWalls: WallStyle;
  /** Lower course of the ground storey (a stone footing under timber); null = none. */
  footing: WallStyle | null;
  /** Height of the footing course (tiles). */
  footingHeight: number;
  /** Main wall course per storey, above the floor top and footing (tiles). Floors stack on the wall top. */
  wallHeight: number;
  floor: Material;
  roof: {
    type: RoofType;
    /** Roof kit: palette roles roof.<kit>.* */
    kit: string;
    /** Attic deck on the top storey's walls; the pitched roof sits on its top. */
    deck: boolean;
    /** Flat roofs: parapet wall style, null = none. */
    parapet: WallStyle | null;
    /** Fraction of roof pieces built broken (ruins). */
    broken: number;
  };
  windows: { width: 1 | 2 };
  /**
   * Ranges the per-building seed draws from when the plan leaves a choice open, so two buildings of one style differ.
   */
  variety: {
    windowDensities: readonly WindowDensity[];
    porchChance: number;
    chimneyChance: number;
    /** Door position along its face (0..1). */
    doorPosition: readonly [number, number];
  };
  /** A wall light beside every outside door. */
  doorLight: boolean;
  // ── phase 2 (all optional; absent = the phase-1 behaviour) ──
  /** Wall height of storeys above the ground: a fixed height or a range drawn per storey (multiples of 0.5). */
  upperWallHeight?: number | readonly [number, number];
  /** Walls of the top storey when it differs (material by height: a timber chamber on a stone tower). */
  crownWalls?: WallStyle;
  corners?: "square" | "chamfer";
  /** Seam over the ring a set-in storey leaves, by weight. */
  seams?: Partial<Record<"skirt" | "plain" | "crenellated", number>>;
  /** Storeys above the ground step in by one cell with this chance while the storey stays at least minWidth. */
  setIn?: { chance: number; minWidth: number };
  /** Roof layers stacked after the first (e.g. a spire on a skirt) and the spire shape. */
  roofLayers?: ReadonlyArray<{ type: RoofType; courses?: number; kit?: string }>;
  spire?: { taper: number; courseHeight: number; bands: readonly [number, number] };
  /** Roof furniture slots: chances and ranges drawn by the seed. */
  furniture?: {
    dormers: number;
    clutter: readonly [number, number];
    mast: number;
    finial: boolean;
    hut?: number;
  };
  /** Light anchors: lit windows (warm room light or a coloured glow) with a lit fraction range, entrance strips. */
  lighting?: {
    windows: "none" | "warm" | "glow";
    lit: readonly [number, number];
    colours: readonly string[];
    strips: number;
  };
  // ── street variety (drawn on a third stream; absent = no draw) ──
  /** Storey count when the plan gives none: a range drawn per volume. */
  storeyCount?: readonly [number, number];
  /** Wall material variants: one is drawn per building for every storey (brick or concrete for a city block). */
  wallVariants?: readonly WallStyle[];
  /** Parapet variants for flat roofs; "walls" = the building's own wall style, null = none. */
  parapets?: ReadonlyArray<WallStyle | "walls" | null>;
  /** Window width variants (window rhythm). */
  windowWidths?: ReadonlyArray<1 | 2>;
  /** Chance that the ground storey's street face is a shopfront (wide glazing and a sign band). */
  shopfront?: number;
  /** Variety: the design space a building of this style is drawn from when the plan leaves shape and looks unset. */
  design?: DesignSpace;
  /** Default condition of a building of this style (Building.condition overrides). */
  condition?: "intact" | "weathered" | "ruined";
  /**
   * Era: the palette rows this style may use — rows owned by these themes, or roles matching these patterns (the
   * style's own families in the structures batch). Anything else in a fallback chain is left out and named
   * (structure_style_fallback), so a city block never borrows a medieval lantern. Absent = any row.
   */
  era?: { themes: readonly string[]; roles: readonly string[] };
  /** A raised base under the building: chance, height range, margin, face material and rim. */
  plinth?: {
    chance: number;
    height: readonly [number, number];
    margin: number;
    face: Material;
    rim: WallStyle | null;
  };
}

/** Cells between window starts per density (a window every N cells of wall). */
export const WINDOW_SPACING: Record<Exclude<WindowDensity, "none">, number> = {
  sparse: 5,
  regular: 3,
  dense: 2,
};

export const DEFAULT_STRUCTURE_STYLE = "cottage";

export const STRUCTURE_STYLES: Readonly<Record<string, StructureStyleProfile>> = {
  cottage: {
    id: "cottage",
    summary:
      "timber walls on a stone footing, pitched slate roof on an attic deck, windows every few cells, a light by the door",
    walls: "wood",
    upperWalls: "wood",
    footing: "stone",
    footingHeight: 1,
    wallHeight: 2,
    floor: "wood_plank",
    roof: { type: "gable", kit: "slate", deck: true, parapet: null, broken: 0 },
    windows: { width: 2 },
    variety: {
      windowDensities: ["sparse", "regular"],
      porchChance: 0.6,
      chimneyChance: 0.8,
      doorPosition: [0.3, 0.7],
    },
    doorLight: true,
    lighting: { windows: "warm", lit: [0.3, 0.7], colours: ["warm"], strips: 0 },
    design: {
      archetypes: { box: 2.5, ell: 1.5, twin: 1.2, lean: 1.5, shed: 0.3 },
      storeys: [1, 2],
      groundHeight: [2, 2.5],
      upperHeight: [2, 2],
      // an attic storey under the roof (a storey and a half)
      tops: { same: 2, attic: 1.5 },
      atticHeight: 1.5,
      materials: { wood: 4, stone: 1.5, plaster: 0.6 },
      footings: { stone: 3, none: 1.5, wood: 0.5 },
      sizes: { full: 2, compact: 2, small: 1.5 },
      roofs: { gable: 3, gable_cross: 1.5, hip: 1.5, shed: 0.4 },
      windows: { paired: 3, punched: 2, sparse: 1.5 },
      bases: { plain: 3, stoop: 0.5 },
      uses: {
        shack: {
          "sizes:small": 5,
          "archetypes:lean": 2,
          "tops:attic": 0,
          "roofs:shed": 4,
          "windows:sparse": 4,
        },
        farmhouse: { "sizes:full": 4, "archetypes:ell": 2, "archetypes:lean": 1.5, "tops:attic": 2 },
        workshop: { "archetypes:twin": 3, "archetypes:lean": 2, "roofs:hip": 0.5 },
        tavern: { "sizes:full": 3, "archetypes:ell": 2, "roofs:hip": 2, "tops:same": 3 },
      },
    },
  },
  keep: {
    id: "keep",
    // variety (2026-11-20): a frontier keep, a gatehouse block, a tower-house on a curtain base
    design: {
      archetypes: { box: 3, setback: 1.5, podium: 1, ell: 1, twin: 0.7 },
      storeys: [2, 4],
      groundHeight: [2.5, 3],
      upperHeight: [2, 3],
      materials: { stone: 4, brick: 0.4 },
      roofs: { flat: 4, skirt: 0.6, hip: 0.4 },
      pitchedKit: "slate",
      parapets: { railing_stone: 3, none: 0.5 },
      lowerParapets: { railing_stone: 2, none: 1 },
      windows: { sparse: 3, punched: 1 },
      bases: { plain: 3, stoop: 1 },
      tops: { same: 3, attic: 0.5 },
      sizes: { full: 3, compact: 1.5 },
      uses: {
        gatehouse: { "archetypes:twin": 4, "bases:plain": 3 },
        manor: { "archetypes:ell": 3, "roofs:hip": 6, "windows:punched": 3 },
        tower: { "archetypes:setback": 3, "storeys:4": 3 },
      },
    },
    summary:
      "thick stone walls, few narrow windows, flat roof with a stone parapet, battlemented ledges where storeys step in",
    walls: "stone",
    upperWalls: "stone",
    footing: null,
    footingHeight: 1,
    wallHeight: 2,
    floor: "flagstone",
    roof: { type: "flat", kit: "stone", deck: false, parapet: "railing_stone", broken: 0 },
    windows: { width: 1 },
    variety: { windowDensities: ["sparse"], porchChance: 0, chimneyChance: 0, doorPosition: [0.5, 0.5] },
    doorLight: true,
    seams: { crenellated: 1 },
    furniture: { dormers: 0, clutter: [0.02, 0.06], mast: 0.4, finial: false },
    lighting: { windows: "warm", lit: [0.2, 0.5], colours: ["warm"], strips: 0 },
    plinth: { chance: 0.3, height: [1, 2], margin: 1, face: "rock", rim: "railing_stone" },
  },
  tower: {
    id: "tower",
    // variety: a watchtower, a bell tower, a lighthouse-like stack
    design: {
      archetypes: { box: 3, setback: 1.2, podium: 0.8 },
      storeys: [3, 5],
      groundHeight: [2.5, 3],
      upperHeight: [2, 3],
      materials: { stone: 3, wood: 0.6, brick: 0.4 },
      roofs: { spire: 3, flat: 1.2, hip: 1, skirt_spire: 0.8 },
      pitchedKit: "slate",
      parapets: { railing_stone: 2, none: 1 },
      lowerParapets: { railing_stone: 2, none: 1 },
      windows: { sparse: 3, punched: 1 },
      bases: { plain: 3 },
      tops: { same: 2, attic: 1 },
      crowns: { same: 3, wood: 1 },
      // a tower is a tower: 3 to 5 cells a side, at least twice as tall as wide
      maxFootprint: 5,
      minAspect: 2,
    },
    summary: "tall and narrow stone storeys, sparse windows, a spire",
    walls: "stone",
    upperWalls: "stone",
    footing: null,
    footingHeight: 1,
    wallHeight: 2,
    floor: "flagstone",
    roof: { type: "cone", kit: "slate", deck: false, parapet: "railing_stone", broken: 0 },
    windows: { width: 1 },
    variety: { windowDensities: ["sparse"], porchChance: 0, chimneyChance: 0, doorPosition: [0.5, 0.5] },
    doorLight: true,
  },
  ruin: {
    id: "ruin",
    condition: "ruined",
    // variety: a roofless shell, a fallen-in hall, a broken tower stump
    design: {
      archetypes: { box: 2, ell: 2, twin: 1.2, lean: 0.8 },
      storeys: [1, 2],
      groundHeight: [2, 2.5],
      upperHeight: [2, 2],
      materials: { ruined: 4, stone: 1 },
      roofs: { gable: 2.5, none: 2, hip: 0.5 },
      pitchedKit: "slate",
      windows: { sparse: 2, punched: 1, paired: 1 },
      bases: { plain: 3 },
      sizes: { full: 2, compact: 1.5, small: 1 },
    },
    summary: "broken walls and a fallen-in roof: an abandoned building",
    walls: "ruined",
    upperWalls: "ruined",
    footing: null,
    footingHeight: 1,
    wallHeight: 2,
    floor: "flagstone",
    roof: { type: "gable", kit: "slate", deck: false, parapet: null, broken: 0.35 },
    windows: { width: 2 },
    variety: {
      windowDensities: ["sparse", "regular"],
      porchChance: 0.2,
      chimneyChance: 0.3,
      doorPosition: [0.3, 0.7],
    },
    doorLight: false,
  },
  wizard_tower: {
    id: "wizard_tower",
    design: {
      // a slender shaft (3 to 5 cells, 5 to 8 storeys, three times as tall as wide), a crown storey wider than the
      // shaft under a spire, a stair turret beside it; character (twisted, leaning …) bends the shaft
      archetypes: { shaft: 1 },
      storeys: [8, 10], // crown and spire about a third of the height
      groundHeight: [3, 3],
      upperHeight: [2.5, 3],
      materials: { stone: 4, marble: 0.6, plaster: 0.3 },
      roofs: { spire: 1 },
      pitchedKit: "village", // tiled spire, skirts and turret roofs in one material
      lowerParapets: { none: 1 },
      windows: { punched: 3, tall: 1.5, sparse: 1 },
      bases: { plain: 3 },
      crowns: { same: 2, wood: 1 },
      // the crown keeps to the shaft's family: marble stays marble, stone may turn timber or plaster, plaster stone
      crownFor: { marble: { same: 1 }, stone: { same: 2, wood: 1 }, plaster: { same: 2, stone: 1 } },
      // wall treatments as belonging sets (base tier and trim, shaft, lantern room); the half-timbered lantern room
      // is an option on each (the reference tower: dark stone, or red brick with stone trim, timbered lantern)
      treatments: {
        grey_stone: { weight: 3, base: "stone", material: "stone", crowns: { same: 2, timber: 1.5 } },
        brick_trim: { weight: 2.5, base: "stone", material: "brick", crowns: { timber: 2, stone: 1 } },
        sandstone: { weight: 1.5, base: "plaster", material: "plaster", crowns: { same: 2, timber: 1 } },
        dark_stone: { weight: 2, base: "dark_stone", material: "dark_stone", crowns: { same: 2, timber: 1 } },
        marble: { weight: 0.5, base: "marble", material: "marble", crowns: { same: 1 } },
      },
      // one roof colour per tower: orange village tile or grey slate (the palette's pitched kits)
      roofKits: { village: 3, slate: 1.2 },
      // at least two visible signs of magic per tower, plus usually a stair turret
      details: { bartizans: 4, turret: 2, beacon: 3, banners: 2, vines: 2, balcony: 1.5 },
      detailCount: [3, 4],
      maxFootprint: 5,
      minAspect: 3,
    },

    summary:
      "a slender tapering shaft in a wall treatment that belongs together (grey stone, red brick on a stone foot, sandstone, dark stone), a lantern room under a steep spire with a finial or a magic orb, bartizans or a stair turret, glowing windows, on a raised rocky base",
    walls: "stone",
    upperWalls: "stone",
    footing: null,
    footingHeight: 1,
    wallHeight: 3,
    upperWallHeight: [3, 4],
    crownWalls: "wood",
    corners: "chamfer",
    floor: "flagstone",
    roof: { type: "skirt", kit: "slate", deck: false, parapet: null, broken: 0 },
    roofLayers: [{ type: "spire" }],
    spire: { taper: 0.5, courseHeight: 2, bands: [1, 2] },
    windows: { width: 1 },
    variety: { windowDensities: ["sparse"], porchChance: 0, chimneyChance: 0, doorPosition: [0.4, 0.6] },
    doorLight: true,
    seams: { skirt: 0.6, crenellated: 0.3, plain: 0.1 },
    setIn: { chance: 0.6, minWidth: 4 },
    furniture: { dormers: 0, clutter: [0, 0], mast: 0, finial: true },
    lighting: { windows: "glow", lit: [0.85, 1], colours: ["violet", "cyan", "amber", "green"], strips: 0 },
    plinth: { chance: 0.9, height: [2, 4], margin: 2, face: "rock", rim: "low_wall" },
  },
  modern_block: {
    id: "modern_block",
    summary:
      "a city building drawn from many shapes (plain block, set-back top, podium and tower, twin heights, corner L, stepped, low shed), brick, concrete, metal or panel walls, a shopfront, stoop or garage at street level, varied window patterns, flat parapet roofs with a hut, plant, mast or terrace, lit entrances",
    walls: "brick",
    upperWalls: "brick",
    footing: null,
    footingHeight: 1,
    wallHeight: 3,
    floor: "stone_tile",
    roof: { type: "flat", kit: "city", deck: false, parapet: "low_wall", broken: 0 },
    windows: { width: 1 },
    variety: {
      windowDensities: ["dense", "regular"],
      porchChance: 0,
      chimneyChance: 0,
      doorPosition: [0.3, 0.7],
    },
    doorLight: true,
    upperWallHeight: [2.5, 3.5],
    furniture: { dormers: 0, clutter: [0.08, 0.2], mast: 0.6, finial: false, hut: 0.6 },
    lighting: { windows: "warm", lit: [0.1, 0.4], colours: ["warm"], strips: 0.7 },
    design: {
      archetypes: { box: 2, setback: 2, podium: 1.5, twin: 1.5, ell: 1, stepped: 1, shed: 0.6 },
      storeys: [2, 4],
      groundHeight: [3, 4],
      upperHeight: [2.5, 3],
      // weights after the first street seen in game: concrete and metal read almost black, so they are rarer and
      // mostly a base under a lighter upper part
      materials: { brick: 3, concrete: 1, metal: 0.6, panel: 1.2, plaster: 0.6, marble: 0.5 },
      tones: {
        concrete: "dark",
        metal: "dark",
        brick: "mid",
        marble: "light",
        panel: "light",
        plaster: "light",
      },
      darkShare: 1 / 3,
      darkLit: 0.7,
      // industrial and durable floors read as works yards from above: mostly on works buildings
      roofSurfaces: { default: 2, concrete: 2, industrial: 0.6, durable: 0.8 },
      lowerParapets: { walls: 3, none: 2, concrete: 0.7 },
      // plaster (Desert Village walls) has no parapet piece: a concrete coping instead
      parapetFor: { plaster: "concrete" },
      details: { fire_escape: 2, balconies: 2, piers: 1.5, canopy: 1.5, services: 3 },
      detailCount: [1, 3],
      serviceDoor: 0.7,
      baseChance: 0.5,
      baseMaterials: { concrete: 2, brick: 1.5, metal: 0.7, marble: 0.5 },
      // flat only: the modern packs have no sloped roof kit (the silhouette varies through the massing instead)
      roofs: { flat: 1 },
      parapets: { walls: 5, concrete: 0.8, none: 1.5 },
      rooftop: { hut: 2, mast: 1.5, plant: 3, storage: 0.8, terrace: 1.5 },
      rooftopCount: [1, 2],
      windows: { punched: 3, paired: 2, ribbon: 1.5, tall: 1.5, sparse: 0.5 },
      bases: { plain: 2, shopfront: 3, stoop: 1, garage: 1 },
      tops: { same: 3, attic: 1 },
      uses: {
        shop: { "bases:shopfront": 5, "archetypes:box": 1.5, "details:canopy": 4 },
        diner: { "bases:shopfront": 6, "archetypes:box": 3, "archetypes:shed": 2, "details:canopy": 4 },
        apartments: {
          "archetypes:setback": 2,
          "windows:paired": 2,
          "bases:stoop": 3,
          "bases:shopfront": 0.3,
          "details:fire_escape": 8,
          "details:balconies": 6,
          "roofSurfaces:industrial": 0,
          "roofSurfaces:durable": 0,
        },
        townhouse: {
          "bases:stoop": 5,
          "windows:tall": 3,
          "tops:attic": 3,
          "archetypes:twin": 0.3,
          "roofSurfaces:industrial": 0,
          "roofSurfaces:durable": 0,
        },
        office: {
          "windows:ribbon": 4,
          "archetypes:podium": 3,
          "materials:concrete": 2,
          "materials:panel": 3,
          "details:piers": 3,
        },
        civic: {
          "archetypes:podium": 4,
          "materials:concrete": 3,
          "materials:marble": 6,
          "windows:tall": 3,
          "bases:stoop": 3,
          "details:piers": 4,
          "roofSurfaces:industrial": 0,
          "roofSurfaces:durable": 0,
        },
        warehouse: {
          "archetypes:shed": 30,
          "bases:garage": 6,
          "materials:metal": 4,
          "windows:sparse": 4,
          "details:services": 2,
          "materials:marble": 0,
          "materials:plaster": 0,
          "baseMaterials:marble": 0,
          "roofSurfaces:industrial": 15,
          "roofSurfaces:durable": 10,
        },
        garage: {
          "archetypes:shed": 20,
          "bases:garage": 10,
          "materials:metal": 3,
          "materials:marble": 0,
          "baseMaterials:marble": 0,
          "roofSurfaces:industrial": 15,
          "roofSurfaces:durable": 10,
        },
        workshop: {
          "archetypes:shed": 3,
          "bases:garage": 4,
          "materials:metal": 2,
          "materials:brick": 2,
          "roofSurfaces:industrial": 10,
        },
      },
    },
    plinth: { chance: 0, height: [0.5, 0.5], margin: 1, face: "stone_tile", rim: null },
    era: {
      themes: ["city"],
      roles: [
        "^(facade|wall|facade_post|over_door|parapet|window|corner_pier|wall_light|light\\.window)\\.(brick|concrete|metal|panel|marble|plaster)$",
        "^opening\\.(door|double_door)\\.(shop|home|office|works)$",
        "^roof\\.(city|concrete|industrial|durable)\\.",
        "^roof_terrace\\.",
        "^ruin_(rubble|growth)\\.",
        "^(roof_clutter|mast|light\\.strip|sign_band|fire_escape|wall_pipe|wall_unit|canopy|balcony|balcony_rail|corner_pier)\\.",
        "^light\\.strip$",
      ],
    },
  },
  modern: {
    id: "modern",
    // variety: plain modern houses and offices (no era lock: any theme)
    design: {
      archetypes: { box: 3, setback: 1.2, twin: 1, ell: 0.8 },
      storeys: [1, 3],
      groundHeight: [2.5, 3],
      upperHeight: [2.5, 3],
      materials: { concrete: 2, panel: 2, plaster: 1, brick: 1 },
      tones: {
        concrete: "dark",
        metal: "dark",
        brick: "mid",
        marble: "light",
        panel: "light",
        plaster: "light",
      },
      roofs: { flat: 1 },
      parapets: { walls: 3, none: 1.5 },
      parapetFor: { plaster: "concrete" },
      windows: { ribbon: 2, paired: 2, punched: 1 },
      bases: { plain: 2, shopfront: 1, stoop: 0.5 },
      tops: { same: 3, attic: 1 },
    },
    summary: "plain panel walls, many large windows, flat roof with a low parapet",
    walls: "concrete",
    upperWalls: "concrete",
    footing: null,
    footingHeight: 1,
    wallHeight: 2,
    floor: "stone_tile",
    roof: { type: "flat", kit: "concrete", deck: false, parapet: "low_wall", broken: 0 },
    windows: { width: 2 },
    variety: {
      windowDensities: ["dense", "regular"],
      porchChance: 0.3,
      chimneyChance: 0,
      doorPosition: [0.2, 0.8],
    },
    doorLight: true,
  },
  desert: {
    id: "desert",
    // variety: flat-roofed courtyard houses, stepped terraces, a tower house
    design: {
      archetypes: { box: 3, ell: 1.5, twin: 1.2, stepped: 1, setback: 1 },
      storeys: [1, 3],
      groundHeight: [2, 2.5],
      upperHeight: [2, 2.5],
      materials: { plaster: 4, stone: 1 },
      roofs: { flat: 1 },
      parapets: { low_wall: 2, none: 1.5 },
      lowerParapets: { low_wall: 1.5, none: 2 },
      windows: { sparse: 3, punched: 1 },
      bases: { plain: 2, stoop: 1 },
      sizes: { full: 2, compact: 1.5, small: 0.8 },
    },
    summary: "plastered walls, few small windows, flat roof with a low parapet",
    walls: "plaster",
    upperWalls: "plaster",
    footing: null,
    footingHeight: 1,
    wallHeight: 2,
    floor: "stone_tile",
    roof: { type: "flat", kit: "adobe", deck: false, parapet: "low_wall", broken: 0 },
    windows: { width: 1 },
    variety: { windowDensities: ["sparse"], porchChance: 0.3, chimneyChance: 0, doorPosition: [0.3, 0.7] },
    doorLight: false,
  },
};

export function structureStyle(id: string | undefined): StructureStyleProfile | null {
  const key = id ?? DEFAULT_STRUCTURE_STYLE;
  return Object.prototype.hasOwnProperty.call(STRUCTURE_STYLES, key) ? (STRUCTURE_STYLES[key] ?? null) : null;
}
