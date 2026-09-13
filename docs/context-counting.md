# Context usage measurement

## Implemented

- `ContextMeter.tokens` and `ContextStats.estimatedTokens` retain their conservative budgeting semantics. The existing safety calibration remains at least 1; compression thresholds and output reservation do not use the display estimate.
- `displayTokens` uses normalized provider input usage for the unchanged prefix and estimates only newly appended content. After pruning or another prefix rewrite, a separate rolling median of provider/local token ratios estimates the new request, including ratios below 1. Existing persisted usage anchors bootstrap this calculation on upgrade.
- Display calibration is scoped to Bot/provider/endpoint/protocol/model/reasoning settings, with text and vision observations kept separate. It is shared across that Bot's conversation scopes, without sharing messages. Invalid/tiny samples are ignored; observations from a fallback model or omitted-image requests do not train the original model's meter.
- `ModelClient` publishes normalized input usage as soon as a completed response is parsed, before returning to the task loop. Missing usage stays estimated. Anthropic cache reads and writes are already included by `modelUsage`; they must not be added twice. Output usage is not part of the last request's input total.
- The overview identifies provider-reported totals separately from estimated totals. Category allocations remain estimates and always add up to the displayed total. Measurement metadata does not enter model messages or cache keys.

## No additional counting requests

The user explicitly declined provider pre-count APIs on 2026-09-13 because they can add costs. Do not add or enable separate token-counting requests for this feature. This applies even when the destination is the already configured Provider or a native counting endpoint is available.

Use only local estimates/calibration and usage returned by the existing inference request. Do not issue dummy inference requests, retry an inference solely to obtain usage, or send conversation/attachment content to another service for counting. Missing usage remains labeled as estimated.

## Verification

`node --import tsx --test tests/context-view.test.ts tests/context-cache-stability.test.ts tests/context-overview.test.ts tests/model-runtime.test.ts tests/context-recovery.test.ts tests/i18n.test.ts`

Fixtures cover downward calibration and conservative budgeting, legacy anchors, model/modality isolation, proportional breakdowns, same-request updates for all four protocols, missing usage, fallback identity, and unchanged wire payloads. Tests use isolated storage and local HTTP fixtures, without altering a user's conversation or sending it to a model service.
