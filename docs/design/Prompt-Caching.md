# Prompt caching

## Request layout

Requests are assembled in this order:

1. Stable Bot identity, behavior rules and tool guidance.
2. Current memory, skill catalog and project/environment reference material.
3. Saved summary and relevant history, preserving original tool pairs and native reasoning.
4. Current task state, unresolved operations, time, reaction targets and collaboration events.

New turns append history without moving newly generated task IDs or timestamps in front of it. Runtime context is assembled for the request and does not rewrite stored history. Memory, skills, tools and project changes still take effect; cache reuse never freezes authorization or intentionally hides changes. Compaction may replace an old prefix when necessary to fit the context window.

Both the cognitive context engine and the plain-history fallback use this order. Group contexts use the same engine. Task-state and runtime-context tokens remain included in capacity checks.

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

Each model invocation snapshots its messages and canonicalizes tool definitions before sending. Tool names and object keys use deterministic ordering, while schema arrays retain their original order. A retry uses that owned snapshot, even if the caller later modifies its input. Protocol adapters do not share mutable native output objects with saved history. Greeting requests have their own purpose and retain native reasoning in history without exposing it as greeting text.

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

Comparisons are bounded to the 64 most recent scopes and 4 MiB of input blocks per scope. The provider's usage fields remain the source for actual cache reads/writes; raw records preserve missing fields. Usage reports treat missing cache details as misses and divide known cached tokens by all reported input tokens. Missing input usage is not estimated for that denominator.

Message-level comparison is capped at 4,096 items. A full input digest detects changes beyond that cap and reports `input-beyond-scan` rather than incorrectly claiming identical input. Chunk hashes operate on bytes without an intermediate base64 copy. Usage records also include allowlisted `transportErrorCodes` from nested network causes, without copying exception messages, hostnames or credentials into these diagnostics.

## References

- [Hermes prompt assembly](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/prompt-assembly.md): separates stable and volatile material.
- [Codex client](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs): stable session cache keys.
- [OpenCode provider transforms](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/transform.ts): provider-specific cache markers and native reasoning handling.
- [GLM caching](https://docs.bigmodel.cn/cn/guide/capabilities/cache): stable system instructions and repeated history improve reuse.

Local tests check request construction, unsupported-field fallback, scope isolation, original-message immutability and diagnostic redaction. They do not assert a guaranteed hit rate on a third-party gateway.
