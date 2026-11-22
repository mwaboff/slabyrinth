/**
 * What a room is for, and whether anyone keeps it up (generator 4). The ONE classifier of a room: the resolver calls
 * `classifyRoom` once per area and writes the result on the resolved area (`ResolvedArea.purpose`, `.abandoned`);
 * its floor, dressing, lights, rubble and wall tops, the compiler's broken tops, and the review all read that, and
 * never parse words again. Being abandoned never changes what a room's walls are made of (`ResolvedArea.finish` is
 * the theme's, and the compiler's shell reads that alone). A room whose plan and words say nothing gets no purpose (we never
 * invent one).
 *
 * Where the purpose comes from, first match wins:
 *  1. the plan's `Area.purpose`: the author said what the room is for (a name in another language, "The Grey Hall of
 *     Oaths" used for feasts, "Shrine antechamber" that is a shrine);
 *  2. the NAME. English puts the head noun last ("Guard room", "Shrine antechamber", "Crypt passage", "Kitchen
 *     cellar"), so the last purpose word before a linking word (of, for, by, and ...) wins: "Shrine of the Hearth" is
 *     a shrine, "Shrine antechamber" an antechamber. Failing that, the first purpose word after it;
 *  3. each TAG in order, read the same way;
 *  4. the NOTES (the whole words of their first 160 characters), and only for what the room is used for: notes are
 *     prose that mention neighbours and debris ("the keys hang by the stair door", "rubble by the hearth"), so a passage
 *     or a ruin is never read from them; the earliest use word wins.
 * Then the state words of the name and tags: a word of wreckage (ruined, collapsed) makes an inferred purpose a ruin,
 * nothing to furnish, except a passage, which stays a way through; a name of neglect with no use ("Abandoned chamber")
 * is a ruin. An explicit purpose is never replaced.
 *
 * A room is abandoned when its purpose is a place nobody keeps (a crypt, cells, a ruin), when its name or tags carry a
 * word of neglect (derelict, deserted, looted ...: it keeps its purpose, sparsely dressed) or of wreckage, or when it is
 * a passage of such a place ("Crypt passage", "Cell block corridor").
 *
 * Words are matched whole: a text is split into runs of the letters a-z (lower-cased), and each run is looked up in
 * the word lists below; every word names at most one purpose (checked when this module loads), so the order of the
 * purposes never decides a match. Plurals and spellings are listed as words of their own.
 */
import type { Material, RoomPurpose } from "../contracts/plan";
import type { FloorFamily } from "../contracts/resolved";

export type { RoomPurpose } from "../contracts/plan";

/** What a purpose implies. */
export interface PurposeInfo {
  /** The whole lower-case words that name it (each word names one purpose only). */
  words: readonly string[];
  /** Nobody keeps such a place up: sparse furniture, one light at most (the dark-dungeon rule), rough finish. */
  abandoned: boolean;
  /** The generator dresses it from its recipe (gen/rooms4 ROOM_RECIPES_4); also a dress preset of the same name. */
  furnished: boolean;
  /**
   * The room's floor in each floor family (resolve/level/rooms.ts stepRoomFloors), null = no floor of its own (the rotation
   * decides). "keep" = a corridor in all but name: it keeps the floor and height of the corridors it joins.
   */
  floor: Readonly<Record<FloorFamily, Material | null>> | "keep";
  /** May the notes name it (a use of the room, not its shape or state)? */
  inNotes: boolean;
  /**
   * An open fire does not belong here (paper, cloth, straw, stored goods): a big room's floor light is a stand of
   * candles, not a brazier (gen/rooms4 dressRoom).
   */
  noFire: boolean;
}

/** A room someone uses: furnished from its recipe, and named by its notes as well as its name. */
const use = (
  words: readonly string[],
  stone: Material | null,
  timber: Material | null,
  traits: { abandoned?: boolean; noFire?: boolean } = {},
): PurposeInfo => ({
  words,
  abandoned: traits.abandoned ?? false,
  furnished: true,
  floor: { stone, timber },
  inNotes: true,
  noFire: traits.noFire ?? false,
});

/**
 * Every purpose and what it implies (one row per value of the plan contract's ROOM_PURPOSES). The floors: a stone
 * level never takes wood (a barracks gets tile); a timber building takes wood except where water, fire or storage
 * asks for tile or cobble.
 */
