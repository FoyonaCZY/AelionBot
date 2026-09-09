# Prompt caching

## Request layout

Requests are assembled in this order:

1. Stable Bot identity, behavior rules and tool guidance.
2. Current memory, skill catalog and project/environment reference material.
3. Saved summary and relevant history, preserving original tool pairs and native reasoning.
4. Current task state, unresolved operations, time, reaction targets and collaboration events.

New turns append history without moving newly generated task IDs or timestamps in front of it. Runtime context is assembled for the request and does not rewrite stored history. Memory, skills, tools and project changes still take effect; cache reuse never freezes authorization or intentionally hides changes. Compaction may replace an old prefix when necessary to fit the context window.

Both the cognitive context engine and the plain-history fallback use this order. Group contexts use the same engine. Task-state and runtime-context tokens remain included in capacity checks.

Continuing after a network failure does not force compression. The current capacity checks still apply, and an explicit provider context-overflow response can force a recovery compression. Model-authored intermediate messages remain part of normal task execution; no separate progress-summary requests are scheduled. The retired `progressSeconds` setting is ignored when reading older profiles and is no longer offered in settings.

## Protocol handling

- Responses requests use a hashed `prompt_cache_key` scoped by provider/model, conversation and request purpose. A new run ID does not create a new key. Main conversations, private sessions and groups remain separate.
- If a Responses endpoint explicitly rejects `prompt_cache_key` with HTTP 400 or 422, retry once without that field and remember the unsupported capability for that endpoint/model in the current client instance. Unrelated errors do not trigger this fallback.
- Native Anthropic requests mark the first and last leading system blocks and up to two eligible history blocks, with at most four ephemeral markers. Later runtime controls do not receive a marker. Native reasoning signatures and stored message objects remain unchanged.
- Other protocols receive the improved message layout and diagnostics, without unsupported provider-specific cache parameters.

The key is a routing/matching hint, not a guarantee. `store: false` is retained. No real provider calls are required for local regression tests.

## Diagnostics

Each new usage record can contain `requestCache`. It is persisted alongside normal model usage and included in diagnostic exports. It contains hashes, sizes and comparison results only, never raw prompts, image data, credentials or tool results.

- `scopeFingerprint`: identifies the comparison scope without exposing its name.
- `optionsFingerprint`, `toolsFingerprint`, `inputFingerprint`: identify changed request sections.
- `firstDifference`: first observed change in options, tools, leading native system blocks or input messages.
- `firstDifferentMessage`: zero-based input item index, when a previously present item changed.
- `matchingPrefixMessages`: unchanged leading input items.
- `matchingInputPrefixBytes`: conservative matching byte count in serialized input, using 1 KiB blocks; this is not a token count or a provider cache-hit measurement.
- `prefixScanTruncated`: input exceeded the bounded fingerprint scan.
- `promptCacheKeySent`, `cacheKeyRejected`: whether a key was sent and whether the endpoint rejected it.

Comparisons are bounded to the 64 most recent scopes and 4 MiB of input blocks per scope. The provider's usage fields remain the source for actual cache reads/writes; raw records preserve missing fields. Usage reports treat missing cache details as misses and divide known cached tokens by all reported input tokens. Missing input usage is not estimated for that denominator.

## References

- [Hermes prompt assembly](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/prompt-assembly.md): separates stable and volatile material.
- [Codex client](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs): stable session cache keys.
- [OpenCode provider transforms](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/transform.ts): provider-specific cache markers and native reasoning handling.
- [GLM caching](https://docs.bigmodel.cn/cn/guide/capabilities/cache): stable system instructions and repeated history improve reuse.

Local tests check request construction, unsupported-field fallback, scope isolation, original-message immutability and diagnostic redaction. They do not assert a guaranteed hit rate on a third-party gateway.
