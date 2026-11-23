/**
 * Build tab (UX §9, adjusted by the 2026-11-18 export ruling): the common case is ONE slab with every level in
 * it — one prominent "Copy & open TaleSpire" button, a plain Copy, the size gauge and a short instruction.
 * Only an oversized build shows the numbered slab checklist, the paste steps (talespire/pasteSteps.ts) and the paste guide.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import "./build.css";
import { STEAM_LAUNCH_URL, type CompileDiagnostic, type ExportBundle, type MapPlan } from "@slabyrinth/core";
import { OUT_OF_LINE_MESSAGE, pastesOutOfLine } from "../../../shared/pasteRegister";
import { SendToTaleSpire } from "../talespire/SendToTaleSpire";
import { pasteSteps } from "../talespire/pasteSteps";
import { Icon } from "../../ui/Icon";
import { useDismiss } from "../../ui/dismiss";
import { useBuild } from "../../stores/build";
import { latestBuild, levelShort, orderedLevels, useProject } from "../../stores/project";
import { displayOptions, useMap } from "../../stores/map";
import { useSettings } from "../../stores/settings";
import { useApp } from "../../stores/app";
import { call } from "../../bridge/client";
import { useResolved } from "../../map/resolveClient";
import { drawLevel, mapThemeFor } from "../../map/render";
import { contentViewBox } from "@slabyrinth/core/render";
import { useAppliedTheme, cssVar } from "../../app/theme";
import { clock, kb } from "../../lib/format";
import { approve, run } from "../../app/actions";
import { buildModel, levelsLabel, sizeState, type BuildModel, type SlabRow } from "./model";
import { currentStep, nextSlab } from "./pasteMachine";
import { IssueList, askToFix, issueWhere, showIssue, type ListItem } from "../stage/Issues";

// ───────────── shared bits ─────────────

function usePlanAt(version: number | null): MapPlan | null {
  const snap = useProject((s) => s.snap);
  const [fetched, setFetched] = useState<{ v: number; plan: MapPlan } | null>(null);
  const atHead = version !== null && snap?.head === version && snap.plan !== null;
  useEffect(() => {
    if (version === null || atHead) return;
    void run("plan:getVersion", { version }, `Couldn't load v${version}.`, (p) => {
      setFetched({ v: version, plan: p });
    });
  }, [version, atHead]);
  if (atHead) return snap.plan;
  return fetched !== null && fetched.v === version ? fetched.plan : null;
}

/** Small drawing of the level(s) a slab covers, with the slab's region outlined in gold. */
function SlabPreview({
  plan,
  version,
  slab,
  levelIds,
  wide,
}: {
  plan: MapPlan;
  version: number;
  slab: SlabRow | null;
  levelIds: string[];
  wide?: boolean;
}) {
  const layers = useMap((s) => s.layers);
  const { data } = useResolved(
    plan,
    version,
    useMemo(() => ({ ...displayOptions(layers), roomNames: false }), [layers]),
  );
  const appTheme = useAppliedTheme();
  const theme = useMemo(() => mapThemeFor(appTheme), [appTheme]);
  const refs = useRef<Array<HTMLCanvasElement | null>>([]);
  useEffect(() => {
    if (!data) return;
    levelIds.forEach((id, i) => {
      const cv = refs.current[i];
      const list = data.lists[id];
      if (!cv || !list) return;
      const w = cv.clientWidth;
      // fit to what is drawn on the level (a building on one edge of a big level, a narrow gorge), not its bounds;
      // very tall content is letterboxed instead of making a towering thumbnail
      const vb = contentViewBox(list, 2);
      const h = Math.round(Math.min((w * vb.h) / vb.w, w * 0.75));
      const scale = Math.min(w / vb.w, h / vb.h);
      const ox = (w - vb.w * scale) / 2 - vb.x * scale;
      const oy = (h - vb.h * scale) / 2 - vb.y * scale;
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      cv.style.height = `${h}px`;
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = theme.colors["paper"] ?? cssVar("--bg");
      ctx.fillRect(0, 0, w, h);
      drawLevel(ctx, list, theme, { scale, ox, oy, w, h });
      if (slab && !(slab.region.x0 <= vb.x && slab.region.x1 >= vb.x + vb.w - 1)) {
        ctx.strokeStyle = cssVar("--accent");
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(
          ox + slab.region.x0 * scale + 1,
          oy + slab.region.y0 * scale + 1,
          (slab.region.x1 - slab.region.x0 + 1) * scale - 2,
          (slab.region.y1 - slab.region.y0 + 1) * scale - 2,
        );
      }
    });
  }, [data, theme, levelIds, slab]);
  return (
    <div className={`slabprev${wide === true ? " slabprev--wide" : ""}`} aria-hidden="true">
      {levelIds.map((id, i) => (
        <figure key={id} className="slabprev__lvl">
          <canvas
            ref={(el) => {
              refs.current[i] = el;
            }}
          />
          {levelIds.length > 1 && (
            <figcaption>{`${levelShort(plan, id)} ${plan.levels.find((l) => l.id === id)?.name ?? ""}`}</figcaption>
          )}
        </figure>
      ))}
    </div>
  );
}

