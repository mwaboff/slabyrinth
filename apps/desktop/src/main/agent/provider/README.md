# Chat providers

The engine (`../engine.ts`) talks only to `ChatProvider` (`types.ts`, a contract copy). Everything vendor-specific
lives in one folder per provider. v1 ships `anthropic/`. Register a provider in `registry.ts`.

## What an LM Studio provider (`lmstudio/`) has to implement

- **`info`**: `needsKey: false`, `hasServerUrl: true`, `defaultServerUrl: "http://localhost:1234/v1"`,
  `modelSource: "fetched"`, `hasCost: false`, `available: true` once it ships.
- **`configure`**: read `baseUrl` (and any `options`) from `ProviderConfig`. No key.
- **`checkConnection` / `listModels`**: `GET /v1/models` with `fetch`. Descriptors: `effort: { supported: false }`,
  `thinking: "unknown"`, `toolCalling: "json"` by default (user may override to `"native"`), `imageInput: false`
  unless overridden, `pricing: null`, `source: "api"`. A refused connection maps to kind `network` (UX 10.19).
- **`runStep`**: `POST /v1/chat/completions` with SSE.
  - Render the neutral transcript itself: `user` → user text; `context` → user text tagged
    `<app_context reason="…">` (no mid-conversation system role); `marker` → nothing; `assistant` items from
    other providers → their neutral `text`/`tool_call` parts (ignore other providers' `providerState`);
    `excludedFromContext` → skipped. Rendering must be deterministic (same transcript → same bytes).
  - `toolMode: "json"`: append `jsonProtocolSection(request.tools)` (core) to the system prompt; parse each reply
    with `parseJsonReply` (same schemas as native tools); emit neutral `tool_call` parts with synthetic ids; send
    tool results back with `jsonToolResultsText`. On `kind: "invalid"`, ask for a corrected reply up to twice
    (append the message, re-run), then throw `malformed_output`. A reply with no JSON is plain chat.
  - `toolMode: "native"`: OpenAI-style `tools` / `tool_calls`; wrap unparseable arguments with
    `invalidJsonInput(raw)` (core) so the executor answers with an INVALID_JSON result.
  - Stream `text_delta` / `tool_call_*` events; honour the `AbortSignal` (throw kind `cancelled`).
  - Usage from the response `usage` if present, else characters ÷ 4; `cost: null`.
  - Store `providerState: { providerId: "lmstudio", modelId, raw }` only if the server needs exact replay.
- **`describeSwitch`**: switching to/from a local model always resets any cache and drops hidden reasoning;
  `estimatedExtraCost: null`.
- **Errors**: throw `ProviderFailure` (`errors.ts`) with a `ProviderErrorInfo`; never include secrets.
- **Long conversations**: no server compaction. The engine-side client compaction (summary + outline + new turn at
  70 % of `contextWindow`, architecture §3.13) is not built yet; it is the engine's job, not the provider's.

Nothing in the engine, executor, settings or cost code assumes Anthropic; the only provider-specific settings bag
is `ProviderSettings.options`.
