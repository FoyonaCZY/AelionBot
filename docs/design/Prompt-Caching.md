# Prompt caching

## Request layout

Each context epoch begins with:

1. Stable Bot identity, behavior rules and tool guidance.
2. Current memory, skill catalog and project/environment reference material.
3. Saved summary and relevant history, preserving original tool pairs and native reasoning.
4. Task-state and reference-update events at the positions where they were first introduced.

The model-visible view is persisted separately from the original transcript. New turns retain earlier runtime events in place and append changed state after new history. Identical state is not repeatedly inserted. Reference snapshots remain byte-stable within an epoch; current memory/skill/environment changes append an explicitly superseding reference event. A summary epoch rebuilds the base snapshot and consolidates prior events. Actual system changes or non-append edits to raw history also invalidate the view. Memory, skills, tools and project changes still take effect; execution permissions remain live.

Main conversations, Bot-private exchanges and group contexts use the same engine, with isolated scope keys. When the cognition service is unavailable, the harness owns a short-lived engine rather than using a separate character-count fallback. Runtime-event tokens remain included in capacity checks. Bot deletion clears persisted views and usage anchors.

## Stable tool definitions and live execution restrictions

Ordinary plan/goal creation no longer removes `chat_pin` or `group_pin` from the declared tools. Duplicate-reaction correction also keeps the original schema. These temporary restrictions are described in the trailing task state and checked again immediately before dispatch, including when an earlier call in the same model response creates a plan. A rejected call is recorded as not executed and cannot apply a reaction or create a successful execution receipt.

`read_result` is available from the start, so the first truncated output does not add a new schema. Its existing Bot-ownership checks continue to restrict access to stored outputs.

Planning-only mode, private-chat boundaries, memory ownership and installed-service availability remain real tool-set boundaries. Their restrictions are not relaxed to improve cache rates. Planning restrictions are also enforced in the execution path and batch reader.

This adapts the separation of request construction and runtime execution/approval found in [OpenCode's LLM integration](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/llm.ts) and [Codex's tool orchestrator](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/orchestrator.rs), alongside Hermes's stable/volatile prompt layering. The implementation uses Aelion's own tool registry and permission machinery; it does not vendor another agent's runtime.

Continuing after a network failure does not force compression. The current capacity checks still apply, and an explicit provider context-overflow response can force a recovery compression. Model-authored intermediate messages remain part of normal task execution; no separate progress-summary requests are scheduled. The retired `progressSeconds` setting is ignored when reading older profiles and is no longer offered in settings.

## Protocol handling

- Responses requests use a hashed `prompt_cache_key` scoped by provider/model, conversation and request purpose. A new run ID does not create a new key. Main conversations, private sessions and groups remain separate.
- Capability detection, diagnostics and session keys also separate protocols. Requests with a known conversation send opaque `x-session-affinity` and `x-session-id` headers, following OpenCode's routing approach. These are best-effort hints; a provider may ignore them. Chat requests do not gain unsupported cache fields in their body.
- If a Responses endpoint explicitly rejects `prompt_cache_key` with HTTP 400 or 422, retry once without that field and remember the unsupported capability for that endpoint/model in the current client instance. Unrelated errors do not trigger this fallback.
- Native Anthropic requests mark the first and last leading system blocks and up to two completed history transactions, with at most four ephemeral markers. A parallel tool call gets one history breakpoint after all its results, rather than spending both on individual results. Incomplete or orphan tool-result groups are not marked. Later runtime controls do not receive a marker. Native reasoning signatures and stored message objects remain unchanged.
- Other protocols receive the improved message layout and diagnostics, without unsupported provider-specific cache parameters.

The key is a routing/matching hint, not a guarantee. `store: false` is retained. No real provider calls are required for local regression tests.

Each model invocation snapshots its messages and canonicalizes tool definitions before sending. Tool names and object keys use deterministic ordering, while schema arrays retain their original order. A retry uses that owned snapshot, including a per-request image-resolution cache, even if the caller later modifies its input. Protocol adapters do not share mutable native output objects with saved history. Greeting requests have their own purpose and retain native reasoning in history without exposing it as greeting text.

### Responses connection reuse

The Provider editor offers Auto, HTTP and WebSocket for Responses. Auto enables WebSocket on the official OpenAI `/v1` endpoint when no HTTP proxy environment is selected; unknown compatible endpoints stay on HTTP unless explicitly enabled. No VM network settings are involved.

A bounded pool holds at most eight scoped connections and closes idle connections after 60 seconds. Keys include endpoint/header identity, so credential or route changes discard old connections. A WebSocket continuation requires unchanged request options plus an exact prefix match against the previous request and returned native output. Only then is the new input suffix sent with `previous_response_id`. The logical complete history remains available locally, and `store:false` is retained.

