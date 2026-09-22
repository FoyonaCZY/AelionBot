# Model streaming timeout audit — 2026-09-16

The shared request path contained reproducible client defects. They affect both general and designer execution because both use ModelClient.

## Reproduced before the change

1. A local service emitted valid tool-argument fragments every 45 ms for about 500 ms. With a 220 ms request timeout, the previous absolute deadline aborted the healthy stream. The production default used the same mechanism with 180,000 ms.
2. A Chat-compatible service sent a complete finish_reason and trailing usage, but kept the connection open without [DONE]. The client waited until its deadline and discarded a complete result.
3. Valid multi-line SSE data and carriage-return event boundaries failed parsing because each LF-delimited data line was parsed independently.
4. Public progress tracked visible prose only. Tool arguments and private processing events could continue while the UI described the response as stalled. Historical diagnostics did not retain last-event or argument-progress counters, so they cannot prove the exact cause of every past timeout.

## Changes

- RequestIdleTimeout starts at transport dispatch and resets on meaningful model output. Local prompt preparation is outside this clock. Ping comments and role-only frames do not extend it. The existing RunPolicy remains responsible for overall task time limits and cancellation.
- A shared response reader handles LF, CRLF and CR, multi-line data, UTF-8 fragments, EOF and [DONE]. After a definitive protocol completion event, it drains trailing usage for up to one second instead of waiting indefinitely. Incomplete tool JSON still fails validation before execution.
- Stream activity reports metadata only: text/tool/processing category, received bytes and argument character counts. Private content is never displayed or added to diagnostics. Progress timestamps reflect meaningful output.
- Diagnostic timing includes first tool data, last meaningful event, response bytes, output event count, argument character count and completion state. This distinguishes a silent service from a continuously producing stream.

## Validation

- Before fix: 3 of 5 focused lifecycle tests failed with the defects above.
- After fix: all 10 lifecycle tests passed under both the development Node runtime and the actual packaged Electron 44.2.0 runtime in ELECTRON_RUN_AS_NODE mode.
- Cross-protocol coverage: Chat, Responses, Anthropic and Gemini; continuous arguments/processing, bounded heartbeat-only waits, user cancellation, missing DONE, trailing usage, and invalid tool JSON.
- Focused request/progress/diagnostics/TTFT regression: 44 passed.
- Full suite: 772 tests, 768 passed, 4 skipped, 0 failed.
- No live user task was interrupted, no credentials were exported, and no extra real-provider request was sent for these reproductions. The currently running older package is unchanged until a new build is installed.
