# Design work

Every Bot can take on design work. There is no separate designer Bot type: a Bot asked for a prototype, deck, website clone, mobile screen or multi-page visual document starts a local design task in the same conversation, keeps its context, and returns to ordinary work when the task is done.

## Engine

`BotRuntime` runs every Bot on the general `Harness`. `DesignWork` (`electron/core/designer/design-work.ts`) hooks into it:

- An unbound run is offered only the entry tools `design_tasks`, `design_start` and `design_use`, beside the ordinary tools. A run with no conversation origin a design task can belong to (for example an unverified peer request) is offered none.
- `design_start`/`design_use` bind the run to a task. A message sent while the canvas shows a task carries its `designSessionId`, and a run continued from one bound to a task stays bound. A task is only found in its own conversation: the Bot's private chat, a group, or a peer thread.
- Once bound, the run gets the remaining `design_*` tools, a stable prompt prefix (design-mode rules, the kind's playbook, craft guidance and the pinned design-system reference, read once per run) and the task state in the task frame, which survives context compression.
- Host writes into the task folder go through the ordinary permission-checked host tools. After each write `DesignWork` records the change, lints HTML and shows the page on the canvas; findings reach the model at the start of its next turn.
- When the run ends the binding is released. A written but unpublished draft still shows on the task's delivery card.

Design tools run exclusively (never in parallel with another tool) and store ordinary execution receipts.

## Checks

The first draft needs no click-through and no extra polish round. `design_publish` is called when files should reach the user; it is not a required last step.

What publish still refuses: a file outside the task, an empty or missing file, HTML without page content, a PPTX without editable text and real slides, a delivery without the kind's primary format, and any task process still running. Lint findings (P0 and P1), brand-token drift and a clone without a source URL in `NOTES.md` are returned as warnings. After the user saves an edit in the preview, whole-file HTML/CSS overwrites are refused in favour of patches.

A refused publish is an ordinary failed tool call: the run cannot claim completion until a later publish succeeds or the failure is resolved.

## Canvas

While the conversation has an active design task, a canvas card floats under the computer and scheduled-task card at the top right; the two cards share the height of the message list, and each can be closed on its own. The canvas card shows a thumbnail of the task's home page, its title and one status line, with Confirm delivery while it waits for review. It names no files: a design is one piece of work, the preview opens on the home page and reaches other pages from inside it, and files are exported from the preview. The thumbnail is the page's first screen, rendered by the main process in a hidden sandboxed window that reads only the task folder and makes no network requests; it is cached per file revision and re-rendered when the page changes (`electron/core/designer/design-thumbnails.ts`). Clicking it shows the page in the docked preview at half the window, which can be widened further. Closing the task ends the association; later messages are ordinary chat. A run that binds a task brings the canvas card back.

## Settings

Settings → Design has two tabs. Design systems is a gallery of every system drawn in its own colors, type and corners, with search, category chips and `DESIGN.md` folder import. Fonts is the font library: download Fontsource families, import local font files, preview and delete them. The Bot decides which design system to use, if any, and which fonts, from the task content and what the user asks for in the chat, and asks when the choice is unclear. `design_fonts list` shows the font library, and `acquire` copies a library family into the task offline.

The two built-in skills `web-ui-design` and `presentation-design` route visual work to design tasks and edits of existing projects to the project itself, and say how much checking each needs.

## Files and design systems

Tasks live in `<default workspace>/designers/<botId>/<taskId>` on this computer and need no work computer. All 152 reviewed packages from `nexu-io/open-design` revision `d465086b2c9264c47c5d3e1cfeb8cfb2864a41d4` are bundled in `assets/design-systems/` with per-file SHA-256, source and license. Only the selected package is materialized into a task, under `.design-system/<revision>/<systemId>`, and the selected version is cached so an app update does not change existing tasks. Brand-inspired references are not official endorsements.

Legacy VM task records are kept but cannot resume against a host directory.

## Upgrading from designer Bots

A Bot saved with `type: 'designer'` keeps the field on disk, so an older version still finds its designer; the current version ignores it. Its chat, memories and design tasks remain. The separate designer model histories (`designer:*`) are kept but no longer read, and a run of the retired designer engine cannot be resumed; start a new message to continue the task. Only structured delegations (`peer_task`) accept delegation receipts.

## Checks to run

```powershell
node scripts/verify-design-systems.mjs
pnpm run typecheck
pnpm exec tsx --test tests/design-work.test.ts tests/retired-designer.test.ts tests/designer*.test.ts
pnpm test
pnpm run build
pnpm exec electron-builder --win dir
node scripts/verify-designer-package.mjs '<path to app.asar>'
```

`tests/design-harness.ts` wires a real `Harness`, `HostComputer` and `DesignWork` with a scripted model and a stopped work computer; the design workflow tests use it. The package verifier extracts each catalog file from the app archive and compares its hash and license notices.
