/** The fake main's plan channels: the GM's edits, undo/redo/restore, versions and diffs, approval, the brief. */
import {
  applyChecked,
  approve as approveHistory,
  commitVersion,
  diffPlans,
  parseBriefPatch,
  patchBrief,
  planGate,
  redo as redoHistory,
  restore as restoreHistory,
  supersedeHead,
  TEXT_EDIT_FIELDS,
  textEditPlan,
  undo as undoHistory,
  validatePlan,
} from "@slabyrinth/core";
import type { DesignBrief, MapPlan, PlanOp } from "@slabyrinth/core";
import type { FakeProject } from "../fixtures";
import { fakeRules as rules } from "../rules";
import type { FakeState, HandlerGroup } from "../state";
import { fail } from "../state";

type PlanChannels =
  | "plan:applyOps"
  | "plan:undo"
  | "plan:redo"
  | "plan:restore"
  | "plan:getVersion"
  | "plan:diff"
  | "plan:approve"
  | "plan:editText"
  | "brief:update";

export function planHandlers(s: FakeState): HandlerGroup<PlanChannels> {
  /** Commits the GM's ops as a new version (the caller touches the project and announces the change). */
  const commitUserOps = (p: FakeProject, plan: MapPlan, summary: string, ops: PlanOp[]): void => {
    p.history = commitVersion(
      p.history,
      { plan, author: "user", createdAt: new Date().toISOString(), summary, cause: { type: "ops", ops } },
      rules(),
    ).history;
  };
  /** The head plan for a GM edit (rejects while a reply is being written or before the first plan). */
  const editablePlan = (p: FakeProject): MapPlan => {
    if (s.turn) return fail("busy", "Wait for the current reply to finish.");
    const plan = s.planAt(p, p.history.head);
    if (!plan) return fail("validation", "There's no plan to edit yet.");
    return plan;
  };
  /** After undo, redo or restore: the new history is current and announced. */
  const moved = (p: FakeProject, history: FakeProject["history"]): { head: number } => {
    p.history = history;
    s.touch(p);
    s.planChanged(p);
    return { head: p.history.head };
  };
  return {
    "plan:applyOps": ({ baseVersion, label, ops }) => {
      const p = s.open();
      const plan = editablePlan(p);
      if (baseVersion !== p.history.head)
        return fail("validation", `The map changed (now v${p.history.head}). Try again.`);
      const r = applyChecked(plan, ops, rules());
      if (!r.ok) return r;
      commitUserOps(p, r.plan, label, ops);
      s.touch(p);
      s.planChanged(p);
      return { ...r, version: p.history.head };
    },
    "plan:undo": () => {
      const p = s.open();
      const r = undoHistory(p.history);
      if (!r.ok) return fail("validation", r.error.message);
      return moved(p, r.history);
    },
    "plan:redo": () => {
      const p = s.open();
      const r = redoHistory(p.history);
      if (!r.ok) return fail("validation", r.error.message);
      return moved(p, r.history);
    },
    "plan:restore": ({ version }) => {
      const p = s.open();
      const r = restoreHistory(p.history, version, new Date().toISOString(), rules());
      if (!r.ok) return fail("not_found", r.error.message);
      return moved(p, r.history);
    },
    "plan:getVersion": ({ version }) => {
      const plan = s.planAt(s.open(), version);
      if (!plan) return fail("not_found", `No version v${version}.`);
      return plan;
    },
    "plan:diff": ({ from, to }) => {
      const p = s.open();
      const b = s.planAt(p, to);
      if (!b) return fail("not_found", `No version v${to}.`);
      return diffPlans(s.planAt(p, from), b);
    },
    "plan:approve": ({ version }) => {
      const p = s.open();
      const plan = s.planAt(p, version);
      if (!plan) return fail("not_found", `No version v${version}.`);
      // main's rule (ProjectService.approve): core's approval gate
      const gate = planGate(validatePlan(plan, rules()).issues, "approve");
      const blocking = gate.blocking.map((i) => i.message);
      const warnings = gate.checks.warnings.map((i) => i.message);
      if (blocking.length > 0) return { approved: false, blocking, warnings };
      const r = approveHistory(p.history, version);
      if (!r.ok) return fail("not_found", r.error.message);
      p.history = r.history;
      s.touch(p);
      s.emit("project:changed", { dirty: false, filePath: p.path, name: p.name });
      s.planChanged(p);
      return { approved: true, blocking, warnings };
    },
    // main's rule (ProjectService.editText): core textEditPlan, joined edits superseding the head under a new number
    "plan:editText": ({ id, set }) => {
      const p = s.open();
      for (const k of Object.keys(set))
        if (!TEXT_EDIT_FIELDS.has(k)) return fail("validation", `"${k}" isn't a text field.`);
      editablePlan(p);
      const pinned = new Set(p.builds.map((b) => b.versionNumber));
      const edit = textEditPlan(p.history, { id, set }, Date.now(), pinned);
      const base = s.planAt(p, edit.base);
      if (!base) return fail("validation", "There's no plan to edit yet.");
      const r = applyChecked(base, [edit.op], rules());
      if (!r.ok)
        return fail("validation", r.opErrors[0]?.message ?? r.issues[0]?.message ?? "The edit was rejected.");
      const input = {
        plan: r.plan,
        author: "user" as const,
        createdAt: new Date().toISOString(),
        summary: `You edited ${Object.keys(edit.op.set).join(", ")} of ${id}`,
        cause: { type: "ops" as const, ops: [edit.op] },
      };
      p.history = (edit.supersedes === null ? commitVersion : supersedeHead)(
        p.history,
        input,
        rules(),
      ).history;
      s.touch(p);
      s.planChanged(p);
      return { head: p.history.head };
    },
    "brief:update": ({ set }) => {
      const p = s.open();
      // main's rule (ProjectService.updateBrief): core parseBriefPatch + patchBrief
      const parsed = parseBriefPatch(set);
      if (!parsed.ok) return fail("validation", parsed.message);
      p.brief = patchBrief(p.brief, parsed.patch);
      s.touch(p);
      return structuredClone<DesignBrief>(p.brief);
    },
  };
}
