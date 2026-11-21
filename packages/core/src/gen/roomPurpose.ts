/**
 * What a room is for, and whether anyone keeps it up (generator 4). The ONE classifier of a room's words: the resolver
 * calls `classifyRoom` once per area and writes the result on the resolved area (`ResolvedArea.purpose`, `.abandoned`,
 * `.finish`); its floor, dressing, lights, rubble and wall tops, the compiler's shell and broken tops, and the review
 * all read that, and never parse words again. Keyword inference only: a room whose words say nothing gets no purpose
 * (we never invent one).
 *
 * How the words are read (one policy for every stage):
 *  - the NAME says what the room is. English puts the head noun last ("Guard room", "Shrine antechamber", "Crypt
 *    passage", "Kitchen cellar"), so the last purpose word before a linking word (of, for, by, and ...) wins: "Shrine
 *    of the Hearth" is a shrine, "Shrine antechamber" an antechamber. Failing that, the first purpose word after it.
 *  - then each TAG in order, read the same way;
 *  - then the NOTES (their first 160 characters), and only for what the room is used for: notes are prose that mention
 *    neighbours and debris ("the keys hang by the stair door", "rubble by the hearth"), so a passage or a ruin is never
 *    read from them; the earliest use word wins.
 *  - A room is abandoned when its purpose is a place nobody keeps (a crypt, cells, a ruin), when its name or tags
 *    carry a word of neglect (derelict, deserted, looted ...: it keeps its purpose, sparsely dressed) or of wreckage
 *    (ruined, collapsed: it is a ruin, nothing to furnish; a passage stays a passage), or when it is a passage of such
 *    a place ("Crypt passage", "Cell block corridor"). A name of neglect with no use ("Abandoned chamber") is a ruin.
 */
import type { Material } from "../contracts/plan";
import type { FloorFamily, RoomPurpose } from "../contracts/resolved";

export type { RoomPurpose } from "../contracts/resolved";

/** What a purpose implies. */
export interface PurposeInfo {
  /** Whole lower-case words that name it. */
  words: RegExp;
  /** Nobody keeps such a place up: sparse furniture, one light at most (the dark-dungeon rule), rough finish. */
  abandoned: boolean;
  /** The generator dresses it from its recipe (gen/rooms4.ts ROOM_RECIPES_4); also a dress preset of the same name. */
  furnished: boolean;
  /**
   * The room's floor in each floor family (resolve LevelWork.stepRoomFloors), null = no floor of its own (the rotation
   * decides). "keep" = a corridor in all but name: it keeps the floor and height of the corridors it joins.
   */
  floor: Readonly<Record<FloorFamily, Material | null>> | "keep";
  /** May the notes name it (a use of the room, not its shape or state)? */
  inNotes: boolean;
}

const use = (words: RegExp, stone: Material | null, timber: Material | null, abandoned = false): PurposeInfo => ({
  words,
  abandoned,
  furnished: true,
  floor: { stone, timber },
  inNotes: true,
});

/**
 * Every purpose and what it implies, in priority order (a word that two purposes claim goes to the earlier one). The
 * floors: a stone level never takes wood (a barracks gets tile); a timber building takes wood except where water,
 * fire or storage asks for tile or cobble.
 */
export const ROOM_PURPOSE_INFO: Readonly<Record<RoomPurpose, PurposeInfo>> = {
  ruin: {
    words: /^(ruins?|rubble|wreck|wreckage)$/,
    abandoned: true,
    furnished: false,
    floor: { stone: null, timber: null },
    inNotes: false,
  },
  passage: {
    words:
      /^(passages?|passageway|corridors?|tunnels?|hallway|landings?|stairs?|stairway|staircase|vestibule|lobby|foyer|junction|gallery|antechamber|anteroom)$/,
    abandoned: false,
    furnished: false,
    floor: "keep",
    inNotes: false,
  },
  tavern: use(/^(taverns?|inns?|taprooms?|tap|taphouse|pubs?|alehouses?|saloons?|bar)$/, "stone_tile", "wood_plank"),
  throne_room: use(/^(throne|thrones|audience|court|courtroom)$/, "marble", "wood_plank"),
  dining: use(/^(halls?|refectory|dining|mess|banquet|feast|feasting|canteen)$/, "stone_tile", "wood_plank"),
  kitchen: use(/^(kitchens?|scullery|galley|bakery|cookhouse|cookroom)$/, "stone_tile", "stone_tile"),
  library: use(/^(librar(y|ies)|scriptorium|archives?|bookroom|reading)$/, "stone_tile", "wood_plank"),
  study: use(
    /^(study|studies|office|offices|sanctum|workroom|counting|scribes?|chancery|solar|parlou?r)$/,
    "stone_tile",
    "wood_plank",
  ),
  armoury: use(/^(armou?ry|armou?ries|arsenal|weaponry|armou?rers?)$/, "stone_tile", "wood_plank"),
  barracks: use(
    /^(guards?|guardroom|guardhouse|barracks?|garrison|watch|watchroom|sentry|sentries|soldiers?|gatehouse)$/,
    "stone_tile",
    "wood_plank",
  ),
  bedroom: use(
    /^(beds?|bedrooms?|bedchambers?|dormitory|dorm|quarters|cabin|guestroom|guests?|lodgings?|suite|nursery|boudoir|sleeping)$/,
    "stone_tile",
    "wood_plank",
  ),
  storeroom: use(
    /^(stores?|storerooms?|storage|pantry|cellars?|larder|warehouse|stockroom|supplies|granary|stockpile)$/,
    "cobble",
    "cobble",
  ),
  shrine: use(
    /^(shrines?|chapels?|temples?|sanctuary|oratory|altar|church|prayer|vestry|cathedral|reliquary|chantry)$/,
    "stone_tile",
    "wood_plank",
  ),
  crypt: use(
    /^(crypts?|tombs?|ossuary|catacombs?|mausoleum|burial|sepulch(re|er)|sarcophagus)$/,
    "cobble",
    "cobble",
    true,
  ),
  prison: use(
    /^(cells?|prison|prisons|gaol|jail|oubliette|torture|cellblock|dungeons?|brig|stockade)$/,
    "stone_tile",
    "wood_plank",
    true,
  ),
  forge: use(/^(forge|smithy|smith|smithing|foundry|workshops?|carpentry)$/, "flagstone", "cobble"),
  laboratory: use(
    /^(laborator(y|ies)|lab|alchem(y|ist)|alchemists?|apothecary|infirmary|sickbay|herbarium|distillery)$/,
    null,
    null,
  ),
  treasury: use(/^(treasur(y|e|ies)|vaults?|strongroom|hoard|bank|bullion|coffers)$/, "stone_tile", "wood_plank"),
  washroom: use(
    /^(baths?|bathhouse|bathroom|wash|washroom|latrines?|privy|privies|laundry|lavatory|washhouse|garderobe|sauna)$/,
    null,
    "stone_tile",
  ),
};

