# Designer Bots

AelionBot supports `general` and `designer` Bot types. Existing profiles migrate to `general`. Users choose the type during creation or in Bot profile. Changing an existing Bot requires explicit confirmation that all context will be lost. Running or queued work blocks the switch. A confirmed switch clears conversations, memories, task history, design sessions and owned context caches; files, plugins, Bot identity, memberships and shared conversation records remain. Old deferred type switches are discarded on upgrade.

## Execution and context

`BotRuntime` is the dispatch boundary for chat, groups, peer work and schedules. `DesignerLoop` owns design orchestration and a separate model history. It reuses the current permission-checked tool services through `Harness.openToolSession`; it does not call the general inference loop, load default skills or enqueue skill-learning work. Explicit private user memory requests can use the existing verified memory route.

Design histories are keyed by Bot + origin (main chat, group or peer thread) + design session. They use the existing `ContextEngine` for compression, with the structured task frame injected separately. Group design runs read only the current group's public messages, not the main chat's private history. Peer write capabilities require a verifiable original human request. Structured peer work still requires an execution-backed receipt.

Each `DesignSession` stores its brief, artifact kind, design-system version, design decisions, constraints, stage, checks, artifacts, run IDs and manual-edit ledger. Prototype and PPT tasks are independent. Queue batches do not combine distinct design-session IDs. A group reply to a design task follows that task's owner; preview feedback carries the explicit session ID.

Manual saves invalidate prior checks and record the saved file revision. If a user saves while the model is generating another edit, the old operation pauses before dispatching further tools. It does not silently overwrite the newly saved file.

## Product UI

The existing general chat and computer sidebar remain. Designer mode adds a task home, prototype/PPT/website-clone choices, a searchable preinstalled design-system library, a task selector, brief/design-direction context and verified deliverable cards. There is no top-right type switch or automatic general/designer handoff. Drafts are scoped to a context-reset generation. Group chat keeps its message UI and uses design task cards; the task drawer can open the shared file/web preview.

The same preview supports code and element editing, annotations, keyboard undo/redo and save. Designer model calls use the configured provider; designer tools run locally without VM or desktop startup; an isolated browser fixture lives under `.local/designer-product-ui/` for UI tests and never sends real model requests.

## Deliverables and verification

`design_publish` reads actual files under the task directory before attaching them. A prototype requires an HTML artifact. PPT requires a PPTX archive with actual slides and editable text, rather than an image-only deck. A companion HTML preview is encouraged. A website clone requires HTML plus `NOTES.md` that names the source URL and what was not cloned. File validation does not imply visual correctness: screenshot checks remain pending until the run supplies actual successful `view_image` observation evidence. Human acceptance is a separate UI action.

Tools with unresolved failures cannot produce a successful completion silently. Runs share cancellation and time/token budgets. User questions use the existing interaction service. CLI/terminal startup is not a verification signal.

## Bundled design systems

All 152 reviewed `design-systems/` packages from `nexu-io/open-design` revision `d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4` are included in `assets/design-systems/`. The catalog records every file's SHA-256, size, source and license. Original files are unchanged, and LICENSE / NOTICE accompany the catalog. Brand-inspired references are not official brand endorsements; external font/image references are not separately downloaded or licensed by this integration.

New tasks pin their local directory to `<configured-default-workspace>/designers/<botId>/<sessionId>`. Only the selected package is materialized under `.design-system/<revision>/<systemId>` within that task. File read/write, attachment copying, file trees and live preview resolve to the same host files. Legacy VM task records remain intact and cannot silently resume against a different host directory. The app retains selected versions in its own `design-system-cache` so an app update does not change existing tasks' references. Unreferenced catalog content is not copied wholesale into each Bot workspace.

`vendor-design-systems.mjs` is a maintenance command requiring the reviewed checkout; builds consume the checked-in assets and need no OpenDesign checkout or network fetch.

## Dedicated local workflows

