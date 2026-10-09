---
name: web-ui-design
description: "Design and build websites, app interfaces, prototypes and visual documents: local design tasks with a live canvas, design systems and project fonts, or edits to an existing app."
metadata:
  aelion-id: aelion-web-ui-design
  aelion-display-name: 网页与界面设计
---

# Web and UI design

## Choose the route first

- **A new visual deliverable** (prototype, landing page, mobile screen, website clone, multi-page visual document, new slide deck): call `design_start` when it is available. The task lives in a local folder and appears on the canvas card next to the chat. Choose its design system yourself: pass `systemId` when a bundled or imported system fits the brief or the brand the user named, leave it out for free-form work, and ask the user first when the choice would change the result and the brief does not settle it. Continue an earlier design of this conversation with `design_tasks`/`design_use` instead of starting a new one.
- **A change to an existing app or site**: edit the selected host project in place with its own framework and components. Do not start a design task for it. Implementing a delivered design in a real project is this route too.
- **A question or critique**: answer it; no task, no files.

Inside a bound design task the task-state block, the pinned design system and the kind's workflow are already in context. Fonts are yours to choose: pick families that fit the brief, the brand and the design system unless the user names specific ones, and get them with `design_fonts` (list, search, acquire, check) and `design_font_apply`. `list` also shows the user's font library; prefer a library family when it fits or was imported for this brand, since `acquire` copies it offline. Read extra design-system files with `design_resource` only when needed.

## How much checking

A first draft of a design task needs no click-through: HTML shows on the canvas as soon as it is written, and each write returns static design-check findings. Fix P0 findings; P1/P2 are suggestions. Call `design_publish` when the user should receive the files; its findings are warnings. Run interaction checks and screenshot reviews when the user asks for them, or when the deliverable is a working app rather than a visual draft. For an existing app change, the checks below always apply.

## Design for the actual product

Read the existing design system and real content first. Identify the audience and the primary action. Follow explicit user references and established components. For new work, choose a deliberate palette, type scale, spacing system, and layout suited to the subject. Use one memorable design idea with a readable supporting structure; decorative cards, gradients, labels, or animation should serve a purpose.

Typography, alignment, and content hierarchy do most of the work. Keep body lines readable, provide useful contrast and focus states, respect reduced motion, and make layouts work at narrow and wide widths. Use real user-facing words: an action's label should explain what happens. Design loading, empty, validation, and failure states as well as the ideal screen.

## Implement in the right place

For an existing app, edit the selected host project using its current framework and components. For a standalone artifact without design tools, create self-contained HTML/CSS/JS in the Bot workspace. Use available local assets and fonts; avoid adding a network dependency solely for a visual flourish. Do not invent backend success or silently wire a button to a placeholder action.

For a preview server, use the available process tools and bind only the necessary interface. The VM browser's localhost is not the host project's localhost. Show the Bot's own VM page with `open_preview`, or open that same page in the work-computer browser. Never claim to have tested a host site by opening an unrelated VM address. There is no separate host-browser tool.

## Inspect and iterate

For an app change, open the actual page in the browser. Observe it before clicking; use current screenshots and observation IDs with `computer`, or an available browser MCP for DOM-based interactions. Check the primary workflow, keyboard navigation, modal focus, disabled states, errors, and a narrow viewport. Inspect layout for overflow, spacing, hierarchy, and unintended font substitution. Correct defects and rerun the affected flow.

For a local HTML deliverable, keep assets portable, attach the needed files, and explain how to open it. For an existing app change, report the actual files and observed behavior. Describe untested integration points accurately instead of treating a screenshot as proof of backend correctness.

## Aelion workspace and delivery

- Read incoming files with `attachment_read`; use `attachment_save` for binary files and use its returned path.
- `computer_execute`, `python_execute`, `file_read`, `file_write`, and `file_patch` operate in the Linux work computer, under the current Bot's workspace. `host_*` tools operate on the user's selected local project; these are different filesystems. Never assume a host path exists in the VM. `view_image` reads host paths only: to look at a PNG or PDF rendered in the VM, open it in the work-computer browser with `computer` and inspect the screenshot. `open_preview` shows a file to the user; it is not a check you performed.
- Read supporting files with `skill_file_read`. Before running a bundled script in the VM, call `skill_materialize` for this skill and use its returned `vmPath`; quote that path in shell commands. Keep generated files in the Bot workspace, outside the materialized skill directory.
- Open Writer, Calc, Impress, or the work-computer browser with `computer` (`action: open_app`) only when this task needs that application. For an existing document, pass its workspace-relative `path`. Inspect screenshots before coordinate actions and use the latest returned `observationId`. Do not open a desktop app in place of search, `web_read`, file tools, or an edit in the selected host project.
- Final files belong in `message_attach` using `attachments: [{path: "output/actual-file.ext"}]`. This also works for a final group or private-chat reply. When explicitly sending a separate collaboration message, `bot_send_message` and `group_send_message` accept the same attachment entries. Attach only useful deliverables, not every intermediate preview.
- Discover an omitted tool with `tool_search`; use only tools actually available. A missing optional library does not justify changing VM networking or using another Bot's files. Prefer existing applications and libraries; report an actual missing dependency if no suitable route exists.