const PURPOSE_ORDER = Object.keys(ROOM_PURPOSE_INFO) as RoomPurpose[];

/** Words of neglect: nobody keeps the room up, but it is still what it was for (an abandoned chapel keeps its pews). */
const NEGLECT = /^(abandoned|derelict|disused|forgotten|looted|deserted|ransacked)$/;
/** Words of wreckage: the room is a ruin whatever it was for (a ruined chapel is rubble, nothing to furnish). */
const WRECKED = /^(ruined|collapsed|wrecked|caved)$/;
/** Words that end the head phrase of a name ("Shrine | of the Hearth", "Guard room | by the cells"). */
const LINKING = /^(of|for|with|by|near|under|beneath|below|beside|behind|above|over|in|on|at|to|from|off|past|and)$/;

function purposeOfWord(w: string): RoomPurpose | undefined {
  for (const p of PURPOSE_ORDER) if (ROOM_PURPOSE_INFO[p].words.test(w)) return p;
  return undefined;
}

const wordsOf = (text: string): string[] => text.toLowerCase().match(/[a-z]+/g) ?? [];

/** A name or tag: the last purpose word of the head phrase, else the first one after it; plus any other purpose named. */
function readPhrase(text: string): { head?: RoomPurpose; named: RoomPurpose[]; neglect: boolean; wrecked: boolean } {
  const words = wordsOf(text);
  const cut = words.findIndex((w) => LINKING.test(w));
  const headWords = cut < 0 ? words : words.slice(0, cut);
  const named: RoomPurpose[] = [];
  for (const w of words) {
    const p = purposeOfWord(w);
    if (p !== undefined) named.push(p);
  }
  let head: RoomPurpose | undefined;
  for (const w of headWords) head = purposeOfWord(w) ?? head;
  if (head === undefined && cut >= 0)
    for (const w of words.slice(cut)) {
      head = purposeOfWord(w);
      if (head !== undefined) break;
    }
  const out: { head?: RoomPurpose; named: RoomPurpose[]; neglect: boolean; wrecked: boolean } = {
    named,
    neglect: words.some((w) => NEGLECT.test(w)),
    wrecked: words.some((w) => WRECKED.test(w)),
  };
  if (head !== undefined) out.head = head;
  return out;
}

export interface RoomWords {
  name?: string | undefined;
  tags?: readonly string[] | undefined;
  notes?: string | undefined;
}

export interface RoomClass {
  /** What the room is for; absent = its words name nothing. */
  purpose?: RoomPurpose;
  /** Nobody keeps it up. */
  abandoned: boolean;
}

/** The one reading of a room's words (see the file header for the policy). */
export function classifyRoom(area: RoomWords): RoomClass {
  const phrases = [area.name ?? "", ...(area.tags ?? [])].map(readPhrase);
  let purpose = phrases.find((ph) => ph.head !== undefined)?.head;
  if (purpose === undefined) {
    for (const w of wordsOf((area.notes ?? "").slice(0, 160))) {
      const p = purposeOfWord(w);
      if (p !== undefined && ROOM_PURPOSE_INFO[p].inNotes) {
        purpose = p;
        break;
      }
    }
  }
  const neglect = phrases.some((ph) => ph.neglect);
  // a wrecked room is a ruin, whatever it was for ("Ruined chapel", "Collapsed chamber", tag "ruined"), except a
  // passage, which stays a way through ("Collapsed tunnel")
  const wrecked = phrases.some((ph) => ph.wrecked);
  if (wrecked && purpose !== "passage") purpose = "ruin";
  // a name of neglect with no use is a ruin too ("Abandoned chamber")
  if (purpose === undefined && neglect) purpose = "ruin";
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

/** Does the generator dress rooms of this purpose from a recipe? */
export function furnishedPurpose(p: RoomPurpose | undefined): p is FurnishedPurpose {
  return p !== undefined && ROOM_PURPOSE_INFO[p].furnished;
}

/** Purposes with a recipe (gen/rooms4.ts); each is also an interior dress preset of the same name. */
export type FurnishedPurpose = Exclude<RoomPurpose, "ruin" | "passage">;

/** The purpose an interior dress preset stands for (a dress op over a room uses that purpose's recipe). */
export function presetPurpose(preset: string): FurnishedPurpose | undefined {
  const p = preset as RoomPurpose;
  return Object.hasOwn(ROOM_PURPOSE_INFO, p) && furnishedPurpose(p) ? p : undefined;
}
