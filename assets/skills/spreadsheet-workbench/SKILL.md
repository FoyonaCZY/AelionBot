---
name: spreadsheet-workbench
description: "Create, clean, analyze, or edit XLSX/CSV/ODS files using Calc and openpyxl; preserve formulas and verify recalculated values."
metadata:
  aelion-id: aelion-spreadsheet-workbench
  aelion-display-name: 表格与数据整理
---

# Spreadsheet workbench

## Understand the workbook

Inspect sheet names, used ranges, headers, formulas, units, number formats, and whether identifiers contain leading zeros. Separate raw inputs, calculations, and presentation when the task benefits from it. Preserve formulas, charts, named ranges, and formatting in an existing workbook; use Calc for features openpyxl cannot round-trip reliably, especially macros and complex embedded objects.

## Create and modify

The work computer includes Calc and openpyxl. `scripts/csv_to_xlsx.py input.csv output.xlsx` creates a styled, filterable workbook with a frozen header from UTF-8 CSV. It intentionally imports cells as literal text, so identifiers and formula-like untrusted strings are not executed. Convert selected numeric/date columns deliberately after inspecting their semantics. It refuses to overwrite the output.

For calculations, use real formulas and formats rather than hardcoded displayed totals. Label units, dates, assumptions, and percentage denominators. Keep original data intact unless modification was requested. Resolve duplicate headers, missing values, encodings, separators, and timezones explicitly; never silently treat missing values as zero.

## Recalculate and validate

openpyxl writes formulas but does not calculate them. Open the result in Calc and save it, or materialize `aelion-pdf-workbench` and use `scripts/office_export.py input.xlsx --format xlsx --out-dir output/recalculated`. Use a separate directory. Read the saved workbook with `data_only=True` and check representative formula results, totals, and errors. Cross-check important aggregates independently against the raw data.

Inspect the workbook in Calc for clipped headers, unreadable columns, number formats, filter/freeze behavior, and print range if printing is requested. Test both a normal case and edge cases relevant to the data, such as empty groups or zero denominators. Deliver XLSX/ODS when formulas or formatting matter; CSV cannot preserve them.

## Aelion workspace and delivery

- Read incoming files with `attachment_read`; use `attachment_save` for binary files and use its returned path.
- `computer_execute`, `file_read`, `file_write`, and `file_patch` operate in the Linux work computer, under the current Bot's workspace. `host_*` tools operate on the user's selected local project; these are different filesystems. Never assume a host path exists in the VM.
- Read supporting files with `skill_file_read`. Before running a bundled script in the VM, call `skill_materialize` for this skill and use its returned `vmPath`; quote that path in shell commands. Keep generated files in the Bot workspace, outside the materialized skill directory.
- Use `computer` with `action: open_app` and `app: writer`, `calc`, `impress`, or `browser` as appropriate. For a document, pass its workspace-relative `path`. Inspect screenshots before coordinate actions and use the latest returned `observationId`.
- Final files belong in `message_attach` using `attachments: [{path: "output/actual-file.ext"}]`. This also works for a final group or private-chat reply. When explicitly sending a separate collaboration message, `bot_send_message` and `group_send_message` accept the same attachment entries. Attach only useful deliverables, not every intermediate preview.
- Discover an omitted tool with `tool_search`; use only tools actually available. A missing optional library does not justify changing VM networking or using another Bot's files. Prefer existing applications and libraries; report an actual missing dependency if no suitable route exists.
