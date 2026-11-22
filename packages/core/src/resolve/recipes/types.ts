/**
 * A detail recipe (generator 5): data plus one small pure function. It says what anchor kind it attaches to and when
 * (`when`: theme-neutral conditions over the anchor: purposes, wall styles, seen or not, sizes), which pieces it needs
 * (`slots`: by role chain and by shape, each with its fallback when the theme lacks them), how it composes them in the
 * anchor's frame with the arrange/ operators (`compose`), what it is worth when a budget thins (`tier`), whether it is
 * fastened to a wall (`mount`) and blocks the way, and its switch (plan/generator.ts SWITCHES). The engine (engine.ts)
 * does everything else once: finding anchors, filling slots, seeding, keeping doors, stairs and lanes clear, the budget,
 * attaching the instance. Adding a recipe is one entry in table.ts and its test.
 */
import type { Arrangement, ArrangePiece } from "../../arrange";
import type { RoleName } from "../../contracts/compiler";
import type { ResolvedLevel } from "../../contracts/resolved";
import type { TraitQuery } from "../../palette/traitPools";
import type { PlanRoles } from "../../palette/planRoles";
import type { SwitchName } from "../../plan/generator";
import type { AnchorKind, AnchorOf, LevelAnchors } from "../anchors";
import type { Treatment } from "./treatments";

/** What a slot does when neither its roles nor the theme's own pieces have what it needs. */
export type SlotFallback =
  /** Borrow from the whole theme chain, the generic palette included (small clutter, never a visible trim). */
  | "borrow"
  /** Compose a simpler form without it (the slot comes empty; `compose` says what it does then). */
  | "simplify"
  /** Leave the recipe out at this anchor (a wrong piece is worse than none). */
  | "skip";

/** One role a slot asks: the role, and whether only the theme's own palette may answer it (not a borrowed kit). */
export interface SlotRole {
  readonly role: RoleName;
  /** Only when the theme's own palette (or its `extends`, not generic) lists the role. */
  readonly own?: boolean;
}

/** The pieces one slot of a recipe needs. */
export interface SlotSpec<A> {
  /** Roles asked first, in order (style-aware: a function of the anchor); every piece must also fit `shape`. */
  readonly roles?: (a: A, trim: string) => readonly SlotRole[];
  /** The shape the slot's pieces have; the theme's own pieces of it (palette/traitPools.ts) come after the roles. */
  readonly shape?: (a: A, trim: string) => TraitQuery | null;
  /** Fewest distinct pieces a source must offer to supply the slot (default 1). */
  readonly min?: number;
  readonly fallback: SlotFallback;
}

/**
 * A filled slot: its candidate pieces and where they came from (a role, the theme's own pieces, borrowed along the
 * whole chain, or "simplified": none, the recipe composes without).
 */
export interface FilledSlot {
  readonly pieces: readonly ArrangePiece[];
  readonly source: "role" | "theme" | "borrowed" | "simplified";
}

/** What a recipe's functions are told. */
export interface RecipeCtx {
  readonly level: ResolvedLevel;
  readonly anchors: LevelAnchors;
  readonly roles: PlanRoles;
}

/** What `compose` is told besides the anchor and its pieces. */
export interface ComposeCtx extends RecipeCtx {
  /** Names every draw of this recipe at this anchor (plan seed, level, anchor key, recipe). */
  readonly seed: string;
  /** 1, or less when the budget thins a `thinnable` recipe (repeats at a wider pitch). */
  readonly density: number;
  /** The variant the anchor's subject drew for this recipe (treatments.ts), e.g. "every" or "first". */
  readonly variant: string;
  /** The subject's treatment: its seed (one set of pieces per subject), jitter and trim material. */
  readonly treatment: Treatment;
  /** The style the subject's trims are made in (its own wall style unless the treatment contrasts). */
  readonly trim: string;
}

export interface Recipe<K extends AnchorKind = AnchorKind> {
  readonly id: string;
  /** What it does, in a line. */
  readonly doc: string;
  readonly switch: SwitchName;
  /** Its treatment family (treatments.ts TREATMENTS): it applies where its subject's drawn option names it. */
  readonly family: string;
  readonly anchor: K;
  /** Budget tier: 0 never dropped .. 3 dropped first (plan §5); may depend on the anchor (a door's posts outrank a window's). */
  readonly tier: (a: AnchorOf<K>) => 0 | 1 | 2 | 3;
  /** Fastened to a wall (built as wall structure) or standing loose on the floor. */
  readonly mount: "wall" | "floor";
  /** Its pieces block the way (a loose recipe's furniture); wall-mounted trims do not. */
  readonly blocking: boolean;
  /** Its repeats may be spread (density < 1) before it is dropped. */
  readonly thinnable: boolean;
  /**
   * Its pieces lie underfoot (flat or low, walked over: ground cover): they may cover open floor, but never a way, a
   * lane or a door's apron, even against a wall (keepClear.ts).
   */
  readonly underfoot?: boolean;
  /**
   * Cover a large anchor (a whole field) as one instance per block of this many cells, each its own element with its
   * own focus, so the budget thins and drops calm blocks first and no instance passes its piece cap.
   */
  readonly block?: number;
  /** Whether it applies at an anchor (theme-neutral conditions). */
  readonly when: (a: AnchorOf<K>, ctx: RecipeCtx) => boolean;
  readonly slots: Readonly<Record<string, SlotSpec<AnchorOf<K>>>>;
  /** The arrangement in the anchor's frame (unmirrored: the engine mirrors a mirrored frame), or null to skip. */
  readonly compose: (
    a: AnchorOf<K>,
    pieces: Readonly<Record<string, FilledSlot>>,
    ctx: ComposeCtx,
  ) => Arrangement | null;
}

/** A recipe of any anchor kind (the table's entries). */
export type AnyRecipe = { [K in AnchorKind]: Recipe<K> }[AnchorKind];
