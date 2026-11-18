/**
 * A fake ChatProvider that plays back scripted steps (tests and the eval harness's self-test). No network.
 */
import type {
  AssistantPart,
  ChatItem,
  ChatProvider,
  ModelDescriptor,
  ModelSelection,
  ProviderErrorInfo,
  StepEventSink,
  StepRequest,
  StepResult,
  StopReason,
  SwitchImpact,
  Usage,
} from "../provider/types";
import { staticDescriptors } from "../provider/anthropic/models";
import { ANTHROPIC_INFO } from "../provider/anthropic/provider";
import { costOf } from "../cost";
import { ProviderFailure } from "../provider/errors";

export type ScriptedStep =
  | {
      kind: "reply";
      parts: AssistantPart[];
      stopReason?: StopReason;
      usage?: Partial<Usage>;
      delayMs?: number;
      streamText?: string[];
    }
  | { kind: "error"; info: ProviderErrorInfo }
  | { kind: "hang" };

let counter = 0;

export function call(name: string, input: unknown, callId = `toolu_${++counter}`): AssistantPart {
  return { type: "tool_call", callId, name, input };
}
export function say(text: string): AssistantPart {
  return { type: "text", text };
}

export class ScriptedProvider implements ChatProvider {
  readonly id = "anthropic";
  readonly info = ANTHROPIC_INFO;
  readonly requests: StepRequest[] = [];
  private readonly steps: ScriptedStep[];
  /** Effort switches keep the cache (per-message effort) unless false. */
  perMessageEffort = true;

  constructor(steps: ScriptedStep[] | ((req: StepRequest, i: number) => ScriptedStep)) {
    this.steps = Array.isArray(steps) ? [...steps] : [];
    if (!Array.isArray(steps)) this.dynamic = steps;
  }
  private dynamic: ((req: StepRequest, i: number) => ScriptedStep) | null = null;

  configure(): void {
    /* no config */
  }
  checkConnection(): Promise<{ ok: true }> {
    return Promise.resolve({ ok: true });
  }
  listModels(): Promise<ModelDescriptor[]> {
    return Promise.resolve(staticDescriptors());
  }
  describeSwitch(from: ModelSelection, to: ModelSelection): SwitchImpact {
    const modelChanged = from.modelId !== to.modelId;
    const reset = modelChanged || (from.effort !== to.effort && !this.perMessageEffort);
    return {
      cacheReset: reset,
      reasoningDropped: modelChanged,
      estimatedExtraCost: reset ? 0.01 : 0,
      messages: [],
    };
  }

  async runStep(request: StepRequest, onEvent: StepEventSink, signal: AbortSignal): Promise<StepResult> {
    this.requests.push(structuredClone(request));
    const i = this.requests.length - 1;
    const step = this.dynamic ? this.dynamic(request, i) : this.steps.shift();
    if (!step) throw new Error(`script exhausted at step ${i}`);
    if (step.kind === "error") throw new ProviderFailure(step.info);
    onEvent({ type: "started", servedBy: { providerId: "anthropic", modelId: request.selection.modelId } });
    if (step.kind === "hang") {
      onEvent({ type: "text_delta", text: "Partial answer" });
      await new Promise<void>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(new ProviderFailure({ kind: "cancelled", retryable: false, message: "Stopped." }));
          },
          { once: true },
        );
      });
      throw new Error("unreachable");
    }
    if (step.delayMs !== undefined && step.delayMs > 0) {
      const ms = step.delayMs;
      // A slow model (e2e specs observe the app mid-turn); Stop still aborts it.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new ProviderFailure({ kind: "cancelled", retryable: false, message: "Stopped." }));
          },
          { once: true },
        );
      });
    }
    for (const t of step.streamText ?? []) onEvent({ type: "text_delta", text: t });
    for (const p of step.parts) {
      if (p.type === "tool_call") {
        onEvent({ type: "tool_call_start", callId: p.callId, name: p.name });
        onEvent({ type: "tool_call_delta", callId: p.callId, partialJson: JSON.stringify(p.input) });
        onEvent({ type: "tool_call_end", callId: p.callId });
      }
    }
    const usage: Usage = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 8000,
      cacheWriteTokens: 200,
      ...step.usage,
    };
    const stopReason: StopReason =
      step.stopReason ?? (step.parts.some((p) => p.type === "tool_call") ? "tool_use" : "end_turn");
    const spec = staticDescriptors().find((d) => d.modelId === request.selection.modelId);
    const item: Extract<ChatItem, { type: "assistant" }> = {
      type: "assistant",
      id: `a${i}`,
      turnId: request.turnId,
      parts: step.parts,
      stopReason,
      servedBy: { providerId: "anthropic", modelId: request.selection.modelId },
      usage,
      createdAt: new Date(0).toISOString(),
    };
    const result: StepResult = {
      stopReason,
      usage,
      cost: costOf(usage, spec?.pricing ?? null),
      assistant: item,
    };
    if (stopReason === "refusal") result.refusal = { category: "cyber", explanation: null };
    return result;
  }
}