export const ROOM_PURPOSE_INFO: Readonly<Record<RoomPurpose, PurposeInfo>> = {
  ruin: {
    words: ["ruin", "ruins", "rubble", "wreck", "wreckage"],
    abandoned: true,
    furnished: false,
    floor: { stone: null, timber: null },
    inNotes: false,
    noFire: false,
  },
  passage: {
    words: [
      "passage",
      "passages",
      "passageway",
      "corridor",
      "corridors",
      "tunnel",
      "tunnels",
      "hallway",
      "landing",
      "landings",
      "stair",
      "stairs",
      "stairway",
      "staircase",
      "vestibule",
      "lobby",
      "foyer",
      "junction",
      "gallery",
      "antechamber",
      "anteroom",
    ],
    abandoned: false,
    furnished: false,
    floor: "keep",
    inNotes: false,
    noFire: false,
  },
  tavern: use(
    [
      "tavern",
      "taverns",
      "inn",
      "inns",
      "taproom",
      "taprooms",
      "tap",
      "taphouse",
      "pub",
      "pubs",
      "alehouse",
      "alehouses",
      "saloon",
      "saloons",
      "bar",
    ],
    "stone_tile",
    "wood_plank",
  ),
  throne_room: use(["throne", "thrones", "audience", "court", "courtroom"], "marble", "wood_plank"),
  dining: use(
    ["hall", "halls", "refectory", "dining", "mess", "banquet", "feast", "feasting", "canteen"],
    "stone_tile",
    "wood_plank",
  ),
  kitchen: use(
    ["kitchen", "kitchens", "scullery", "galley", "bakery", "cookhouse", "cookroom"],
    "stone_tile",
    "stone_tile",
  ),
  library: use(
    ["library", "libraries", "scriptorium", "archive", "archives", "bookroom", "reading"],
    "stone_tile",
    "wood_plank",
    { noFire: true },
  ),
  study: use(
    [
      "study",
      "studies",
      "office",
      "offices",
      "sanctum",
      "workroom",
      "counting",
      "scribe",
      "scribes",
      "chancery",
      "solar",
      "parlor",
      "parlour",
    ],
    "stone_tile",
    "wood_plank",
    { noFire: true },
  ),
  armoury: use(
    [
      "armory",
      "armoury",
      "armories",
      "armouries",
      "arsenal",
      "weaponry",
      "armorer",
      "armorers",
      "armourer",
      "armourers",
    ],
    "stone_tile",
    "wood_plank",
  ),
  barracks: use(
    [
      "guard",
      "guards",
      "guardroom",
      "guardhouse",
      "barrack",
      "barracks",
      "garrison",
      "watch",
      "watchroom",
      "sentry",
      "sentries",
      "soldier",
      "soldiers",
      "gatehouse",
    ],
    "stone_tile",
    "wood_plank",
  ),
  bedroom: use(
    [
      "bed",
      "beds",
      "bedroom",
      "bedrooms",
      "bedchamber",
      "bedchambers",
      "dormitory",
      "dorm",
      "quarters",
      "cabin",
      "guestroom",
      "guest",
      "guests",
      "lodging",
      "lodgings",
      "suite",
      "nursery",
      "boudoir",
      "sleeping",
    ],
    "stone_tile",
    "wood_plank",
    { noFire: true },
  ),
  storeroom: use(
    [
      "store",
      "stores",
      "storeroom",
      "storerooms",
      "storage",
      "pantry",
      "cellar",
      "cellars",
      "larder",
      "warehouse",
      "stockroom",
      "supplies",
      "granary",
      "stockpile",
    ],
    "cobble",
    "cobble",
    { noFire: true },
  ),
  shrine: use(
    [
      "shrine",
      "shrines",
      "chapel",
      "chapels",
      "temple",
      "temples",
      "sanctuary",
      "oratory",
      "altar",
      "church",
      "prayer",
      "vestry",
      "cathedral",
      "reliquary",
      "chantry",
    ],
    "stone_tile",
    "wood_plank",
  ),
  crypt: use(
    [
      "crypt",
      "crypts",
      "tomb",
      "tombs",
      "ossuary",
      "catacomb",
      "catacombs",
      "mausoleum",
      "burial",
      "sepulchre",
      "sepulcher",
      "sarcophagus",
    ],
    "cobble",
    "cobble",
    { abandoned: true },
  ),
  prison: use(
    [
      "cell",
      "cells",
      "prison",
      "prisons",
      "gaol",
      "jail",
      "oubliette",
      "torture",
      "cellblock",
      "dungeon",
      "dungeons",
      "brig",
      "stockade",
    ],
    "stone_tile",
    "wood_plank",
    { abandoned: true },
  ),
  forge: use(
    ["forge", "smithy", "smith", "smithing", "foundry", "workshop", "workshops", "carpentry"],
    "flagstone",
    "cobble",
  ),
  laboratory: use(
    [
      "laboratory",
      "laboratories",
      "lab",
      "alchemy",
      "alchemist",
      "alchemists",
      "apothecary",
      "infirmary",
      "sickbay",
      "herbarium",
      "distillery",
    ],
    null,
    null,
    { noFire: true },
  ),
  treasury: use(
    [
      "treasury",
      "treasure",
      "treasuries",
      "vault",
      "vaults",
      "strongroom",
      "hoard",
      "bank",
      "bullion",
      "coffers",
    ],
    "stone_tile",
    "wood_plank",
    { noFire: true },
  ),
  washroom: use(
    [
      "bath",
      "baths",
      "bathhouse",
      "bathroom",
      "wash",
      "washroom",
      "latrine",
      "latrines",
      "privy",
      "privies",
      "laundry",
      "lavatory",
      "washhouse",
      "garderobe",
      "sauna",
    ],
    null,
    "stone_tile",
  ),
};

