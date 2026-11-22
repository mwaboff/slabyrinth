/** The fake main's build channels: the estimate, a simulated compile with progress, chunks, PNG and room-key export. */
import { estimateSlabs, fakeCompile, levelBytes } from "../compile";
import type { FakeState, HandlerGroup } from "../state";
import { fail } from "../state";

type BuildChannels =
  | "compile:estimate"
  | "compile:run"
  | "compile:cancel"
  | "build:setPasted"
  | "build:saveChunk"
  | "export:savePng"
  | "export:roomKeyMarkdown"
  | "clipboard:writeText";

/** The simulated compile's stages, each reported in this many progress steps this far apart. */
const COMPILE_STAGES = ["resolve", "realize", "chunk", "encode"] as const;
const STEPS_PER_STAGE = 3;
const STEP_MS = 170;
/** The fake estimate's bytes per asset. */
const BYTES_PER_ASSET = 9;

export function buildHandlers(s: FakeState): HandlerGroup<BuildChannels> {
  return {
    "compile:estimate": () => {
      const plan = s.planAt(s.open(), s.open().history.head);
      const perLevel = (plan?.levels ?? []).map((l) => ({
        levelId: l.id,
        assets: Math.round(levelBytes(l) / BYTES_PER_ASSET),
        estimatedChunks: 1,
      }));
      return {
        perLevel,
        totalAssets: perLevel.reduce((sum, l) => sum + l.assets, 0),
        estimatedChunks: plan ? estimateSlabs(plan) : 0,
        diagnostics: [],
      };
    },
    "compile:run": async ({ version, options }) => {
      const p = s.open();
      const v = version ?? p.history.approvedVersion ?? p.history.head;
      const plan = s.planAt(p, v);
      if (!plan) return fail("validation", "Approve a plan to build it for TaleSpire.");
      const total = COMPILE_STAGES.length * STEPS_PER_STAGE;
      for (const [i, stage] of COMPILE_STAGES.entries()) {
        for (let k = 1; k <= STEPS_PER_STAGE; k++) {
          s.emit("compile:progress", { stage, done: i * STEPS_PER_STAGE + k, total });
          await s.sleep(STEP_MS);
        }
      }
      const layout = options?.levelLayout ?? s.settings.talespire.levelLayout;
      const { bundle, record, slabText } = fakeCompile(
        plan,
        v,
        { ...options, levelLayout: layout },
        new Date().toISOString(),
        s.catalogState === "no_install" ? "builtin" : "install",
      );
      // a chunk unchanged since the last build keeps its pasted and copied marks
      const prev = p.builds.at(-1);
      if (prev) {
        const old = new Map(prev.levels.flatMap((l) => l.chunks).map((c) => [c.id, c]));
        for (const l of record.levels)
          for (const c of l.chunks) {
            const o = old.get(c.id);
            if (!o) continue;
            c.changedSinceBuild = o.contentHash !== c.contentHash;
            if (!c.changedSinceBuild) {
              c.pasted = o.pasted;
              if (o.copiedAt !== undefined) c.copiedAt = o.copiedAt;
            }
          }
      }
      p.builds.push(record);
      p.slabs[record.id] = slabText;
      s.touch(p);
      return { ...bundle, buildId: record.id };
    },
    "compile:cancel": () => undefined,
    "build:setPasted": ({ buildId, chunkId, pasted }) => {
      const b = s.open().builds.find((x) => x.id === buildId);
      const cs = (b?.levels ?? []).flatMap((l) => l.chunks).filter((x) => x.id === chunkId);
      if (cs.length === 0) return fail("not_found", "Slab not found.");
      for (const c of cs) {
        c.pasted = pasted;
        if (pasted && c.copiedAt === undefined) c.copiedAt = new Date().toISOString();
      }
    },
    "build:saveChunk": ({ chunkId }) => ({ path: `C:\\Users\\GM\\Documents\\Slabyrinth\\${chunkId}.txt` }),
    "export:savePng": async ({ suggestedName, files }) => {
      await s.sleep(300);
      return {
        paths: files.map(
          (f, i) =>
            `C:\\Users\\GM\\Pictures\\${files.length > 1 ? `${suggestedName}-${i + 1}` : suggestedName}.png`,
        ),
      };
    },
    "export:roomKeyMarkdown": ({ copyToClipboard }) => {
      const plan = s.planAt(s.open(), s.open().history.head);
      const md = (plan?.levels ?? [])
        .map(
          (l) =>
            `## ${l.name}\n\n${l.areas
              .filter((a) => a.key !== undefined)
              .map((a) => `### ${a.key ?? ""}. ${a.name ?? ""}\n\n${a.notes ?? ""}`)
              .join("\n\n")}`,
        )
        .join("\n\n");
      return copyToClipboard
        ? { markdown: md }
        : { markdown: md, path: "C:\\Users\\GM\\Documents\\room-key.md" };
    },
    // the fake never touches the real clipboard
    "clipboard:writeText": ({ chunk }) => {
      s.markCopied(chunk);
    },
  };
}
