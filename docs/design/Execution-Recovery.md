# Execution recovery and plan state

## Completion blockers

`ExecutionLedger.blocking` is the shared completion gate for ordinary replies and goal completion. Failed reads, diagnostic queries, and plan/goal control updates stay in the audit history but do not represent unfinished external side effects. Failed writes, commands and other side-effecting operations still block completion. Unknown outcomes also remain blocking.

Plan steps still require actual successful task execution evidence. Goal completion still checks its checklist, evidence ownership and unfinished background processes. A failed `goal_update` does not bypass any of these checks; it simply does not create another blocker that the next valid `goal_update` must somehow resolve first.

## Plan revisions

`task_update` and `plan_update` update the same checklist. A stale conflicting submission returns `PLAN_REVISION_CONFLICT` with `details.currentPlan`, allowing the model to merge against the real current revision. An identical retry of the immediately preceding successful submission returns the existing plan without incrementing its revision.

Successful plan updates supersede old failed plan submissions within the same task history, including legacy entries whose target hashes differed because the arguments changed. This does not resolve unrelated file or command failures. Already-resolved entries can be queried through `execution_resolve` idempotently. Failed control updates return `required: false` instead of demanding unrelated file reads as evidence.

## Execution queries

`execution_list` returns compact pages, newest first:

- `filter: recent` omits diagnostic bookkeeping calls so querying the list does not continually grow the default result.
- `filter: blocking` focuses on actual completion blockers.
- `filter: evidence` shows successful non-control operations that can be referenced as evidence.
- `filter: all` includes the full audit inventory.
- `executionId` returns one complete owned record.
- `before` accepts the previous page's `nextBefore` cursor; it is an execution ID, not a character offset.

Pages have both a requested item limit and an approximately 5,000-character item budget so they remain readable without repeated `read_result` pagination. Entries distinguish `executionId` from `resultId`, include `blocksCompletion` and `evidenceEligible`, and preserve the full IDs. Cursors are located in the task's audit history before filtering, so new diagnostic entries do not shift older pages.

No historical user records are deleted or silently rewritten by the query path. Full errors remain accessible through the single-record query and original result files.