/** Words of neglect: nobody keeps the room up, but it is still what it was for (an abandoned chapel keeps its pews). */
const NEGLECT: ReadonlySet<string> = new Set([
  "abandoned",
  "derelict",
  "disused",
  "forgotten",
  "looted",
  "deserted",
  "ransacked",
]);
/** Words of wreckage: the room is a ruin whatever it was for (a ruined chapel is rubble, nothing to furnish). */
const WRECKED: ReadonlySet<string> = new Set(["ruined", "collapsed", "wrecked", "caved"]);
/** Words that end the head phrase of a name ("Shrine | of the Hearth", "Guard room | by the cells"). */
const LINKING: ReadonlySet<string> = new Set([
  "of",
  "for",
  "with",
  "by",
  "near",
  "under",
  "beneath",
  "below",
  "beside",
  "behind",
  "above",
  "over",
  "in",
  "on",
  "at",
  "to",
  "from",
  "off",
  "past",
  "and",
]);

/** Each purpose word and the one purpose it names. */
const PURPOSE_OF_WORD: ReadonlyMap<string, RoomPurpose> = (() => {
  const out = new Map<string, RoomPurpose>();
  for (const [purpose, info] of Object.entries(ROOM_PURPOSE_INFO) as Array<[RoomPurpose, PurposeInfo]>)
    for (const w of info.words) {
      const other = out.get(w);
      if (other !== undefined) throw new Error(`room purpose word "${w}" names both ${other} and ${purpose}`);
      out.set(w, purpose);
    }
  return out;
})();

/** How much of the notes is read for a use (their opening, where a GM says what the room is). */
const NOTES_READ = 160;

/** The whole words of a text, lower-cased: runs of the letters a-z. */
const wordsOf = (text: string): string[] => text.toLowerCase().match(/[a-z]+/g) ?? [];

/** The whole words in the first `n` characters of a text (a word the limit cuts through is left out). */
function leadingWords(text: string, n: number): string[] {
  const words = wordsOf(text.slice(0, n));
  const cutMidWord = text.length > n && /[a-z]/i.test(text.charAt(n - 1)) && /[a-z]/i.test(text.charAt(n));
  return cutMidWord ? words.slice(0, -1) : words;
}

