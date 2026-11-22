/**
 * Fixture projects for the fake bridge, built from WP1's real fixture plans
 * (packages/core/test/fixtures/plans) through the real history functions, so versions, undo/redo,
 * restore and diff behave exactly like main's ProjectService will.
 */
import {
  applyOps,
  commitVersion,
  createHistory,
  parsePlan,
  approve as approveHistory,
} from "@slabyrinth/core";
import type { DesignBrief, MapPlan, MapSelection, PlanHistory, PlanOp } from "@slabyrinth/core";
import type { ChatItem, ModelSelection, Usage } from "../../../main/agent/provider/types";
import type { BuildRecord, ChatMessageMeta } from "../../../shared/project";
import exampleARaw from "../../../../../../packages/core/test/fixtures/plans/example-a.json?raw";
import exampleBRaw from "../../../../../../packages/core/test/fixtures/plans/example-b.json?raw";
import towerRaw from "../../../../../../packages/core/test/fixtures/plans/multi-level-stairs.json?raw";
import proofRaw from "../../../../../../data/test-slabs/02-single-room.plan.json?raw";
import proofV4Raw from "../../../../../../data/test-slabs/02-single-room.v4.plan.json?raw";
import { fakeCompile } from "./compile";
import { fakeRules } from "./rules";

export const DEFAULT_SELECTION: ModelSelection = {
  providerId: "anthropic",
  modelId: "claude-opus-5-5",
  effort: "medium",
};

export interface FakeProject {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  history: PlanHistory;
  brief: DesignBrief;
  conversation: {
    id: string;
    selection: ModelSelection;
    items: ChatItem[];
    meta: Record<string, ChatMessageMeta>;
    totals: {
      usage: Usage;
      cost: { currency: "USD"; amount: number; estimated: boolean } | null;
      turns: number;
    };
    toolMode: "native" | "json" | "none";
  };
  builds: BuildRecord[];
  /** Slab text per build (main recompiles these deterministically; the fake keeps them). */
  slabs: Record<string, Record<string, string>>;
}

/** A fixture plan of the repository, checked with core's plan schema like any plan from outside. */
export const loadFixturePlan = (raw: string): MapPlan => {
  const r = parsePlan(JSON.parse(raw));
  if (!r.ok) throw new Error(`fixture plan invalid: ${r.issues[0]?.message ?? ""}`);
  return r.plan;
};
export const EXAMPLE_A = (): MapPlan => loadFixturePlan(exampleARaw);
export const EXAMPLE_B = (): MapPlan => loadFixturePlan(exampleBRaw);
export const TOWER = (): MapPlan => loadFixturePlan(towerRaw);

const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const usage = (i: number, o: number, r = 0): Usage => ({
  inputTokens: i,
  outputTokens: o,
  cacheReadTokens: r,
  cacheWriteTokens: 0,
});
const ago = (now: number, minutes: number): string => new Date(now - minutes * 60_000).toISOString();

/** applyOps that falls back to the input plan when a fixture op does not validate (WP1/WP2 still moving). */
export function tryOps(plan: MapPlan, ops: PlanOp[]): MapPlan {
  const r = applyOps(plan, ops, fakeRules());
  if (r.ok) return r.plan;
  console.warn("[fake] fixture ops rejected", r.opErrors, r.issues);
  return plan;
}

interface Turn {
  user?: { text: string; selection?: MapSelection };
  ai: string;
  version?: {
    plan: MapPlan;
    summary: string;
    changes: string[];
    cause: "create" | PlanOp[];
    seconds: number;
    cost: number;
  };
  minutesAgo: number;
  effort?: ModelSelection["effort"];
  modelId?: string;
}