Missing previous-response state retries once with the full input on that connection. Unsupported handshakes/transport fall back to HTTP with a cooldown; a dropped stream goes through normal retry/reset handling before full HTTP recovery. Cancellation closes the lane without falling back. Disposal closes active and connecting sockets. The implementation follows [the official WebSocket mode contract](https://developers.openai.com/api/docs/guides/websocket-mode) and [Codex's strict incremental-prefix checks](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs), not a promise that third-party gateways honor routing hints or expose this transport.

## Long-task estimation and stable pruning

Calibration v2 uses `reported input / (estimated input / applied factor)`. Foreground and compaction calls pass the factor used when preparing their request; background review explicitly passes `1` because its estimate is unscaled. This avoids repeatedly multiplying an existing factor by an unscaled background ratio. New observations can increase the factor immediately, while sustained overestimation lowers it gradually. The uncalibrated estimate remains the floor. Legacy scalar calibration values from the compounding implementation are not inherited; observations are relearned under a versioned provider/protocol/model key.

Tool-output pruning is a persistent, scoped request view. Once an archived output has been shortened, subsequent requests reuse that same shortened content even when the estimate drops below the pruning trigger. Existing shortened outputs are not recursively shortened again. The original transcript and result files remain intact. Content fingerprints prevent reuse after a source changes, and Bot deletion clears its pruning rows. Obsolete rows are removed after their source leaves the retained context. New pruning stops at the view cache's 4,096-entry / 4 MiB budget rather than evicting still-visible entries and re-expanding an old prefix.

Usage records include the numeric context estimate, applied calibration, pruning count and summary epoch for the actual request. These are also included in diagnostic exports. Pruning and summary compression are distinct: a zero summary-epoch count does not imply that the sent history was never shortened.

Capacity checks now prefer a persisted actual-usage anchor for the same model/options/tools and an unchanged request prefix. The prior input uses reported tokens; only appended content is estimated. Rewrites, different models/tools, or absent observations fall back to the calibrated tokenizer. Calibration observations still use the tokenizer estimate, never feed the anchored estimate back into calibration. Output and safety reserves are retained; additional headroom is 3% of input (512–8,192 tokens), replacing the extra 15% multiplier. Ordinary pruning requires a minimum useful saving (up to 8,000 tokens); emergency recovery may bypass that minimum. This reduces repeated small rewrites without disabling capacity handling.

### Image lifecycle

Protocol conversion no longer evicts images on each append. The context view archives older occurrences in batches after 32 screenshots/attachment images, retaining the latest eight screenshots/ten attachment occurrences; under token pressure it can retain two screenshots/ten attachments. Archival is persisted by source-message occurrence, not global image ID: rereading the same attachment displays it again without resurrecting earlier archived copies. Original image files/transcripts remain unchanged. Archived entries retain IDs and instructions for attachment rereading or obtaining a fresh desktop observation. Repeated images are counted per occurrence in the capacity estimate.

## Diagnostics

Each new usage record can contain `requestCache`. It is persisted alongside normal model usage and included in diagnostic exports. It contains hashes, sizes and comparison results only, never raw prompts, image data, credentials or tool results.

- `scopeFingerprint`: identifies the comparison scope without exposing its name.
- `optionsFingerprint`, `toolsFingerprint`, `inputFingerprint`: identify changed request sections.
- `firstDifference`: first observed change in options, tools, leading native system blocks or input messages.
- `firstDifferentMessage`: zero-based input item index, when a previously present item changed.
- `firstDifferentRole`: role/type of the changed input item.
- `toolCount`, `toolsAdded`, `toolsRemoved`, `toolsChanged`: named tool-definition changes, without including schemas or descriptions; inventories are bounded to 256 recognized tool names.
- `matchingPrefixMessages`: unchanged leading input items.
- `matchingInputPrefixBytes`: conservative matching byte count in serialized input, using 1 KiB blocks; this is not a token count or a provider cache-hit measurement.
- `prefixScanTruncated`: input exceeded the bounded fingerprint scan.
- `promptCacheKeySent`, `cacheKeyRejected`: whether a key was sent and whether the endpoint rejected it.
- `sessionAffinitySent`: whether stable routing headers were sent; it does not claim the provider honored them.
- `successfulPrefixMessages`, `strictContinuation`: comparison against the last successful logical request plus returned assistant output, not merely the last attempt. Failed attempts do not replace that successful baseline.
- `transport`, `incremental`, `sentInputItems`: actual transport and transmitted input count, while the ordinary input hash/count still describes the complete logical request.

Context diagnostics additionally include `estimateSource`, `contextChanges` and `archivedImages`, distinguishing usage anchoring, reference/system/history changes, summary epochs, tool pruning and image archival. These records do not contain the snapshots or event text.

Comparisons are bounded to the 64 most recent scopes and 4 MiB of input blocks per scope. The provider's usage fields remain the source for actual cache reads/writes; raw records preserve missing fields. Usage reports treat missing cache details as misses and divide known cached tokens by all reported input tokens. Missing input usage is not estimated for that denominator.

Message-level comparison is capped at 4,096 items. A full input digest detects changes beyond that cap and reports `input-beyond-scan` rather than incorrectly claiming identical input. Chunk hashes operate on bytes without an intermediate base64 copy. Usage records also include allowlisted `transportErrorCodes` from nested network causes, without copying exception messages, hostnames or credentials into these diagnostics.

## References

- [Hermes prompt assembly](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/prompt-assembly.md): separates stable and volatile material.
- [Codex client](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs): stable session cache keys.
- [OpenCode provider transforms](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/transform.ts): provider-specific cache markers and native reasoning handling.
- [GLM caching](https://docs.bigmodel.cn/cn/guide/capabilities/cache): stable system instructions and repeated history improve reuse.

Local tests check request construction, unsupported-field fallback, scope isolation, original-message immutability and diagnostic redaction. They do not assert a guaranteed hit rate on a third-party gateway.
