# Agent-initiated file previews

AelionBot exposes `open_preview` as a built-in system tool. It presents a file in the existing viewer; reading or validating the artifact remains a separate operation.

## Calls

VM file (paths are relative to the calling Bot workspace; its own /work/<botId>/ prefix is also accepted):

```json
{"path":"output/report.pdf","location":"vm","placement":"side","reason":"Show the completed report for review"}
```

Host file (relative paths use the run’s selected host workspace):

```json
{"path":"output/slides.pptx","location":"host","placement":"full","reason":"Show the presentation"}
```

An attachment the calling Bot already received:

```json
{"attachmentId":"<actual attachment ID>","reason":"Show the reference image"}
```

Provide exactly one of path and attachmentId. location is required for path and omitted for attachmentId. side is the default; on narrow windows the existing responsive viewer uses a modal. full requests the large canvas.

## Behavior

- The tool validates the file and returns queued: true with a requestId. This is a presentation request, not proof of a displayed, reviewed, or correct artifact.
- The renderer only consumes a request when the relevant Bot/group conversation is visible, the document has focus, and other application dialogs are closed. Background chats do not steal navigation.
- Only the latest pending request per conversation is kept. Consumption uses the existing unsaved-edit guard. Requests are acknowledged once offered; cancelling the guard dismisses that request.
- The queue is in memory, survives renderer reconnects until consumed, and is not replayed after an app restart.
- Workspace files use the existing file tree and editor. Host files are read with the current host permission policy and captured as immutable owned attachments; editing those previews saves a copy, not the host original.
- Attachment access is checked against Bot ownership or actual receipt. VM paths are confined to the calling Bot workspace. Host reads detect file replacement during approval/read and do not enqueue after cancellation.
- Supported formats follow the existing preview renderer: source/text, static HTML, images, PDF, and office documents. Host files and attachments are limited to 25 MB; VM text is limited to 2 MB and images/PDF to 15 MB. Office conversion still uses the managed computer.
- The tool does not start a web server, navigate a live URL, execute preview HTML, or replace message_attach. HTML keeps the existing sandbox/CSP.

## Reference

The design follows the separation exposed by Codex’s available open_in_codex tool: request presentation in an application panel separately from reading/interacting with the file, and queue presentation for a background conversation. This is a behavior reference, not a claim that AelionBot shares Codex internals.

Official documentation also describes generated files opening beside chat and switching HTML between preview/source: [Work with files](https://learn.chatgpt.com/docs/artifacts-viewer).

## Verification

- tests/agent-previews.test.ts: tool schema, actual Harness dispatch/receipt, scope routing, latest-request acknowledgement, access denial, cancellation, immutable host copies, and replacement during approval.
- Existing attachment and editable-text regression tests.
- Local interaction fixture: http://127.0.0.1:5191/.local/agent-preview/ (real preview provider and queue hook; synthetic files and requests).