/** Builds conversation + history together so version.messageId links Plan update cards. */
function buildProject(args: {
  id: string;
  name: string;
  minutesAgo: number;
  brief: DesignBrief;
  turns: Turn[];
  userEdit?: { plan: MapPlan; summary: string; ops: PlanOp[]; minutesAgo: number };
  approve?: boolean;
  build?: { pasted: number };
  now: number;
}): FakeProject {
  const { now } = args;
  let history = createHistory();
  const items: ChatItem[] = [];
  const meta: Record<string, ChatMessageMeta> = {};
  let totalCost = 0;
  let turns = 0;
  const totalUsage = zeroUsage();
  args.turns.forEach((t, i) => {
    const at = ago(now, t.minutesAgo);
    if (t.user) {
      const u: ChatItem = { type: "user", id: `${args.id}-u${i}`, text: t.user.text, createdAt: at };
      if (t.user.selection) u.selection = t.user.selection;
      items.push(u);
    }
    const aid = `${args.id}-a${i}`;
    const sel: ModelSelection = {
      providerId: "anthropic",
      modelId: t.modelId ?? "claude-opus-5-5",
      effort: t.effort ?? "medium",
    };
    const cost = t.version?.cost ?? 0.01;
    const u = usage(8000 + i * 3000, t.version ? 6000 : 400, 4000 * i);
    items.push({
      type: "assistant",
      id: aid,
      turnId: `${args.id}-t${i}`,
      parts: [{ type: "text", text: t.ai }],
      stopReason: "end_turn",
      servedBy: { providerId: "anthropic", modelId: sel.modelId },
      usage: u,
      createdAt: at,
    });
    const versions: number[] = [];
    if (t.version) {
      const v = t.version;
      const r = commitVersion(
        history,
        {
          plan: v.plan,
          author: "ai",
          createdAt: at,
          summary: v.summary,
          changeSummary: v.changes,
          cause: v.cause === "create" ? { type: "create" } : { type: "ops", ops: v.cause },
          messageId: aid,
          cost: { currency: "USD", amount: v.cost },
        },
        fakeRules(),
      );
      history = r.history;
      versions.push(r.version.number);
    }
    if (t.user)
      meta[aid] = {
        selection: sel,
        servedBy: { providerId: "anthropic", modelId: sel.modelId },
        effortUsed: sel.effort,
        durationMs: (t.version?.seconds ?? 6) * 1000,
        usage: u,
        cost: { currency: "USD", amount: cost, estimated: true },
        status: "complete",
        versions,
      };
    totalCost += cost;
    turns++;
    totalUsage.inputTokens += u.inputTokens;
    totalUsage.outputTokens += u.outputTokens;
    totalUsage.cacheReadTokens += u.cacheReadTokens;
  });
  if (args.userEdit) {
    history = commitVersion(
      history,
      {
        plan: args.userEdit.plan,
        author: "user",
        createdAt: ago(now, args.userEdit.minutesAgo),
        summary: args.userEdit.summary,
        cause: { type: "ops", ops: args.userEdit.ops },
      },
      fakeRules(),
    ).history;
  }
  const builds: BuildRecord[] = [];
  const slabs: FakeProject["slabs"] = {};
  if (args.approve === true && history.head > 0) {
    const r = approveHistory(history, history.head);
    if (r.ok) history = r.history;
    if (args.build) {
      const lastVersion = history.versions.find((v) => v.number === history.head);
      const planOf = args.userEdit?.plan ?? [...args.turns].reverse().find((t) => t.version)?.version?.plan;
      if (lastVersion && planOf) {
        const { record, slabText } = fakeCompile(
          planOf,
          history.head,
          { levelLayout: "stacked" },
          ago(now, args.minutesAgo + 5),
          "install",
        );
        let n = args.build.pasted;
        for (const l of record.levels)
          for (const c of l.chunks) {
            if (n > 0) {
              c.pasted = true;
              c.copiedAt = ago(now, args.minutesAgo + 2);
              n--;
            }
          }
        builds.push(record);
        slabs[record.id] = slabText;
      }
    }
  }
  return {
    id: args.id,
    name: args.name,
    path: `C:\\Users\\GM\\Documents\\Slabyrinth\\${args.name}.slabyrinth`,
    createdAt: ago(now, args.minutesAgo + 60 * 24 * 3),
    updatedAt: ago(now, args.minutesAgo),
    lastActivityAt: ago(now, args.minutesAgo),
    history,
    brief: args.brief,
    conversation: {
      id: `${args.id}-conv`,
      selection: { ...DEFAULT_SELECTION },
      items,
      meta,
      totals: { usage: totalUsage, cost: { currency: "USD", amount: totalCost, estimated: true }, turns },
      toolMode: "native",
    },
    builds,
    slabs,
  };
}

