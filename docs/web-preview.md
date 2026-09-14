# Web previews

`open_preview` can show a running website in the same side or full-screen preview used for files.

```json
{
  "url": "http://localhost:5173/",
  "location": "vm",
  "placement": "full",
  "reason": "Review the running frontend"
}
```

Start the server from the Bot's own `/work/<botId>` project directory and keep its process running. VM preview accepts HTTP loopback ports 1024–65535. A localhost URL requires an explicit `location`: `vm` means the work computer, and `host` means the user's computer. Public HTTP/HTTPS URLs can omit `location`.

Only one of `url`, `path`, or `attachmentId` may be supplied. Existing file calls remain compatible. `queued` confirms a presentation request, not that the user has viewed or approved the result.

## Browser and forwarding

- A sandboxed Electron `WebContentsView` provides navigation, JavaScript, forms, and a PDF viewer. It has no Node access or app preload bridge. Website permissions and downloads are denied.
- HTML uses the browser surface and retains source editing. PDF and PPT use the page-aware viewer so annotations remain attached to the correct page. VM HTML can read supported web assets beneath the HTML file's directory. Host HTML attachments remain a single-file copy; use a local dev server for multi-file host projects.
- The existing pinned SSH host key authenticates the VM connection. Before forwarding, the VM checks that the listening process belongs to the current Bot's work directory. The local listener binds only to `127.0.0.1` on an ephemeral port.
- Same-origin HTTP and WebSocket traffic pass through the tunnel, including ordinary dev-server hot updates. Configure API and HMR endpoints through the frontend's same-origin proxy; separate backend ports, hard-coded WebSocket addresses, and HTTPS VM services are not automatically remapped.
- Closing or replacing a preview, reloading the app, or stopping the VM releases its forwarding connections. It does not stop the project server. Preview sessions are ephemeral and cleared between previews; one browser session is reused to avoid accumulating partitions.
- Docked previews share the conversation composer; a context checkbox controls screenshot attachment. Full-screen previews keep a floating text composer. Feedback captures the visible content and includes its current URL as model context. Common credential query parameters are redacted. The message bubble still shows only the user's prompt and screenshot attachment.

The workbench folds Bot switching into the conversation header and gives the remaining width to the preview. Its divider is resizable; per-conversation previews and annotations are kept independently.

The native browser rectangle leaves room for navigation and extends to the bottom edge. In full-screen mode, feedback is a transparent, trusted sibling view floating over the page; its bridge only relays text input to the main app, and browser screenshots exclude this overlay. It is hidden behind settings and unsaved-change dialogs. Non-Electron preview fixtures retain the existing static file renderers.

## Verification

```sh
npm run typecheck
npx tsx --test tests/web-preview.test.ts tests/agent-previews.test.ts tests/preview-feedback.test.ts tests/file-preview.test.ts tests/preview-editing.test.ts
node scripts/verify-web-preview.mjs
npm run build
```

Set `AELION_TEST_PYTHON` to a Python executable to include VM file-editing fixture checks. The Electron check uses an isolated hidden window and local fixture server, not the user's VM. Native screenshots may be unavailable in a hidden compositor; that check reports a skip explicitly. Verify actual screenshot feedback and the complete VM project flow in a visible desktop window before release.

## Selection, annotation and editing

- Rectangle, arrow, pen, text and element annotations are included in screenshot feedback. File annotations are tied to their file/page; webpage annotations follow document scrolling. The composer keeps user attachments, replies and Bot mentions.
- The webpage preload exposes no API to the page. Only the app's main frame can issue editing commands. Selection events and responses are accepted only from the current preview's main frame. User clicks are checked as trusted DOM events.
- The inspector supports arbitrary elements in the main document and open shadow roots, parent selection, a lazy structure tree, CSS declarations, HTML attributes, text and raw HTML. Cross-origin frame internals and closed shadow roots are not exposed; their host elements can still be selected or annotated.
- Raw HTML can be previewed, reverted, applied and undone. Edits are temporary until saved or sent. Unsaved changes guard file switching, navigation and closing; saves lock editing while the write is in flight.
- Static workspace HTML writes back only verified source subtrees. The source parser verifies the original markup and structural path, and the existing revision check prevents concurrent file overwrites. Unrelated source bytes remain unchanged. HTML attachments are immutable and export an edited copy.
- Running applications and remote sites can be edited in the preview. **Send changes** attaches a JSON change manifest and the current screenshot to the originating conversation so the Bot can update the actual project source. It does not claim to rewrite React/Vue components from a runtime DOM snapshot. Navigation to another page also disables writing back to the original HTML file.
- Limits: one million characters per edited DOM subtree, 64 changes / eight million characters per editing session, and 100 annotations with bounded point counts. Larger elements remain inspectable and can be edited through the source editor.

Additional checks: `npx tsx --test tests/preview-editor.test.ts tests/preview-feedback.test.ts` and `node scripts/verify-web-preview.mjs`. The latter exercises the isolated native DOM editor, HTML preview/revert, undo/redo, navigation protection and export of source edits.

### 字体与画布操作

元素编辑面板支持字体预设、自定义字体栈、字号、字重、行高和字间距。字体来自当前网页加载的字体或运行预览的电脑；纯数字的字号和尺寸按 px 应用。

选中元素后，可拖动元素本身或蓝色标签移动，拖动八个边角手柄调整尺寸。移动采用 CSS 位移并保留原文档流位置；按住 Shift 拖角等比缩放，Esc 取消当前手势。一次完整手势对应一次撤销操作，修改会进入同一套静态 HTML 保存或动态网页修改清单流程。
