---
name: code-development
description: "Understand repositories, implement features, diagnose failures, and validate changes in the selected local project."
metadata:
  aelion-id: aelion-code-development
  aelion-display-name: 代码开发与问题排查
---

# Code development and debugging

## Establish the project boundary

Use the current main conversation's selected host working directory for repository work. Read project instructions, version-control status, relevant entry points, and build/test commands. Preserve existing uncommitted work. The Linux work computer is a separate environment: do not assume it contains the host repository or has the same shell.

Start with targeted filename and text search, then read relevant code. Use `host_file_read`, `host_file_patch`, `apply_patch`, and host execution tools as actually exposed. Discover omitted tools with `tool_search`. Batch independent reads; keep dependent edits and commands ordered. For long-running commands use the available process or terminal tools and their returned identifiers.

## Diagnose from evidence

Read the actual error, reproduce the concrete trigger where possible, and inspect recent changes. Trace input, output, and state across the boundary where behavior first becomes incorrect. Compare with a working path. Form one testable hypothesis, perform the smallest useful experiment, and change the cause supported by evidence. If evidence is incomplete, identify the uncertainty rather than presenting a guess as a proven cause.

For a feature, implement the whole requested behavior with the existing architecture and conventions. For a bug, add a meaningful regression check when it can catch recurrence; avoid tests that merely restate the implementation. Do not turn a small reversible edit into an unnecessary testing project.

## Verify and hand off

Run the checks appropriate to the change and honor the user's testing constraints. Review the diff for accidental files, unrelated changes, and secrets. For UI behavior use the actual browser/work computer and inspect the interaction; a successful build does not prove the UI works. State what changed, how it was verified, and any remaining limitation.

When a tool operation is denied, use the returned reason and continue independent permitted work; do not retry through another shell or tool to bypass it. Make commits, publish, or send collaboration messages only within the user's requested scope. Attach requested artifacts through `message_attach`; source code already edited in the selected project does not need a duplicate ZIP by default.

## Aelion workspace and delivery

- Read incoming files with `attachment_read`; use `attachment_save` for binary files and use its returned path.
- `computer_execute`, `file_read`, `file_write`, and `file_patch` operate in the Linux work computer, under the current Bot's workspace. `host_*` tools operate on the user's selected local project; these are different filesystems. Never assume a host path exists in the VM.
- Read supporting files with `skill_file_read`. Before running a bundled script in the VM, call `skill_materialize` for this skill and use its returned `vmPath`; quote that path in shell commands. Keep generated files in the Bot workspace, outside the materialized skill directory.
- Use `computer` with `action: open_app` and `app: writer`, `calc`, `impress`, or `browser` as appropriate. For a document, pass its workspace-relative `path`. Inspect screenshots before coordinate actions and use the latest returned `observationId`.
- Final files belong in `message_attach` using `attachments: [{path: "output/actual-file.ext"}]`. This also works for a final group or private-chat reply. When explicitly sending a separate collaboration message, `bot_send_message` and `group_send_message` accept the same attachment entries. Attach only useful deliverables, not every intermediate preview.
- Discover an omitted tool with `tool_search`; use only tools actually available. A missing optional library does not justify changing VM networking or using another Bot's files. Prefer existing applications and libraries; report an actual missing dependency if no suitable route exists.
