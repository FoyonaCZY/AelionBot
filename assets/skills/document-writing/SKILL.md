---
name: document-writing
description: "Create or revise editable Word/ODT documents and reports with Writer, evidence-backed structure, and checked PDF exports."
metadata:
  aelion-id: aelion-document-writing
  aelion-display-name: 文档与报告
---

# Document writing

## Shape the document

Identify the reader, purpose, requested format, and available evidence. Lead with the answer or recommendation, then support each finding with a source, calculation, or clearly labeled assumption. For numerical claims record units, denominator, period, and comparison baseline. Match depth to the request; a short memo does not need a research-report ceremony.

## Build an editable source

- For an existing DOCX/ODT, open it in Writer first. Preserve headings, numbering, tables, comments, tracked changes, and images that matter to the request. Edit a copy. Converting an existing complex file through HTML can discard these features.
- For a new simple report, copy `assets/report.html` into the Bot workspace and replace all sample text. It uses print styles, headings, a compact evidence table, and source notes. Open in Writer, adjust page style, and save as ODT or DOCX. It is a starting layout, not a requirement for every document.
- Prefer native Writer styles for headings, lists, tables, headers, page numbers, and section breaks. Keep tables within text width and avoid manually aligning text with spaces.
- For complex automation use python-docx only after checking availability. The baseline VM does not promise it. Writer is already available, so ordinary document work should not depend on installing a new SDK.

## Export and verify

For command-line conversion, materialize `aelion-pdf-workbench` and run its `scripts/office_export.py` with `--format docx` or `--format pdf` and a new output directory. Open the editable document in Writer and inspect the PDF export for pagination, repeated table headers, widows, overflow, and font substitutions. Reopen the saved source and confirm content survived conversion.

Deliver the editable format requested by the user. A PDF is useful for a stable preview but does not replace an explicitly requested Word document. Preserve sources and uncertainty near the associated claims.

## Aelion workspace and delivery

- Read incoming files with `attachment_read`; use `attachment_save` for binary files and use its returned path.
- `computer_execute`, `file_read`, `file_write`, and `file_patch` operate in the Linux work computer, under the current Bot's workspace. `host_*` tools operate on the user's selected local project; these are different filesystems. Never assume a host path exists in the VM.
- Read supporting files with `skill_file_read`. Before running a bundled script in the VM, call `skill_materialize` for this skill and use its returned `vmPath`; quote that path in shell commands. Keep generated files in the Bot workspace, outside the materialized skill directory.
- Use `computer` with `action: open_app` and `app: writer`, `calc`, `impress`, or `browser` as appropriate. For a document, pass its workspace-relative `path`. Inspect screenshots before coordinate actions and use the latest returned `observationId`.
- Final files belong in `message_attach` using `attachments: [{path: "output/actual-file.ext"}]`. This also works for a final group or private-chat reply. When explicitly sending a separate collaboration message, `bot_send_message` and `group_send_message` accept the same attachment entries. Attach only useful deliverables, not every intermediate preview.
- Discover an omitted tool with `tool_search`; use only tools actually available. A missing optional library does not justify changing VM networking or using another Bot's files. Prefer existing applications and libraries; report an actual missing dependency if no suitable route exists.
