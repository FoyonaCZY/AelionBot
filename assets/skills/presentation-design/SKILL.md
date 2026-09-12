---
name: presentation-design
description: "Create or revise editable presentations with Impress and python-pptx; export and visually verify slides before delivery."
metadata:
  aelion-id: aelion-presentation-design
  aelion-display-name: 演示文稿设计
---

# Presentation design

## Story before slides

Identify the audience, decision, speaking time, and requested format. Build a sequence with one main takeaway per slide. Make slide titles communicate those takeaways. Pair numerical claims with a legible chart or table and a source; use diagrams for relationships. Put supporting detail in notes or appendices instead of shrinking the body text.

## Build with the work computer

- For an existing PPTX/ODP, open it with `computer` (`action: open_app`, `app: impress`, `path: ...`) and inspect its master, aspect ratio, fonts, and media. Preserve editable objects and speaker notes.
- For a new deck, use Impress directly or the installed python-pptx package. `scripts/create_deck.py assets/deck.json output/deck.pptx` is an editable 16:9 starting deck. First copy and tailor the JSON in the workspace; never deliver the sample text. It supports title/body slides, two columns, and local images, with explicit text-size bounds to avoid silent clipping.
- Replace the starter palette and layout when the subject or user's design requires it. Establish a type scale and alignment grid. Use fonts actually present in the VM; Noto Sans/CJK, Carlito, and Caladea are usual choices. Do not turn every slide into a screenshot.
- Use real assets from the user or verified sources. A remote image URL alone is not an embedded image. Do not claim to generate images if no image-generation tool is available.

## Verify in Impress

Open the saved PPTX in Impress, not just python-pptx. Check editable text, images, slide order, chart labels, contrast, and notes. Materialize `aelion-pdf-workbench` for its isolated-profile export helper, export the presentation to PDF, and render the slides with Poppler. Inspect all slides at overview scale and detailed slides for clipping and font changes. Correct problems in the editable source and re-export.

Deliver PPTX or ODP as requested, with a PDF preview when useful. State any material compatibility limitation such as unsupported animations; successful file creation alone is not proof that slides render correctly.

## Aelion workspace and delivery

- Read incoming files with `attachment_read`; use `attachment_save` for binary files and use its returned path.
- `computer_execute`, `file_read`, `file_write`, and `file_patch` operate in the Linux work computer, under the current Bot's workspace. `host_*` tools operate on the user's selected local project; these are different filesystems. Never assume a host path exists in the VM.
- Read supporting files with `skill_file_read`. Before running a bundled script in the VM, call `skill_materialize` for this skill and use its returned `vmPath`; quote that path in shell commands. Keep generated files in the Bot workspace, outside the materialized skill directory.
- Use `computer` with `action: open_app` and `app: writer`, `calc`, `impress`, or `browser` as appropriate. For a document, pass its workspace-relative `path`. Inspect screenshots before coordinate actions and use the latest returned `observationId`.
- Final files belong in `message_attach` using `attachments: [{path: "output/actual-file.ext"}]`. This also works for a final group or private-chat reply. When explicitly sending a separate collaboration message, `bot_send_message` and `group_send_message` accept the same attachment entries. Attach only useful deliverables, not every intermediate preview.
- Discover an omitted tool with `tool_search`; use only tools actually available. A missing optional library does not justify changing VM networking or using another Bot's files. Prefer existing applications and libraries; report an actual missing dependency if no suitable route exists.