/** A name or tag: the last purpose word of the head phrase, else the first one after it; plus any other purpose named. */
function readPhrase(text: string): {
  head?: RoomPurpose;
  named: RoomPurpose[];
  neglect: boolean;
  wrecked: boolean;
} {
  const words = wordsOf(text);
  const cut = words.findIndex((w) => LINKING.has(w));
  const headWords = cut < 0 ? words : words.slice(0, cut);
  const named: RoomPurpose[] = [];
  for (const w of words) {
    const p = PURPOSE_OF_WORD.get(w);
    if (p !== undefined) named.push(p);
  }
  let head: RoomPurpose | undefined;
  for (const w of headWords) head = PURPOSE_OF_WORD.get(w) ?? head;
  if (head === undefined && cut >= 0)
    for (const w of words.slice(cut)) {
      head = PURPOSE_OF_WORD.get(w);
      if (head !== undefined) break;
    }
  const out: { head?: RoomPurpose; named: RoomPurpose[]; neglect: boolean; wrecked: boolean } = {
    named,
    neglect: words.some((w) => NEGLECT.has(w)),
    wrecked: words.some((w) => WRECKED.has(w)),
  };
  if (head !== undefined) out.head = head;
  return out;
}

/** What the classifier reads of an area (a plan Area or a ResolvedArea). */
export interface RoomWords {
  /** The plan's explicit purpose (Area.purpose); wins over the words. */
  purpose?: RoomPurpose | undefined;
  name?: string | undefined;
  tags?: readonly string[] | undefined;
  notes?: string | undefined;
}

export interface RoomClass {
  /** What the room is for; absent = neither the plan nor its words name one. */
  purpose?: RoomPurpose;
  /** Nobody keeps it up. */
  abandoned: boolean;
}

/** The one reading of a room (see the file header for the order). */
export function classifyRoom(area: RoomWords): RoomClass {
  const phrases = [area.name ?? "", ...(area.tags ?? [])].map(readPhrase);
  const neglect = phrases.some((ph) => ph.neglect);
  const wrecked = phrases.some((ph) => ph.wrecked);
  const purpose = area.purpose ?? inferredPurpose(phrases, area.notes ?? "", { neglect, wrecked });
  const abandoned =
    neglect ||
    wrecked ||
    (purpose !== undefined && ROOM_PURPOSE_INFO[purpose].abandoned) ||
    // a passage takes the state of the place it serves
    (purpose === "passage" && phrases.some((ph) => ph.named.some((p) => ROOM_PURPOSE_INFO[p].abandoned)));
  const out: RoomClass = { abandoned };
  if (purpose !== undefined) out.purpose = purpose;
  return out;
}

/** The purpose a room's words give when the plan states none: name, tags, notes, then its state words. */
function inferredPurpose(
  phrases: ReadonlyArray<ReturnType<typeof readPhrase>>,
  notes: string,
  state: { neglect: boolean; wrecked: boolean },
): RoomPurpose | undefined {
  let purpose = phrases.find((ph) => ph.head !== undefined)?.head;
  if (purpose === undefined)
    purpose = leadingWords(notes, NOTES_READ)
      .map((w) => PURPOSE_OF_WORD.get(w))
      .find((p) => p !== undefined && ROOM_PURPOSE_INFO[p].inNotes);
  // a wrecked room is a ruin, whatever it was for ("Ruined chapel", "Collapsed chamber", tag "ruined"), except a
  // passage, which stays a way through ("Collapsed tunnel")
  if (state.wrecked && purpose !== "passage") return "ruin";
  // a name of neglect with no use is a ruin too ("Abandoned chamber")
  if (purpose === undefined && state.neglect) return "ruin";
  return purpose;
}

/** Does the generator dress rooms of this purpose from a recipe? */
export function furnishedPurpose(p: RoomPurpose | undefined): p is FurnishedPurpose {
  return p !== undefined && ROOM_PURPOSE_INFO[p].furnished;
}

/** Purposes with a recipe (gen/rooms4); each is also an interior dress preset of the same name. */
export type FurnishedPurpose = Exclude<RoomPurpose, "ruin" | "passage">;

/** The purpose an interior dress preset stands for (a dress op over a room uses that purpose's recipe). */
export function presetPurpose(preset: string): FurnishedPurpose | undefined {
  const p = preset as RoomPurpose;
  return Object.hasOwn(ROOM_PURPOSE_INFO, p) && furnishedPurpose(p) ? p : undefined;
}