export const WELCOME_TEXT =
  "**Let's build a map.** Tell me what you're running — a dungeon, a tower, a town, a stretch of forest — and anything you already know: the game, the party, the mood. I'll sketch a plan you can poke at before anything goes into TaleSpire.";

export function abbeyBrief(): DesignBrief {
  return {
    mapType: { value: "Dungeon · crypt", source: "ai" },
    system: { value: "daggerheart", source: "user" },
    party: { value: { tier: 2, size: 4 }, source: "ai" },
    footprint: { value: { preset: "medium", widthSq: 30, heightSq: 24 }, source: "ai" },
    levels: { value: { count: 2, names: ["Upper Crypts", "Cistern Depths"] }, source: "ai" },
    tone: { value: "Gothic, drowned, melancholy", source: "ai" },
    mustInclude: { value: ["flooded crypt", "a way down"], source: "user" },
  };
}

export function makeFixtureProjects(now = Date.now()): FakeProject[] {
  // ── The Drowned Abbey: plan phase, 4 versions, resumed after 2 days ──
  const a0 = EXAMPLE_A();
  const a1 = tryOps(a0, [
    { op: "update", id: "bones1", set: { at: [26, 10] } },
    { op: "reshape", id: "ossuary", shape: { type: "rect", x: 24, y: 4, w: 5, h: 8 } },
    { op: "update", id: "hall", set: { notes: "Pillars carved as hooded monks hold up the vault." } },
  ]);
  const a2Ops: PlanOp[] = [
    { op: "reshape", id: "ossuary", shape: { type: "rect", x: 24, y: 4, w: 5, h: 10 } },
    {
      op: "update",
      id: "ossuary",
      set: {
        notes:
          "Walls of niched skulls. A secret door in the west wall opens onto the Hall of Pillars; it grinds loudly.",
      },
    },
  ];
  const a2 = tryOps(a1, a2Ops);
  const a3Ops: PlanOp[] = [
    {
      op: "update",
      id: "hall",
      set: {
        notes:
          "Eight pillars carved as hooded monks. The statue is the Abbot: placing the saint's ring in his open hand opens the secret door to ④. The statue's eyes follow light sources, and the braziers stay cold until someone speaks a prayer.",
        readAloud:
          "Eight pillars carved as weeping monks hold up the vault. Somewhere in the dark, water drips in a slow, patient rhythm.",
        encounter:
          "1× Bone Sentinel (Bruiser), 3× Skeleton Warrior (Standard). Difficulty 14 to force the secret door.",
      },
    },
  ];
  const a3 = tryOps(a2, a3Ops);
  const a4Ops: PlanOp[] = [
    {
      op: "update",
      id: "chapel",
      set: {
        notes:
          "A small altar to the drowned saint. Candles here never quite go out; a PC who relights one hears the saint's last confession.",
      },
    },
  ];
  const a4 = tryOps(a3, a4Ops);
  const abbey = buildProject({
    id: "abbey",
    name: "The Drowned Abbey",
    minutesAgo: 60 * 50,
    now,
    brief: abbeyBrief(),
    turns: [
      { ai: WELCOME_TEXT, minutesAgo: 60 * 52 + 30 },
      {
        user: {
          text: "A two-level crypt under a ruined abbey, half-flooded, for my Daggerheart group. Melancholy rather than gory — they've been hunting a drowned saint.",
        },
        ai: "Here's a first plan: an upper crypt around the **Hall of Pillars** ②, with the guardroom ③ and ossuary ④ off it, and a collapsed stair ① down to a flooded cistern below. Have a look and tell me what to change.",
        version: {
          plan: a1,
          summary: "First plan · 2 levels",
          changes: [
            "Drew Upper Crypts: 4 rooms, 2 corridors",
            "Drew Cistern Depths: flooded cave, landing and chapel",
            "Linked the levels with a stair from ⑥ up to the surface hall",
          ],
          cause: "create",
          seconds: 48,
          cost: 0.11,
        },
        minutesAgo: 60 * 52,
        effort: "high",
      },
      {
        user: { text: "Make the ossuary a bit longer, and give me a secret way from the hall into it." },
        ai: "Done. The ossuary ④ now runs the full height of the east side, and a secret door joins it to the Hall of Pillars ② — it grinds loudly, so anyone listening will hear it.",
        version: {
          plan: a2,
          summary: "Longer ossuary, secret door",
          changes: ["Lengthened ④ Ossuary 2 squares south", "Rewrote GM notes for ④"],
          cause: a2Ops,
          seconds: 22,
          cost: 0.04,
        },
        minutesAgo: 60 * 51,
      },
      {
        user: {
          text: "This is where the boss fight happens — give it read-aloud text and an encounter, and tie the statue to the secret door.",
          selection: { levelId: "l1", areaIds: ["hall"], featureIds: [], openingIds: [], linkIds: [] },
        },
        ai: "The hall now has read-aloud text and a Daggerheart encounter. The Abbot statue is the key: the saint's ring in his hand opens the secret door to ④, so the Sentinel can follow the party between rooms.",
        version: {
          plan: a3,
          summary: "Boss fight in ②",
          changes: [
            "Added read-aloud text for ② Hall of Pillars",
            "Added a Daggerheart encounter to ②",
            "Tied the Abbot statue to the secret door ② → ④",
          ],
          cause: a3Ops,
          seconds: 41,
          cost: 0.05,
        },
        minutesAgo: 60 * 50 + 20,
        effort: "high",
      },
    ],
    userEdit: { plan: a4, summary: "You edited notes for ⑦", ops: a4Ops, minutesAgo: 60 * 50 },
  });

  // ── Chapel in the Pines: approved and built, 1 of 2 pasted ──
  const b0 = EXAMPLE_B();
  const b1Ops: PlanOp[] = [
    {
      op: "update",
      id: "ruin",
      set: {
        notes: "The bandits use the chapel as a lookout. A loose flagstone by the altar hides their takings.",
      },
    },
  ];
  const b1 = tryOps(b0, b1Ops);
  const chapel = buildProject({
    id: "pines",
    name: "Chapel in the Pines",
    minutesAgo: 60 * 24 * 6,
    now,
    brief: {
      mapType: { value: "Wilderness · forest", source: "user" },
      system: { value: "dnd5e", source: "user" },
      party: { value: { level: 3, size: 5 }, source: "user" },
      footprint: { value: { preset: "large", widthSq: 48, heightSq: 40 }, source: "ai" },
      levels: { value: { count: 1, names: ["Old Chapel Clearing"] }, source: "ai" },
      tone: { value: "Quiet, watchful, pine-scented", source: "ai" },
    },
    turns: [
      { ai: WELCOME_TEXT, minutesAgo: 60 * 24 * 6 + 90 },
      {
        user: {
          text: "A forest clearing with a ruined chapel where bandits are camped, with a stream and a bridge.",
        },
        ai: "Here's the clearing: the ruined chapel ① on a low rise, the bandit camp in the clearing ②, and a stream crossed by an old bridge to the south.",
        version: {
          plan: b0,
          summary: "First plan · 1 level",
          changes: [
            "Drew the clearing with the chapel ruin and bandit camp",
            "Added a stream and a wooden bridge",
            "Scattered pines, bushes and boulders",
          ],
          cause: "create",
          seconds: 52,
          cost: 0.09,
        },
        minutesAgo: 60 * 24 * 6 + 60,
      },
      {
        user: { text: "Give the chapel a hiding place for their loot." },
        ai: "Added a hiding place under a loose flagstone by the altar in ①.",
        version: {
          plan: b1,
          summary: "Loot hiding place",
          changes: ["Rewrote GM notes for ① Ruined Chapel"],
          cause: b1Ops,
          seconds: 12,
          cost: 0.02,
        },
        minutesAgo: 60 * 24 * 6 + 20,
      },
    ],
    approve: true,
    build: { pasted: 1 },
  });

  // ── Wizard's Tower: built and fully pasted ──
  const t0 = TOWER();
  const tower = buildProject({
    id: "tower",
    name: "Wizard's Tower",
    minutesAgo: 60 * 24 * 9,
    now,
    brief: {
      mapType: { value: "Tower", source: "user" },
      system: { value: "dnd5e", source: "user" },
      levels: { value: { count: 3, names: t0.levels.map((l) => l.name) }, source: "ai" },
    },
    turns: [
      { ai: WELCOME_TEXT, minutesAgo: 60 * 24 * 9 + 50 },
      {
        user: { text: "A three-storey wizard's tower." },
        ai: "Here's the tower: three storeys linked by stairs.",
        version: {
          plan: t0,
          summary: "First plan · 3 levels",
          changes: ["Drew three storeys", "Linked them with stairs"],
          cause: "create",
          seconds: 40,
          cost: 0.08,
        },
        minutesAgo: 60 * 24 * 9 + 40,
      },
    ],
    approve: true,
    build: { pasted: 99 },
  });

  // ── Market at Lowbridge: brief only ──
  const market = buildProject({
    id: "market",
    name: "Market at Lowbridge",
    minutesAgo: 60 * 24 * 20,
    now,
    brief: { mapType: { value: "Town · market square", source: "user" } },
    turns: [{ ai: WELCOME_TEXT, minutesAgo: 60 * 24 * 20 }],
  });

  // ── Proof room: the in-game test plan, then an AI edit that left furniture in the way (plan issues) ──
  const p0 = loadFixturePlan(proofRaw);
  const p1: MapPlan = structuredClone(p0);
  const room = p1.levels[0];
  if (room) {
    room.features.push(
      { id: "crate1", type: "crate", at: [9, 7] },
      { id: "barrel1", type: "barrel", at: [4, 2] },
      { id: "shelf2", type: "bookshelf", at: [7, 4] },
    );
  }
  const proof = buildProject({
    id: "proof",
    name: "Proof room",
    minutesAgo: 25,
    now,
    brief: {
      mapType: { value: "Dungeon · test room", source: "user" },
      system: { value: "daggerheart", source: "user" },
    },
    turns: [
      { ai: WELCOME_TEXT, minutesAgo: 90 },
      {
        user: { text: "The single proof room from the in-game test, please." },
        ai: "Here is the proof room ①, with a stair up to the mezzanine.",
        version: {
          plan: p0,
          summary: "First plan · 2 levels",
          changes: ["Drew the proof room and the mezzanine landing"],
          cause: "create",
          seconds: 20,
          cost: 0.03,
        },
        minutesAgo: 80,
      },
      {
        user: { text: "Make it feel lived in — add a crate, a barrel and another shelf." },
        ai: "Added a crate, a barrel and a second bookshelf to ①.",
        version: {
          plan: p1,
          summary: "Storage clutter in ①",
          changes: ["Added a crate, a barrel and a bookshelf to ① Proof room"],
          cause: [{ op: "add_features", level: "room", features: (room?.features ?? []).slice(-3) }],
          seconds: 14,
          cost: 0.02,
        },
        minutesAgo: 26,
      },
    ],
  });

  // ── Proof room v4 (archived): approved, builds with a blocked east door (verify diagnostics) ──
  const v4 = loadFixturePlan(proofV4Raw);
  const proofV4 = buildProject({
    id: "proof-v4",
    name: "Proof room v4 (archived)",
    minutesAgo: 60 * 30,
    now,
    brief: { mapType: { value: "Dungeon · test room", source: "user" } },
    turns: [
      { ai: WELCOME_TEXT, minutesAgo: 60 * 31 },
      {
        user: { text: "Proof room, fourth round trip." },
        ai: "Here is the proof room ① as tested in round 4.",
        version: {
          plan: v4,
          summary: "Proof room v4",
          changes: ["Drew the proof room with the east door by the stairs"],
          cause: "create",
          seconds: 18,
          cost: 0.03,
        },
        minutesAgo: 60 * 30 + 10,
      },
    ],
    approve: true,
  });

  return [abbey, chapel, tower, market, proof, proofV4];
}

export function newUntitledProject(id: string, name: string, now = Date.now()): FakeProject {
  return buildProject({
    id,
    name,
    minutesAgo: 0,
    now,
    brief: {},
    turns: [{ ai: WELCOME_TEXT, minutesAgo: 0 }],
  });
}
