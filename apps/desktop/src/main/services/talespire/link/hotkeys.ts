/**
 * The add-on link's three global hotkeys (next, back, again). They are registered only while a map is being placed
 * (`arm`), and released when it is finished, the add-on leaves or the app quits (`disarm`), so the app holds no
 * system-wide keys the rest of the time. The GM chooses them in the add-on (`request`); a refused choice keeps the
 * previous key.
 *
 * `register` is Electron's globalShortcut.register in the app (it returns false when another program owns the key)
 * and a fake in tests and e2e runs: this file never touches Electron.
 */
import {
  DEFAULT_HOTKEYS,
  HOTKEY_ACTIONS,
  checkHotkey,
  type HotkeyAction,
  type HotkeyResult,
} from "./protocol";

export interface HotkeyRegistrar {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

interface Combo {
  combo: string;
  accelerator: string;
}

type Refusals = Partial<Record<HotkeyAction, { wanted: string; reason: string }>>;
export type HotkeyResults = Record<HotkeyAction, HotkeyResult>;

const TAKEN = "taken by another program";

function defaults(): Record<HotkeyAction, Combo> {
  const out = {} as Record<HotkeyAction, Combo>;
  for (const a of HOTKEY_ACTIONS) {
    const c = checkHotkey(DEFAULT_HOTKEYS[a]);
    if (!c.ok) throw new Error(`default hotkey ${a} is not allowed`);
    out[a] = { combo: c.combo, accelerator: c.accelerator };
  }
  return out;
}

export class HotkeyManager {
  /** The keys chosen (the defaults until the GM picks others). */
  private readonly wanted = defaults();
  /** Registered keys while armed. */
  private readonly active = new Map<HotkeyAction, Combo>();
  /** Keys that could not be registered when arming. */
  private readonly failed = new Map<HotkeyAction, { wanted: string; reason: string }>();
  private armedNow = false;

  constructor(
    private readonly registrar: HotkeyRegistrar,
    private readonly onCommand: (action: HotkeyAction) => void,
  ) {}

  get armed(): boolean {
    return this.armedNow;
  }

  /** Registers the chosen keys (a map is being placed). Returns the results. */
  arm(): HotkeyResults {
    if (this.armedNow) return this.state();
    this.armedNow = true;
    this.failed.clear();
    for (const a of HOTKEY_ACTIONS) {
      const w = this.wanted[a];
      if (this.tryRegister(a, w)) this.active.set(a, w);
      else this.failed.set(a, { wanted: w.combo, reason: TAKEN });
    }
    return this.state();
  }

  /** Releases every key (the map is finished, the add-on left, the app quits). */
  disarm(): HotkeyResults {
    for (const c of this.active.values()) this.registrar.unregister(c.accelerator);
    this.active.clear();
    this.armedNow = false;
    this.failed.clear();
    return this.state();
  }

  /**
   * The GM's choice for some of the actions. Invalid keys and duplicates are refused; while armed a key another
   * program holds is refused and the previous one kept. The results name each refusal once.
   */
  request(wanted: Partial<Record<HotkeyAction, string | undefined>>): HotkeyResults {
    const refused: Refusals = {};
    const changes = new Map<HotkeyAction, Combo>();
    for (const a of HOTKEY_ACTIONS) {
      const raw = wanted[a];
      if (raw === undefined) continue;
      const c = checkHotkey(raw);
      if (!c.ok) refused[a] = { wanted: raw, reason: `invalid: ${c.reason}` };
      else if (this.wanted[a].accelerator !== c.accelerator)
        changes.set(a, { combo: c.combo, accelerator: c.accelerator });
    }
    // duplicates between the three actions, judged on the result
    const after = (a: HotkeyAction): string => (changes.get(a) ?? this.wanted[a]).accelerator;
    for (const [a, c] of [...changes]) {
      const other = HOTKEY_ACTIONS.find((b) => b !== a && after(b) === c.accelerator);
      if (other) {
        refused[a] = { wanted: c.combo, reason: `the same key as ${other}` };
        changes.delete(a);
      }
    }
    if (this.armedNow) {
      // free the old keys first (so two actions can swap), then register the new ones
      for (const a of changes.keys()) {
        const old = this.active.get(a);
        if (old) this.registrar.unregister(old.accelerator);
      }
      for (const [a, c] of changes) {
        if (this.tryRegister(a, c)) {
          this.wanted[a] = c;
          this.active.set(a, c);
          this.failed.delete(a);
          continue;
        }
        refused[a] = { wanted: c.combo, reason: TAKEN };
        const old = this.active.get(a);
        if (old && !this.tryRegister(a, old)) this.active.delete(a);
      }
    } else for (const [a, c] of changes) this.wanted[a] = c;
    return this.state(refused);
  }

  /** Where each key stands; `refused` names this request's refusals. */
  state(refused: Refusals = {}): HotkeyResults {
    const out = {} as HotkeyResults;
    for (const a of HOTKEY_ACTIONS) {
      const r = refused[a] ?? (this.armedNow ? this.failed.get(a) : undefined);
      const kept = this.armedNow ? (this.active.get(a)?.combo ?? null) : this.wanted[a].combo;
      if (r) out[a] = { status: "refused", combo: kept, wanted: r.wanted, reason: r.reason };
      else if (this.armedNow) out[a] = { status: kept ? "active" : "none", combo: kept };
      else out[a] = { status: "standby", combo: kept };
    }
    return out;
  }

  /** off while not armed; else how many keys are registered. */
  summary(): "off" | "active" | "partial" | "failed" {
    if (!this.armedNow) return "off";
    const n = this.active.size;
    return n === HOTKEY_ACTIONS.length ? "active" : n === 0 ? "failed" : "partial";
  }

  private tryRegister(a: HotkeyAction, c: Combo): boolean {
    try {
      return this.registrar.register(c.accelerator, () => {
        this.onCommand(a);
      });
    } catch {
      return false;
    }
  }
}