The first-party `design_skill` playbooks cover prototypes, presentations, website clones and focused refinement. General default skills are not mounted. `design_spec` persists DESIGN.md; `design_deck` creates editable OOXML text/shapes and a companion HTML deck without Python or Office. Built-in layouts are title, agenda, split, statement, quote, compare, timeline, stat and cta — a starting scaffold, not an arbitrary PPT renderer. Clone tasks observe a public page with existing web tools and rebuild a local replica; they do not vendor OpenDesign's CDP harvest scripts. External Office attachments without an HTML companion have no VM-free visual converter yet; they remain downloadable.

File APIs validate task ownership, canonical paths and saved revisions. Host command cwd is pinned to the task and follows the existing permission system; this is not an OS-level filesystem sandbox for arbitrary shell commands. Dedicated design tools now store execution receipts and full results, supporting collaboration evidence and interrupted-run recovery.

The approved Bauhaus UI is implemented in DesignerWorkspace and designer-bauhaus.css. The design-system dialog retains its layout and derives longer cached descriptions from the verified DESIGN.md resources.

## Checks

```powershell
node scripts/verify-design-systems.mjs
pnpm run typecheck
# Set this to a usable Python installation with python-pptx for both real-file checks.
$env:AELION_TEST_PYTHON = '<python executable>'
pnpm exec tsx --test tests/designer.test.ts
pnpm test
pnpm run build
pnpm exec electron-builder --win dir
node scripts/verify-designer-package.mjs '<path to app.asar>'
```

The package verifier extracts each catalog file from the actual app archive and compares its hash, including the license notices. A desktop build without `runtime/qemu` does not establish a self-contained VM first-start distribution; validate the complete VM runtime separately before release. Live provider/VM acceptance should cover a generated prototype, an editable PPTX, a group reply, and a delegated design task.

## Independent Bot types and collaboration

General requests use the existing general tools immediately: no classification call, routing tool or mandatory design handoff is added. BotRuntime selects the recipient's configured engine and preserves private/group origin metadata. General and designer Bots can exchange private messages and participate in the same groups through the established gateways and authorization checks. They never change type because of a message's topic.

A profile switch requires confirmContextReset and the expected old type; cancellation and ordinary profile edits preserve context. Queued messages and pending private/group work block reset. Shared conversation records are retained for participants, but automatic group context after reset starts at the reset timestamp with a separate compression scope. Explicit history-reading tools still allow access to the shared conversation. Old runs cannot resume across types. Future collaboration uses the new type selected by the user.

## Task progress and streaming

The designer task view uses the shared StreamingReply renderer and ReplyStreams transport. The first visible text replaces the waiting state immediately; streams are selected by Bot and active design run, with private/group routing preserved. A compact task progress surface shows the current stage, elapsed time, real tool activity and successful recent operations. Waiting and retry explanations reuse the general Bot progress helpers. It shows no invented percentage or hidden reasoning.

Designer system instructions are stable across task revisions. The pinned design-system reference is cached once per run and supplied as prefixContext; changing task state travels through ContextView tail controls. Completed inference records feed the same usage-based context calibration as general runs, and prepared context statistics are passed to ModelClient to avoid duplicate estimation. Existing request timing and provider-reported cache usage remain authoritative; no synthetic cache-hit rate is shown.

Validation: 56 focused tests passed across designer execution, context-prefix stability, context views, TTFT instrumentation and model retry. Browser fixture checks covered first-text visibility, cross-task stream isolation, tool progress, retry display and the final reply transition. These checks do not constitute a live-provider latency or cache-hit benchmark.

## First-draft delivery policy

Default design work ends after a usable first draft and basic file/format checks. HTML publish also rejects remote font stylesheets and filler copy, and records token/selector warnings without blocking delivery. After the user saves preview edits, whole-file HTML/CSS overwrites are rejected in favor of patches. Exhaustive click-through flows, repeated screenshot reviews and extra product modules require an explicit user request. Design-system materials define visual references, not additional feature scope or mandatory acceptance steps. The user reviews the first draft and drives revisions.

Designer requests archive old screenshots in batches once more than eight are present, retaining four recent observations in subsequent requests while preserving original records. After a partial-response timeout, the next designer retry explicitly requests smaller complete file writes and preserves already completed operations; incomplete tool calls are never executed. Usage records notify the UI after persistence, and missing provider token counts are distinguished from zero consumption.
