---
name: data-analysis
description: "Analyze CSV/JSON/tabular data, validate definitions and calculations, and create readable charts or reproducible reports."
metadata:
  aelion-id: aelion-data-analysis
  aelion-display-name: 数据分析与可视化
---

# Data analysis and visualization

## Establish what the numbers mean

Inspect schema, row grain, identifier columns, date coverage, timezone, units, nulls, duplicates, and join coverage. State the metric, cohort, denominator, and time window before calculating ratios. Distinguish a missing measurement from zero; deduplicate or exclude rows only for an explicit reason. Keep raw inputs unchanged.

`scripts/profile_csv.py input.csv --output output/profile.json` gives row counts, null counts, and finite-numeric statistics without third-party dependencies. It is an exploratory check, not a substitute for domain definitions: postal codes, IDs, and dates may be numeric-looking. For larger analyses use available pandas/NumPy or SQL; check availability before relying on them.

## Compute and challenge the result

Use reproducible code for aggregates and joins. Compare key totals against an independent calculation or source total. Check segment-level behavior, incomplete periods, outliers, zero denominators, and whether sampling changes the conclusion. Correlation does not establish causation. Label synthetic or estimated data clearly, and do not replace missing real data with invented observations.

## Choose the visual relationship

- Time trend: line chart, ordered dates, explicit gaps.
- Category comparison: bars with a meaningful order and usually a zero baseline.
- Distribution: histogram or box plot; expose sample size and binning choices.
- Association: scatter plot with units and an appropriate observation grain.
- Part-to-whole: stacked bars with an explicit denominator; avoid a crowded pie.

Use Calc charts, available Matplotlib, or self-contained HTML/SVG as appropriate. Prefer static PNG/PDF/SVG for export; a browser-based chart is useful when interaction helps the user explore. Do not depend on a CDN for an offline deliverable. Label units, dates, scales, and uncertainty; avoid misleading axes, hidden filters, and color-only distinctions.

Inspect the actual output in the browser or Calc and verify labels, legends, contrast, clipping, and values. Deliver the useful chart/report plus reproducible data or script when requested. Keep methodology and caveats close to the findings they qualify. Use document-writing for a requested report rather than delivering only a chart.

## Aelion workspace and delivery

- Read incoming files with `attachment_read`; use `attachment_save` for binary files and use its returned path.
- `computer_execute`, `file_read`, `file_write`, and `file_patch` operate in the Linux work computer, under the current Bot's workspace. `host_*` tools operate on the user's selected local project; these are different filesystems. Never assume a host path exists in the VM.
- Read supporting files with `skill_file_read`. Before running a bundled script in the VM, call `skill_materialize` for this skill and use its returned `vmPath`; quote that path in shell commands. Keep generated files in the Bot workspace, outside the materialized skill directory.
- Use `computer` with `action: open_app` and `app: writer`, `calc`, `impress`, or `browser` as appropriate. For a document, pass its workspace-relative `path`. Inspect screenshots before coordinate actions and use the latest returned `observationId`.
- Final files belong in `message_attach` using `attachments: [{path: "output/actual-file.ext"}]`. This also works for a final group or private-chat reply. When explicitly sending a separate collaboration message, `bot_send_message` and `group_send_message` accept the same attachment entries. Attach only useful deliverables, not every intermediate preview.
- Discover an omitted tool with `tool_search`; use only tools actually available. A missing optional library does not justify changing VM networking or using another Bot's files. Prefer existing applications and libraries; report an actual missing dependency if no suitable route exists.
