/**
 * tools-1.10.0, published in 0.4.0 with sp-1.14.0 (generator 5), frozen: a conversation that started on this tools
 * version keeps these exact definitions (the bytes are part of the prompt-cache key). Generated from
 * TOOL_DEFINITIONS at release (tools.frozen.ts holds tools-1.7.0, tools.frozen.v1_8_0.ts tools-1.8.0,
 * tools.frozen.v1_9_0.ts tools-1.9.0); never edit by hand. Edit TOOL_DEFINITIONS (tools.ts) for the next working
 * version, tools-1.11.0, when generator 6 opens.
 */
import type { ToolDefinition } from "./tools";

export const TOOLS_1_10_0: readonly ToolDefinition[] = [
  {
    name: "update_brief",
    streamInput: false,
    description:
      "Record what you and the GM have agreed in the design brief card (map type, game system, party, footprint, levels, tone, must-include, avoid, theme). Call it whenever the conversation settles or changes one of these, in the same turn. Fields the GM set by hand are kept; the result tells you which were skipped.",
    inputSchema: {
      type: "object",
      required: ["set"],
      additionalProperties: false,
      properties: {
        set: {
          type: "object",
          additionalProperties: false,
          properties: {
            mapType: {
              type: "string",
            },
            system: {
              type: "string",
              enum: ["daggerheart", "dnd5e", "other"],
            },
            party: {
              type: "object",
              additionalProperties: false,
              properties: {
                tier: {
                  type: "integer",
                },
                level: {
                  type: "integer",
                },
                size: {
                  type: "integer",
                },
              },
            },
            footprint: {
              type: "object",
              required: ["preset", "widthSq", "heightSq"],
              additionalProperties: false,
              properties: {
                preset: {
                  type: "string",
                  enum: ["small", "medium", "large", "custom"],
                },
                widthSq: {
                  type: "integer",
                },
                heightSq: {
                  type: "integer",
                },
              },
            },
            levels: {
              type: "object",
              required: ["count", "names"],
              additionalProperties: false,
              properties: {
                count: {
                  type: "integer",
                },
                names: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                },
              },
            },
            tone: {
              type: "string",
            },
            mustInclude: {
              type: "array",
              items: {
                type: "string",
              },
            },
            avoid: {
              type: "array",
              items: {
                type: "string",
              },
            },
            theme: {
              type: "string",
            },
          },
        },
      },
    },
  },
  {
    name: "ask_questions",
    streamInput: false,
    description:
      "Ask the GM up to 3 clarifying questions as a card with answer chips. Use at most once per turn and normally only once before the first draft; every question must state the default you will use if it is ignored. Your turn ends with this call — the answers arrive as its result together with the GM's next message. Do not repeat the questions in text.",
    inputSchema: {
      type: "object",
      required: ["questions"],
      additionalProperties: false,
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: {
            type: "object",
            required: ["id", "text", "default", "options"],
            additionalProperties: false,
            properties: {
              id: {
                type: "string",
              },
              text: {
                type: "string",
              },
              default: {
                type: "string",
              },
              options: {
                type: "array",
                items: {
                  type: "string",
                },
                minItems: 2,
                maxItems: 4,
              },
            },
          },
        },
      },
    },
  },
  {
    name: "create_plan",
    streamInput: true,
    description:
      "Create the map plan from scratch (or replace it wholesale with replace=true). Call this once the GM has agreed on the brief, to produce the FIRST complete draft. For any later change use edit_plan instead — never re-send the whole plan to change a part of it. The app validates the plan; if it is rejected nothing changes and the result lists every problem with hints.",
    inputSchema: {
      type: "object",
      required: ["replace", "summary", "plan"],
      additionalProperties: false,
      properties: {
        replace: {
          type: "boolean",
        },
        summary: {
          type: "string",
          description: "≤ 80 chars, becomes the version label.",
        },
        changes: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 6,
        },
        plan: {
          type: "object",
          required: ["title", "kind", "theme", "levels", "links"],
          additionalProperties: false,
          properties: {
            title: {
              type: "string",
            },
            summary: {
              type: "string",
            },
            kind: {
              type: "string",
              enum: ["dungeon", "cave", "building", "tower", "town", "outdoor", "mixed"],
            },
            seed: {
              type: "integer",
              description: "Optional root seed; omitted = app picks one.",
            },
            theme: {
              type: "string",
            },
            levels: {
              type: "array",
              items: {
                $ref: "#/$defs/level",
              },
              minItems: 1,
              maxItems: 8,
            },
            entryLevel: {
              type: "string",
            },
            links: {
              type: "array",
              items: {
                $ref: "#/$defs/link",
              },
            },
            notes: {
              type: "string",
            },
          },
        },
      },
      $defs: {
        shape: {
          description:
            "Cell-set shape. A cell is inside iff its center is inside. Prefer rect for rooms, route for corridors, cave/blob for organic spaces.",
          oneOf: [
            {
              type: "object",
              required: ["type", "x", "y", "w", "h"],
              additionalProperties: false,
              properties: {
                type: {
                  const: "rect",
                },
                x: {
                  type: "integer",
                },
                y: {
                  type: "integer",
                },
                w: {
                  type: "integer",
                },
                h: {
                  type: "integer",
                },
              },
            },
            {
              type: "object",
              required: ["type", "points"],
              additionalProperties: false,
              properties: {
                type: {
                  const: "polygon",
                },
                points: {
                  type: "array",
                  items: {
                    type: "array",
                    items: {
                      type: "integer",
                    },
                    minItems: 2,
                    maxItems: 2,
                    description: "[x, y] grid VERTEX (corner) coordinates.",
                  },
                  minItems: 3,
                  maxItems: 64,
                },
              },
            },
            {
              type: "object",
              required: ["type", "cx", "cy", "r"],
              additionalProperties: false,
              properties: {
                type: {
                  const: "circle",
                },
                cx: {
                  type: "number",
                },
                cy: {
                  type: "number",
                },
                r: {
                  type: "number",
                },
              },
            },
            {
              type: "object",
              required: ["type", "cx", "cy", "rx", "ry"],
              additionalProperties: false,
              properties: {
                type: {
                  const: "ellipse",
                },
                cx: {
                  type: "number",
                },
                cy: {
                  type: "number",
                },
                rx: {
                  type: "number",
                },
                ry: {
                  type: "number",
                },
              },
            },
            {
              type: "object",
              required: ["type", "cx", "cy", "r"],
              additionalProperties: false,
              properties: {
                type: {
                  const: "blob",
                },
                cx: {
                  type: "number",
                },
                cy: {
                  type: "number",
                },
                r: {
                  type: "number",
                },
                roughness: {
                  type: "number",
                  description: "0..1, default 0.35",
                },
                seed: {
                  type: "integer",
                },
              },
            },
            {
              type: "object",
              required: ["type", "x", "y", "w", "h"],
              additionalProperties: false,
              properties: {
                type: {
                  const: "cave",
                },
                x: {
                  type: "integer",
                },
                y: {
                  type: "integer",
                },
                w: {
                  type: "integer",
                },
                h: {
                  type: "integer",
                },
                fill: {
                  type: "number",
                  description: "0.3..0.7, default 0.45",
                },
                steps: {
                  type: "integer",
                  description: "0..8, default 4",
                },
                seed: {
                  type: "integer",
                },
              },
            },
            {
              type: "object",
              required: ["type", "x", "y", "rows"],
              additionalProperties: false,
              properties: {
                type: {
                  const: "cells",
                },
                x: {
                  type: "integer",
                },
                y: {
                  type: "integer",
                },
                rows: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                  maxItems: 64,
                  description: "'#' = in, '.' = out; ≤ 64×64",
                },
              },
            },
            {
              type: "object",
              required: ["type", "points"],
              additionalProperties: false,
              properties: {
                type: {
                  const: "path",
                },
                points: {
                  type: "array",
                  items: {
                    type: "array",
                    items: {
                      type: "integer",
                    },
                    minItems: 2,
                    maxItems: 2,
                    description: "[x, y] cell coordinates (x east, y south).",
                  },
                  minItems: 2,
                },
                width: {
                  type: "integer",
                  description: "1..5, default 1",
                },
              },
              description: "Thick polyline through cell centers; consecutive points axis-aligned.",
            },
            {
              type: "object",
              required: ["type", "from", "to"],
              additionalProperties: false,
              properties: {
                type: {
                  const: "route",
                },
                from: {
                  oneOf: [
                    {
                      type: "string",
                      pattern: "^[a-z][a-z0-9_]{0,31}$",
                      description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                    },
                    {
                      type: "array",
                      items: {
                        type: "integer",
                      },
                      minItems: 2,
                      maxItems: 2,
                      description: "[x, y] cell coordinates (x east, y south).",
                    },
                  ],
                },
                to: {
                  oneOf: [
                    {
                      type: "string",
                      pattern: "^[a-z][a-z0-9_]{0,31}$",
                      description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                    },
                    {
                      type: "array",
                      items: {
                        type: "integer",
                      },
                      minItems: 2,
                      maxItems: 2,
                      description: "[x, y] cell coordinates (x east, y south).",
                    },
                  ],
                },
                width: {
                  type: "integer",
                  enum: [1, 2, 3],
                },
                bend: {
                  type: "string",
                  enum: ["hv", "vh"],
                },
                openings: {
                  type: "string",
                  enum: [
                    "door",
                    "double_door",
                    "locked_door",
                    "secret_door",
                    "portcullis",
                    "archway",
                    "open",
                    "window",
                    "arrow_slit",
                    "bars",
                  ],
                },
              },
              description:
                "L-shaped corridor between two areas (or cells); never overwrites other areas; auto-adds openings where it meets them.",
            },
          ],
        },
        area: {
          type: "object",
          required: ["id", "kind", "shape"],
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]{0,31}$",
              description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
            },
            kind: {
              type: "string",
              enum: ["room", "corridor", "cave", "building", "courtyard", "zone", "bridge"],
              description:
                "zone = names cells only (never changes floor, height or walls). bridge = a walkable deck over a drop: open air under it, railings on the sides facing the drop, deck height = floorHeight or the floor at its ends; list it AFTER the areas it crosses.",
            },
            name: {
              type: "string",
            },
            key: {
              type: "string",
              description: 'Room-key label, e.g. "1" or "A3".',
            },
            shape: {
              $ref: "#/$defs/shape",
            },
            floor: {
              type: "string",
              enum: [
                "flagstone",
                "stone_tile",
                "marble",
                "brick",
                "cobble",
                "wood_plank",
                "carpet",
                "rock",
                "dirt",
                "grass",
                "sand",
                "gravel",
                "mud",
                "snow",
                "ice",
                "swamp",
                "water_shallow",
                "water_deep",
                "lava",
                "bridge_wood",
                "asphalt",
                "concrete",
                "none",
              ],
              description:
                "Omitted = the theme default. Generator 4, a room on a solid-base level: leave it off and the room takes a floor from its purpose in the theme's floor family, unlike its neighbours' where it can; a passage or an abandoned room keeps the default. Name a floor only to choose one (naming the theme default counts as leaving it off).",
            },
            floorHeight: {
              type: "number",
              description:
                "Tiles relative to the level, multiple of 0.25, -4..4 (dais 0.5, pit -1). Omitted = keep the height underneath (e.g. from a height op). Generator 4: a room on a solid-base level that a corridor opens into (an opening, a route ending on it, or no wall between) sits a quarter tile above it when this is omitted; 0 keeps it level.",
            },
            walls: {
              type: "string",
              enum: ["auto", "perimeter", "none"],
            },
            wallStyle: {
              type: "string",
              enum: [
                "wall",
                "stone",
                "brick",
                "wood",
                "cave_rock",
                "plaster",
                "palisade",
                "fence",
                "hedge",
                "low_wall",
                "railing",
                "iron_bars",
                "ruined",
                "railing_stone",
                "concrete",
                "metal",
                "panel",
                "marble",
                "dark_stone",
                "timber",
              ],
            },
            wallHeight: {
              type: "number",
              description: "Tiles (1 = 5 ft), multiple of 0.25.",
            },
            labelAt: {
              type: "array",
              items: {
                type: "integer",
              },
              minItems: 2,
              maxItems: 2,
              description: "[x, y] cell coordinates (x east, y south).",
            },
            theme: {
              type: "string",
            },
            notes: {
              type: "string",
            },
            readAloud: {
              type: "string",
              description: "Boxed text read to players on entry.",
            },
            encounter: {
              type: "string",
              description: "Encounter line(s) in the brief's game system.",
            },
            tags: {
              type: "array",
              items: {
                type: "string",
              },
            },
            purpose: {
              type: "string",
              enum: [
                "tavern",
                "dining",
                "kitchen",
                "library",
                "study",
                "armoury",
                "barracks",
                "bedroom",
                "storeroom",
                "shrine",
                "crypt",
                "prison",
                "forge",
                "laboratory",
                "treasury",
                "washroom",
                "throne_room",
                "ruin",
                "passage",
              ],
              description:
                "Generator 4: set it only when the name does not say what the room is for; it wins over the name, tags and notes. Generator 5: the name also picks kinds this list lacks (shop, stable, lounge or parlour, classroom, command, ward or infirmary); leave purpose off for those.",
            },
            light: {
              type: "string",
              enum: ["dark", "dim", "moderate", "bright", "flooded"],
              description:
                "Generator 5: how many lights mark the place in use, dark (none) to flooded; not the board's brightness. Omitted = read from its words, else the place around it.",
            },
            condition: {
              type: "string",
              enum: ["intact", "weathered", "ramshackle", "ruined"],
              description:
                "Generator 5: how kept the place is (a ruined room is rubble, sparsely dressed). Omitted = read from its words, else the place around it.",
            },
            wealth: {
              type: "string",
              enum: ["poor", "modest", "wealthy", "lavish"],
              description:
                "Generator 5: how plain or rich its trims and contents are. Omitted = read from its words, else the place around it.",
            },
            railing: {
              type: "string",
              enum: [
                "wall",
                "stone",
                "brick",
                "wood",
                "cave_rock",
                "plaster",
                "palisade",
                "fence",
                "hedge",
                "low_wall",
                "railing",
                "iron_bars",
                "ruined",
                "railing_stone",
                "concrete",
                "metal",
                "panel",
                "marble",
                "dark_stone",
                "timber",
                "none",
              ],
              description:
                "bridge only: railing style on the edges facing the drop (default low_wall; ruined for a crumbling bridge).",
            },
            broken: {
              type: "array",
              items: {
                type: "array",
                items: {
                  type: "integer",
                },
                minItems: 2,
                maxItems: 2,
                description: "[x, y] cell coordinates (x east, y south).",
              },
              maxItems: 64,
              description: "bridge only: deck cells that have fallen away.",
            },
            crumble: {
              type: "number",
              description:
                "bridge only: 0..0.6 fraction of deck cells crumbled away; a way across always remains.",
            },
            span: {
              type: "string",
              enum: ["arch", "flat", "plank", "natural"],
              description:
                "bridge only: arch (stone, rises to the middle, piers, parapet), flat, plank (wood, sags, rope railing), natural (rock span or fallen column). Default by floor. A bridge whose ends touch floors at different heights becomes an inclined span with steps.",
            },
            arch: {
              type: "number",
              description: "bridge only: rise of the middle above the ends, tiles 0..2.",
            },
          },
        },
        opening: {
          type: "object",
          required: ["id", "kind"],
          additionalProperties: false,
          description:
            "Give EITHER between (preferred) OR at. secret_door is a wall that looks solid to players and opens only for the GM (always gmOnly): use it for a hidden shrine, vault or escape, with the room behind reached some other way too if players must be able to find it. Generator 4 builds it as one wall piece standing in the doorway; the build notes tell the GM which piece to delete in TaleSpire to open the way.",
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]{0,31}$",
              description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
            },
            kind: {
              type: "string",
              enum: [
                "door",
                "double_door",
                "locked_door",
                "secret_door",
                "portcullis",
                "archway",
                "open",
                "window",
                "arrow_slit",
                "bars",
              ],
            },
            between: {
              type: "array",
              items: {
                type: "string",
              },
              minItems: 2,
              maxItems: 2,
              description: '[areaId, areaId|"@outside"]',
            },
            position: {
              type: "number",
              description: "0..1 along the shared boundary, default 0.5",
            },
            at: {
              type: "object",
              required: ["x", "y", "side"],
              additionalProperties: false,
              properties: {
                x: {
                  type: "integer",
                },
                y: {
                  type: "integer",
                },
                side: {
                  type: "string",
                  enum: ["N", "E", "S", "W"],
                },
              },
            },
            width: {
              type: "integer",
              enum: [1, 2, 3],
            },
            label: {
              type: "string",
            },
            notes: {
              type: "string",
            },
            gmOnly: {
              type: "boolean",
            },
          },
        },
        wallRun: {
          type: "object",
          required: ["id", "op", "points"],
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]{0,31}$",
              description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
            },
            op: {
              type: "string",
              enum: ["add", "remove"],
            },
            points: {
              type: "array",
              items: {
                type: "array",
                items: {
                  type: "integer",
                },
                minItems: 2,
                maxItems: 2,
                description: "[x, y] grid VERTEX (corner) coordinates.",
              },
              minItems: 2,
              maxItems: 64,
            },
            style: {
              type: "string",
              enum: [
                "wall",
                "stone",
                "brick",
                "wood",
                "cave_rock",
                "plaster",
                "palisade",
                "fence",
                "hedge",
                "low_wall",
                "railing",
                "iron_bars",
                "ruined",
                "railing_stone",
                "concrete",
                "metal",
                "panel",
                "marble",
                "dark_stone",
                "timber",
              ],
            },
            height: {
              type: "number",
              description: "Tiles (1 = 5 ft), multiple of 0.25.",
            },
          },
        },
        feature: {
          type: "object",
          required: ["id", "type", "at"],
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]{0,31}$",
              description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
            },
            type: {
              type: "string",
              enum: [
                "table",
                "round_table",
                "chair",
                "bench",
                "stool",
                "bed",
                "bunk_bed",
                "wardrobe",
                "bookshelf",
                "desk",
                "chest",
                "barrel",
                "crate",
                "sack",
                "shelf",
                "counter",
                "bar_counter",
                "throne",
                "rug",
                "cauldron",
                "anvil",
                "forge",
                "weapon_rack",
                "armor_stand",
                "cage",
                "stocks",
                "pillar",
                "statue",
                "altar",
                "fountain",
                "well",
                "brazier",
                "torch_wall",
                "candelabra",
                "banner_wall",
                "painting_wall",
                "sarcophagus",
                "coffin",
                "tomb",
                "bones",
                "rubble",
                "web",
                "debris",
                "pool",
                "lever",
                "trap",
                "trap_plate",
                "chandelier",
                "tree",
                "dead_tree",
                "pine_tree",
                "bush",
                "rock",
                "boulder",
                "stump",
                "log",
                "mushroom",
                "flowers",
                "tall_grass",
                "reeds",
                "campfire",
                "tent",
                "cart",
                "wagon",
                "fence_post",
                "signpost",
                "standing_stone",
                "grave",
                "stalagmite",
                "stalactite",
                "rock_formation",
                "cave_in",
                "crystal",
                "giant_mushroom",
                "root",
                "root_large",
                "roots_wall",
                "vines",
                "tree_large",
                "candles",
                "skull_pile",
                "spawn_point",
                "torch_floor",
                "lantern",
                "magic_fire",
                "lava_glow",
                "fire_pit",
                "monolith",
                "cave_column",
                "statue_large",
                "mine_cart",
                "rails",
                "mine_support",
                "chains",
                "landmark",
                "tall_marker",
                "formation",
                "cluster_tall",
                "undergrowth",
                "ground_cover",
                "accent_light",
                "edge_dressing",
                "small_detail",
                "wall_dressing",
                "bank_dressing",
                "jetty",
                "vehicle",
                "seating",
                "signage",
                "cliff_face",
                "cliff_crest",
                "stall",
                "goods",
                "overhead",
                "line_post",
                "clutter",
                "shelf_line",
                "custom",
              ],
              description:
                "Generator 4: clutter is the small things a room's dressing stands on its furniture (variant table, study, store, tools or shelf) and shelf_line a wall shelf plank for them (needs wall); a room dressed by default or by a preset already has both.",
            },
            at: {
              type: "array",
              items: {
                type: "integer",
              },
              minItems: 2,
              maxItems: 2,
              description: "[x, y] cell coordinates (x east, y south).",
            },
            rot: {
              type: "integer",
              enum: [0, 90, 180, 270],
            },
            size: {
              type: "array",
              items: {
                type: "integer",
              },
              minItems: 2,
              maxItems: 2,
              description:
                "Cells [w, h]. Leave it off for a named type (the piece keeps its own footprint). For custom, the size of the thing: only an asset within about nine times its area either way is taken.",
            },
            wall: {
              type: "string",
              enum: ["N", "E", "S", "W"],
            },
            lift: {
              type: "number",
              description: "Tiles (1 = 5 ft), multiple of 0.25.",
            },
            variant: {
              type: "string",
            },
            hint: {
              type: "string",
              description:
                'Required for type "custom": a plain noun that is a whole word of the game asset\'s name ("wheel", "anchor", "skull"); its last word must be in the name.',
            },
            label: {
              type: "string",
            },
            notes: {
              type: "string",
            },
            gmOnly: {
              type: "boolean",
            },
          },
        },
        terrain: {
          oneOf: [
            {
              type: "object",
              required: ["id", "op", "shape", "material"],
              additionalProperties: false,
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "paint",
                },
                shape: {
                  $ref: "#/$defs/shape",
                },
                material: {
                  type: "string",
                  enum: [
                    "flagstone",
                    "stone_tile",
                    "marble",
                    "brick",
                    "cobble",
                    "wood_plank",
                    "carpet",
                    "rock",
                    "dirt",
                    "grass",
                    "sand",
                    "gravel",
                    "mud",
                    "snow",
                    "ice",
                    "swamp",
                    "water_shallow",
                    "water_deep",
                    "lava",
                    "bridge_wood",
                    "asphalt",
                    "concrete",
                  ],
                },
                layer: {
                  type: "string",
                  enum: ["under", "over"],
                  description:
                    "under (default) = applied before the areas: paint/noise/path under are replaced wherever an area sets its floor (use under for outdoor ground and roads); a height op under sets the ground height that areas without floorHeight inherit. over = applied after the areas, on their floor (water or lava in a cave, a dais or pit inside a room).",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op", "shape"],
              additionalProperties: false,
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "height",
                },
                shape: {
                  $ref: "#/$defs/shape",
                },
                delta: {
                  type: "number",
                  description: "Tiles (1 = 5 ft), multiple of 0.25.",
                },
                set: {
                  type: "number",
                  description: "Tiles (1 = 5 ft), multiple of 0.25.",
                },
                smooth: {
                  type: "integer",
                },
                layer: {
                  type: "string",
                  enum: ["under", "over"],
                  description:
                    "under (default) = applied before the areas: paint/noise/path under are replaced wherever an area sets its floor (use under for outdoor ground and roads); a height op under sets the ground height that areas without floorHeight inherit. over = applied after the areas, on their floor (water or lava in a cave, a dais or pit inside a room).",
                },
                edge: {
                  type: "string",
                  enum: ["ragged", "clean"],
                  description: "ragged breaks the outline (natural ground; default on open-air levels).",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op", "shape", "material", "coverage"],
              additionalProperties: false,
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "noise",
                },
                shape: {
                  $ref: "#/$defs/shape",
                },
                material: {
                  type: "string",
                  enum: [
                    "flagstone",
                    "stone_tile",
                    "marble",
                    "brick",
                    "cobble",
                    "wood_plank",
                    "carpet",
                    "rock",
                    "dirt",
                    "grass",
                    "sand",
                    "gravel",
                    "mud",
                    "snow",
                    "ice",
                    "swamp",
                    "water_shallow",
                    "water_deep",
                    "lava",
                    "bridge_wood",
                    "asphalt",
                    "concrete",
                  ],
                },
                coverage: {
                  type: "number",
                },
                scale: {
                  type: "integer",
                },
                seed: {
                  type: "integer",
                },
                layer: {
                  type: "string",
                  enum: ["under", "over"],
                  description:
                    "under (default) = applied before the areas: paint/noise/path under are replaced wherever an area sets its floor (use under for outdoor ground and roads); a height op under sets the ground height that areas without floorHeight inherit. over = applied after the areas, on their floor (water or lava in a cave, a dais or pit inside a room).",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op", "width", "material"],
              additionalProperties: false,
              description:
                "Road, trail, track or stream bed of a material along a line: give points (cell centres), or connect (area ids, feature ids or [x,y] cells joined in order, winding with jitter). kerb edges it with kerb pieces.",
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "path",
                },
                points: {
                  type: "array",
                  items: {
                    type: "array",
                    items: {
                      type: "integer",
                    },
                    minItems: 2,
                    maxItems: 2,
                    description: "[x, y] cell coordinates (x east, y south).",
                  },
                  minItems: 2,
                },
                connect: {
                  type: "array",
                  items: {
                    oneOf: [
                      {
                        type: "string",
                      },
                      {
                        type: "array",
                        items: {
                          type: "integer",
                        },
                        minItems: 2,
                        maxItems: 2,
                        description: "[x, y] cell coordinates (x east, y south).",
                      },
                    ],
                  },
                  minItems: 2,
                  maxItems: 16,
                },
                width: {
                  type: "integer",
                },
                material: {
                  type: "string",
                  enum: [
                    "flagstone",
                    "stone_tile",
                    "marble",
                    "brick",
                    "cobble",
                    "wood_plank",
                    "carpet",
                    "rock",
                    "dirt",
                    "grass",
                    "sand",
                    "gravel",
                    "mud",
                    "snow",
                    "ice",
                    "swamp",
                    "water_shallow",
                    "water_deep",
                    "lava",
                    "bridge_wood",
                    "asphalt",
                    "concrete",
                  ],
                },
                jitter: {
                  type: "number",
                },
                seed: {
                  type: "integer",
                },
                layer: {
                  type: "string",
                  enum: ["under", "over"],
                  description:
                    "under (default) = applied before the areas: paint/noise/path under are replaced wherever an area sets its floor (use under for outdoor ground and roads); a height op under sets the ground height that areas without floorHeight inherit. over = applied after the areas, on their floor (water or lava in a cave, a dais or pit inside a room).",
                },
                kerb: {
                  type: "boolean",
                  description: "Broken kerb stones here and there along the path's edges.",
                },
                style: {
                  type: "string",
                  enum: ["natural", "straight"],
                  description:
                    "natural winds and varies in width (default for dirt, gravel, grass, sand, mud, snow, rock); straight for paved roads and corridors.",
                },
                sidewalk: {
                  type: "object",
                  required: ["width", "material"],
                  additionalProperties: false,
                  description:
                    "Makes the path a road (straight, no jitter) with a raised pavement on both sides and kerbs between (kerb false turns them off).",
                  properties: {
                    width: {
                      type: "integer",
                    },
                    material: {
                      type: "string",
                      enum: [
                        "flagstone",
                        "stone_tile",
                        "marble",
                        "brick",
                        "cobble",
                        "wood_plank",
                        "carpet",
                        "rock",
                        "dirt",
                        "grass",
                        "sand",
                        "gravel",
                        "mud",
                        "snow",
                        "ice",
                        "swamp",
                        "water_shallow",
                        "water_deep",
                        "lava",
                        "bridge_wood",
                        "asphalt",
                        "concrete",
                      ],
                    },
                    raise: {
                      type: "number",
                      description: "pavement height above the road, tiles (default 0.25)",
                    },
                  },
                },
                crossings: {
                  type: "array",
                  items: {
                    type: "number",
                  },
                  description:
                    "Pedestrian crossings at these fractions of the road's length (0..1); makes the path a road.",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op", "feature", "density"],
              additionalProperties: false,
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "scatter",
                },
                feature: {
                  type: "string",
                  enum: [
                    "table",
                    "round_table",
                    "chair",
                    "bench",
                    "stool",
                    "bed",
                    "bunk_bed",
                    "wardrobe",
                    "bookshelf",
                    "desk",
                    "chest",
                    "barrel",
                    "crate",
                    "sack",
                    "shelf",
                    "counter",
                    "bar_counter",
                    "throne",
                    "rug",
                    "cauldron",
                    "anvil",
                    "forge",
                    "weapon_rack",
                    "armor_stand",
                    "cage",
                    "stocks",
                    "pillar",
                    "statue",
                    "altar",
                    "fountain",
                    "well",
                    "brazier",
                    "torch_wall",
                    "candelabra",
                    "banner_wall",
                    "painting_wall",
                    "sarcophagus",
                    "coffin",
                    "tomb",
                    "bones",
                    "rubble",
                    "web",
                    "debris",
                    "pool",
                    "lever",
                    "trap",
                    "trap_plate",
                    "chandelier",
                    "tree",
                    "dead_tree",
                    "pine_tree",
                    "bush",
                    "rock",
                    "boulder",
                    "stump",
                    "log",
                    "mushroom",
                    "flowers",
                    "tall_grass",
                    "reeds",
                    "campfire",
                    "tent",
                    "cart",
                    "wagon",
                    "fence_post",
                    "signpost",
                    "standing_stone",
                    "grave",
                    "stalagmite",
                    "stalactite",
                    "rock_formation",
                    "cave_in",
                    "crystal",
                    "giant_mushroom",
                    "root",
                    "root_large",
                    "roots_wall",
                    "vines",
                    "tree_large",
                    "candles",
                    "skull_pile",
                    "spawn_point",
                    "torch_floor",
                    "lantern",
                    "magic_fire",
                    "lava_glow",
                    "fire_pit",
                    "monolith",
                    "cave_column",
                    "statue_large",
                    "mine_cart",
                    "rails",
                    "mine_support",
                    "chains",
                    "landmark",
                    "tall_marker",
                    "formation",
                    "cluster_tall",
                    "undergrowth",
                    "ground_cover",
                    "accent_light",
                    "edge_dressing",
                    "small_detail",
                    "wall_dressing",
                    "bank_dressing",
                    "jetty",
                    "vehicle",
                    "seating",
                    "signage",
                    "cliff_face",
                    "cliff_crest",
                    "stall",
                    "goods",
                    "overhead",
                    "line_post",
                    "clutter",
                    "shelf_line",
                    "custom",
                  ],
                },
                shape: {
                  $ref: "#/$defs/shape",
                },
                exclude: {
                  type: "array",
                  items: {
                    $ref: "#/$defs/shape",
                  },
                  maxItems: 8,
                },
                density: {
                  type: "number",
                  description: "0..1",
                },
                minSpacing: {
                  type: "integer",
                },
                avoid: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: ["water", "paths", "areas", "walls", "features", "links"],
                  },
                },
                variants: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                },
                randomRotation: {
                  type: "boolean",
                },
                seed: {
                  type: "integer",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op", "preset"],
              additionalProperties: false,
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "dress",
                },
                area: {
                  type: "string",
                  description:
                    "area: optional on generator 2 — leave it out (or give the level id) to dress the whole level: the open ground and each zone.",
                },
                preset: {
                  type: "string",
                  enum: [
                    "tavern",
                    "library",
                    "barracks",
                    "bedroom",
                    "kitchen",
                    "storeroom",
                    "throne_room",
                    "shrine",
                    "crypt",
                    "prison",
                    "forge",
                    "laboratory",
                    "treasury",
                    "ruin",
                    "camp",
                    "ritual_circle",
                    "overgrown",
                    "cavern",
                    "collapse",
                    "crystal_grotto",
                    "campsite",
                    "shrine_ruin",
                    "bone_pit",
                    "mine_works",
                    "mushroom_grove",
                    "barricade",
                    "natural_clusters",
                    "woodland",
                    "forest",
                    "dense_forest",
                    "street",
                    "alley",
                    "plaza",
                  ],
                  description:
                    "Generator 4: a room preset (tavern to treasury in this list) furnishes and lights the room as that purpose, the way a room named for it is dressed by default (density 0.5 is the default amount); use one to choose the purpose or the amount.",
                },
                density: {
                  type: "number",
                },
                seed: {
                  type: "integer",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op", "points", "width"],
              additionalProperties: false,
              description:
                "A meandering trench cut into the floor of the areas it crosses (always applied after the areas): a chasm, crevasse, ravine or rift, and also a stream or river bed (floor water_shallow, depth 0.5..1) or a dry gully. Cliff sides, optional bridges across.",
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "chasm",
                },
                points: {
                  type: "array",
                  items: {
                    type: "array",
                    items: {
                      type: "integer",
                    },
                    minItems: 2,
                    maxItems: 2,
                    description: "[x, y] cell coordinates (x east, y south).",
                  },
                  minItems: 2,
                  maxItems: 64,
                  description:
                    "Course as cell centres, any direction; run it from wall to wall across the room.",
                },
                width: {
                  type: "number",
                  description: "Average width in cells, 1..12.",
                },
                depth: {
                  type: "number",
                  description: "Tiles below the floor, 0.5..4, multiple of 0.25 (default 3).",
                },
                meander: {
                  type: "number",
                  description: "0..1 (default 0.5): how much the course and the banks wander.",
                },
                floor: {
                  type: "string",
                  enum: [
                    "flagstone",
                    "stone_tile",
                    "marble",
                    "brick",
                    "cobble",
                    "wood_plank",
                    "carpet",
                    "rock",
                    "dirt",
                    "grass",
                    "sand",
                    "gravel",
                    "mud",
                    "snow",
                    "ice",
                    "swamp",
                    "water_shallow",
                    "water_deep",
                    "lava",
                    "bridge_wood",
                    "asphalt",
                    "concrete",
                    "none",
                  ],
                  description:
                    "Bottom: lava, water_deep, water_shallow, rock… (default: keep the floor); none = bottomless.",
                },
                bridges: {
                  type: "array",
                  maxItems: 4,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      at: {
                        type: "number",
                        description: "0..1 along the chasm (default 0.5).",
                      },
                      width: {
                        type: "integer",
                        description: "1..4 cells (default 2).",
                      },
                      floor: {
                        type: "string",
                        enum: [
                          "flagstone",
                          "stone_tile",
                          "marble",
                          "brick",
                          "cobble",
                          "wood_plank",
                          "carpet",
                          "rock",
                          "dirt",
                          "grass",
                          "sand",
                          "gravel",
                          "mud",
                          "snow",
                          "ice",
                          "swamp",
                          "water_shallow",
                          "water_deep",
                          "lava",
                          "bridge_wood",
                          "asphalt",
                          "concrete",
                        ],
                        description: "Deck material (default flagstone).",
                      },
                      railing: {
                        type: "string",
                        enum: [
                          "wall",
                          "stone",
                          "brick",
                          "wood",
                          "cave_rock",
                          "plaster",
                          "palisade",
                          "fence",
                          "hedge",
                          "low_wall",
                          "railing",
                          "iron_bars",
                          "ruined",
                          "railing_stone",
                          "concrete",
                          "metal",
                          "panel",
                          "marble",
                          "dark_stone",
                          "timber",
                          "none",
                        ],
                        description: "default low_wall; ruined suits an old bridge.",
                      },
                      crumble: {
                        type: "number",
                        description:
                          "0..0.6 fraction of the deck crumbled away (a way across always remains).",
                      },
                      span: {
                        type: "string",
                        enum: ["arch", "flat", "plank", "natural"],
                        description: "default arch (stone) or plank (wood floor).",
                      },
                      arch: {
                        type: "number",
                        description: "rise of the middle above the ends, tiles 0..2.",
                      },
                    },
                  },
                },
                seed: {
                  type: "integer",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op", "shape"],
              additionalProperties: false,
              description:
                "Tiered platform: dais, stepped pyramid, terrace, raised walkway, plateau; negative rise = sunken pit or amphitheatre. Rings each inset cells inside the one below and rise tiles higher. Cut into open floor (after the areas). Steps of 0.5 are walkable everywhere; stairs adds a flight on those sides.",
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "platform",
                },
                shape: {
                  $ref: "#/$defs/shape",
                },
                tiers: {
                  type: "integer",
                  description: "1..5 (default 3).",
                },
                rise: {
                  type: "number",
                  description: "Tiles per tier, -2..2, not 0, multiple of 0.25 (default 0.5).",
                },
                inset: {
                  type: "integer",
                  description: "Cells each tier steps in, 1..4 (default 1).",
                },
                material: {
                  type: "string",
                  enum: [
                    "flagstone",
                    "stone_tile",
                    "marble",
                    "brick",
                    "cobble",
                    "wood_plank",
                    "carpet",
                    "rock",
                    "dirt",
                    "grass",
                    "sand",
                    "gravel",
                    "mud",
                    "snow",
                    "ice",
                    "swamp",
                    "water_shallow",
                    "water_deep",
                    "lava",
                    "bridge_wood",
                    "asphalt",
                    "concrete",
                  ],
                },
                topMaterial: {
                  type: "string",
                  enum: [
                    "flagstone",
                    "stone_tile",
                    "marble",
                    "brick",
                    "cobble",
                    "wood_plank",
                    "carpet",
                    "rock",
                    "dirt",
                    "grass",
                    "sand",
                    "gravel",
                    "mud",
                    "snow",
                    "ice",
                    "swamp",
                    "water_shallow",
                    "water_deep",
                    "lava",
                    "bridge_wood",
                    "asphalt",
                    "concrete",
                  ],
                },
                stairs: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: ["N", "E", "S", "W"],
                  },
                  maxItems: 4,
                  description: "Sides that get a 2-wide flight of steps to the top.",
                },
                edge: {
                  type: "string",
                  enum: ["ragged", "clean"],
                  description:
                    "ragged = organic wandering contours (mounds, terraces, hills; default on open-air levels for natural materials); clean = crisp built tiers (daises).",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op", "from", "to"],
              additionalProperties: false,
              description:
                "A straight flight of steps between two floor cells on one row or column, at any two heights (ledge to floor, into a dry chasm, up to a terrace or plateau). The cells between step evenly; every step is walkable.",
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "stairs",
                },
                from: {
                  type: "array",
                  items: {
                    type: "integer",
                  },
                  minItems: 2,
                  maxItems: 2,
                  description: "[x, y] cell coordinates (x east, y south).",
                },
                to: {
                  type: "array",
                  items: {
                    type: "integer",
                  },
                  minItems: 2,
                  maxItems: 2,
                  description: "[x, y] cell coordinates (x east, y south).",
                },
                width: {
                  type: "integer",
                  minimum: 1,
                  maximum: 6,
                  description: "Stairs 1..3 (default 1); a ramp 3..6 (default 4).",
                },
                style: {
                  type: "string",
                  enum: ["stairs", "ramp"],
                  description:
                    "stairs (default): a flight of steps. ramp (generator 2): a rock ramp cut through a cliff, 3..6 cells wide, in any direction (a diagonal suits it), climbing at most 1 tile per 2.5 cells, so it needs a long run. An option for a natural slope where stairs would look built; whether minis walk it in game is not yet confirmed.",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op"],
              additionalProperties: false,
              description:
                "Uneven ground: gentle seeded bumps and hollows that stay walkable. Leave fighting space and paths out with exclude.",
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "uneven",
                },
                shape: {
                  $ref: "#/$defs/shape",
                },
                exclude: {
                  type: "array",
                  items: {
                    $ref: "#/$defs/shape",
                  },
                  maxItems: 8,
                },
                amount: {
                  type: "number",
                  description: "Largest change in tiles, 0.25..1 (default 0.5).",
                },
                scale: {
                  type: "number",
                  description: "Bump size in cells, 3..12 (default 6).",
                },
                seed: {
                  type: "integer",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op", "shape"],
              additionalProperties: false,
              description:
                "Outcrop: a rock mass, column, crag or buttress rising out of the floor with cliff sides (any setting).",
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "outcrop",
                },
                shape: {
                  $ref: "#/$defs/shape",
                },
                height: {
                  type: "number",
                  description: "Tiles, 0.5..4 (default 2).",
                },
                material: {
                  type: "string",
                  enum: [
                    "flagstone",
                    "stone_tile",
                    "marble",
                    "brick",
                    "cobble",
                    "wood_plank",
                    "carpet",
                    "rock",
                    "dirt",
                    "grass",
                    "sand",
                    "gravel",
                    "mud",
                    "snow",
                    "ice",
                    "swamp",
                    "water_shallow",
                    "water_deep",
                    "lava",
                    "bridge_wood",
                    "asphalt",
                    "concrete",
                  ],
                  description: "Top surface (default rock).",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op", "shape"],
              additionalProperties: false,
              description:
                'Generator 3. An opening in the floor of this level so the level below shows through: a collapsed floor, a shaft, a gallery or balcony looking down into a hall. Put it inside a room of the upper level, over open floor of a room on the level below (stack the levels by elevation, one storey = 2.5). No wall is built round it (unlike an area with floor "none"): the edge gets a low railing or broken rim, a collapse gets a ragged outline and a heap of rubble on the floor below, and the build checks the cells beneath are open floor.',
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "floor_opening",
                },
                shape: {
                  $ref: "#/$defs/shape",
                },
                kind: {
                  type: "string",
                  enum: ["collapse", "shaft", "balcony"],
                  description:
                    "collapse (default): ragged hole, broken edge, rubble below. shaft: clean hole with a railing. balcony: like shaft, for a gallery over a room.",
                },
                edge: {
                  type: "string",
                  enum: ["ragged", "clean"],
                  description: "Outline (default: ragged for a collapse, clean otherwise).",
                },
                rim: {
                  type: "string",
                  enum: [
                    "wall",
                    "stone",
                    "brick",
                    "wood",
                    "cave_rock",
                    "plaster",
                    "palisade",
                    "fence",
                    "hedge",
                    "low_wall",
                    "railing",
                    "iron_bars",
                    "ruined",
                    "railing_stone",
                    "concrete",
                    "metal",
                    "panel",
                    "marble",
                    "dark_stone",
                    "timber",
                    "none",
                  ],
                  description:
                    "Edge piece. Generator 4 default: a collapse has none (broken rubble on the rim), a shaft a low_wall kerb, a balcony a railing; never ask for a 2-tall wall style, it hides the hole. Earlier generators: ruined for a collapse, iron_bars otherwise.",
                },
                rubble: {
                  type: "boolean",
                  description: "Collapse: heap rubble on the floor below (default true).",
                },
              },
            },
          ],
        },
        label: {
          type: "object",
          required: ["id", "text", "at"],
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]{0,31}$",
              description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
            },
            text: {
              type: "string",
            },
            at: {
              type: "array",
              items: {
                type: "integer",
              },
              minItems: 2,
              maxItems: 2,
              description: "[x, y] cell coordinates (x east, y south).",
            },
            size: {
              type: "string",
              enum: ["s", "m", "l"],
            },
          },
        },
        link: {
          type: "object",
          required: ["id", "kind", "from", "to"],
          additionalProperties: false,
          description:
            'A way between two levels. `from` is always the LOWER level (lower elevation), `to` the upper; walkers go either way. Stairs: `from.at` is the first step (the foot, on the lower level) and `dir` is the way the run climbs; it covers one cell per tile of rise in a straight line (rise 2.5 = 3 cells, a 1-wide strip, or `width` wide), the cell BEHIND the foot (opposite `dir`) must be open floor, and the cells the run climbs over must be free floor on the lower level (a corridor the run climbs along becomes the stair). The top lands on the upper level one cell past the last step, which must be open floor there; the run\'s cells on the upper level become a stair well with no floor. Example: levels hall (elevation 0) and crypt (elevation -2.5); { kind: "stairs", from: { level: "crypt", at: [10, 20] }, to: { level: "hall" }, dir: "N" } occupies crypt (10,20), (10,19), (10,18), you step on from (10,21) (open floor), and you arrive on the hall at (10,17); the hall cells (10,18..20) get no floor (a stair well). A ladder or trapdoor occupies one cell: { kind: "ladder", from: { level: "shrine", at: [15, 20] }, to: { level: "crypt" } } climbs from shrine (15,20) up through a one-cell hole in the crypt floor at (15,20); you step on from any side cell of the lower level and off beside the hole above. Keep links out of the cells you build features on.',
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]{0,31}$",
              description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
            },
            kind: {
              type: "string",
              enum: ["stairs", "spiral_stairs", "ladder", "ramp", "trapdoor", "pit_drop"],
            },
            from: {
              type: "object",
              required: ["level", "at"],
              additionalProperties: false,
              properties: {
                level: {
                  type: "string",
                },
                at: {
                  type: "array",
                  items: {
                    type: "integer",
                  },
                  minItems: 2,
                  maxItems: 2,
                  description: "[x, y] cell coordinates (x east, y south).",
                },
              },
            },
            to: {
              type: "object",
              required: ["level"],
              additionalProperties: false,
              properties: {
                level: {
                  type: "string",
                },
                at: {
                  type: "array",
                  items: {
                    type: "integer",
                  },
                  minItems: 2,
                  maxItems: 2,
                  description: "[x, y] cell coordinates (x east, y south).",
                },
              },
            },
            dir: {
              type: "string",
              enum: ["N", "E", "S", "W"],
              description: "Stairs/ramp only: the way the run climbs from the foot (from.at).",
            },
            width: {
              type: "integer",
              enum: [1, 2],
            },
            label: {
              type: "string",
            },
            notes: {
              type: "string",
            },
          },
        },
        level: {
          type: "object",
          required: ["id", "name", "elevation", "bounds", "base"],
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]{0,31}$",
              description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
            },
            name: {
              type: "string",
            },
            elevation: {
              type: "number",
              description:
                "Base of the floor in tiles. For levels stacked over each other (a dungeon of rooms above rooms) space them 4 apart for the usual 2-tall walls (wall height + 0.5 floor + 1 of air), so a player sees clear air between the wall tops and the floor above; a level under another at 2.5 has walls touching the ceiling. A stairs link grows by a cell per tile, so 4 apart means a 4-cell run. Let the levels overlap in plan (a hall over a crypt, cells under a guard room) and join them with a floor_opening terrain op as well as stairs.",
            },
            wallHeight: {
              type: "number",
              description: "Tiles (1 = 5 ft), multiple of 0.25.",
            },
            bounds: {
              type: "object",
              required: ["x", "y", "w", "h"],
              additionalProperties: false,
              properties: {
                x: {
                  type: "integer",
                },
                y: {
                  type: "integer",
                },
                w: {
                  type: "integer",
                },
                h: {
                  type: "integer",
                },
              },
            },
            foundation: {
              type: "number",
              description:
                "Depth of the solid base under the level's edge, tiles 0..4 (default 2 on open-air levels, 0 otherwise).",
            },
            outline: {
              type: "string",
              enum: ["natural", "rect"],
              description:
                "The board's edge (generator 2). natural (default on open-air natural levels at least 16x16 with no roads and fewer than 3 buildings): a ragged, rounded edge with a low strip round the outside. Choose rect for built-up maps (streets, towns), a map that must tile against another, or when the GM asks for a full rectangle.",
            },
            roomDress: {
              const: false,
              description:
                "Generator 4. false turns off the default dressing of rooms (a room whose name, tags or notes say its purpose, with no dress op over it and little furniture of its own, is furnished and lit from that purpose). Leave it out.",
            },
            light: {
              type: "string",
              enum: ["dark", "dim", "moderate", "bright", "flooded"],
              description:
                "Generator 5: how many lights mark the place in use, dark (none) to flooded; not the board's brightness. Omitted = read from its words, else the place around it.",
            },
            condition: {
              type: "string",
              enum: ["intact", "weathered", "ramshackle", "ruined"],
              description:
                "Generator 5: how kept the place is (a ruined room is rubble, sparsely dressed). Omitted = read from its words, else the place around it.",
            },
            wealth: {
              type: "string",
              enum: ["poor", "modest", "wealthy", "lavish"],
              description:
                "Generator 5: how plain or rich its trims and contents are. Omitted = read from its words, else the place around it.",
            },
            base: {
              oneOf: [
                {
                  type: "object",
                  required: ["type"],
                  additionalProperties: false,
                  properties: {
                    type: {
                      const: "solid",
                    },
                  },
                },
                {
                  type: "object",
                  required: ["type"],
                  additionalProperties: false,
                  properties: {
                    type: {
                      const: "void",
                    },
                  },
                },
                {
                  type: "object",
                  required: ["type", "material"],
                  additionalProperties: false,
                  properties: {
                    type: {
                      const: "ground",
                    },
                    material: {
                      type: "string",
                      enum: [
                        "flagstone",
                        "stone_tile",
                        "marble",
                        "brick",
                        "cobble",
                        "wood_plank",
                        "carpet",
                        "rock",
                        "dirt",
                        "grass",
                        "sand",
                        "gravel",
                        "mud",
                        "snow",
                        "ice",
                        "swamp",
                        "water_shallow",
                        "water_deep",
                        "lava",
                        "bridge_wood",
                        "asphalt",
                        "concrete",
                      ],
                    },
                    layer: {
                      type: "string",
                      enum: ["under", "over"],
                      description:
                        "under (default) = applied before the areas: paint/noise/path under are replaced wherever an area sets its floor (use under for outdoor ground and roads); a height op under sets the ground height that areas without floorHeight inherit. over = applied after the areas, on their floor (water or lava in a cave, a dais or pit inside a room).",
                    },
                  },
                },
              ],
            },
            theme: {
              type: "string",
            },
            areas: {
              type: "array",
              items: {
                $ref: "#/$defs/area",
              },
            },
            openings: {
              type: "array",
              items: {
                $ref: "#/$defs/opening",
              },
            },
            walls: {
              type: "array",
              items: {
                $ref: "#/$defs/wallRun",
              },
            },
            features: {
              type: "array",
              items: {
                $ref: "#/$defs/feature",
              },
            },
            terrain: {
              type: "array",
              items: {
                $ref: "#/$defs/terrain",
              },
            },
            labels: {
              type: "array",
              items: {
                $ref: "#/$defs/label",
              },
            },
            structures: {
              type: "array",
              items: {
                $ref: "#/$defs/structure",
              },
              maxItems: 32,
            },
            stalls: {
              type: "array",
              maxItems: 8,
              description:
                'Generator 3. Rows or clusters of market stalls, laid out for you in a rectangle whose long side is the row, kinds from `goods` in shuffled order; cells already taken (a well, a building) are skipped. Generator 4: covered stalls that differ: small 2x3, medium 3x3, large 4x4 (and 4x3, 3x2, 2x2), a raised base, skirted counters with a walk-in gap or goods trays, corner posts, a gable or flat cloth canopy, a stool and a lantern, an empty one when `goods` has "empty", a few open tables, loose gaps and the odd turned stall. Two rows face each other across the aisle when the rectangle is at least aisle + 4 deep (aisle + 6 for full-size stalls), else one row up to 4 deep faces `facing`. A theme without canopy pieces builds generator 3\'s stalls. Keep overhead lines along the aisle or street: a line through a covered stall is dropped. Generator 3: tables 2 cells wide, spaced irregularly, two rows from aisle + 2 deep; fruit, vegetables, spices, magic and weapons use the theme\'s stall pieces, the rest a bare table with bread, dairy, fish, potions or grain on it. Example: {"id": "market", "area": {"x": 17, "y": 6, "w": 14, "h": 7}, "goods": ["fruit", "bread", "potions", "vegetables"]}. A single stall: a feature of type stall with variant = the kind. Do not dress the same square with the plaza preset: it plants trees and seats in the aisle.',
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "area"],
                properties: {
                  id: {
                    type: "string",
                  },
                  area: {
                    type: "object",
                    additionalProperties: false,
                    required: ["x", "y", "w", "h"],
                    properties: {
                      x: {
                        type: "integer",
                      },
                      y: {
                        type: "integer",
                      },
                      w: {
                        type: "integer",
                      },
                      h: {
                        type: "integer",
                      },
                    },
                  },
                  goods: {
                    type: "array",
                    items: {
                      type: "string",
                      enum: [
                        "fruit",
                        "vegetables",
                        "spices",
                        "magic",
                        "weapons",
                        "empty",
                        "bread",
                        "dairy",
                        "fish",
                        "potions",
                        "grain",
                      ],
                    },
                    description: "Kinds on offer; default fruit, vegetables, bread, dairy, potions, spices.",
                  },
                  facing: {
                    type: "string",
                    enum: ["N", "E", "S", "W"],
                    description: "The side a lone row faces (default S).",
                  },
                  count: {
                    type: "integer",
                    description: "Most stalls (default: as many as fit).",
                  },
                  aisle: {
                    type: "integer",
                    description: "Clear aisle between two rows, 1 to 4 cells (default 2).",
                  },
                  seed: {
                    type: "integer",
                  },
                },
              },
            },
            lines: {
              type: "array",
              maxItems: 12,
              description:
                'Generator 3. A line strung overhead between two cells on one row or column: lanterns (rope with lanterns hung along it), lights (a string of lights) or flags (rope with cloth flags; the data has no bunting piece). Each end is anchored on a building wall within 3 cells beyond it, else on a post the generator stands there; the line hangs `height` tiles up (2 to 3, default 2.6, clear of shop awnings). A wall shorter than the line cannot hold it: the build warns (verify_line_unanchored) and the pieces float, so end such a line on a post or pick taller buildings. Generator 5: a line over the canopy or awning of a shop front is raised above it, or dropped (line_unanchored) when its walls cannot hold it that high, so end it clear of such fronts. Example across a street between facing buildings: {"id": "across1", "from": [12, 14], "to": [12, 22], "kind": "lanterns"}. Lines over a street are the way to light it from above; do not float lanterns with lift.',
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "from", "to"],
                properties: {
                  id: {
                    type: "string",
                  },
                  from: {
                    type: "array",
                    items: {
                      type: "integer",
                    },
                    minItems: 2,
                    maxItems: 2,
                  },
                  to: {
                    type: "array",
                    items: {
                      type: "integer",
                    },
                    minItems: 2,
                    maxItems: 2,
                  },
                  kind: {
                    type: "string",
                    enum: ["lanterns", "lights", "flags"],
                  },
                  height: {
                    type: "number",
                  },
                  spacing: {
                    type: "integer",
                    description: "Cells between hung pieces, 2 to 6 (default 3).",
                  },
                },
              },
            },
            notes: {
              type: "string",
            },
          },
        },
        structure: {
          type: "object",
          required: ["id"],
          additionalProperties: false,
          description:
            'A building (kind omitted) or a yard (kind "enclosure"). Buildings: wings, volumes or footprint; everything else comes from the style, the use and the seed unless given (one wing with no storeys list and no roof lets the style draw the whole design). Example: {"id": "bakery", "style": "modern_block", "use": "shop", "front": "S", "wings": [{"x": 4, "y": 2, "w": 7, "h": 8}]}; bare x, y, w, h on the building are read as that one wing.',
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]{0,31}$",
              description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
            },
            kind: {
              type: "string",
              enum: ["building", "enclosure"],
            },
            name: {
              type: "string",
            },
            key: {
              type: "string",
              description: "Room-key label of the building's ground storey / yard.",
            },
            theme: {
              type: "string",
            },
            notes: {
              type: "string",
            },
            style: {
              type: "string",
              description:
                'Style profile: cottage: timber walls on a stone footing, pitched slate roof on an attic deck, windows every few cells, a light by the door; keep: thick stone walls, few narrow windows, flat roof with a stone parapet, battlemented ledges where storeys step in; tower: tall and narrow stone storeys, sparse windows, a spire; wizard_tower: a slender tapering shaft (grey stone, red brick on a stone foot, sandstone or dark stone), a lantern room under a steep spire with a finial or a magic orb (the lantern sometimes half-timbered), bartizans or a stair turret, glowing windows, on a raised rocky base; ruin: an old building fallen to ruin (for a ruined tower, cottage, keep or warehouse use that style with condition "ruined" instead, so it keeps its kind); modern: plain panel walls, many large windows, flat roof with a low parapet; modern_block: a city building drawn from many shapes (plain block, set-back top, podium and tower, twin heights, corner L, stepped, low shed) in brick, concrete, metal or panel, with a shopfront, stoop or garage at street level, varied windows, flat parapet roofs with a hut, plant, mast or terrace; desert: plastered walls, few small windows, flat roof with a low parapet. Default cottage.',
            },
            seed: {
              type: "integer",
              description:
                "Another seed gives another variant of the same spec (door slide, windows, porch, chimney).",
            },
            wings: {
              type: "array",
              maxItems: 8,
              items: {
                type: "object",
                required: ["x", "y", "w", "h"],
                additionalProperties: false,
                properties: {
                  x: {
                    type: "integer",
                  },
                  y: {
                    type: "integer",
                  },
                  w: {
                    type: "integer",
                  },
                  h: {
                    type: "integer",
                  },
                  ridge: {
                    type: "string",
                    enum: ["ew", "ns"],
                  },
                },
              },
              description:
                "Rectangles whose union is the footprint (an L or T is two wings); each gets its own roof ridge (default along its longer side).",
            },
            footprint: {
              $ref: "#/$defs/shape",
              description: "Any other ground plan (round, polygonal); built with a flat roof for now.",
            },
            storeys: {
              oneOf: [
                {
                  type: "integer",
                  description: "1..12",
                },
                {
                  type: "array",
                  maxItems: 12,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      walls: {
                        type: "string",
                        enum: [
                          "wall",
                          "stone",
                          "brick",
                          "wood",
                          "cave_rock",
                          "plaster",
                          "palisade",
                          "fence",
                          "hedge",
                          "low_wall",
                          "railing",
                          "iron_bars",
                          "ruined",
                          "railing_stone",
                          "concrete",
                          "metal",
                          "panel",
                          "marble",
                          "dark_stone",
                          "timber",
                          "none",
                        ],
                      },
                      footing: {
                        type: "string",
                        enum: [
                          "wall",
                          "stone",
                          "brick",
                          "wood",
                          "cave_rock",
                          "plaster",
                          "palisade",
                          "fence",
                          "hedge",
                          "low_wall",
                          "railing",
                          "iron_bars",
                          "ruined",
                          "railing_stone",
                          "concrete",
                          "metal",
                          "panel",
                          "marble",
                          "dark_stone",
                          "timber",
                          "none",
                        ],
                        description: "ground storey only: a lower course (stone under timber)",
                      },
                      floor: {
                        type: "string",
                        enum: [
                          "flagstone",
                          "stone_tile",
                          "marble",
                          "brick",
                          "cobble",
                          "wood_plank",
                          "carpet",
                          "rock",
                          "dirt",
                          "grass",
                          "sand",
                          "gravel",
                          "mud",
                          "snow",
                          "ice",
                          "swamp",
                          "water_shallow",
                          "water_deep",
                          "lava",
                          "bridge_wood",
                          "asphalt",
                          "concrete",
                        ],
                      },
                      windows: {
                        type: "string",
                        enum: ["none", "sparse", "regular", "dense"],
                      },
                      height: {
                        type: "number",
                        description: "this storey's wall height, 1..8 tiles",
                      },
                      inset: {
                        type: "integer",
                        description: "0..2 cells this storey steps in from the one below on every side",
                      },
                      seam: {
                        type: "string",
                        enum: ["skirt", "plain", "crenellated"],
                        description: "the ledge a set-in leaves: roofed, plain or battlemented",
                      },
                    },
                  },
                },
              ],
            },
            storeyHeight: {
              type: "number",
              description:
                "wall height of each storey in tiles, 1..8 in steps of 0.25 (default from the style)",
            },
            volumes: {
              type: "array",
              maxItems: 8,
              items: {
                type: "object",
                required: ["id", "x", "y", "w", "h"],
                additionalProperties: false,
                properties: {
                  id: {
                    type: "string",
                    description: "short volume id, unique in the building",
                  },
                  x: {
                    type: "integer",
                  },
                  y: {
                    type: "integer",
                  },
                  w: {
                    type: "integer",
                  },
                  h: {
                    type: "integer",
                  },
                  on: {
                    type: "string",
                    description: "id of the volume it stands on",
                  },
                  storeys: {
                    oneOf: [
                      {
                        type: "integer",
                        description: "1..12",
                      },
                      {
                        type: "array",
                        maxItems: 12,
                        items: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            walls: {
                              type: "string",
                              enum: [
                                "wall",
                                "stone",
                                "brick",
                                "wood",
                                "cave_rock",
                                "plaster",
                                "palisade",
                                "fence",
                                "hedge",
                                "low_wall",
                                "railing",
                                "iron_bars",
                                "ruined",
                                "railing_stone",
                                "concrete",
                                "metal",
                                "panel",
                                "marble",
                                "dark_stone",
                                "timber",
                                "none",
                              ],
                            },
                            footing: {
                              type: "string",
                              enum: [
                                "wall",
                                "stone",
                                "brick",
                                "wood",
                                "cave_rock",
                                "plaster",
                                "palisade",
                                "fence",
                                "hedge",
                                "low_wall",
                                "railing",
                                "iron_bars",
                                "ruined",
                                "railing_stone",
                                "concrete",
                                "metal",
                                "panel",
                                "marble",
                                "dark_stone",
                                "timber",
                                "none",
                              ],
                              description: "ground storey only: a lower course (stone under timber)",
                            },
                            floor: {
                              type: "string",
                              enum: [
                                "flagstone",
                                "stone_tile",
                                "marble",
                                "brick",
                                "cobble",
                                "wood_plank",
                                "carpet",
                                "rock",
                                "dirt",
                                "grass",
                                "sand",
                                "gravel",
                                "mud",
                                "snow",
                                "ice",
                                "swamp",
                                "water_shallow",
                                "water_deep",
                                "lava",
                                "bridge_wood",
                                "asphalt",
                                "concrete",
                              ],
                            },
                            windows: {
                              type: "string",
                              enum: ["none", "sparse", "regular", "dense"],
                            },
                            height: {
                              type: "number",
                              description: "this storey's wall height, 1..8 tiles",
                            },
                            inset: {
                              type: "integer",
                              description: "0..2 cells this storey steps in from the one below on every side",
                            },
                            seam: {
                              type: "string",
                              enum: ["skirt", "plain", "crenellated"],
                              description: "the ledge a set-in leaves: roofed, plain or battlemented",
                            },
                          },
                        },
                      },
                    ],
                  },
                  storeyHeight: {
                    type: "number",
                  },
                  corners: {
                    type: "string",
                    enum: ["square", "chamfer"],
                  },
                  roof: {
                    oneOf: [
                      {
                        const: "none",
                      },
                      {
                        type: "object",
                        required: ["type"],
                        additionalProperties: false,
                        properties: {
                          type: {
                            type: "string",
                            enum: [
                              "gable",
                              "flat",
                              "none",
                              "hip",
                              "shed",
                              "cone",
                              "dome",
                              "skirt",
                              "stepped",
                              "spire",
                              "vault",
                            ],
                            description:
                              "built: gable, hip, shed, flat, skirt (mansard ring), stepped, spire (cone builds as spire), none; dome and vault are built flat for now",
                          },
                          layers: {
                            type: "array",
                            maxItems: 4,
                            items: {
                              type: "object",
                              required: ["type"],
                              additionalProperties: false,
                              properties: {
                                type: {
                                  type: "string",
                                  enum: [
                                    "gable",
                                    "flat",
                                    "none",
                                    "hip",
                                    "shed",
                                    "cone",
                                    "dome",
                                    "skirt",
                                    "stepped",
                                    "spire",
                                    "vault",
                                  ],
                                  description:
                                    "built: gable, hip, shed, flat, skirt (mansard ring), stepped, spire (cone builds as spire), none; dome and vault are built flat for now",
                                },
                                style: {
                                  type: "string",
                                },
                                ridge: {
                                  type: "string",
                                  enum: ["ew", "ns"],
                                },
                                courses: {
                                  type: "integer",
                                  description: "skirt, stepped: rings (1..6); spire: flared bands",
                                },
                                low: {
                                  type: "string",
                                  enum: ["N", "E", "S", "W"],
                                },
                                parapet: {
                                  type: "string",
                                  enum: [
                                    "wall",
                                    "stone",
                                    "brick",
                                    "wood",
                                    "cave_rock",
                                    "plaster",
                                    "palisade",
                                    "fence",
                                    "hedge",
                                    "low_wall",
                                    "railing",
                                    "iron_bars",
                                    "ruined",
                                    "railing_stone",
                                    "concrete",
                                    "metal",
                                    "panel",
                                    "marble",
                                    "dark_stone",
                                    "timber",
                                    "none",
                                  ],
                                },
                              },
                            },
                            description:
                              "Stacked roof strategies, bottom first, each on the flat top the one below leaves (skirt then spire; stepped then flat).",
                          },
                          courses: {
                            type: "integer",
                            description: "skirt, stepped: rings (1..6); spire: flared bands",
                          },
                          low: {
                            type: "string",
                            enum: ["N", "E", "S", "W"],
                            description: "shed: the side the roof falls to",
                          },
                          ridge: {
                            type: "string",
                            enum: ["ew", "ns"],
                          },
                          style: {
                            type: "string",
                            description: "roof kit, e.g. slate",
                          },
                          deck: {
                            type: "boolean",
                          },
                          broken: {
                            type: "number",
                            description: "0..0.6 fraction of roof built broken (ruins); default 0",
                          },
                          parapet: {
                            type: "string",
                            enum: [
                              "wall",
                              "stone",
                              "brick",
                              "wood",
                              "cave_rock",
                              "plaster",
                              "palisade",
                              "fence",
                              "hedge",
                              "low_wall",
                              "railing",
                              "iron_bars",
                              "ruined",
                              "railing_stone",
                              "concrete",
                              "metal",
                              "panel",
                              "marble",
                              "dark_stone",
                              "timber",
                              "none",
                            ],
                          },
                        },
                      },
                    ],
                  },
                  ridge: {
                    type: "string",
                    enum: ["ew", "ns"],
                  },
                },
              },
              description:
                "Massing: blocks of different heights instead of wings, e.g. a tall tenement beside a low warehouse. Each has its own storeys, storeyHeight and roof; on: the volume it stands on (a tower on a hall). The ground volumes together are the ground storey.",
            },
            plinth: {
              type: "object",
              required: ["height"],
              additionalProperties: false,
              description: "A raised base under the building (a crag, a podium) with steps to every door.",
              properties: {
                height: {
                  type: "number",
                  description: "0.5..6 tiles",
                },
                margin: {
                  type: "integer",
                  description: "cells of base round the walls, 1..4",
                },
                face: {
                  type: "string",
                  enum: [
                    "flagstone",
                    "stone_tile",
                    "marble",
                    "brick",
                    "cobble",
                    "wood_plank",
                    "carpet",
                    "rock",
                    "dirt",
                    "grass",
                    "sand",
                    "gravel",
                    "mud",
                    "snow",
                    "ice",
                    "swamp",
                    "water_shallow",
                    "water_deep",
                    "lava",
                    "bridge_wood",
                    "asphalt",
                    "concrete",
                  ],
                },
                rim: {
                  type: "string",
                  enum: [
                    "wall",
                    "stone",
                    "brick",
                    "wood",
                    "cave_rock",
                    "plaster",
                    "palisade",
                    "fence",
                    "hedge",
                    "low_wall",
                    "railing",
                    "iron_bars",
                    "ruined",
                    "railing_stone",
                    "concrete",
                    "metal",
                    "panel",
                    "marble",
                    "dark_stone",
                    "timber",
                    "none",
                  ],
                },
                approach: {
                  type: "string",
                  enum: ["steps", "none"],
                },
              },
            },
            corners: {
              type: "string",
              enum: ["square", "chamfer"],
              description: "chamfer cuts the outer corners of every storey",
            },
            roof: {
              oneOf: [
                {
                  const: "none",
                },
                {
                  type: "object",
                  required: ["type"],
                  additionalProperties: false,
                  properties: {
                    type: {
                      type: "string",
                      enum: [
                        "gable",
                        "flat",
                        "none",
                        "hip",
                        "shed",
                        "cone",
                        "dome",
                        "skirt",
                        "stepped",
                        "spire",
                        "vault",
                      ],
                      description:
                        "built: gable, hip, shed, flat, skirt (mansard ring), stepped, spire (cone builds as spire), none; dome and vault are built flat for now",
                    },
                    layers: {
                      type: "array",
                      maxItems: 4,
                      items: {
                        type: "object",
                        required: ["type"],
                        additionalProperties: false,
                        properties: {
                          type: {
                            type: "string",
                            enum: [
                              "gable",
                              "flat",
                              "none",
                              "hip",
                              "shed",
                              "cone",
                              "dome",
                              "skirt",
                              "stepped",
                              "spire",
                              "vault",
                            ],
                            description:
                              "built: gable, hip, shed, flat, skirt (mansard ring), stepped, spire (cone builds as spire), none; dome and vault are built flat for now",
                          },
                          style: {
                            type: "string",
                          },
                          ridge: {
                            type: "string",
                            enum: ["ew", "ns"],
                          },
                          courses: {
                            type: "integer",
                            description: "skirt, stepped: rings (1..6); spire: flared bands",
                          },
                          low: {
                            type: "string",
                            enum: ["N", "E", "S", "W"],
                          },
                          parapet: {
                            type: "string",
                            enum: [
                              "wall",
                              "stone",
                              "brick",
                              "wood",
                              "cave_rock",
                              "plaster",
                              "palisade",
                              "fence",
                              "hedge",
                              "low_wall",
                              "railing",
                              "iron_bars",
                              "ruined",
                              "railing_stone",
                              "concrete",
                              "metal",
                              "panel",
                              "marble",
                              "dark_stone",
                              "timber",
                              "none",
                            ],
                          },
                        },
                      },
                      description:
                        "Stacked roof strategies, bottom first, each on the flat top the one below leaves (skirt then spire; stepped then flat).",
                    },
                    courses: {
                      type: "integer",
                      description: "skirt, stepped: rings (1..6); spire: flared bands",
                    },
                    low: {
                      type: "string",
                      enum: ["N", "E", "S", "W"],
                      description: "shed: the side the roof falls to",
                    },
                    ridge: {
                      type: "string",
                      enum: ["ew", "ns"],
                    },
                    style: {
                      type: "string",
                      description: "roof kit, e.g. slate",
                    },
                    deck: {
                      type: "boolean",
                    },
                    broken: {
                      type: "number",
                      description: "0..0.6 fraction of roof built broken (ruins); default 0",
                    },
                    parapet: {
                      type: "string",
                      enum: [
                        "wall",
                        "stone",
                        "brick",
                        "wood",
                        "cave_rock",
                        "plaster",
                        "palisade",
                        "fence",
                        "hedge",
                        "low_wall",
                        "railing",
                        "iron_bars",
                        "ruined",
                        "railing_stone",
                        "concrete",
                        "metal",
                        "panel",
                        "marble",
                        "dark_stone",
                        "timber",
                        "none",
                      ],
                    },
                  },
                },
              ],
            },
            roofFurniture: {
              type: "object",
              additionalProperties: false,
              description: "Override the style's roof furniture.",
              properties: {
                dormers: {
                  type: "boolean",
                },
                clutter: {
                  type: "number",
                  description: "0..0.5 share of a flat roof covered by vents, crates and the like",
                },
                mast: {
                  type: "boolean",
                },
                finial: {
                  type: "boolean",
                },
                hut: {
                  type: "boolean",
                  description: "a stair hut on a flat roof",
                },
              },
            },
            x: {
              type: "integer",
              description: "shorthand: x, y, w, h = wings [{x, y, w, h}]",
            },
            y: {
              type: "integer",
            },
            w: {
              type: "integer",
            },
            h: {
              type: "integer",
            },
            character: {
              type: "array",
              maxItems: 4,
              items: {
                type: "string",
                enum: ["twisted", "leaning", "crooked", "top_heavy", "squat", "slender"],
              },
              description:
                "How the request's adjectives bend the form (combines with condition): twisted = the shaft's storeys step round its axis in turn (a corkscrew), each overhang on a corbel; leaning = storeys step one way; crooked = small random offsets, uneven storeys; top_heavy = upper storeys wider; squat / slender. Leave storeys, roof and volumes unset so the style can draw it.",
            },
            light: {
              type: "string",
              enum: ["dark", "dim", "moderate", "bright", "flooded"],
              description:
                "Generator 5: how many lights mark the place in use, dark (none) to flooded; not the board's brightness. Omitted = read from its words, else the place around it.",
            },
            condition: {
              type: "string",
              enum: ["intact", "weathered", "ramshackle", "ruined"],
              description:
                "State: words in the request about it must be honoured (ruined, abandoned, burnt → ruined; worn, old, overgrown → weathered). Ruined: falls away from one standing corner (low wall stubs against a tall remnant, ragged tops, holed floors, roof fallen in, a gable wall may stand), breaches, rubble mostly inside, no lights. Weathered: whole, with a patch of roof fallen in, most windows dark, growth and rubble at its foot. Generator 5: ramshackle (older generators build it weathered) is a patched roof, boarded windows, a lean-to, and ramshackle words in its name, tags or notes make an intact or weathered building so too; a ruin loses a few whole bays, and crumbling or collapsed in its words make it a lighter or a heavier one.",
            },
            wealth: {
              type: "string",
              enum: ["poor", "modest", "wealthy", "lavish"],
              description:
                "Generator 5: how plain or rich its trims and contents are. Omitted = read from its words, else the place around it.",
            },
            growth: {
              type: "string",
              enum: ["none", "light", "medium", "heavy"],
              description:
                "How overgrown a weathered or ruined building is. light (the weathered default): a few vines, a bush or two at the foot. medium (the ruined default): vines on about a fifth of the wall. heavy: vines and creepers climbing from the ground on a third to half of the walls, bushes at the wall feet and inside, plants on the wall tops, a tree in a roofless part. Words overgrown, ivy-covered, reclaimed, abandoned, nature taking it back → heavy.",
            },
            use: {
              type: "string",
              description:
                "What the building is for (shop, apartments, office, warehouse, garage, townhouse, diner, civic, workshop; shack, farmhouse, tavern …). Leave shape and looks to the style and set a different use per building: the style draws silhouette, material, roof, windows and street level from it. Generator 3 cottages know trades: baker, smith, shop (store, general, grocer), butcher, apothecary (herbalist), cobbler, tailor, inn (tavern): each gets a glazed shop front with a sign, a tent-cloth awning over it and a few trade props outside the door (sacks, anvil, crates, barrels, benches). Neighbours that share a wall stand wing to wing; vary wing depth by a cell so the street front is not a ruler line. Generator 5: the use also picks the ground storey's rooms (an inn's taproom and kitchen, a shop floor and store, a workshop, a shrine, a guardroom and armoury, a store room and office, else a home).",
            },
            front: {
              type: "string",
              enum: ["N", "E", "S", "W"],
              description:
                "The face toward the street or square: door, shopfront and entrance lights go there. Default: the face onto the most open ground.",
            },
            shopfront: {
              type: "boolean",
              description:
                "ground storey on the front face as a shopfront (wide glazing, sign band). Works on cottage and the other styles too (generator 3: corner cells keep their wall); a trade `use` sets it for you.",
            },
            lighting: {
              type: "object",
              additionalProperties: false,
              description: "Override the style's lights.",
              properties: {
                windows: {
                  type: "string",
                  enum: ["none", "warm", "glow"],
                  description: "lit windows: warm room light or a magical glow",
                },
                colour: {
                  type: "string",
                  description: "glow colour, e.g. violet",
                },
                doors: {
                  type: "boolean",
                  description: "a light beside every door",
                },
                strips: {
                  type: "boolean",
                  description: "light strips flanking the main entrance",
                },
              },
            },
            openings: {
              type: "array",
              maxItems: 32,
              items: {
                type: "object",
                required: ["kind", "side"],
                additionalProperties: false,
                properties: {
                  kind: {
                    type: "string",
                    enum: [
                      "door",
                      "double_door",
                      "locked_door",
                      "secret_door",
                      "portcullis",
                      "archway",
                      "open",
                      "window",
                      "arrow_slit",
                      "bars",
                    ],
                  },
                  side: {
                    type: "string",
                    enum: ["N", "E", "S", "W"],
                  },
                  position: {
                    type: "number",
                    description: "0..1 along that face",
                  },
                  storey: {
                    type: "integer",
                  },
                  width: {
                    type: "integer",
                    enum: [1, 2, 3],
                  },
                },
              },
              description:
                "Doors, windows, arches by face. Without a door the building gets one on a face the seed picks.",
            },
            windows: {
              type: "string",
              enum: ["none", "sparse", "regular", "dense"],
            },
            chimneys: {
              type: "array",
              maxItems: 4,
              items: {
                type: "object",
                required: ["side"],
                additionalProperties: false,
                properties: {
                  side: {
                    type: "string",
                    enum: ["N", "E", "S", "W"],
                  },
                  position: {
                    type: "number",
                  },
                },
              },
              description:
                "Chimney breasts in the wall line (on a gable end for a pitched roof); [] for none.",
            },
            attachments: {
              type: "array",
              maxItems: 8,
              items: {
                type: "object",
                required: ["type", "side"],
                additionalProperties: false,
                properties: {
                  type: {
                    type: "string",
                    enum: ["porch", "lean_to", "balcony", "outside_stairs"],
                    description: "built today: porch",
                  },
                  side: {
                    type: "string",
                    enum: ["N", "E", "S", "W"],
                  },
                  position: {
                    type: "number",
                  },
                  width: {
                    type: "integer",
                  },
                  depth: {
                    type: "integer",
                  },
                  floor: {
                    type: "string",
                    enum: [
                      "flagstone",
                      "stone_tile",
                      "marble",
                      "brick",
                      "cobble",
                      "wood_plank",
                      "carpet",
                      "rock",
                      "dirt",
                      "grass",
                      "sand",
                      "gravel",
                      "mud",
                      "snow",
                      "ice",
                      "swamp",
                      "water_shallow",
                      "water_deep",
                      "lava",
                      "bridge_wood",
                      "asphalt",
                      "concrete",
                    ],
                  },
                  roof: {
                    type: "string",
                    enum: ["flat", "none"],
                  },
                },
              },
            },
            readAloud: {
              type: "string",
            },
            encounter: {
              type: "string",
            },
            tags: {
              type: "array",
              items: {
                type: "string",
              },
            },
            shape: {
              $ref: "#/$defs/shape",
              description: "enclosure: the yard",
            },
            wall: {
              type: "string",
              enum: [
                "wall",
                "stone",
                "brick",
                "wood",
                "cave_rock",
                "plaster",
                "palisade",
                "fence",
                "hedge",
                "low_wall",
                "railing",
                "iron_bars",
                "ruined",
                "railing_stone",
                "concrete",
                "metal",
                "panel",
                "marble",
                "dark_stone",
                "timber",
                "none",
              ],
              description: "enclosure: fence style (default fence)",
            },
            gates: {
              type: "array",
              maxItems: 8,
              items: {
                type: "object",
                required: ["side"],
                additionalProperties: false,
                properties: {
                  side: {
                    type: "string",
                    enum: ["N", "E", "S", "W"],
                  },
                  position: {
                    type: "number",
                  },
                  width: {
                    type: "integer",
                    enum: [1, 2, 3],
                  },
                },
              },
            },
            floor: {
              type: "string",
              enum: [
                "flagstone",
                "stone_tile",
                "marble",
                "brick",
                "cobble",
                "wood_plank",
                "carpet",
                "rock",
                "dirt",
                "grass",
                "sand",
                "gravel",
                "mud",
                "snow",
                "ice",
                "swamp",
                "water_shallow",
                "water_deep",
                "lava",
                "bridge_wood",
                "asphalt",
                "concrete",
              ],
              description: "enclosure: yard floor",
            },
          },
        },
      },
    },
  },
  {
    name: "edit_plan",
    streamInput: true,
    description:
      "Change the existing plan with a batch of operations applied in order as ONE transaction: if any op or the resulting plan is invalid, nothing is applied and you get every problem with hints — fix them and call edit_plan again. Use for every change after the first draft: add/update/remove/move/duplicate elements by id, reshape areas, materialize generated features. Group related changes into one call. baseVersion must be the current plan version.",
    inputSchema: {
      type: "object",
      required: ["baseVersion", "summary", "changes", "ops"],
      additionalProperties: false,
      properties: {
        baseVersion: {
          type: "integer",
        },
        summary: {
          type: "string",
          description: "≤ 80 chars, becomes the version label.",
        },
        changes: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 6,
          description: "≤ 6 short bullets describing what changed, naming rooms by key.",
        },
        ops: {
          type: "array",
          items: {
            $ref: "#/$defs/op",
          },
          minItems: 1,
          maxItems: 100,
        },
      },
      $defs: {
        shape: {
          description:
            "Cell-set shape. A cell is inside iff its center is inside. Prefer rect for rooms, route for corridors, cave/blob for organic spaces.",
          oneOf: [
            {
              type: "object",
              required: ["type", "x", "y", "w", "h"],
              additionalProperties: false,
              properties: {
                type: {
                  const: "rect",
                },
                x: {
                  type: "integer",
                },
                y: {
                  type: "integer",
                },
                w: {
                  type: "integer",
                },
                h: {
                  type: "integer",
                },
              },
            },
            {
              type: "object",
              required: ["type", "points"],
              additionalProperties: false,
              properties: {
                type: {
                  const: "polygon",
                },
                points: {
                  type: "array",
                  items: {
                    type: "array",
                    items: {
                      type: "integer",
                    },
                    minItems: 2,
                    maxItems: 2,
                    description: "[x, y] grid VERTEX (corner) coordinates.",
                  },
                  minItems: 3,
                  maxItems: 64,
                },
              },
            },
            {
              type: "object",
              required: ["type", "cx", "cy", "r"],
              additionalProperties: false,
              properties: {
                type: {
                  const: "circle",
                },
                cx: {
                  type: "number",
                },
                cy: {
                  type: "number",
                },
                r: {
                  type: "number",
                },
              },
            },
            {
              type: "object",
              required: ["type", "cx", "cy", "rx", "ry"],
              additionalProperties: false,
              properties: {
                type: {
                  const: "ellipse",
                },
                cx: {
                  type: "number",
                },
                cy: {
                  type: "number",
                },
                rx: {
                  type: "number",
                },
                ry: {
                  type: "number",
                },
              },
            },
            {
              type: "object",
              required: ["type", "cx", "cy", "r"],
              additionalProperties: false,
              properties: {
                type: {
                  const: "blob",
                },
                cx: {
                  type: "number",
                },
                cy: {
                  type: "number",
                },
                r: {
                  type: "number",
                },
                roughness: {
                  type: "number",
                  description: "0..1, default 0.35",
                },
                seed: {
                  type: "integer",
                },
              },
            },
            {
              type: "object",
              required: ["type", "x", "y", "w", "h"],
              additionalProperties: false,
              properties: {
                type: {
                  const: "cave",
                },
                x: {
                  type: "integer",
                },
                y: {
                  type: "integer",
                },
                w: {
                  type: "integer",
                },
                h: {
                  type: "integer",
                },
                fill: {
                  type: "number",
                  description: "0.3..0.7, default 0.45",
                },
                steps: {
                  type: "integer",
                  description: "0..8, default 4",
                },
                seed: {
                  type: "integer",
                },
              },
            },
            {
              type: "object",
              required: ["type", "x", "y", "rows"],
              additionalProperties: false,
              properties: {
                type: {
                  const: "cells",
                },
                x: {
                  type: "integer",
                },
                y: {
                  type: "integer",
                },
                rows: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                  maxItems: 64,
                  description: "'#' = in, '.' = out; ≤ 64×64",
                },
              },
            },
            {
              type: "object",
              required: ["type", "points"],
              additionalProperties: false,
              properties: {
                type: {
                  const: "path",
                },
                points: {
                  type: "array",
                  items: {
                    type: "array",
                    items: {
                      type: "integer",
                    },
                    minItems: 2,
                    maxItems: 2,
                    description: "[x, y] cell coordinates (x east, y south).",
                  },
                  minItems: 2,
                },
                width: {
                  type: "integer",
                  description: "1..5, default 1",
                },
              },
              description: "Thick polyline through cell centers; consecutive points axis-aligned.",
            },
            {
              type: "object",
              required: ["type", "from", "to"],
              additionalProperties: false,
              properties: {
                type: {
                  const: "route",
                },
                from: {
                  oneOf: [
                    {
                      type: "string",
                      pattern: "^[a-z][a-z0-9_]{0,31}$",
                      description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                    },
                    {
                      type: "array",
                      items: {
                        type: "integer",
                      },
                      minItems: 2,
                      maxItems: 2,
                      description: "[x, y] cell coordinates (x east, y south).",
                    },
                  ],
                },
                to: {
                  oneOf: [
                    {
                      type: "string",
                      pattern: "^[a-z][a-z0-9_]{0,31}$",
                      description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                    },
                    {
                      type: "array",
                      items: {
                        type: "integer",
                      },
                      minItems: 2,
                      maxItems: 2,
                      description: "[x, y] cell coordinates (x east, y south).",
                    },
                  ],
                },
                width: {
                  type: "integer",
                  enum: [1, 2, 3],
                },
                bend: {
                  type: "string",
                  enum: ["hv", "vh"],
                },
                openings: {
                  type: "string",
                  enum: [
                    "door",
                    "double_door",
                    "locked_door",
                    "secret_door",
                    "portcullis",
                    "archway",
                    "open",
                    "window",
                    "arrow_slit",
                    "bars",
                  ],
                },
              },
              description:
                "L-shaped corridor between two areas (or cells); never overwrites other areas; auto-adds openings where it meets them.",
            },
          ],
        },
        area: {
          type: "object",
          required: ["id", "kind", "shape"],
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]{0,31}$",
              description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
            },
            kind: {
              type: "string",
              enum: ["room", "corridor", "cave", "building", "courtyard", "zone", "bridge"],
              description:
                "zone = names cells only (never changes floor, height or walls). bridge = a walkable deck over a drop: open air under it, railings on the sides facing the drop, deck height = floorHeight or the floor at its ends; list it AFTER the areas it crosses.",
            },
            name: {
              type: "string",
            },
            key: {
              type: "string",
              description: 'Room-key label, e.g. "1" or "A3".',
            },
            shape: {
              $ref: "#/$defs/shape",
            },
            floor: {
              type: "string",
              enum: [
                "flagstone",
                "stone_tile",
                "marble",
                "brick",
                "cobble",
                "wood_plank",
                "carpet",
                "rock",
                "dirt",
                "grass",
                "sand",
                "gravel",
                "mud",
                "snow",
                "ice",
                "swamp",
                "water_shallow",
                "water_deep",
                "lava",
                "bridge_wood",
                "asphalt",
                "concrete",
                "none",
              ],
              description:
                "Omitted = the theme default. Generator 4, a room on a solid-base level: leave it off and the room takes a floor from its purpose in the theme's floor family, unlike its neighbours' where it can; a passage or an abandoned room keeps the default. Name a floor only to choose one (naming the theme default counts as leaving it off).",
            },
            floorHeight: {
              type: "number",
              description:
                "Tiles relative to the level, multiple of 0.25, -4..4 (dais 0.5, pit -1). Omitted = keep the height underneath (e.g. from a height op). Generator 4: a room on a solid-base level that a corridor opens into (an opening, a route ending on it, or no wall between) sits a quarter tile above it when this is omitted; 0 keeps it level.",
            },
            walls: {
              type: "string",
              enum: ["auto", "perimeter", "none"],
            },
            wallStyle: {
              type: "string",
              enum: [
                "wall",
                "stone",
                "brick",
                "wood",
                "cave_rock",
                "plaster",
                "palisade",
                "fence",
                "hedge",
                "low_wall",
                "railing",
                "iron_bars",
                "ruined",
                "railing_stone",
                "concrete",
                "metal",
                "panel",
                "marble",
                "dark_stone",
                "timber",
              ],
            },
            wallHeight: {
              type: "number",
              description: "Tiles (1 = 5 ft), multiple of 0.25.",
            },
            labelAt: {
              type: "array",
              items: {
                type: "integer",
              },
              minItems: 2,
              maxItems: 2,
              description: "[x, y] cell coordinates (x east, y south).",
            },
            theme: {
              type: "string",
            },
            notes: {
              type: "string",
            },
            readAloud: {
              type: "string",
              description: "Boxed text read to players on entry.",
            },
            encounter: {
              type: "string",
              description: "Encounter line(s) in the brief's game system.",
            },
            tags: {
              type: "array",
              items: {
                type: "string",
              },
            },
            purpose: {
              type: "string",
              enum: [
                "tavern",
                "dining",
                "kitchen",
                "library",
                "study",
                "armoury",
                "barracks",
                "bedroom",
                "storeroom",
                "shrine",
                "crypt",
                "prison",
                "forge",
                "laboratory",
                "treasury",
                "washroom",
                "throne_room",
                "ruin",
                "passage",
              ],
              description:
                "Generator 4: set it only when the name does not say what the room is for; it wins over the name, tags and notes. Generator 5: the name also picks kinds this list lacks (shop, stable, lounge or parlour, classroom, command, ward or infirmary); leave purpose off for those.",
            },
            light: {
              type: "string",
              enum: ["dark", "dim", "moderate", "bright", "flooded"],
              description:
                "Generator 5: how many lights mark the place in use, dark (none) to flooded; not the board's brightness. Omitted = read from its words, else the place around it.",
            },
            condition: {
              type: "string",
              enum: ["intact", "weathered", "ramshackle", "ruined"],
              description:
                "Generator 5: how kept the place is (a ruined room is rubble, sparsely dressed). Omitted = read from its words, else the place around it.",
            },
            wealth: {
              type: "string",
              enum: ["poor", "modest", "wealthy", "lavish"],
              description:
                "Generator 5: how plain or rich its trims and contents are. Omitted = read from its words, else the place around it.",
            },
            railing: {
              type: "string",
              enum: [
                "wall",
                "stone",
                "brick",
                "wood",
                "cave_rock",
                "plaster",
                "palisade",
                "fence",
                "hedge",
                "low_wall",
                "railing",
                "iron_bars",
                "ruined",
                "railing_stone",
                "concrete",
                "metal",
                "panel",
                "marble",
                "dark_stone",
                "timber",
                "none",
              ],
              description:
                "bridge only: railing style on the edges facing the drop (default low_wall; ruined for a crumbling bridge).",
            },
            broken: {
              type: "array",
              items: {
                type: "array",
                items: {
                  type: "integer",
                },
                minItems: 2,
                maxItems: 2,
                description: "[x, y] cell coordinates (x east, y south).",
              },
              maxItems: 64,
              description: "bridge only: deck cells that have fallen away.",
            },
            crumble: {
              type: "number",
              description:
                "bridge only: 0..0.6 fraction of deck cells crumbled away; a way across always remains.",
            },
            span: {
              type: "string",
              enum: ["arch", "flat", "plank", "natural"],
              description:
                "bridge only: arch (stone, rises to the middle, piers, parapet), flat, plank (wood, sags, rope railing), natural (rock span or fallen column). Default by floor. A bridge whose ends touch floors at different heights becomes an inclined span with steps.",
            },
            arch: {
              type: "number",
              description: "bridge only: rise of the middle above the ends, tiles 0..2.",
            },
          },
        },
        opening: {
          type: "object",
          required: ["id", "kind"],
          additionalProperties: false,
          description:
            "Give EITHER between (preferred) OR at. secret_door is a wall that looks solid to players and opens only for the GM (always gmOnly): use it for a hidden shrine, vault or escape, with the room behind reached some other way too if players must be able to find it. Generator 4 builds it as one wall piece standing in the doorway; the build notes tell the GM which piece to delete in TaleSpire to open the way.",
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]{0,31}$",
              description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
            },
            kind: {
              type: "string",
              enum: [
                "door",
                "double_door",
                "locked_door",
                "secret_door",
                "portcullis",
                "archway",
                "open",
                "window",
                "arrow_slit",
                "bars",
              ],
            },
            between: {
              type: "array",
              items: {
                type: "string",
              },
              minItems: 2,
              maxItems: 2,
              description: '[areaId, areaId|"@outside"]',
            },
            position: {
              type: "number",
              description: "0..1 along the shared boundary, default 0.5",
            },
            at: {
              type: "object",
              required: ["x", "y", "side"],
              additionalProperties: false,
              properties: {
                x: {
                  type: "integer",
                },
                y: {
                  type: "integer",
                },
                side: {
                  type: "string",
                  enum: ["N", "E", "S", "W"],
                },
              },
            },
            width: {
              type: "integer",
              enum: [1, 2, 3],
            },
            label: {
              type: "string",
            },
            notes: {
              type: "string",
            },
            gmOnly: {
              type: "boolean",
            },
          },
        },
        wallRun: {
          type: "object",
          required: ["id", "op", "points"],
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]{0,31}$",
              description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
            },
            op: {
              type: "string",
              enum: ["add", "remove"],
            },
            points: {
              type: "array",
              items: {
                type: "array",
                items: {
                  type: "integer",
                },
                minItems: 2,
                maxItems: 2,
                description: "[x, y] grid VERTEX (corner) coordinates.",
              },
              minItems: 2,
              maxItems: 64,
            },
            style: {
              type: "string",
              enum: [
                "wall",
                "stone",
                "brick",
                "wood",
                "cave_rock",
                "plaster",
                "palisade",
                "fence",
                "hedge",
                "low_wall",
                "railing",
                "iron_bars",
                "ruined",
                "railing_stone",
                "concrete",
                "metal",
                "panel",
                "marble",
                "dark_stone",
                "timber",
              ],
            },
            height: {
              type: "number",
              description: "Tiles (1 = 5 ft), multiple of 0.25.",
            },
          },
        },
        feature: {
          type: "object",
          required: ["id", "type", "at"],
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]{0,31}$",
              description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
            },
            type: {
              type: "string",
              enum: [
                "table",
                "round_table",
                "chair",
                "bench",
                "stool",
                "bed",
                "bunk_bed",
                "wardrobe",
                "bookshelf",
                "desk",
                "chest",
                "barrel",
                "crate",
                "sack",
                "shelf",
                "counter",
                "bar_counter",
                "throne",
                "rug",
                "cauldron",
                "anvil",
                "forge",
                "weapon_rack",
                "armor_stand",
                "cage",
                "stocks",
                "pillar",
                "statue",
                "altar",
                "fountain",
                "well",
                "brazier",
                "torch_wall",
                "candelabra",
                "banner_wall",
                "painting_wall",
                "sarcophagus",
                "coffin",
                "tomb",
                "bones",
                "rubble",
                "web",
                "debris",
                "pool",
                "lever",
                "trap",
                "trap_plate",
                "chandelier",
                "tree",
                "dead_tree",
                "pine_tree",
                "bush",
                "rock",
                "boulder",
                "stump",
                "log",
                "mushroom",
                "flowers",
                "tall_grass",
                "reeds",
                "campfire",
                "tent",
                "cart",
                "wagon",
                "fence_post",
                "signpost",
                "standing_stone",
                "grave",
                "stalagmite",
                "stalactite",
                "rock_formation",
                "cave_in",
                "crystal",
                "giant_mushroom",
                "root",
                "root_large",
                "roots_wall",
                "vines",
                "tree_large",
                "candles",
                "skull_pile",
                "spawn_point",
                "torch_floor",
                "lantern",
                "magic_fire",
                "lava_glow",
                "fire_pit",
                "monolith",
                "cave_column",
                "statue_large",
                "mine_cart",
                "rails",
                "mine_support",
                "chains",
                "landmark",
                "tall_marker",
                "formation",
                "cluster_tall",
                "undergrowth",
                "ground_cover",
                "accent_light",
                "edge_dressing",
                "small_detail",
                "wall_dressing",
                "bank_dressing",
                "jetty",
                "vehicle",
                "seating",
                "signage",
                "cliff_face",
                "cliff_crest",
                "stall",
                "goods",
                "overhead",
                "line_post",
                "clutter",
                "shelf_line",
                "custom",
              ],
              description:
                "Generator 4: clutter is the small things a room's dressing stands on its furniture (variant table, study, store, tools or shelf) and shelf_line a wall shelf plank for them (needs wall); a room dressed by default or by a preset already has both.",
            },
            at: {
              type: "array",
              items: {
                type: "integer",
              },
              minItems: 2,
              maxItems: 2,
              description: "[x, y] cell coordinates (x east, y south).",
            },
            rot: {
              type: "integer",
              enum: [0, 90, 180, 270],
            },
            size: {
              type: "array",
              items: {
                type: "integer",
              },
              minItems: 2,
              maxItems: 2,
              description:
                "Cells [w, h]. Leave it off for a named type (the piece keeps its own footprint). For custom, the size of the thing: only an asset within about nine times its area either way is taken.",
            },
            wall: {
              type: "string",
              enum: ["N", "E", "S", "W"],
            },
            lift: {
              type: "number",
              description: "Tiles (1 = 5 ft), multiple of 0.25.",
            },
            variant: {
              type: "string",
            },
            hint: {
              type: "string",
              description:
                'Required for type "custom": a plain noun that is a whole word of the game asset\'s name ("wheel", "anchor", "skull"); its last word must be in the name.',
            },
            label: {
              type: "string",
            },
            notes: {
              type: "string",
            },
            gmOnly: {
              type: "boolean",
            },
          },
        },
        terrain: {
          oneOf: [
            {
              type: "object",
              required: ["id", "op", "shape", "material"],
              additionalProperties: false,
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "paint",
                },
                shape: {
                  $ref: "#/$defs/shape",
                },
                material: {
                  type: "string",
                  enum: [
                    "flagstone",
                    "stone_tile",
                    "marble",
                    "brick",
                    "cobble",
                    "wood_plank",
                    "carpet",
                    "rock",
                    "dirt",
                    "grass",
                    "sand",
                    "gravel",
                    "mud",
                    "snow",
                    "ice",
                    "swamp",
                    "water_shallow",
                    "water_deep",
                    "lava",
                    "bridge_wood",
                    "asphalt",
                    "concrete",
                  ],
                },
                layer: {
                  type: "string",
                  enum: ["under", "over"],
                  description:
                    "under (default) = applied before the areas: paint/noise/path under are replaced wherever an area sets its floor (use under for outdoor ground and roads); a height op under sets the ground height that areas without floorHeight inherit. over = applied after the areas, on their floor (water or lava in a cave, a dais or pit inside a room).",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op", "shape"],
              additionalProperties: false,
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "height",
                },
                shape: {
                  $ref: "#/$defs/shape",
                },
                delta: {
                  type: "number",
                  description: "Tiles (1 = 5 ft), multiple of 0.25.",
                },
                set: {
                  type: "number",
                  description: "Tiles (1 = 5 ft), multiple of 0.25.",
                },
                smooth: {
                  type: "integer",
                },
                layer: {
                  type: "string",
                  enum: ["under", "over"],
                  description:
                    "under (default) = applied before the areas: paint/noise/path under are replaced wherever an area sets its floor (use under for outdoor ground and roads); a height op under sets the ground height that areas without floorHeight inherit. over = applied after the areas, on their floor (water or lava in a cave, a dais or pit inside a room).",
                },
                edge: {
                  type: "string",
                  enum: ["ragged", "clean"],
                  description: "ragged breaks the outline (natural ground; default on open-air levels).",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op", "shape", "material", "coverage"],
              additionalProperties: false,
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "noise",
                },
                shape: {
                  $ref: "#/$defs/shape",
                },
                material: {
                  type: "string",
                  enum: [
                    "flagstone",
                    "stone_tile",
                    "marble",
                    "brick",
                    "cobble",
                    "wood_plank",
                    "carpet",
                    "rock",
                    "dirt",
                    "grass",
                    "sand",
                    "gravel",
                    "mud",
                    "snow",
                    "ice",
                    "swamp",
                    "water_shallow",
                    "water_deep",
                    "lava",
                    "bridge_wood",
                    "asphalt",
                    "concrete",
                  ],
                },
                coverage: {
                  type: "number",
                },
                scale: {
                  type: "integer",
                },
                seed: {
                  type: "integer",
                },
                layer: {
                  type: "string",
                  enum: ["under", "over"],
                  description:
                    "under (default) = applied before the areas: paint/noise/path under are replaced wherever an area sets its floor (use under for outdoor ground and roads); a height op under sets the ground height that areas without floorHeight inherit. over = applied after the areas, on their floor (water or lava in a cave, a dais or pit inside a room).",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op", "width", "material"],
              additionalProperties: false,
              description:
                "Road, trail, track or stream bed of a material along a line: give points (cell centres), or connect (area ids, feature ids or [x,y] cells joined in order, winding with jitter). kerb edges it with kerb pieces.",
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "path",
                },
                points: {
                  type: "array",
                  items: {
                    type: "array",
                    items: {
                      type: "integer",
                    },
                    minItems: 2,
                    maxItems: 2,
                    description: "[x, y] cell coordinates (x east, y south).",
                  },
                  minItems: 2,
                },
                connect: {
                  type: "array",
                  items: {
                    oneOf: [
                      {
                        type: "string",
                      },
                      {
                        type: "array",
                        items: {
                          type: "integer",
                        },
                        minItems: 2,
                        maxItems: 2,
                        description: "[x, y] cell coordinates (x east, y south).",
                      },
                    ],
                  },
                  minItems: 2,
                  maxItems: 16,
                },
                width: {
                  type: "integer",
                },
                material: {
                  type: "string",
                  enum: [
                    "flagstone",
                    "stone_tile",
                    "marble",
                    "brick",
                    "cobble",
                    "wood_plank",
                    "carpet",
                    "rock",
                    "dirt",
                    "grass",
                    "sand",
                    "gravel",
                    "mud",
                    "snow",
                    "ice",
                    "swamp",
                    "water_shallow",
                    "water_deep",
                    "lava",
                    "bridge_wood",
                    "asphalt",
                    "concrete",
                  ],
                },
                jitter: {
                  type: "number",
                },
                seed: {
                  type: "integer",
                },
                layer: {
                  type: "string",
                  enum: ["under", "over"],
                  description:
                    "under (default) = applied before the areas: paint/noise/path under are replaced wherever an area sets its floor (use under for outdoor ground and roads); a height op under sets the ground height that areas without floorHeight inherit. over = applied after the areas, on their floor (water or lava in a cave, a dais or pit inside a room).",
                },
                kerb: {
                  type: "boolean",
                  description: "Broken kerb stones here and there along the path's edges.",
                },
                style: {
                  type: "string",
                  enum: ["natural", "straight"],
                  description:
                    "natural winds and varies in width (default for dirt, gravel, grass, sand, mud, snow, rock); straight for paved roads and corridors.",
                },
                sidewalk: {
                  type: "object",
                  required: ["width", "material"],
                  additionalProperties: false,
                  description:
                    "Makes the path a road (straight, no jitter) with a raised pavement on both sides and kerbs between (kerb false turns them off).",
                  properties: {
                    width: {
                      type: "integer",
                    },
                    material: {
                      type: "string",
                      enum: [
                        "flagstone",
                        "stone_tile",
                        "marble",
                        "brick",
                        "cobble",
                        "wood_plank",
                        "carpet",
                        "rock",
                        "dirt",
                        "grass",
                        "sand",
                        "gravel",
                        "mud",
                        "snow",
                        "ice",
                        "swamp",
                        "water_shallow",
                        "water_deep",
                        "lava",
                        "bridge_wood",
                        "asphalt",
                        "concrete",
                      ],
                    },
                    raise: {
                      type: "number",
                      description: "pavement height above the road, tiles (default 0.25)",
                    },
                  },
                },
                crossings: {
                  type: "array",
                  items: {
                    type: "number",
                  },
                  description:
                    "Pedestrian crossings at these fractions of the road's length (0..1); makes the path a road.",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op", "feature", "density"],
              additionalProperties: false,
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "scatter",
                },
                feature: {
                  type: "string",
                  enum: [
                    "table",
                    "round_table",
                    "chair",
                    "bench",
                    "stool",
                    "bed",
                    "bunk_bed",
                    "wardrobe",
                    "bookshelf",
                    "desk",
                    "chest",
                    "barrel",
                    "crate",
                    "sack",
                    "shelf",
                    "counter",
                    "bar_counter",
                    "throne",
                    "rug",
                    "cauldron",
                    "anvil",
                    "forge",
                    "weapon_rack",
                    "armor_stand",
                    "cage",
                    "stocks",
                    "pillar",
                    "statue",
                    "altar",
                    "fountain",
                    "well",
                    "brazier",
                    "torch_wall",
                    "candelabra",
                    "banner_wall",
                    "painting_wall",
                    "sarcophagus",
                    "coffin",
                    "tomb",
                    "bones",
                    "rubble",
                    "web",
                    "debris",
                    "pool",
                    "lever",
                    "trap",
                    "trap_plate",
                    "chandelier",
                    "tree",
                    "dead_tree",
                    "pine_tree",
                    "bush",
                    "rock",
                    "boulder",
                    "stump",
                    "log",
                    "mushroom",
                    "flowers",
                    "tall_grass",
                    "reeds",
                    "campfire",
                    "tent",
                    "cart",
                    "wagon",
                    "fence_post",
                    "signpost",
                    "standing_stone",
                    "grave",
                    "stalagmite",
                    "stalactite",
                    "rock_formation",
                    "cave_in",
                    "crystal",
                    "giant_mushroom",
                    "root",
                    "root_large",
                    "roots_wall",
                    "vines",
                    "tree_large",
                    "candles",
                    "skull_pile",
                    "spawn_point",
                    "torch_floor",
                    "lantern",
                    "magic_fire",
                    "lava_glow",
                    "fire_pit",
                    "monolith",
                    "cave_column",
                    "statue_large",
                    "mine_cart",
                    "rails",
                    "mine_support",
                    "chains",
                    "landmark",
                    "tall_marker",
                    "formation",
                    "cluster_tall",
                    "undergrowth",
                    "ground_cover",
                    "accent_light",
                    "edge_dressing",
                    "small_detail",
                    "wall_dressing",
                    "bank_dressing",
                    "jetty",
                    "vehicle",
                    "seating",
                    "signage",
                    "cliff_face",
                    "cliff_crest",
                    "stall",
                    "goods",
                    "overhead",
                    "line_post",
                    "clutter",
                    "shelf_line",
                    "custom",
                  ],
                },
                shape: {
                  $ref: "#/$defs/shape",
                },
                exclude: {
                  type: "array",
                  items: {
                    $ref: "#/$defs/shape",
                  },
                  maxItems: 8,
                },
                density: {
                  type: "number",
                  description: "0..1",
                },
                minSpacing: {
                  type: "integer",
                },
                avoid: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: ["water", "paths", "areas", "walls", "features", "links"],
                  },
                },
                variants: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                },
                randomRotation: {
                  type: "boolean",
                },
                seed: {
                  type: "integer",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op", "preset"],
              additionalProperties: false,
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "dress",
                },
                area: {
                  type: "string",
                  description:
                    "area: optional on generator 2 — leave it out (or give the level id) to dress the whole level: the open ground and each zone.",
                },
                preset: {
                  type: "string",
                  enum: [
                    "tavern",
                    "library",
                    "barracks",
                    "bedroom",
                    "kitchen",
                    "storeroom",
                    "throne_room",
                    "shrine",
                    "crypt",
                    "prison",
                    "forge",
                    "laboratory",
                    "treasury",
                    "ruin",
                    "camp",
                    "ritual_circle",
                    "overgrown",
                    "cavern",
                    "collapse",
                    "crystal_grotto",
                    "campsite",
                    "shrine_ruin",
                    "bone_pit",
                    "mine_works",
                    "mushroom_grove",
                    "barricade",
                    "natural_clusters",
                    "woodland",
                    "forest",
                    "dense_forest",
                    "street",
                    "alley",
                    "plaza",
                  ],
                  description:
                    "Generator 4: a room preset (tavern to treasury in this list) furnishes and lights the room as that purpose, the way a room named for it is dressed by default (density 0.5 is the default amount); use one to choose the purpose or the amount.",
                },
                density: {
                  type: "number",
                },
                seed: {
                  type: "integer",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op", "points", "width"],
              additionalProperties: false,
              description:
                "A meandering trench cut into the floor of the areas it crosses (always applied after the areas): a chasm, crevasse, ravine or rift, and also a stream or river bed (floor water_shallow, depth 0.5..1) or a dry gully. Cliff sides, optional bridges across.",
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "chasm",
                },
                points: {
                  type: "array",
                  items: {
                    type: "array",
                    items: {
                      type: "integer",
                    },
                    minItems: 2,
                    maxItems: 2,
                    description: "[x, y] cell coordinates (x east, y south).",
                  },
                  minItems: 2,
                  maxItems: 64,
                  description:
                    "Course as cell centres, any direction; run it from wall to wall across the room.",
                },
                width: {
                  type: "number",
                  description: "Average width in cells, 1..12.",
                },
                depth: {
                  type: "number",
                  description: "Tiles below the floor, 0.5..4, multiple of 0.25 (default 3).",
                },
                meander: {
                  type: "number",
                  description: "0..1 (default 0.5): how much the course and the banks wander.",
                },
                floor: {
                  type: "string",
                  enum: [
                    "flagstone",
                    "stone_tile",
                    "marble",
                    "brick",
                    "cobble",
                    "wood_plank",
                    "carpet",
                    "rock",
                    "dirt",
                    "grass",
                    "sand",
                    "gravel",
                    "mud",
                    "snow",
                    "ice",
                    "swamp",
                    "water_shallow",
                    "water_deep",
                    "lava",
                    "bridge_wood",
                    "asphalt",
                    "concrete",
                    "none",
                  ],
                  description:
                    "Bottom: lava, water_deep, water_shallow, rock… (default: keep the floor); none = bottomless.",
                },
                bridges: {
                  type: "array",
                  maxItems: 4,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      at: {
                        type: "number",
                        description: "0..1 along the chasm (default 0.5).",
                      },
                      width: {
                        type: "integer",
                        description: "1..4 cells (default 2).",
                      },
                      floor: {
                        type: "string",
                        enum: [
                          "flagstone",
                          "stone_tile",
                          "marble",
                          "brick",
                          "cobble",
                          "wood_plank",
                          "carpet",
                          "rock",
                          "dirt",
                          "grass",
                          "sand",
                          "gravel",
                          "mud",
                          "snow",
                          "ice",
                          "swamp",
                          "water_shallow",
                          "water_deep",
                          "lava",
                          "bridge_wood",
                          "asphalt",
                          "concrete",
                        ],
                        description: "Deck material (default flagstone).",
                      },
                      railing: {
                        type: "string",
                        enum: [
                          "wall",
                          "stone",
                          "brick",
                          "wood",
                          "cave_rock",
                          "plaster",
                          "palisade",
                          "fence",
                          "hedge",
                          "low_wall",
                          "railing",
                          "iron_bars",
                          "ruined",
                          "railing_stone",
                          "concrete",
                          "metal",
                          "panel",
                          "marble",
                          "dark_stone",
                          "timber",
                          "none",
                        ],
                        description: "default low_wall; ruined suits an old bridge.",
                      },
                      crumble: {
                        type: "number",
                        description:
                          "0..0.6 fraction of the deck crumbled away (a way across always remains).",
                      },
                      span: {
                        type: "string",
                        enum: ["arch", "flat", "plank", "natural"],
                        description: "default arch (stone) or plank (wood floor).",
                      },
                      arch: {
                        type: "number",
                        description: "rise of the middle above the ends, tiles 0..2.",
                      },
                    },
                  },
                },
                seed: {
                  type: "integer",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op", "shape"],
              additionalProperties: false,
              description:
                "Tiered platform: dais, stepped pyramid, terrace, raised walkway, plateau; negative rise = sunken pit or amphitheatre. Rings each inset cells inside the one below and rise tiles higher. Cut into open floor (after the areas). Steps of 0.5 are walkable everywhere; stairs adds a flight on those sides.",
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "platform",
                },
                shape: {
                  $ref: "#/$defs/shape",
                },
                tiers: {
                  type: "integer",
                  description: "1..5 (default 3).",
                },
                rise: {
                  type: "number",
                  description: "Tiles per tier, -2..2, not 0, multiple of 0.25 (default 0.5).",
                },
                inset: {
                  type: "integer",
                  description: "Cells each tier steps in, 1..4 (default 1).",
                },
                material: {
                  type: "string",
                  enum: [
                    "flagstone",
                    "stone_tile",
                    "marble",
                    "brick",
                    "cobble",
                    "wood_plank",
                    "carpet",
                    "rock",
                    "dirt",
                    "grass",
                    "sand",
                    "gravel",
                    "mud",
                    "snow",
                    "ice",
                    "swamp",
                    "water_shallow",
                    "water_deep",
                    "lava",
                    "bridge_wood",
                    "asphalt",
                    "concrete",
                  ],
                },
                topMaterial: {
                  type: "string",
                  enum: [
                    "flagstone",
                    "stone_tile",
                    "marble",
                    "brick",
                    "cobble",
                    "wood_plank",
                    "carpet",
                    "rock",
                    "dirt",
                    "grass",
                    "sand",
                    "gravel",
                    "mud",
                    "snow",
                    "ice",
                    "swamp",
                    "water_shallow",
                    "water_deep",
                    "lava",
                    "bridge_wood",
                    "asphalt",
                    "concrete",
                  ],
                },
                stairs: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: ["N", "E", "S", "W"],
                  },
                  maxItems: 4,
                  description: "Sides that get a 2-wide flight of steps to the top.",
                },
                edge: {
                  type: "string",
                  enum: ["ragged", "clean"],
                  description:
                    "ragged = organic wandering contours (mounds, terraces, hills; default on open-air levels for natural materials); clean = crisp built tiers (daises).",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op", "from", "to"],
              additionalProperties: false,
              description:
                "A straight flight of steps between two floor cells on one row or column, at any two heights (ledge to floor, into a dry chasm, up to a terrace or plateau). The cells between step evenly; every step is walkable.",
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "stairs",
                },
                from: {
                  type: "array",
                  items: {
                    type: "integer",
                  },
                  minItems: 2,
                  maxItems: 2,
                  description: "[x, y] cell coordinates (x east, y south).",
                },
                to: {
                  type: "array",
                  items: {
                    type: "integer",
                  },
                  minItems: 2,
                  maxItems: 2,
                  description: "[x, y] cell coordinates (x east, y south).",
                },
                width: {
                  type: "integer",
                  minimum: 1,
                  maximum: 6,
                  description: "Stairs 1..3 (default 1); a ramp 3..6 (default 4).",
                },
                style: {
                  type: "string",
                  enum: ["stairs", "ramp"],
                  description:
                    "stairs (default): a flight of steps. ramp (generator 2): a rock ramp cut through a cliff, 3..6 cells wide, in any direction (a diagonal suits it), climbing at most 1 tile per 2.5 cells, so it needs a long run. An option for a natural slope where stairs would look built; whether minis walk it in game is not yet confirmed.",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op"],
              additionalProperties: false,
              description:
                "Uneven ground: gentle seeded bumps and hollows that stay walkable. Leave fighting space and paths out with exclude.",
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "uneven",
                },
                shape: {
                  $ref: "#/$defs/shape",
                },
                exclude: {
                  type: "array",
                  items: {
                    $ref: "#/$defs/shape",
                  },
                  maxItems: 8,
                },
                amount: {
                  type: "number",
                  description: "Largest change in tiles, 0.25..1 (default 0.5).",
                },
                scale: {
                  type: "number",
                  description: "Bump size in cells, 3..12 (default 6).",
                },
                seed: {
                  type: "integer",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op", "shape"],
              additionalProperties: false,
              description:
                "Outcrop: a rock mass, column, crag or buttress rising out of the floor with cliff sides (any setting).",
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "outcrop",
                },
                shape: {
                  $ref: "#/$defs/shape",
                },
                height: {
                  type: "number",
                  description: "Tiles, 0.5..4 (default 2).",
                },
                material: {
                  type: "string",
                  enum: [
                    "flagstone",
                    "stone_tile",
                    "marble",
                    "brick",
                    "cobble",
                    "wood_plank",
                    "carpet",
                    "rock",
                    "dirt",
                    "grass",
                    "sand",
                    "gravel",
                    "mud",
                    "snow",
                    "ice",
                    "swamp",
                    "water_shallow",
                    "water_deep",
                    "lava",
                    "bridge_wood",
                    "asphalt",
                    "concrete",
                  ],
                  description: "Top surface (default rock).",
                },
              },
            },
            {
              type: "object",
              required: ["id", "op", "shape"],
              additionalProperties: false,
              description:
                'Generator 3. An opening in the floor of this level so the level below shows through: a collapsed floor, a shaft, a gallery or balcony looking down into a hall. Put it inside a room of the upper level, over open floor of a room on the level below (stack the levels by elevation, one storey = 2.5). No wall is built round it (unlike an area with floor "none"): the edge gets a low railing or broken rim, a collapse gets a ragged outline and a heap of rubble on the floor below, and the build checks the cells beneath are open floor.',
              properties: {
                id: {
                  type: "string",
                  pattern: "^[a-z][a-z0-9_]{0,31}$",
                  description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
                },
                op: {
                  const: "floor_opening",
                },
                shape: {
                  $ref: "#/$defs/shape",
                },
                kind: {
                  type: "string",
                  enum: ["collapse", "shaft", "balcony"],
                  description:
                    "collapse (default): ragged hole, broken edge, rubble below. shaft: clean hole with a railing. balcony: like shaft, for a gallery over a room.",
                },
                edge: {
                  type: "string",
                  enum: ["ragged", "clean"],
                  description: "Outline (default: ragged for a collapse, clean otherwise).",
                },
                rim: {
                  type: "string",
                  enum: [
                    "wall",
                    "stone",
                    "brick",
                    "wood",
                    "cave_rock",
                    "plaster",
                    "palisade",
                    "fence",
                    "hedge",
                    "low_wall",
                    "railing",
                    "iron_bars",
                    "ruined",
                    "railing_stone",
                    "concrete",
                    "metal",
                    "panel",
                    "marble",
                    "dark_stone",
                    "timber",
                    "none",
                  ],
                  description:
                    "Edge piece. Generator 4 default: a collapse has none (broken rubble on the rim), a shaft a low_wall kerb, a balcony a railing; never ask for a 2-tall wall style, it hides the hole. Earlier generators: ruined for a collapse, iron_bars otherwise.",
                },
                rubble: {
                  type: "boolean",
                  description: "Collapse: heap rubble on the floor below (default true).",
                },
              },
            },
          ],
        },
        label: {
          type: "object",
          required: ["id", "text", "at"],
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]{0,31}$",
              description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
            },
            text: {
              type: "string",
            },
            at: {
              type: "array",
              items: {
                type: "integer",
              },
              minItems: 2,
              maxItems: 2,
              description: "[x, y] cell coordinates (x east, y south).",
            },
            size: {
              type: "string",
              enum: ["s", "m", "l"],
            },
          },
        },
        link: {
          type: "object",
          required: ["id", "kind", "from", "to"],
          additionalProperties: false,
          description:
            'A way between two levels. `from` is always the LOWER level (lower elevation), `to` the upper; walkers go either way. Stairs: `from.at` is the first step (the foot, on the lower level) and `dir` is the way the run climbs; it covers one cell per tile of rise in a straight line (rise 2.5 = 3 cells, a 1-wide strip, or `width` wide), the cell BEHIND the foot (opposite `dir`) must be open floor, and the cells the run climbs over must be free floor on the lower level (a corridor the run climbs along becomes the stair). The top lands on the upper level one cell past the last step, which must be open floor there; the run\'s cells on the upper level become a stair well with no floor. Example: levels hall (elevation 0) and crypt (elevation -2.5); { kind: "stairs", from: { level: "crypt", at: [10, 20] }, to: { level: "hall" }, dir: "N" } occupies crypt (10,20), (10,19), (10,18), you step on from (10,21) (open floor), and you arrive on the hall at (10,17); the hall cells (10,18..20) get no floor (a stair well). A ladder or trapdoor occupies one cell: { kind: "ladder", from: { level: "shrine", at: [15, 20] }, to: { level: "crypt" } } climbs from shrine (15,20) up through a one-cell hole in the crypt floor at (15,20); you step on from any side cell of the lower level and off beside the hole above. Keep links out of the cells you build features on.',
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]{0,31}$",
              description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
            },
            kind: {
              type: "string",
              enum: ["stairs", "spiral_stairs", "ladder", "ramp", "trapdoor", "pit_drop"],
            },
            from: {
              type: "object",
              required: ["level", "at"],
              additionalProperties: false,
              properties: {
                level: {
                  type: "string",
                },
                at: {
                  type: "array",
                  items: {
                    type: "integer",
                  },
                  minItems: 2,
                  maxItems: 2,
                  description: "[x, y] cell coordinates (x east, y south).",
                },
              },
            },
            to: {
              type: "object",
              required: ["level"],
              additionalProperties: false,
              properties: {
                level: {
                  type: "string",
                },
                at: {
                  type: "array",
                  items: {
                    type: "integer",
                  },
                  minItems: 2,
                  maxItems: 2,
                  description: "[x, y] cell coordinates (x east, y south).",
                },
              },
            },
            dir: {
              type: "string",
              enum: ["N", "E", "S", "W"],
              description: "Stairs/ramp only: the way the run climbs from the foot (from.at).",
            },
            width: {
              type: "integer",
              enum: [1, 2],
            },
            label: {
              type: "string",
            },
            notes: {
              type: "string",
            },
          },
        },
        level: {
          type: "object",
          required: ["id", "name", "elevation", "bounds", "base"],
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]{0,31}$",
              description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
            },
            name: {
              type: "string",
            },
            elevation: {
              type: "number",
              description:
                "Base of the floor in tiles. For levels stacked over each other (a dungeon of rooms above rooms) space them 4 apart for the usual 2-tall walls (wall height + 0.5 floor + 1 of air), so a player sees clear air between the wall tops and the floor above; a level under another at 2.5 has walls touching the ceiling. A stairs link grows by a cell per tile, so 4 apart means a 4-cell run. Let the levels overlap in plan (a hall over a crypt, cells under a guard room) and join them with a floor_opening terrain op as well as stairs.",
            },
            wallHeight: {
              type: "number",
              description: "Tiles (1 = 5 ft), multiple of 0.25.",
            },
            bounds: {
              type: "object",
              required: ["x", "y", "w", "h"],
              additionalProperties: false,
              properties: {
                x: {
                  type: "integer",
                },
                y: {
                  type: "integer",
                },
                w: {
                  type: "integer",
                },
                h: {
                  type: "integer",
                },
              },
            },
            foundation: {
              type: "number",
              description:
                "Depth of the solid base under the level's edge, tiles 0..4 (default 2 on open-air levels, 0 otherwise).",
            },
            outline: {
              type: "string",
              enum: ["natural", "rect"],
              description:
                "The board's edge (generator 2). natural (default on open-air natural levels at least 16x16 with no roads and fewer than 3 buildings): a ragged, rounded edge with a low strip round the outside. Choose rect for built-up maps (streets, towns), a map that must tile against another, or when the GM asks for a full rectangle.",
            },
            roomDress: {
              const: false,
              description:
                "Generator 4. false turns off the default dressing of rooms (a room whose name, tags or notes say its purpose, with no dress op over it and little furniture of its own, is furnished and lit from that purpose). Leave it out.",
            },
            light: {
              type: "string",
              enum: ["dark", "dim", "moderate", "bright", "flooded"],
              description:
                "Generator 5: how many lights mark the place in use, dark (none) to flooded; not the board's brightness. Omitted = read from its words, else the place around it.",
            },
            condition: {
              type: "string",
              enum: ["intact", "weathered", "ramshackle", "ruined"],
              description:
                "Generator 5: how kept the place is (a ruined room is rubble, sparsely dressed). Omitted = read from its words, else the place around it.",
            },
            wealth: {
              type: "string",
              enum: ["poor", "modest", "wealthy", "lavish"],
              description:
                "Generator 5: how plain or rich its trims and contents are. Omitted = read from its words, else the place around it.",
            },
            base: {
              oneOf: [
                {
                  type: "object",
                  required: ["type"],
                  additionalProperties: false,
                  properties: {
                    type: {
                      const: "solid",
                    },
                  },
                },
                {
                  type: "object",
                  required: ["type"],
                  additionalProperties: false,
                  properties: {
                    type: {
                      const: "void",
                    },
                  },
                },
                {
                  type: "object",
                  required: ["type", "material"],
                  additionalProperties: false,
                  properties: {
                    type: {
                      const: "ground",
                    },
                    material: {
                      type: "string",
                      enum: [
                        "flagstone",
                        "stone_tile",
                        "marble",
                        "brick",
                        "cobble",
                        "wood_plank",
                        "carpet",
                        "rock",
                        "dirt",
                        "grass",
                        "sand",
                        "gravel",
                        "mud",
                        "snow",
                        "ice",
                        "swamp",
                        "water_shallow",
                        "water_deep",
                        "lava",
                        "bridge_wood",
                        "asphalt",
                        "concrete",
                      ],
                    },
                    layer: {
                      type: "string",
                      enum: ["under", "over"],
                      description:
                        "under (default) = applied before the areas: paint/noise/path under are replaced wherever an area sets its floor (use under for outdoor ground and roads); a height op under sets the ground height that areas without floorHeight inherit. over = applied after the areas, on their floor (water or lava in a cave, a dais or pit inside a room).",
                    },
                  },
                },
              ],
            },
            theme: {
              type: "string",
            },
            areas: {
              type: "array",
              items: {
                $ref: "#/$defs/area",
              },
            },
            openings: {
              type: "array",
              items: {
                $ref: "#/$defs/opening",
              },
            },
            walls: {
              type: "array",
              items: {
                $ref: "#/$defs/wallRun",
              },
            },
            features: {
              type: "array",
              items: {
                $ref: "#/$defs/feature",
              },
            },
            terrain: {
              type: "array",
              items: {
                $ref: "#/$defs/terrain",
              },
            },
            labels: {
              type: "array",
              items: {
                $ref: "#/$defs/label",
              },
            },
            structures: {
              type: "array",
              items: {
                $ref: "#/$defs/structure",
              },
              maxItems: 32,
            },
            stalls: {
              type: "array",
              maxItems: 8,
              description:
                'Generator 3. Rows or clusters of market stalls, laid out for you in a rectangle whose long side is the row, kinds from `goods` in shuffled order; cells already taken (a well, a building) are skipped. Generator 4: covered stalls that differ: small 2x3, medium 3x3, large 4x4 (and 4x3, 3x2, 2x2), a raised base, skirted counters with a walk-in gap or goods trays, corner posts, a gable or flat cloth canopy, a stool and a lantern, an empty one when `goods` has "empty", a few open tables, loose gaps and the odd turned stall. Two rows face each other across the aisle when the rectangle is at least aisle + 4 deep (aisle + 6 for full-size stalls), else one row up to 4 deep faces `facing`. A theme without canopy pieces builds generator 3\'s stalls. Keep overhead lines along the aisle or street: a line through a covered stall is dropped. Generator 3: tables 2 cells wide, spaced irregularly, two rows from aisle + 2 deep; fruit, vegetables, spices, magic and weapons use the theme\'s stall pieces, the rest a bare table with bread, dairy, fish, potions or grain on it. Example: {"id": "market", "area": {"x": 17, "y": 6, "w": 14, "h": 7}, "goods": ["fruit", "bread", "potions", "vegetables"]}. A single stall: a feature of type stall with variant = the kind. Do not dress the same square with the plaza preset: it plants trees and seats in the aisle.',
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "area"],
                properties: {
                  id: {
                    type: "string",
                  },
                  area: {
                    type: "object",
                    additionalProperties: false,
                    required: ["x", "y", "w", "h"],
                    properties: {
                      x: {
                        type: "integer",
                      },
                      y: {
                        type: "integer",
                      },
                      w: {
                        type: "integer",
                      },
                      h: {
                        type: "integer",
                      },
                    },
                  },
                  goods: {
                    type: "array",
                    items: {
                      type: "string",
                      enum: [
                        "fruit",
                        "vegetables",
                        "spices",
                        "magic",
                        "weapons",
                        "empty",
                        "bread",
                        "dairy",
                        "fish",
                        "potions",
                        "grain",
                      ],
                    },
                    description: "Kinds on offer; default fruit, vegetables, bread, dairy, potions, spices.",
                  },
                  facing: {
                    type: "string",
                    enum: ["N", "E", "S", "W"],
                    description: "The side a lone row faces (default S).",
                  },
                  count: {
                    type: "integer",
                    description: "Most stalls (default: as many as fit).",
                  },
                  aisle: {
                    type: "integer",
                    description: "Clear aisle between two rows, 1 to 4 cells (default 2).",
                  },
                  seed: {
                    type: "integer",
                  },
                },
              },
            },
            lines: {
              type: "array",
              maxItems: 12,
              description:
                'Generator 3. A line strung overhead between two cells on one row or column: lanterns (rope with lanterns hung along it), lights (a string of lights) or flags (rope with cloth flags; the data has no bunting piece). Each end is anchored on a building wall within 3 cells beyond it, else on a post the generator stands there; the line hangs `height` tiles up (2 to 3, default 2.6, clear of shop awnings). A wall shorter than the line cannot hold it: the build warns (verify_line_unanchored) and the pieces float, so end such a line on a post or pick taller buildings. Generator 5: a line over the canopy or awning of a shop front is raised above it, or dropped (line_unanchored) when its walls cannot hold it that high, so end it clear of such fronts. Example across a street between facing buildings: {"id": "across1", "from": [12, 14], "to": [12, 22], "kind": "lanterns"}. Lines over a street are the way to light it from above; do not float lanterns with lift.',
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "from", "to"],
                properties: {
                  id: {
                    type: "string",
                  },
                  from: {
                    type: "array",
                    items: {
                      type: "integer",
                    },
                    minItems: 2,
                    maxItems: 2,
                  },
                  to: {
                    type: "array",
                    items: {
                      type: "integer",
                    },
                    minItems: 2,
                    maxItems: 2,
                  },
                  kind: {
                    type: "string",
                    enum: ["lanterns", "lights", "flags"],
                  },
                  height: {
                    type: "number",
                  },
                  spacing: {
                    type: "integer",
                    description: "Cells between hung pieces, 2 to 6 (default 3).",
                  },
                },
              },
            },
            notes: {
              type: "string",
            },
          },
        },
        structure: {
          type: "object",
          required: ["id"],
          additionalProperties: false,
          description:
            'A building (kind omitted) or a yard (kind "enclosure"). Buildings: wings, volumes or footprint; everything else comes from the style, the use and the seed unless given (one wing with no storeys list and no roof lets the style draw the whole design). Example: {"id": "bakery", "style": "modern_block", "use": "shop", "front": "S", "wings": [{"x": 4, "y": 2, "w": 7, "h": 8}]}; bare x, y, w, h on the building are read as that one wing.',
          properties: {
            id: {
              type: "string",
              pattern: "^[a-z][a-z0-9_]{0,31}$",
              description: 'Lowercase id, unique across the whole plan, e.g. "r1", "crypt_hall".',
            },
            kind: {
              type: "string",
              enum: ["building", "enclosure"],
            },
            name: {
              type: "string",
            },
            key: {
              type: "string",
              description: "Room-key label of the building's ground storey / yard.",
            },
            theme: {
              type: "string",
            },
            notes: {
              type: "string",
            },
            style: {
              type: "string",
              description:
                'Style profile: cottage: timber walls on a stone footing, pitched slate roof on an attic deck, windows every few cells, a light by the door; keep: thick stone walls, few narrow windows, flat roof with a stone parapet, battlemented ledges where storeys step in; tower: tall and narrow stone storeys, sparse windows, a spire; wizard_tower: a slender tapering shaft (grey stone, red brick on a stone foot, sandstone or dark stone), a lantern room under a steep spire with a finial or a magic orb (the lantern sometimes half-timbered), bartizans or a stair turret, glowing windows, on a raised rocky base; ruin: an old building fallen to ruin (for a ruined tower, cottage, keep or warehouse use that style with condition "ruined" instead, so it keeps its kind); modern: plain panel walls, many large windows, flat roof with a low parapet; modern_block: a city building drawn from many shapes (plain block, set-back top, podium and tower, twin heights, corner L, stepped, low shed) in brick, concrete, metal or panel, with a shopfront, stoop or garage at street level, varied windows, flat parapet roofs with a hut, plant, mast or terrace; desert: plastered walls, few small windows, flat roof with a low parapet. Default cottage.',
            },
            seed: {
              type: "integer",
              description:
                "Another seed gives another variant of the same spec (door slide, windows, porch, chimney).",
            },
            wings: {
              type: "array",
              maxItems: 8,
              items: {
                type: "object",
                required: ["x", "y", "w", "h"],
                additionalProperties: false,
                properties: {
                  x: {
                    type: "integer",
                  },
                  y: {
                    type: "integer",
                  },
                  w: {
                    type: "integer",
                  },
                  h: {
                    type: "integer",
                  },
                  ridge: {
                    type: "string",
                    enum: ["ew", "ns"],
                  },
                },
              },
              description:
                "Rectangles whose union is the footprint (an L or T is two wings); each gets its own roof ridge (default along its longer side).",
            },
            footprint: {
              $ref: "#/$defs/shape",
              description: "Any other ground plan (round, polygonal); built with a flat roof for now.",
            },
            storeys: {
              oneOf: [
                {
                  type: "integer",
                  description: "1..12",
                },
                {
                  type: "array",
                  maxItems: 12,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      walls: {
                        type: "string",
                        enum: [
                          "wall",
                          "stone",
                          "brick",
                          "wood",
                          "cave_rock",
                          "plaster",
                          "palisade",
                          "fence",
                          "hedge",
                          "low_wall",
                          "railing",
                          "iron_bars",
                          "ruined",
                          "railing_stone",
                          "concrete",
                          "metal",
                          "panel",
                          "marble",
                          "dark_stone",
                          "timber",
                          "none",
                        ],
                      },
                      footing: {
                        type: "string",
                        enum: [
                          "wall",
                          "stone",
                          "brick",
                          "wood",
                          "cave_rock",
                          "plaster",
                          "palisade",
                          "fence",
                          "hedge",
                          "low_wall",
                          "railing",
                          "iron_bars",
                          "ruined",
                          "railing_stone",
                          "concrete",
                          "metal",
                          "panel",
                          "marble",
                          "dark_stone",
                          "timber",
                          "none",
                        ],
                        description: "ground storey only: a lower course (stone under timber)",
                      },
                      floor: {
                        type: "string",
                        enum: [
                          "flagstone",
                          "stone_tile",
                          "marble",
                          "brick",
                          "cobble",
                          "wood_plank",
                          "carpet",
                          "rock",
                          "dirt",
                          "grass",
                          "sand",
                          "gravel",
                          "mud",
                          "snow",
                          "ice",
                          "swamp",
                          "water_shallow",
                          "water_deep",
                          "lava",
                          "bridge_wood",
                          "asphalt",
                          "concrete",
                        ],
                      },
                      windows: {
                        type: "string",
                        enum: ["none", "sparse", "regular", "dense"],
                      },
                      height: {
                        type: "number",
                        description: "this storey's wall height, 1..8 tiles",
                      },
                      inset: {
                        type: "integer",
                        description: "0..2 cells this storey steps in from the one below on every side",
                      },
                      seam: {
                        type: "string",
                        enum: ["skirt", "plain", "crenellated"],
                        description: "the ledge a set-in leaves: roofed, plain or battlemented",
                      },
                    },
                  },
                },
              ],
            },
            storeyHeight: {
              type: "number",
              description:
                "wall height of each storey in tiles, 1..8 in steps of 0.25 (default from the style)",
            },
            volumes: {
              type: "array",
              maxItems: 8,
              items: {
                type: "object",
                required: ["id", "x", "y", "w", "h"],
                additionalProperties: false,
                properties: {
                  id: {
                    type: "string",
                    description: "short volume id, unique in the building",
                  },
                  x: {
                    type: "integer",
                  },
                  y: {
                    type: "integer",
                  },
                  w: {
                    type: "integer",
                  },
                  h: {
                    type: "integer",
                  },
                  on: {
                    type: "string",
                    description: "id of the volume it stands on",
                  },
                  storeys: {
                    oneOf: [
                      {
                        type: "integer",
                        description: "1..12",
                      },
                      {
                        type: "array",
                        maxItems: 12,
                        items: {
                          type: "object",
                          additionalProperties: false,
                          properties: {
                            walls: {
                              type: "string",
                              enum: [
                                "wall",
                                "stone",
                                "brick",
                                "wood",
                                "cave_rock",
                                "plaster",
                                "palisade",
                                "fence",
                                "hedge",
                                "low_wall",
                                "railing",
                                "iron_bars",
                                "ruined",
                                "railing_stone",
                                "concrete",
                                "metal",
                                "panel",
                                "marble",
                                "dark_stone",
                                "timber",
                                "none",
                              ],
                            },
                            footing: {
                              type: "string",
                              enum: [
                                "wall",
                                "stone",
                                "brick",
                                "wood",
                                "cave_rock",
                                "plaster",
                                "palisade",
                                "fence",
                                "hedge",
                                "low_wall",
                                "railing",
                                "iron_bars",
                                "ruined",
                                "railing_stone",
                                "concrete",
                                "metal",
                                "panel",
                                "marble",
                                "dark_stone",
                                "timber",
                                "none",
                              ],
                              description: "ground storey only: a lower course (stone under timber)",
                            },
                            floor: {
                              type: "string",
                              enum: [
                                "flagstone",
                                "stone_tile",
                                "marble",
                                "brick",
                                "cobble",
                                "wood_plank",
                                "carpet",
                                "rock",
                                "dirt",
                                "grass",
                                "sand",
                                "gravel",
                                "mud",
                                "snow",
                                "ice",
                                "swamp",
                                "water_shallow",
                                "water_deep",
                                "lava",
                                "bridge_wood",
                                "asphalt",
                                "concrete",
                              ],
                            },
                            windows: {
                              type: "string",
                              enum: ["none", "sparse", "regular", "dense"],
                            },
                            height: {
                              type: "number",
                              description: "this storey's wall height, 1..8 tiles",
                            },
                            inset: {
                              type: "integer",
                              description: "0..2 cells this storey steps in from the one below on every side",
                            },
                            seam: {
                              type: "string",
                              enum: ["skirt", "plain", "crenellated"],
                              description: "the ledge a set-in leaves: roofed, plain or battlemented",
                            },
                          },
                        },
                      },
                    ],
                  },
                  storeyHeight: {
                    type: "number",
                  },
                  corners: {
                    type: "string",
                    enum: ["square", "chamfer"],
                  },
                  roof: {
                    oneOf: [
                      {
                        const: "none",
                      },
                      {
                        type: "object",
                        required: ["type"],
                        additionalProperties: false,
                        properties: {
                          type: {
                            type: "string",
                            enum: [
                              "gable",
                              "flat",
                              "none",
                              "hip",
                              "shed",
                              "cone",
                              "dome",
                              "skirt",
                              "stepped",
                              "spire",
                              "vault",
                            ],
                            description:
                              "built: gable, hip, shed, flat, skirt (mansard ring), stepped, spire (cone builds as spire), none; dome and vault are built flat for now",
                          },
                          layers: {
                            type: "array",
                            maxItems: 4,
                            items: {
                              type: "object",
                              required: ["type"],
                              additionalProperties: false,
                              properties: {
                                type: {
                                  type: "string",
                                  enum: [
                                    "gable",
                                    "flat",
                                    "none",
                                    "hip",
                                    "shed",
                                    "cone",
                                    "dome",
                                    "skirt",
                                    "stepped",
                                    "spire",
                                    "vault",
                                  ],
                                  description:
                                    "built: gable, hip, shed, flat, skirt (mansard ring), stepped, spire (cone builds as spire), none; dome and vault are built flat for now",
                                },
                                style: {
                                  type: "string",
                                },
                                ridge: {
                                  type: "string",
                                  enum: ["ew", "ns"],
                                },
                                courses: {
                                  type: "integer",
                                  description: "skirt, stepped: rings (1..6); spire: flared bands",
                                },
                                low: {
                                  type: "string",
                                  enum: ["N", "E", "S", "W"],
                                },
                                parapet: {
                                  type: "string",
                                  enum: [
                                    "wall",
                                    "stone",
                                    "brick",
                                    "wood",
                                    "cave_rock",
                                    "plaster",
                                    "palisade",
                                    "fence",
                                    "hedge",
                                    "low_wall",
                                    "railing",
                                    "iron_bars",
                                    "ruined",
                                    "railing_stone",
                                    "concrete",
                                    "metal",
                                    "panel",
                                    "marble",
                                    "dark_stone",
                                    "timber",
                                    "none",
                                  ],
                                },
                              },
                            },
                            description:
                              "Stacked roof strategies, bottom first, each on the flat top the one below leaves (skirt then spire; stepped then flat).",
                          },
                          courses: {
                            type: "integer",
                            description: "skirt, stepped: rings (1..6); spire: flared bands",
                          },
                          low: {
                            type: "string",
                            enum: ["N", "E", "S", "W"],
                            description: "shed: the side the roof falls to",
                          },
                          ridge: {
                            type: "string",
                            enum: ["ew", "ns"],
                          },
                          style: {
                            type: "string",
                            description: "roof kit, e.g. slate",
                          },
                          deck: {
                            type: "boolean",
                          },
                          broken: {
                            type: "number",
                            description: "0..0.6 fraction of roof built broken (ruins); default 0",
                          },
                          parapet: {
                            type: "string",
                            enum: [
                              "wall",
                              "stone",
                              "brick",
                              "wood",
                              "cave_rock",
                              "plaster",
                              "palisade",
                              "fence",
                              "hedge",
                              "low_wall",
                              "railing",
                              "iron_bars",
                              "ruined",
                              "railing_stone",
                              "concrete",
                              "metal",
                              "panel",
                              "marble",
                              "dark_stone",
                              "timber",
                              "none",
                            ],
                          },
                        },
                      },
                    ],
                  },
                  ridge: {
                    type: "string",
                    enum: ["ew", "ns"],
                  },
                },
              },
              description:
                "Massing: blocks of different heights instead of wings, e.g. a tall tenement beside a low warehouse. Each has its own storeys, storeyHeight and roof; on: the volume it stands on (a tower on a hall). The ground volumes together are the ground storey.",
            },
            plinth: {
              type: "object",
              required: ["height"],
              additionalProperties: false,
              description: "A raised base under the building (a crag, a podium) with steps to every door.",
              properties: {
                height: {
                  type: "number",
                  description: "0.5..6 tiles",
                },
                margin: {
                  type: "integer",
                  description: "cells of base round the walls, 1..4",
                },
                face: {
                  type: "string",
                  enum: [
                    "flagstone",
                    "stone_tile",
                    "marble",
                    "brick",
                    "cobble",
                    "wood_plank",
                    "carpet",
                    "rock",
                    "dirt",
                    "grass",
                    "sand",
                    "gravel",
                    "mud",
                    "snow",
                    "ice",
                    "swamp",
                    "water_shallow",
                    "water_deep",
                    "lava",
                    "bridge_wood",
                    "asphalt",
                    "concrete",
                  ],
                },
                rim: {
                  type: "string",
                  enum: [
                    "wall",
                    "stone",
                    "brick",
                    "wood",
                    "cave_rock",
                    "plaster",
                    "palisade",
                    "fence",
                    "hedge",
                    "low_wall",
                    "railing",
                    "iron_bars",
                    "ruined",
                    "railing_stone",
                    "concrete",
                    "metal",
                    "panel",
                    "marble",
                    "dark_stone",
                    "timber",
                    "none",
                  ],
                },
                approach: {
                  type: "string",
                  enum: ["steps", "none"],
                },
              },
            },
            corners: {
              type: "string",
              enum: ["square", "chamfer"],
              description: "chamfer cuts the outer corners of every storey",
            },
            roof: {
              oneOf: [
                {
                  const: "none",
                },
                {
                  type: "object",
                  required: ["type"],
                  additionalProperties: false,
                  properties: {
                    type: {
                      type: "string",
                      enum: [
                        "gable",
                        "flat",
                        "none",
                        "hip",
                        "shed",
                        "cone",
                        "dome",
                        "skirt",
                        "stepped",
                        "spire",
                        "vault",
                      ],
                      description:
                        "built: gable, hip, shed, flat, skirt (mansard ring), stepped, spire (cone builds as spire), none; dome and vault are built flat for now",
                    },
                    layers: {
                      type: "array",
                      maxItems: 4,
                      items: {
                        type: "object",
                        required: ["type"],
                        additionalProperties: false,
                        properties: {
                          type: {
                            type: "string",
                            enum: [
                              "gable",
                              "flat",
                              "none",
                              "hip",
                              "shed",
                              "cone",
                              "dome",
                              "skirt",
                              "stepped",
                              "spire",
                              "vault",
                            ],
                            description:
                              "built: gable, hip, shed, flat, skirt (mansard ring), stepped, spire (cone builds as spire), none; dome and vault are built flat for now",
                          },
                          style: {
                            type: "string",
                          },
                          ridge: {
                            type: "string",
                            enum: ["ew", "ns"],
                          },
                          courses: {
                            type: "integer",
                            description: "skirt, stepped: rings (1..6); spire: flared bands",
                          },
                          low: {
                            type: "string",
                            enum: ["N", "E", "S", "W"],
                          },
                          parapet: {
                            type: "string",
                            enum: [
                              "wall",
                              "stone",
                              "brick",
                              "wood",
                              "cave_rock",
                              "plaster",
                              "palisade",
                              "fence",
                              "hedge",
                              "low_wall",
                              "railing",
                              "iron_bars",
                              "ruined",
                              "railing_stone",
                              "concrete",
                              "metal",
                              "panel",
                              "marble",
                              "dark_stone",
                              "timber",
                              "none",
                            ],
                          },
                        },
                      },
                      description:
                        "Stacked roof strategies, bottom first, each on the flat top the one below leaves (skirt then spire; stepped then flat).",
                    },
                    courses: {
                      type: "integer",
                      description: "skirt, stepped: rings (1..6); spire: flared bands",
                    },
                    low: {
                      type: "string",
                      enum: ["N", "E", "S", "W"],
                      description: "shed: the side the roof falls to",
                    },
                    ridge: {
                      type: "string",
                      enum: ["ew", "ns"],
                    },
                    style: {
                      type: "string",
                      description: "roof kit, e.g. slate",
                    },
                    deck: {
                      type: "boolean",
                    },
                    broken: {
                      type: "number",
                      description: "0..0.6 fraction of roof built broken (ruins); default 0",
                    },
                    parapet: {
                      type: "string",
                      enum: [
                        "wall",
                        "stone",
                        "brick",
                        "wood",
                        "cave_rock",
                        "plaster",
                        "palisade",
                        "fence",
                        "hedge",
                        "low_wall",
                        "railing",
                        "iron_bars",
                        "ruined",
                        "railing_stone",
                        "concrete",
                        "metal",
                        "panel",
                        "marble",
                        "dark_stone",
                        "timber",
                        "none",
                      ],
                    },
                  },
                },
              ],
            },
            roofFurniture: {
              type: "object",
              additionalProperties: false,
              description: "Override the style's roof furniture.",
              properties: {
                dormers: {
                  type: "boolean",
                },
                clutter: {
                  type: "number",
                  description: "0..0.5 share of a flat roof covered by vents, crates and the like",
                },
                mast: {
                  type: "boolean",
                },
                finial: {
                  type: "boolean",
                },
                hut: {
                  type: "boolean",
                  description: "a stair hut on a flat roof",
                },
              },
            },
            x: {
              type: "integer",
              description: "shorthand: x, y, w, h = wings [{x, y, w, h}]",
            },
            y: {
              type: "integer",
            },
            w: {
              type: "integer",
            },
            h: {
              type: "integer",
            },
            character: {
              type: "array",
              maxItems: 4,
              items: {
                type: "string",
                enum: ["twisted", "leaning", "crooked", "top_heavy", "squat", "slender"],
              },
              description:
                "How the request's adjectives bend the form (combines with condition): twisted = the shaft's storeys step round its axis in turn (a corkscrew), each overhang on a corbel; leaning = storeys step one way; crooked = small random offsets, uneven storeys; top_heavy = upper storeys wider; squat / slender. Leave storeys, roof and volumes unset so the style can draw it.",
            },
            light: {
              type: "string",
              enum: ["dark", "dim", "moderate", "bright", "flooded"],
              description:
                "Generator 5: how many lights mark the place in use, dark (none) to flooded; not the board's brightness. Omitted = read from its words, else the place around it.",
            },
            condition: {
              type: "string",
              enum: ["intact", "weathered", "ramshackle", "ruined"],
              description:
                "State: words in the request about it must be honoured (ruined, abandoned, burnt → ruined; worn, old, overgrown → weathered). Ruined: falls away from one standing corner (low wall stubs against a tall remnant, ragged tops, holed floors, roof fallen in, a gable wall may stand), breaches, rubble mostly inside, no lights. Weathered: whole, with a patch of roof fallen in, most windows dark, growth and rubble at its foot. Generator 5: ramshackle (older generators build it weathered) is a patched roof, boarded windows, a lean-to, and ramshackle words in its name, tags or notes make an intact or weathered building so too; a ruin loses a few whole bays, and crumbling or collapsed in its words make it a lighter or a heavier one.",
            },
            wealth: {
              type: "string",
              enum: ["poor", "modest", "wealthy", "lavish"],
              description:
                "Generator 5: how plain or rich its trims and contents are. Omitted = read from its words, else the place around it.",
            },
            growth: {
              type: "string",
              enum: ["none", "light", "medium", "heavy"],
              description:
                "How overgrown a weathered or ruined building is. light (the weathered default): a few vines, a bush or two at the foot. medium (the ruined default): vines on about a fifth of the wall. heavy: vines and creepers climbing from the ground on a third to half of the walls, bushes at the wall feet and inside, plants on the wall tops, a tree in a roofless part. Words overgrown, ivy-covered, reclaimed, abandoned, nature taking it back → heavy.",
            },
            use: {
              type: "string",
              description:
                "What the building is for (shop, apartments, office, warehouse, garage, townhouse, diner, civic, workshop; shack, farmhouse, tavern …). Leave shape and looks to the style and set a different use per building: the style draws silhouette, material, roof, windows and street level from it. Generator 3 cottages know trades: baker, smith, shop (store, general, grocer), butcher, apothecary (herbalist), cobbler, tailor, inn (tavern): each gets a glazed shop front with a sign, a tent-cloth awning over it and a few trade props outside the door (sacks, anvil, crates, barrels, benches). Neighbours that share a wall stand wing to wing; vary wing depth by a cell so the street front is not a ruler line. Generator 5: the use also picks the ground storey's rooms (an inn's taproom and kitchen, a shop floor and store, a workshop, a shrine, a guardroom and armoury, a store room and office, else a home).",
            },
            front: {
              type: "string",
              enum: ["N", "E", "S", "W"],
              description:
                "The face toward the street or square: door, shopfront and entrance lights go there. Default: the face onto the most open ground.",
            },
            shopfront: {
              type: "boolean",
              description:
                "ground storey on the front face as a shopfront (wide glazing, sign band). Works on cottage and the other styles too (generator 3: corner cells keep their wall); a trade `use` sets it for you.",
            },
            lighting: {
              type: "object",
              additionalProperties: false,
              description: "Override the style's lights.",
              properties: {
                windows: {
                  type: "string",
                  enum: ["none", "warm", "glow"],
                  description: "lit windows: warm room light or a magical glow",
                },
                colour: {
                  type: "string",
                  description: "glow colour, e.g. violet",
                },
                doors: {
                  type: "boolean",
                  description: "a light beside every door",
                },
                strips: {
                  type: "boolean",
                  description: "light strips flanking the main entrance",
                },
              },
            },
            openings: {
              type: "array",
              maxItems: 32,
              items: {
                type: "object",
                required: ["kind", "side"],
                additionalProperties: false,
                properties: {
                  kind: {
                    type: "string",
                    enum: [
                      "door",
                      "double_door",
                      "locked_door",
                      "secret_door",
                      "portcullis",
                      "archway",
                      "open",
                      "window",
                      "arrow_slit",
                      "bars",
                    ],
                  },
                  side: {
                    type: "string",
                    enum: ["N", "E", "S", "W"],
                  },
                  position: {
                    type: "number",
                    description: "0..1 along that face",
                  },
                  storey: {
                    type: "integer",
                  },
                  width: {
                    type: "integer",
                    enum: [1, 2, 3],
                  },
                },
              },
              description:
                "Doors, windows, arches by face. Without a door the building gets one on a face the seed picks.",
            },
            windows: {
              type: "string",
              enum: ["none", "sparse", "regular", "dense"],
            },
            chimneys: {
              type: "array",
              maxItems: 4,
              items: {
                type: "object",
                required: ["side"],
                additionalProperties: false,
                properties: {
                  side: {
                    type: "string",
                    enum: ["N", "E", "S", "W"],
                  },
                  position: {
                    type: "number",
                  },
                },
              },
              description:
                "Chimney breasts in the wall line (on a gable end for a pitched roof); [] for none.",
            },
            attachments: {
              type: "array",
              maxItems: 8,
              items: {
                type: "object",
                required: ["type", "side"],
                additionalProperties: false,
                properties: {
                  type: {
                    type: "string",
                    enum: ["porch", "lean_to", "balcony", "outside_stairs"],
                    description: "built today: porch",
                  },
                  side: {
                    type: "string",
                    enum: ["N", "E", "S", "W"],
                  },
                  position: {
                    type: "number",
                  },
                  width: {
                    type: "integer",
                  },
                  depth: {
                    type: "integer",
                  },
                  floor: {
                    type: "string",
                    enum: [
                      "flagstone",
                      "stone_tile",
                      "marble",
                      "brick",
                      "cobble",
                      "wood_plank",
                      "carpet",
                      "rock",
                      "dirt",
                      "grass",
                      "sand",
                      "gravel",
                      "mud",
                      "snow",
                      "ice",
                      "swamp",
                      "water_shallow",
                      "water_deep",
                      "lava",
                      "bridge_wood",
                      "asphalt",
                      "concrete",
                    ],
                  },
                  roof: {
                    type: "string",
                    enum: ["flat", "none"],
                  },
                },
              },
            },
            readAloud: {
              type: "string",
            },
            encounter: {
              type: "string",
            },
            tags: {
              type: "array",
              items: {
                type: "string",
              },
            },
            shape: {
              $ref: "#/$defs/shape",
              description: "enclosure: the yard",
            },
            wall: {
              type: "string",
              enum: [
                "wall",
                "stone",
                "brick",
                "wood",
                "cave_rock",
                "plaster",
                "palisade",
                "fence",
                "hedge",
                "low_wall",
                "railing",
                "iron_bars",
                "ruined",
                "railing_stone",
                "concrete",
                "metal",
                "panel",
                "marble",
                "dark_stone",
                "timber",
                "none",
              ],
              description: "enclosure: fence style (default fence)",
            },
            gates: {
              type: "array",
              maxItems: 8,
              items: {
                type: "object",
                required: ["side"],
                additionalProperties: false,
                properties: {
                  side: {
                    type: "string",
                    enum: ["N", "E", "S", "W"],
                  },
                  position: {
                    type: "number",
                  },
                  width: {
                    type: "integer",
                    enum: [1, 2, 3],
                  },
                },
              },
            },
            floor: {
              type: "string",
              enum: [
                "flagstone",
                "stone_tile",
                "marble",
                "brick",
                "cobble",
                "wood_plank",
                "carpet",
                "rock",
                "dirt",
                "grass",
                "sand",
                "gravel",
                "mud",
                "snow",
                "ice",
                "swamp",
                "water_shallow",
                "water_deep",
                "lava",
                "bridge_wood",
                "asphalt",
                "concrete",
              ],
              description: "enclosure: yard floor",
            },
          },
        },
        op: {
          oneOf: [
            {
              type: "object",
              required: ["op", "element"],
              additionalProperties: false,
              properties: {
                op: {
                  const: "add",
                },
                element: {
                  oneOf: [
                    {
                      type: "object",
                      required: ["kind", "level", "value"],
                      additionalProperties: false,
                      properties: {
                        kind: {
                          const: "area",
                        },
                        level: {
                          type: "string",
                        },
                        value: {
                          $ref: "#/$defs/area",
                        },
                        index: {
                          type: "integer",
                        },
                      },
                    },
                    {
                      type: "object",
                      required: ["kind", "level", "value"],
                      additionalProperties: false,
                      properties: {
                        kind: {
                          const: "opening",
                        },
                        level: {
                          type: "string",
                        },
                        value: {
                          $ref: "#/$defs/opening",
                        },
                      },
                    },
                    {
                      type: "object",
                      required: ["kind", "level", "value"],
                      additionalProperties: false,
                      properties: {
                        kind: {
                          const: "wall_run",
                        },
                        level: {
                          type: "string",
                        },
                        value: {
                          $ref: "#/$defs/wallRun",
                        },
                      },
                    },
                    {
                      type: "object",
                      required: ["kind", "level", "value"],
                      additionalProperties: false,
                      properties: {
                        kind: {
                          const: "feature",
                        },
                        level: {
                          type: "string",
                        },
                        value: {
                          $ref: "#/$defs/feature",
                        },
                      },
                    },
                    {
                      type: "object",
                      required: ["kind", "level", "value"],
                      additionalProperties: false,
                      properties: {
                        kind: {
                          const: "terrain",
                        },
                        level: {
                          type: "string",
                        },
                        value: {
                          $ref: "#/$defs/terrain",
                        },
                        index: {
                          type: "integer",
                        },
                      },
                    },
                    {
                      type: "object",
                      required: ["kind", "level", "value"],
                      additionalProperties: false,
                      properties: {
                        kind: {
                          const: "label",
                        },
                        level: {
                          type: "string",
                        },
                        value: {
                          $ref: "#/$defs/label",
                        },
                      },
                    },
                    {
                      type: "object",
                      required: ["kind", "level", "value"],
                      additionalProperties: false,
                      properties: {
                        kind: {
                          const: "structure",
                        },
                        level: {
                          type: "string",
                        },
                        value: {
                          $ref: "#/$defs/structure",
                        },
                      },
                    },
                    {
                      type: "object",
                      required: ["kind", "value"],
                      additionalProperties: false,
                      properties: {
                        kind: {
                          const: "link",
                        },
                        value: {
                          $ref: "#/$defs/link",
                        },
                      },
                    },
                    {
                      type: "object",
                      required: ["kind", "value"],
                      additionalProperties: false,
                      properties: {
                        kind: {
                          const: "level",
                        },
                        value: {
                          $ref: "#/$defs/level",
                        },
                      },
                    },
                  ],
                },
              },
            },
            {
              type: "object",
              required: ["op", "level", "features"],
              additionalProperties: false,
              properties: {
                op: {
                  const: "add_features",
                },
                level: {
                  type: "string",
                },
                features: {
                  type: "array",
                  items: {
                    $ref: "#/$defs/feature",
                  },
                  maxItems: 500,
                },
              },
            },
            {
              type: "object",
              required: ["op", "id", "set"],
              additionalProperties: false,
              properties: {
                op: {
                  const: "update",
                },
                id: {
                  type: "string",
                },
                set: {
                  type: "object",
                  description:
                    "Fields to overwrite on that element (same field names as when adding it). null deletes an optional field. Nested objects (shape, bounds, from/to, base) are replaced whole.",
                },
              },
            },
            {
              type: "object",
              required: ["op", "ids"],
              additionalProperties: false,
              properties: {
                op: {
                  const: "remove",
                },
                ids: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                  minItems: 0,
                  description:
                    'ids may name generated features as results show them ("rocks#5"); their scatter or dress op is turned into features first.',
                },
                where: {
                  type: "object",
                  additionalProperties: false,
                  description: "where removes every matching feature in one op.",
                  properties: {
                    generatedBy: {
                      type: "string",
                    },
                    type: {
                      type: "string",
                      enum: [
                        "table",
                        "round_table",
                        "chair",
                        "bench",
                        "stool",
                        "bed",
                        "bunk_bed",
                        "wardrobe",
                        "bookshelf",
                        "desk",
                        "chest",
                        "barrel",
                        "crate",
                        "sack",
                        "shelf",
                        "counter",
                        "bar_counter",
                        "throne",
                        "rug",
                        "cauldron",
                        "anvil",
                        "forge",
                        "weapon_rack",
                        "armor_stand",
                        "cage",
                        "stocks",
                        "pillar",
                        "statue",
                        "altar",
                        "fountain",
                        "well",
                        "brazier",
                        "torch_wall",
                        "candelabra",
                        "banner_wall",
                        "painting_wall",
                        "sarcophagus",
                        "coffin",
                        "tomb",
                        "bones",
                        "rubble",
                        "web",
                        "debris",
                        "pool",
                        "lever",
                        "trap",
                        "trap_plate",
                        "chandelier",
                        "tree",
                        "dead_tree",
                        "pine_tree",
                        "bush",
                        "rock",
                        "boulder",
                        "stump",
                        "log",
                        "mushroom",
                        "flowers",
                        "tall_grass",
                        "reeds",
                        "campfire",
                        "tent",
                        "cart",
                        "wagon",
                        "fence_post",
                        "signpost",
                        "standing_stone",
                        "grave",
                        "stalagmite",
                        "stalactite",
                        "rock_formation",
                        "cave_in",
                        "crystal",
                        "giant_mushroom",
                        "root",
                        "root_large",
                        "roots_wall",
                        "vines",
                        "tree_large",
                        "candles",
                        "skull_pile",
                        "spawn_point",
                        "torch_floor",
                        "lantern",
                        "magic_fire",
                        "lava_glow",
                        "fire_pit",
                        "monolith",
                        "cave_column",
                        "statue_large",
                        "mine_cart",
                        "rails",
                        "mine_support",
                        "chains",
                        "landmark",
                        "tall_marker",
                        "formation",
                        "cluster_tall",
                        "undergrowth",
                        "ground_cover",
                        "accent_light",
                        "edge_dressing",
                        "small_detail",
                        "wall_dressing",
                        "bank_dressing",
                        "jetty",
                        "vehicle",
                        "seating",
                        "signage",
                        "cliff_face",
                        "cliff_crest",
                        "stall",
                        "goods",
                        "overhead",
                        "line_post",
                        "clutter",
                        "shelf_line",
                        "custom",
                      ],
                    },
                    rect: {
                      type: "object",
                      required: ["x", "y", "w", "h"],
                      additionalProperties: false,
                      properties: {
                        x: {
                          type: "integer",
                        },
                        y: {
                          type: "integer",
                        },
                        w: {
                          type: "integer",
                        },
                        h: {
                          type: "integer",
                        },
                      },
                    },
                    level: {
                      type: "string",
                    },
                  },
                },
                keepDependents: {
                  type: "boolean",
                },
              },
            },
            {
              type: "object",
              required: ["op", "ids", "dx", "dy"],
              additionalProperties: false,
              properties: {
                op: {
                  const: "move",
                },
                ids: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                  minItems: 1,
                },
                dx: {
                  type: "integer",
                },
                dy: {
                  type: "integer",
                },
                withContents: {
                  type: "boolean",
                },
                toLevel: {
                  type: "string",
                },
              },
            },
            {
              type: "object",
              required: ["op", "ids", "dx", "dy", "idSuffix"],
              additionalProperties: false,
              properties: {
                op: {
                  const: "duplicate",
                },
                ids: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                  minItems: 1,
                },
                dx: {
                  type: "integer",
                },
                dy: {
                  type: "integer",
                },
                idSuffix: {
                  type: "string",
                },
                toLevel: {
                  type: "string",
                },
              },
            },
            {
              type: "object",
              required: ["op", "id", "index"],
              additionalProperties: false,
              properties: {
                op: {
                  const: "reorder",
                },
                id: {
                  type: "string",
                },
                index: {
                  type: "integer",
                },
              },
            },
            {
              type: "object",
              required: ["op", "id"],
              additionalProperties: false,
              properties: {
                op: {
                  const: "materialize",
                },
                id: {
                  type: "string",
                },
                keepOp: {
                  type: "boolean",
                },
              },
            },
            {
              type: "object",
              required: ["op"],
              additionalProperties: false,
              properties: {
                op: {
                  const: "set_meta",
                },
                title: {
                  type: "string",
                },
                summary: {
                  type: ["string", "null"],
                },
                kind: {
                  type: "string",
                  enum: ["dungeon", "cave", "building", "tower", "town", "outdoor", "mixed"],
                },
                seed: {
                  type: "integer",
                },
                theme: {
                  type: "string",
                },
                notes: {
                  type: ["string", "null"],
                },
              },
            },
            {
              type: "object",
              required: ["op", "id", "shape"],
              additionalProperties: false,
              properties: {
                op: {
                  const: "reshape",
                },
                id: {
                  type: "string",
                },
                shape: {
                  $ref: "#/$defs/shape",
                },
              },
            },
            {
              type: "object",
              required: ["op"],
              additionalProperties: false,
              properties: {
                op: {
                  const: "renumber",
                },
              },
            },
          ],
        },
      },
    },
  },
  {
    name: "view_plan",
    streamInput: false,
    description:
      "Look at the current plan. outline = every element with its key parameters (authoritative ids, compact); ascii = resolved map of one level (walls, doors, features, heights) optionally cropped to a region (a crop over 160×160 cells comes back as an overview, one character per block of cells with its scale stated: ask for a smaller region for every cell); json = exact JSON of selected elements. Call this before editing something you have not seen since the last change, or when the GM refers to a part of the map you need to inspect.",
    inputSchema: {
      type: "object",
      required: ["format"],
      additionalProperties: false,
      properties: {
        level: {
          type: "string",
        },
        format: {
          type: "string",
          enum: ["outline", "ascii", "json"],
        },
        region: {
          type: "object",
          required: ["x", "y", "w", "h"],
          additionalProperties: false,
          properties: {
            x: {
              type: "integer",
            },
            y: {
              type: "integer",
            },
            w: {
              type: "integer",
            },
            h: {
              type: "integer",
            },
          },
        },
        ids: {
          type: "array",
          items: {
            type: "string",
          },
        },
      },
    },
  },
  {
    name: "view_map_image",
    streamInput: false,
    description:
      "Render one level of the current plan as a PNG exactly as the GM sees it in the app. Use it sparingly — after creating a level or a large generated change — to check layout, proportions and overlaps that are hard to judge from ASCII.",
    inputSchema: {
      type: "object",
      required: ["level"],
      additionalProperties: false,
      properties: {
        level: {
          type: "string",
        },
        region: {
          type: "object",
          required: ["x", "y", "w", "h"],
          additionalProperties: false,
          properties: {
            x: {
              type: "integer",
            },
            y: {
              type: "integer",
            },
            w: {
              type: "integer",
            },
            h: {
              type: "integer",
            },
          },
        },
        showIds: {
          type: "boolean",
        },
      },
    },
  },
  {
    name: "compile_preview",
    streamInput: false,
    description:
      "Estimate the TaleSpire build without exporting: asset count and slab chunk count per level, and anything that cannot be built with the current themes (missing assets, unsupported features). Call before telling the GM the map is ready to build, or when asked about size.",
    inputSchema: {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: {
        levels: {
          type: "array",
          items: {
            type: "string",
          },
        },
      },
    },
  },
  {
    name: "list_catalog",
    streamInput: false,
    description:
      "List what can be built: installed themes, materials, wall styles, dress presets, or feature types (with which ones the given theme has real TaleSpire assets for). Call when choosing a theme or before using a feature you are unsure the theme supports.",
    inputSchema: {
      type: "object",
      required: ["what"],
      additionalProperties: false,
      properties: {
        what: {
          type: "string",
          enum: ["themes", "features", "materials", "wall_styles", "presets"],
        },
        theme: {
          type: "string",
        },
      },
    },
  },
];
