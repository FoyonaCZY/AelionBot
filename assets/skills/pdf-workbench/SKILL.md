---
name: pdf-workbench
description: "Create, inspect, merge, split, or export PDF files; verify rendered pages and deliver the actual document."
metadata:
  aelion-id: aelion-pdf-workbench
  aelion-display-name: PDF 制作与处理
---

# PDF workbench

Use the requested document format and page size. For an existing PDF, inspect page count, text, and layout before editing; preserve the original.

## Choose the shortest reliable route

- For a new report, use the document-writing skill and export from Writer. For a deck, use presentation-design and export from Impress. For an existing office file, use `scripts/office_export.py` here.
- The work computer includes LibreOffice, Poppler, and pypdf. Check their actual availability on older installations. Use pypdf for merging, page selection, metadata, and forms; it does not render pages or reliably extract scanned text.
- For layouts best expressed as HTML/CSS, create self-contained HTML and print with the available browser, or import it into Writer. Browser and Writer pagination differ: inspect the result from the chosen route.
- Use ReportLab only if available or deliberately installed for this task; it is not a guaranteed bundled dependency. Embed fonts with coverage for the document's characters.

## Export and check

After materializing this skill:

```sh
python3 "$SKILL_DIR/scripts/office_export.py" output/report.odt --format pdf --out-dir output/pdf
pdftoppm -png -r 100 output/pdf/report.pdf output/preview
pdftotext -layout output/pdf/report.pdf output/extracted.txt
```

`SKILL_DIR` means the actual `vmPath` returned by `skill_materialize`, not a preconfigured environment variable. The export helper uses a separate temporary LibreOffice profile, refuses to overwrite an existing result, checks the result exists, and does not close the user's office windows. Pick a new output directory for revisions.

Inspect rendered pages for clipped text, broken glyphs, blank or duplicate pages, page breaks, table overflow, and inconsistent headers. Text extraction checks content, not appearance. Open the PDF in the work computer browser or use available image inspection tools on rendered previews. For a long document, inspect a contact sheet plus detailed pages around tables and section breaks; state any uninspected portion if it affects confidence.

Deliver the requested PDF and, when useful, its editable source. Report page count and meaningful verification, not implementation logs.

## Aelion workspace and delivery

- Read incoming files with `attachment_read`; use `attachment_save` for binary files and use its returned path.
- `computer_execute`, `file_read`, `file_write`, and `file_patch` operate in the Linux work computer, under the current Bot's workspace. `host_*` tools operate on the user's selected local project; these are different filesystems. Never assume a host path exists in the VM.
- Read supporting files with `skill_file_read`. Before running a bundled script in the VM, call `skill_materialize` for this skill and use its returned `vmPath`; quote that path in shell commands. Keep generated files in the Bot workspace, outside the materialized skill directory.
- Use `computer` with `action: open_app` and `app: writer`, `calc`, `impress`, or `browser` as appropriate. For a document, pass its workspace-relative `path`. Inspect screenshots before coordinate actions and use the latest returned `observationId`.
- Final files belong in `message_attach` using `attachments: [{path: "output/actual-file.ext"}]`. This also works for a final group or private-chat reply. When explicitly sending a separate collaboration message, `bot_send_message` and `group_send_message` accept the same attachment entries. Attach only useful deliverables, not every intermediate preview.
- Discover an omitted tool with `tool_search`; use only tools actually available. A missing optional library does not justify changing VM networking or using another Bot's files. Prefer existing applications and libraries; report an actual missing dependency if no suitable route exists.
