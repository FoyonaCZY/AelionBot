---
name: web-ui-design
description: "Build and refine usable websites and app interfaces, with deliberate visual design and real browser interaction checks."
metadata:
  aelion-id: aelion-web-ui-design
  aelion-display-name: 网页与界面设计
---

# Web and UI design

## Design for the actual product

Read the existing design system and real content first. Identify the audience and the primary action. Follow explicit user references and established components. For new work, choose a deliberate palette, type scale, spacing system, and layout suited to the subject. Use one memorable design idea with a readable supporting structure; decorative cards, gradients, labels, or animation should serve a purpose.

Typography, alignment, and content hierarchy do most of the work. Keep body lines readable, provide useful contrast and focus states, respect reduced motion, and make layouts work at narrow and wide widths. Use real user-facing words: an action's label should explain what happens. Design loading, empty, validation, and failure states as well as the ideal screen.

## Implement in the right place

For an existing app, edit the selected host project using its current framework and components. For a standalone artifact, create self-contained HTML/CSS/JS in the Bot workspace. Use available local assets and fonts; avoid adding a network dependency solely for a visual flourish. Do not invent backend success or silently wire a button to a placeholder action.

For a preview server, use the available process tools and bind only the necessary interface. The VM browser's localhost is not the host project's localhost. Use a reachable preview URL provided by the environment, an available host browser tool, or an explicitly copied VM project; never claim to have tested a host site by opening an unrelated VM address.

## Inspect and iterate

Open the actual page in the browser. Observe it before clicking; use current screenshots and observation IDs with `computer`, or an available browser MCP for DOM-based interactions. Check the primary workflow, keyboard navigation, modal focus, disabled states, errors, and a narrow viewport. Inspect layout for overflow, spacing, hierarchy, and unintended font substitution. Correct defects and rerun the affected flow.

For a local HTML deliverable, keep assets portable, attach the needed files, and explain how to open it. For an existing app change, report the actual files and observed behavior. Describe untested integration points accurately instead of treating a screenshot as proof of backend correctness.

## Aelion workspace and delivery

- Read incoming files with `attachment_read`; use `attachment_save` for binary files and use its returned path.
- `computer_execute`, `file_read`, `file_write`, and `file_patch` operate in the Linux work computer, under the current Bot's workspace. `host_*` tools operate on the user's selected local project; these are different filesystems. Never assume a host path exists in the VM.
- Read supporting files with `skill_file_read`. Before running a bundled script in the VM, call `skill_materialize` for this skill and use its returned `vmPath`; quote that path in shell commands. Keep generated files in the Bot workspace, outside the materialized skill directory.
- Use `computer` with `action: open_app` and `app: writer`, `calc`, `impress`, or `browser` as appropriate. For a document, pass its workspace-relative `path`. Inspect screenshots before coordinate actions and use the latest returned `observationId`.
- Final files belong in `message_attach` using `attachments: [{path: "output/actual-file.ext"}]`. This also works for a final group or private-chat reply. When explicitly sending a separate collaboration message, `bot_send_message` and `group_send_message` accept the same attachment entries. Attach only useful deliverables, not every intermediate preview.
- Discover an omitted tool with `tool_search`; use only tools actually available. A missing optional library does not justify changing VM networking or using another Bot's files. Prefer existing applications and libraries; report an actual missing dependency if no suitable route exists.
