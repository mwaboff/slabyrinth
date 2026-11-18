/**
 * Progress parser (architecture §3.9): turns the streamed, still-incomplete JSON input of create_plan / edit_plan
 * into UX progress steps ("Laying out Level 1", "Placing doors and stairs", "Furnishing", "Writing GM notes").
 * Display only: the final input is validated as a whole by the executor.
 *
 * The accumulated input is re-parsed with WP1's tolerant partial-JSON parser at most once per `parseEveryChars`
 * characters, so cost stays linear-ish even for 60 KB plans.
 */
import { parsePartialJson, type JsonValue } from "../util/partialJson";

export type ProgressStep =
  "laying_out_level" | "placing_openings" | "furnishing" | "writing_notes" | "checking";

export interface ProgressEvent {
  step: ProgressStep;
  label: string;
}

export const PROGRESS_LABELS = {
  reading_brief: "Reading the brief",
  placing_openings: "Placing doors and stairs",
  furnishing: "Furnishing",
  writing_notes: "Writing GM notes",
  checking: "Checking the plan",
} as const;

export interface ProgressTracker {
  /** Feed the next input fragment; returns new progress events (possibly none). */
  push(fragment: string): ProgressEvent[];
  /** Parse whatever is left (end of the tool input). */
  finish(): ProgressEvent[];
}

type Obj = { [key: string]: JsonValue };
const isObj = (v: JsonValue | undefined): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: JsonValue | undefined): JsonValue[] => (Array.isArray(v) ? v : []);
const hasText = (o: Obj, ...keys: string[]): boolean =>
  keys.some((k) => typeof o[k] === "string" && o[k] !== "");

/** Progress for one streamed tool call. Returns null for tools that report no progress. */
export function createProgressTracker(toolName: string, parseEveryChars = 1024): ProgressTracker | null {
  if (toolName !== "create_plan" && toolName !== "edit_plan") return null;
  let text = "";
  let parsedAt = 0;
  let last: string | null = null;
  const emitted = new Set<string>();

  const emit = (out: ProgressEvent[], step: ProgressStep, label: string, key = `${step}:${label}`): void => {
    // Show each distinct step once; consecutive repeats are dropped anyway.
    if (emitted.has(key) || last === key) return;
    emitted.add(key);
    last = key;
    out.push({ step, label });
  };

  const levelLabel = (level: Obj, index: number): string =>
    `Laying out ${typeof level["name"] === "string" && level["name"] !== "" ? level["name"] : `Level ${index + 1}`}`;

  const scanLevel = (out: ProgressEvent[], level: Obj, index: number): void => {
    emit(out, "laying_out_level", levelLabel(level, index), `level:${index}`);
    if (arr(level["openings"]).length > 0) emit(out, "placing_openings", PROGRESS_LABELS.placing_openings);
    if (arr(level["features"]).length > 0 || arr(level["terrain"]).length > 0)
      emit(out, "furnishing", PROGRESS_LABELS.furnishing);
    if (arr(level["areas"]).some((a) => isObj(a) && hasText(a, "notes", "readAloud", "encounter"))) {
      emit(out, "writing_notes", PROGRESS_LABELS.writing_notes);
    }
  };

  const scan = (): ProgressEvent[] => {
    const out: ProgressEvent[] = [];
    const root = parsePartialJson(text).value;
    if (!isObj(root)) return out;
    if (toolName === "create_plan") {
      const plan = root["plan"];
      if (!isObj(plan)) return out;
      arr(plan["levels"]).forEach((l, i) => {
        if (isObj(l)) scanLevel(out, l, i);
      });
      if (arr(plan["links"]).length > 0) emit(out, "placing_openings", PROGRESS_LABELS.placing_openings);
      return out;
    }
    for (const op of arr(root["ops"])) {
      if (!isObj(op)) continue;
      const kind = op["op"];
      if (kind === "add" && isObj(op["element"])) {
        const el = op["element"];
        const k = el["kind"];
        if (k === "level" && isObj(el["value"])) scanLevel(out, el["value"], 0);
        else if (k === "area")
          emit(
            out,
            "laying_out_level",
            typeof el["level"] === "string" ? `Laying out ${el["level"]}` : "Laying out rooms",
          );
        else if (k === "opening" || k === "link" || k === "wall_run")
          emit(out, "placing_openings", PROGRESS_LABELS.placing_openings);
        else if (k === "feature" || k === "terrain" || k === "label")
          emit(out, "furnishing", PROGRESS_LABELS.furnishing);
      } else if (kind === "add_features" || kind === "materialize") {
        emit(out, "furnishing", PROGRESS_LABELS.furnishing);
      } else if (
        kind === "update" &&
        isObj(op["set"]) &&
        hasText(op["set"], "notes", "readAloud", "encounter")
      ) {
        emit(out, "writing_notes", PROGRESS_LABELS.writing_notes);
      } else if (kind === "reshape" || kind === "move" || kind === "duplicate") {
        emit(out, "laying_out_level", "Reshaping the layout");
      }
    }
    return out;
  };

  return {
    push(fragment) {
      text += fragment;
      if (text.length - parsedAt < parseEveryChars) return [];
      parsedAt = text.length;
      return scan();
    },
    finish() {
      if (parsedAt === text.length) return [];
      parsedAt = text.length;
      return scan();
    },
  };
}