function SizeGauge({ bytes, limit }: { bytes: number; limit: number }) {
  const st = sizeState(bytes, limit);
  const pct = Math.min(100, Math.round((bytes / limit) * 100));
  return (
    <div className={`size size--${st}`}>
      <div
        className="size__bar"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={bytes}
        aria-label={`Slab size ${kb(bytes)} of ${kb(limit)} KB`}
      >
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="size__lab">
        <span>
          {kb(bytes)} / {Math.round(limit / 1024)} KB
        </span>
        {st === "near" ? <b>near limit</b> : st === "over" ? <b>over the limit</b> : <span>{pct}%</span>}
      </div>
    </div>
  );
}

function PastedBox({ slab, onTick }: { slab: SlabRow; onTick: (v: boolean) => void }) {
  const pasted = useBuild((s) => s.paste?.pasted[slab.id] ?? slab.pasted);
  return (
    <label className="check chunk__chk">
      <input
        type="checkbox"
        className="sr-only"
        checked={pasted}
        onChange={(e) => {
          onTick(e.target.checked);
        }}
      />
      <span className={`box${pasted ? " box--on" : ""}`} aria-hidden="true">
        {pasted && <Icon name="check" />}
      </span>
      Pasted
    </label>
  );
}

function SlabMenu({ slab, buildId }: { slab: SlabRow; buildId: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    [btn, menu],
    () => {
      setOpen(false);
    },
    btn,
  );
  const slabText = useBuild((s) => s.slabText);
  const toast = useApp((s) => s.toast);
  return (
    <span className="toolwrap">
      <button
        ref={btn}
        className="iconbtn iconbtn--sm"
        aria-label="More slab actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div ref={menu} className="menu slabmenu" role="menu">
          <button
            role="menuitem"
            className="menu__item"
            onClick={() => {
              setOpen(false);
              void slabText(slab.id).then((t) => {
                setText(t ?? "");
              });
            }}
          >
            Show slab text
          </button>
          <button
            role="menuitem"
            className="menu__item"
            onClick={() => {
              setOpen(false);
              void run("build:saveChunk", { buildId, chunkId: slab.id }, "Couldn't save the file.", (r) => {
                if (r) toast({ lead: "Saved.", body: r.path });
              });
            }}
          >
            Save as .txt…
          </button>
          <button
            role="menuitem"
            className="menu__item"
            onClick={() => {
              setOpen(false);
              void slabText(slab.id).then((t) =>
                call("clipboard:writeText", {
                  text: "```\n" + (t ?? "") + "\n```",
                  chunk: { buildId, chunkId: slab.id },
                }).then(() => {
                  toast({ lead: "Copied, wrapped in ```.", body: "Ready to paste into Discord or a forum." });
                }),
              );
            }}
          >
            Copy wrapped in ```
          </button>
        </div>
      )}
      {text !== null && (
        <div
          className="scrim"
          onKeyDown={(e) => {
            if (e.key === "Escape") setText(null);
          }}
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setText(null);
          }}
        >
          <div className="dialog slabtext" role="dialog" aria-modal="true" aria-label="Slab text">
            <h2>Slab text</h2>
            <p>Read only. Select all and copy it if the Copy button can't reach the clipboard.</p>
            <textarea
              className="textarea slabtext__ta"
              readOnly
              value={text}
              autoFocus
              onFocus={(e) => {
                e.currentTarget.select();
              }}
            />
            <div className="dialog__actions">
              <button
                className="btn btn--primary"
                onClick={() => {
                  setText(null);
                }}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </span>
  );
}

function CopyButtons({
  slab,
  primary,
  notFound,
  step,
  blocked = false,
}: {
  slab: SlabRow;
  primary: boolean;
  notFound: boolean;
  step: number | null;
  /** The build check found errors: copying stays possible but is marked (CLI --force). */
  blocked?: boolean;
}) {
  const copy = useBuild((s) => s.copy);
  const flash = useBuild((s) => s.flash);
  const over = sizeState(slab.sizeBytes, slab.limitBytes) === "over";
  const flashing = flash?.id === slab.id;
  return (
    <div className="cbtns">
      <button
        className={`btn ${primary ? "btn--lg" : "btn--sm"}${flashing ? " btn--success" : primary && !blocked ? " btn--primary" : ""} copyopen`}
        disabled={over}
        title="Copies this slab, then brings TaleSpire to the front. Paste it there with Ctrl+V in build mode."
        onClick={() => void copy(slab.id, !notFound)}
      >
        {step !== null && <span className="cstep">{step}</span>}
        {!primary && step === null && <Icon name="play" size="sm" />}
        {flashing
          ? flash.opened
            ? "Copied ✓ · TaleSpire opened"
            : "Copied ✓"
          : notFound
            ? blocked
              ? "Copy anyway"
              : "Copy slab"
            : blocked
              ? "Copy & open anyway"
              : "Copy & open TaleSpire"}
      </button>
      <button
        className={`btn ${primary ? "btn--lg" : "btn--sm btn--ghost"}`}
        disabled={over}
        title="Copy only"
        onClick={() => void copy(slab.id, false)}
      >
        <Icon name="copy" size="sm" />
        {blocked && primary ? "Copy anyway" : "Copy"}
      </button>
    </div>
  );
}

// ───────────── build check (compiler verify diagnostics) ─────────────

function diagItems(plan: MapPlan, diags: readonly CompileDiagnostic[]): ListItem[] {
  return diags.map((d, n) => {
    const loc = {
      message: d.message,
      ...(d.levelId !== undefined ? { levelId: d.levelId } : {}),
      ...(d.elementId !== undefined ? { elementId: d.elementId } : {}),
      ...(d.cell ? { cell: d.cell } : {}),
    };
    const where = [
      issueWhere(plan, loc),
      d.count !== undefined && d.count > 1 ? `×${d.count}` : "",
      d.assets && d.assets.length > 0 ? d.assets.join(", ") : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const it: ListItem = {
      key: `${d.code}-${n}`,
      severity: d.severity,
      message: d.repaired !== undefined ? `Fixed automatically: ${d.message}` : d.message,
      where,
    };
    if (d.repaired !== undefined) it.tag = d.repaired;
    if (d.levelId !== undefined || d.cell)
      it.onShow = () => {
        showIssue(plan, loc);
      };
    if (d.severity !== "info")
      it.onFix = () => {
        askToFix(plan, [loc]);
      };
    return it;
  });
}

const toLoc = (d: CompileDiagnostic) => ({
  message: d.message,
  ...(d.levelId !== undefined ? { levelId: d.levelId } : {}),
  ...(d.elementId !== undefined ? { elementId: d.elementId } : {}),
  ...(d.cell ? { cell: d.cell } : {}),
});

/** Errors: "this build is wrong" — shown above the copy button; the gold action becomes Ask Claude to fix. */
function BuildErrors({ plan, diags }: { plan: MapPlan; diags: readonly CompileDiagnostic[] }) {
  const errors = diags.filter((d) => d.severity === "error");
  if (errors.length === 0) return null;
  return (
    <div className="builderr" role="alert">
      <div className="builderr__h">
        <b>
          The build check found {errors.length} problem{errors.length === 1 ? "" : "s"} in this slab.
        </b>{" "}
        TaleSpire would get them exactly as listed. Fix the plan and build again, or copy anyway.
      </div>
      <IssueList
        items={diagItems(plan, errors)}
        labels={{ error: "Problems", warning: "Warnings", info: "Notes" }}
      />
      <div className="card-actions">
        <button
          className="btn btn--primary"
          onClick={() => {
            askToFix(plan, errors.map(toLoc));
          }}
        >
          <Icon name="at" />
          Ask Claude to fix
        </button>
      </div>
    </div>
  );
}

/** Warnings and notes (repairs) below; a single quiet line when the build is clean. */
function BuildNotes({
  plan,
  diags,
  summary,
}: {
  plan: MapPlan;
  diags: readonly CompileDiagnostic[] | null;
  summary: { errors: number; warnings: number };
}) {
  if (diags === null) {
    if (summary.errors + summary.warnings === 0)
      return (
        <p className="buildok">
          <Icon name="check" size="sm" /> Build check passed
        </p>
      );
    return (
      <p className="build__foot">
        This build had {summary.errors} problem(s) and {summary.warnings} warning(s). Build again to see them.
      </p>
    );
  }
  const rest = diags.filter((d) => d.severity !== "error");
  const clean = !diags.some((d) => d.severity === "error" || d.severity === "warning");
  return (
    <section className="buildnotes" aria-label="Build check">
      {clean && (
        <p className="buildok">
          <Icon name="check" size="sm" /> Build check passed
        </p>
      )}
      {rest.length > 0 && (
        <IssueList
          items={diagItems(plan, rest)}
          labels={{ error: "Problems", warning: "Build warnings", info: "Notes from the build check" }}
        />
      )}
    </section>
  );
}

// ───────────── single slab ─────────────

function SingleSlab({
  model,
  plan,
  diags,
}: {
  model: BuildModel;
  plan: MapPlan;
  diags: readonly CompileDiagnostic[];
}) {
  const slab = model.slabs[0];
  const dispatch = useBuild((s) => s.dispatch);
  const catalog = useSettings((s) => s.catalog);
  const pasted = useBuild((s) => (slab ? (s.paste?.pasted[slab.id] ?? slab.pasted) : false));
  const copiedAt = useBuild((s) => (slab ? (s.paste?.copied[slab.id] ?? slab.copiedAt) : null));
  if (!slab) return null;
  const notFound = catalog?.usingBuiltInOnly === true;
  const ordered = orderedLevels(plan);
  const ids = ordered.map((l) => l.id).filter((id) => slab.levelIds.includes(id));
  const multi = ids.length > 1;
  const short = (id: string): string => levelShort(plan, id);
  return (
    <section className="slab1" aria-label="Your slab">
      <SlabPreview plan={plan} version={model.version} slab={null} levelIds={ids} wide />
      <div className="slab1__body">
        <span className="eyebrow">
          {multi ? `One slab · ${levelsLabel(ids, short, ordered.length)}` : "One slab"}
        </span>
        <h3 className="slab1__title">
          {multi ? "The whole map, every level, in one slab" : "The whole map in one slab"}
        </h3>
        <SizeGauge bytes={slab.sizeBytes} limit={slab.limitBytes} />
        <BuildErrors plan={plan} diags={diags} />
        <CopyButtons
          slab={slab}
          primary
          notFound={notFound}
          step={null}
          blocked={diags.some((d) => d.severity === "error")}
        />
        <ol className="slab1__steps">
          <li>
            In TaleSpire, switch to build mode and press <span className="kbd">Ctrl V</span>. The slab follows
            your cursor.
          </li>
          <li>
            Click and hold to place it, then right-click to let go.
            {multi &&
              (model.stacking === "stacked"
                ? " The levels are already stacked a storey apart inside the slab."
                : " The levels sit side by side inside the slab.")}
          </li>
        </ol>
        <div className="slab1__foot">
          <PastedBox
            slab={slab}
            onTick={(v) =>
              void dispatch({ type: "tick", slabId: slab.id, pasted: v, at: new Date().toISOString() })
            }
          />
          <span className="muted">
            {pasted
              ? "Pasted — enjoy the session."
              : copiedAt !== null
                ? `Copied ${clock(copiedAt)}`
                : "Not copied yet"}
          </span>
          <span className="build__sp" />
          <SlabMenu slab={slab} buildId={model.buildId} />
        </div>
        {notFound && (
          <p className="slab1__nf">
            TaleSpire wasn't found on this PC, so the button only copies.{" "}
            <button
              className="btn btn--link"
              onClick={() => {
                useApp.getState().openSettings("talespire");
              }}
            >
              Locate TaleSpire folder…
            </button>
          </p>
        )}
      </div>
    </section>
  );
}

// ───────────── chunked ─────────────

const copiedLabel = (at: string | null): string => (at !== null ? `copied ${clock(at)}` : "not copied");

function ChunkList({
  model,
  plan,
  anchor,
}: {
  model: BuildModel;
  plan: MapPlan;
  anchor: ExportBundle["pasteAnchor"] | null;
}) {
  const dispatch = useBuild((s) => s.dispatch);
  const paste = useBuild((s) => s.paste);
  const guideOpen = useBuild((s) => s.guideOpen);
  const catalog = useSettings((s) => s.catalog);
  const notFound = catalog?.usingBuiltInOnly === true;
  const order = model.slabs.map((s) => s.id);
  const next = paste ? nextSlab(paste, order) : null;
  const guideSlab = guideOpen && paste ? currentStep(paste) : null;
  const cur = guideSlab?.kind === "slab" ? guideSlab.slabId : next;
  const ordered = orderedLevels(plan);
  const pastedN = model.slabs.filter((s) => paste?.pasted[s.id] ?? s.pasted).length;
  const changedN = model.slabs.filter((s) => s.changed === true).length;
  const words = pasteSteps(anchor);
  return (
    <>
      {changedN > 0 && (
        <div className="build__note" role="status">
          <b>
            {changedN} of {model.slabs.length} slabs changed.
          </b>{" "}
          {words.changed}
        </div>
      )}
      <div className="order eyebrow">
        Paste order · {pastedN} of {model.slabs.length} pasted
      </div>
      <section className="level">
        <div className="chunks">
          {model.slabs.map((s) => {
            const ids = ordered.map((l) => l.id).filter((id) => s.levelIds.includes(id));
            const isCur = s.id === cur;
            return (
              <div key={s.id} className={`chunk${isCur ? " chunk--cur" : ""}`}>
                <SlabPreview plan={plan} version={model.version} slab={s} levelIds={ids.slice(0, 1)} />
                <div className="cinfo">
                  <div className="cname">
                    Slab {s.step} · {s.label}
                    {s.columns !== null && <span className="cmeta">cols {s.columns}</span>}
                    {s.changed === true && <span className="tag tag--changed">Changed</span>}
                    {s.changed === false && <span className="tag">Unchanged</span>}
                  </div>
                  <div className="cmeta">
                    {levelsLabel(
                      ids,
                      (id) =>
                        `${levelShort(plan, id)} ${plan.levels.find((l) => l.id === id)?.name ?? ""}`.trim(),
                      ordered.length,
                    )}
                    {" · "}
                    {copiedLabel(paste?.copied[s.id] ?? s.copiedAt)}
                  </div>
                  <SizeGauge bytes={s.sizeBytes} limit={s.limitBytes} />
                </div>
                <div className="chunk__side">
                  <CopyButtons slab={s} primary={false} notFound={notFound} step={s.step} />
                  <div className="chunk__row">
                    <PastedBox
                      slab={s}
                      onTick={(v) =>
                        void dispatch({ type: "tick", slabId: s.id, pasted: v, at: new Date().toISOString() })
                      }
                    />
                    <SlabMenu slab={s} buildId={model.buildId} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
      <p className="build__foot">{words.foot(model.slabs.length)}</p>
    </>
  );
}

function PasteGuide({
  model,
  plan,
  anchor,
}: {
  model: BuildModel;
  plan: MapPlan;
  anchor: ExportBundle["pasteAnchor"] | null;
}) {
  const paste = useBuild((s) => s.paste);
  const pasteStep = paste?.current;
  const dispatch = useBuild((s) => s.dispatch);
  const setGuide = useBuild((s) => s.setGuide);
  const catalog = useSettings((s) => s.catalog);
  const notFound = catalog?.usingBuiltInOnly === true;
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>(".guide__f .btn--primary")?.focus();
  }, [pasteStep]);
  if (!paste) return null;
  const words = pasteSteps(anchor);
  const step = currentStep(paste);
  const at = (): string => new Date().toISOString();
  const total = paste.steps.length;
  const nextStep = paste.steps[paste.current + 1];
  const nextLabel =
    nextStep?.kind === "slab"
      ? `Next: copy slab ${nextStep.index}${notFound ? "" : " & open TaleSpire"}`
      : nextStep?.kind === "tidy"
        ? "Next: tidy up"
        : null;
  const slab = step?.kind === "slab" ? model.slabs.find((s) => s.id === step.slabId) : undefined;
  const ordered = orderedLevels(plan);
  return (
    <aside
      ref={panel}
      className="guide"
      aria-label="Paste guide"
      onKeyDown={(e) => {
        if (e.key === "Escape") setGuide(false);
      }}
    >
      <div className="guide__h">
        <div className="guide__row">
          <h3>Paste guide</h3>
          <span className="muted">
            Step {paste.current + 1} of {total}
          </span>
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => {
              setGuide(false);
            }}
          >
            Exit guide
          </button>
        </div>
        <div className="pdots" aria-hidden="true">
          {paste.steps.map((s, i) => (
            <i key={i} className={i < paste.current ? "d" : i === paste.current ? "c" : ""} />
          ))}
        </div>
      </div>
      <div className="guide__b">
        {step?.kind === "prepare" && (
          <>
            <div className="gtitle">
              <b>Prepare</b>
            </div>
            <ol className="steps">
              <li>
                <span>1</span>
                <div>Open your board in TaleSpire and switch to build mode.</div>
              </li>
              <li>
                <span>2</span>
                <div>{words.ground}</div>
              </li>
              <li>
                <span>3</span>
                <div>{words.plane}</div>
              </li>
            </ol>
            {!notFound && (
              <button
                className="btn btn--sm guide__open"
                onClick={() =>
                  void run("talespire:openUrl", { url: STEAM_LAUNCH_URL }, "Couldn't start TaleSpire.")
                }
              >
                <Icon name="ext" size="sm" />
                Open TaleSpire
              </button>
            )}
          </>
        )}
        {step?.kind === "slab" && slab && (
          <>
            <SlabPreview
              plan={plan}
              version={model.version}
              slab={slab}
              levelIds={ordered
                .map((l) => l.id)
                .filter((id) => slab.levelIds.includes(id))
                .slice(0, 1)}
            />
            <div className="gtitle">
              <b>
                Slab {step.index} of {step.count} ({slab.label})
              </b>
              {paste.copied[slab.id] !== undefined && (
                <span className="clip">
                  <Icon name="check" size="sm" />
                  On your clipboard
                </span>
              )}
            </div>
            <ol className="steps">
              <li>
                <span>1</span>
                <div>
                  {notFound ? "Switch to TaleSpire." : "TaleSpire is in front."} In build mode, press{" "}
                  <span className="kbd">Ctrl V</span>. The slab follows your cursor.
                </div>
              </li>
              {step.index === 1 ? (
                <>
                  <li>
                    <span>2</span>
                    <div>
                      {words.first} <b>Press and hold</b> left-click to place it, then right-click to let go.
                    </div>
                  </li>
                  <li>
                    <span>3</span>
                    <div>{words.firstNote}</div>
                  </li>
                </>
              ) : (
                <>
                  <li>
                    <span>2</span>
                    <div>{words.later}</div>
                  </li>
                  <li>
                    <span>3</span>
                    <div>
                      <b>Press and hold</b> left-click to place it, then right-click to let go.
                    </div>
                  </li>
                </>
              )}
              <li>
                <span>4</span>
                <div>
                  Come back and press <b>Next</b>.
                </div>
              </li>
            </ol>
            {step.index > 1 && (
              <div className="offset">
                <b>Keep it steady</b>
                {words.steady}
              </div>
            )}
          </>
        )}
        {step?.kind === "tidy" && (
          <>
            <div className="gtitle">
              <b>
                Done — {Object.values(paste.pasted).filter(Boolean).length} of {model.slabs.length} slabs
                pasted.
              </b>
            </div>
            <p className="guide__p">
              {words.pillars} {words.redo}
            </p>
            <div className="card-actions">
              <button
                className="btn btn--sm"
                onClick={() => {
                  setGuide(false);
                }}
              >
                Back to build
              </button>
            </div>
          </>
        )}
      </div>
      <div className="guide__f">
        <button
          className="btn btn--sm"
          disabled={paste.current === 0}
          onClick={() => void dispatch({ type: "back" })}
        >
          <Icon name="left" size="sm" />
          Back
        </button>
        {step?.kind === "slab" && (
          <button
            className="iconbtn"
            aria-label="Copy again"
            title="Copy again"
            onClick={() => void dispatch({ type: "copy_again", at: at() })}
          >
            <Icon name="copy" />
          </button>
        )}
        <span className="build__sp" />
        {nextLabel !== null && (
          <button
            className="btn btn--primary guide__next"
            title="Next (N)"
            onClick={() => void dispatch({ type: "next", at: at() })}
          >
            {step?.kind === "prepare"
              ? `Next: copy the first slab${notFound ? "" : " & open TaleSpire"}`
              : nextLabel}
            <Icon name="right" />
          </button>
        )}
      </div>
    </aside>
  );
}

// ───────────── states ─────────────

const STAGE_LABEL: Record<string, string> = {
  resolve: "Reading the plan",
  realize: "Placing tiles and props",
  chunk: "Fitting it into slabs",
  encode: "Encoding for TaleSpire",
};

function Building() {
  const progress = useBuild((s) => s.progress);
  const pct = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;
  return (
    <div className="build__center">
      <div className="build__panel" role="status">
        <h2>Building…</h2>
        <div className="prog">
          <span className="prog__bar">
            <i style={{ width: `${pct}%` }} />
          </span>
          <span>{progress ? STAGE_LABEL[progress.stage] : "Starting"}</span>
        </div>
        <p className="muted">Building happens on this PC and doesn't use your API key.</p>
        <button
          className="btn btn--sm btn--ghost"
          onClick={() => void run("compile:cancel", undefined, "Couldn't stop the build.")}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function BuildToolbar() {
  const s = useSettings((x) => x.settings);
  const update = useSettings((x) => x.update);
  const run = useBuild((x) => x.run);
  const building = useBuild((x) => x.building);
  const snap = useProject((x) => x.snap);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    [btn, menu],
    () => {
      setOpen(false);
    },
    btn,
  );
  if (!s) return <div className="toolbar" />;
  const layout = s.talespire.levelLayout;
  const levels = snap?.plan?.levels.length ?? 1;
  return (
    <div className="toolbar" role="toolbar" aria-label="Build options">
      {levels > 1 && (
        <>
          <span className="toolbar__txt">
            Levels: <b>{layout === "stacked" ? "Stacked · 2.5 tiles per storey" : "Side by side"}</b>
          </span>
          <span className="toolwrap">
            <button
              ref={btn}
              className="tool"
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => {
                setOpen(!open);
              }}
            >
              Change
              <Icon name="down" size="xs" />
            </button>
            {open && (
              <div ref={menu} className="menu toolmenu" role="menu">
                {(
                  [
                    ["stacked", "Stacked · 2.5 tiles per storey"],
                    ["side_by_side", "Side by side"],
                  ] as const
                ).map(([v, l]) => (
                  <button
                    key={v}
                    role="menuitemradio"
                    aria-checked={layout === v}
                    className="menu__item"
                    onClick={() => {
                      setOpen(false);
                      void update({ talespire: { ...s.talespire, levelLayout: v } }).then(() => run());
                    }}
                  >
                    {l}
                  </button>
                ))}
              </div>
            )}
          </span>
          <span className="tsep" />
        </>
      )}
      <span className="toolbar__txt">
        Copy as: <b>Plain</b>
      </span>
      <span className="toolbar__sp" />
      <button
        className="tool"
        disabled={building || snap?.approvedVersion === null}
        onClick={() => void run()}
      >
        <Icon name="hammer" />
        Rebuild
      </button>
    </div>
  );
}

export function BuildView() {
  const snap = useProject((s) => s.snap);
  const building = useBuild((s) => s.building);
  const bundle = useBuild((s) => s.bundle);
  const guideOpen = useBuild((s) => s.guideOpen);
  const setGuide = useBuild((s) => s.setGuide);
  const run = useBuild((s) => s.run);
  const sync = useBuild((s) => s.syncFromSnapshot);
  const paste = useBuild((s) => s.paste);
  const catalog = useSettings((s) => s.catalog);
  const rec = latestBuild(snap);
  const plan = usePlanAt(rec?.versionNumber ?? null);
  useEffect(() => {
    sync();
  }, [rec?.id, sync]);
  if (!snap) return null;
  if (snap.approvedVersion === null)
    return (
      <div className="build__center">
        <div className="build__panel">
          <h2>Nothing approved yet</h2>
          <p>Approve a plan to build it for TaleSpire.</p>
          <button
            className="btn btn--primary"
            onClick={() => {
              useMap.getState().setTab("map");
            }}
          >
            Go to plan
          </button>
        </div>
      </div>
    );
  if (building) return <Building />;
  if (!rec)
    return (
      <div className="build__center">
        <div className="build__panel">
          <h2>Ready to build v{snap.approvedVersion}</h2>
          <p>
            Slabyrinth turns the approved plan into a TaleSpire slab: text you copy here and paste into
            TaleSpire. The whole map goes into one slab whenever it fits.
          </p>
          <button
            className="btn btn--primary btn--lg"
            onClick={() => void run(snap.approvedVersion ?? undefined)}
          >
            <Icon name="hammer" />
            Build v{snap.approvedVersion} for TaleSpire
          </button>
          <p className="muted">Building happens on this PC and doesn't use your API key.</p>
        </div>
      </div>
    );
  const model = buildModel(rec, bundle?.planVersion === rec.versionNumber ? bundle : null);
  // Verify diagnostics come with the bundle (in memory after a build); after a restart only the record's summary is known.
  const diags =
    bundle?.planVersion === rec.versionNumber
      ? bundle.diagnostics.filter((d) => d.stage === "verify" || d.severity !== "info")
      : null;
  const current = bundle?.planVersion === rec.versionNumber ? bundle : null;
  const anchor = model.pasteAnchor;
  // an empty slab crashes TaleSpire: the store and main refuse to send it; say so before the click
  const emptyChunk = current?.chunks.some((c) => c.assetCount <= 0) ?? false;
  const stale = snap.head !== rec.versionNumber;
  const pastedN = model.slabs.filter((s) => paste?.pasted[s.id] ?? s.pasted).length;
  const levelsN = model.levels.length;
  const showGuide = !model.single && guideOpen;
  return (
    <div className={`buildview${showGuide ? " buildview--guide" : ""}`}>
      <div className="buildlist">
        <div className="bhead">
          <h2>Built from v{rec.versionNumber}</h2>
          {stale ? (
            <span className="okpill okpill--warn">Plan is now v{snap.head}</span>
          ) : (
            <span className="okpill">
              <Icon name="check" size="xs" />
              Up to date
            </span>
          )}
          <span className="bhead__m">
            {levelsN} level{levelsN === 1 ? "" : "s"} ·{" "}
            {model.single ? "one slab" : `${model.slabs.length} slabs`} · built {clock(rec.createdAt)} on this
            PC
            {rec.assetSource === "builtin"
              ? " · built-in asset set"
              : catalog
                ? ` · ${catalog.assets.toLocaleString()} TaleSpire assets`
                : ""}
          </span>
        </div>
        {stale && (
          <div className="stale" role="status">
            <Icon name="warn" />
            <span>
              This build is from v{rec.versionNumber}. The plan is now v{snap.head}.
            </span>
            <button
              className="btn btn--sm"
              onClick={() => {
                useMap.getState().setTab("map");
                useMap.getState().setCompare({ on: true, against: rec.versionNumber });
              }}
            >
              Compare v{rec.versionNumber} → v{snap.head}
            </button>
            <button className="btn btn--sm" onClick={() => void approve(snap.head, true)}>
              Approve v{snap.head} & rebuild
            </button>
          </div>
        )}
        {pastesOutOfLine(rec) && (
          <div className="stale" role="alert">
            <Icon name="warn" />
            <span>{OUT_OF_LINE_MESSAGE}</span>
            <button className="btn btn--sm" disabled={building} onClick={() => void run(rec.versionNumber)}>
              Build again
            </button>
          </div>
        )}
        {rec.assetSource === "builtin" && (
          <div className="build__note">
            Built with the built-in asset set.{" "}
            <button
              className="btn btn--link"
              onClick={() => {
                useApp.getState().openSettings("talespire");
              }}
            >
              Locate TaleSpire folder…
            </button>
          </div>
        )}
        {rec.substitutions.length > 0 && (
          <div className="build__note build__note--warn" role="status">
            <Icon name="warn" />
            <span>
              <b>
                {rec.substitutions.length} asset{rec.substitutions.length === 1 ? "" : "s"} used by this map{" "}
                {rec.substitutions.length === 1 ? "isn't" : "aren't"} in TaleSpire any more, so substitutes
                were used.
              </b>{" "}
              {rec.substitutions
                .map(
                  (s) => `"${s.wanted}" → ${s.used !== null ? `"${s.used}"` : "dropped"} (${s.count} places)`,
                )
                .join("; ")}
              .
            </span>
            <button
              className="btn btn--sm btn--ghost"
              onClick={() => {
                useApp.getState().openSettings("talespire");
              }}
            >
              Asset library
            </button>
          </div>
        )}
        <SendToTaleSpire buildId={rec.id} multi={!model.single} anchor={anchor} emptyChunk={emptyChunk} />
        {!plan ? (
          <span className="spinner" />
        ) : model.single ? (
          <SingleSlab model={model} plan={plan} diags={diags ?? []} />
        ) : (
          <>
            <div className="getin">
              <div className="getin__txt">
                <b>Too big for one slab, so it's in {model.slabs.length} slabs.</b> The paste guide copies
                each slab in order, brings TaleSpire to the front, and tells you where to paste it with
                Ctrl+V.
              </div>
              <button
                className={`btn${guideOpen ? "" : " btn--primary"}`}
                onClick={() => {
                  const opening = !guideOpen;
                  setGuide(opening);
                  // Starting or resuming on a part copies it straight away (UX §9.3).
                  if (opening && paste && currentStep(paste)?.kind === "slab")
                    void useBuild
                      .getState()
                      .dispatch({ type: "goto", index: paste.current, at: new Date().toISOString() });
                }}
              >
                <Icon name="play" />
                {guideOpen
                  ? "Paste guide is open"
                  : pastedN > 0
                    ? `Resume paste guide · step ${(paste?.current ?? 0) + 1} of ${paste?.steps.length ?? 0}`
                    : "Start paste guide"}
              </button>
            </div>
            <BuildErrors plan={plan} diags={diags ?? []} />
            <ChunkList model={model} plan={plan} anchor={anchor} />
          </>
        )}
        {plan && <BuildNotes plan={plan} diags={diags} summary={rec.diagnosticsSummary} />}
      </div>
      {showGuide && plan && <PasteGuide model={model} plan={plan} anchor={anchor} />}
    </div>
  );
}
