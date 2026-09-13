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
- HTML and PDF use the browser surface; HTML retains its source/editing controls. PPT slide previews retain their slide viewer. VM HTML can read supported web assets beneath the HTML file's directory. Host HTML attachments remain a single-file copy; use a local dev server for multi-file host projects.
- The existing pinned SSH host key authenticates the VM connection. Before forwarding, the VM checks that the listening process belongs to the current Bot's work directory. The local listener binds only to `127.0.0.1` on an ephemeral port.
- Same-origin HTTP and WebSocket traffic pass through the tunnel, including ordinary dev-server hot updates. Configure API and HMR endpoints through the frontend's same-origin proxy; separate backend ports, hard-coded WebSocket addresses, and HTTPS VM services are not automatically remapped.
- Closing or replacing a preview, reloading the app, or stopping the VM releases its forwarding connections. It does not stop the project server. Preview sessions are ephemeral and cleared between previews; one browser session is reused to avoid accumulating partitions.
- Full-screen and side-panel feedback capture the visible browser content and includes its current URL as model context. Common credential query parameters are redacted. The message bubble still shows only the user's prompt and screenshot attachment.

The native browser rectangle leaves room for the white navigation controls and feedback input. It is hidden behind settings and unsaved-change dialogs. Non-Electron preview fixtures retain the existing static file renderers.

## Verification

```sh
npm run typecheck
npx tsx --test tests/web-preview.test.ts tests/agent-previews.test.ts tests/preview-feedback.test.ts tests/file-preview.test.ts tests/preview-editing.test.ts
node scripts/verify-web-preview.mjs
npm run build
```

Set `AELION_TEST_PYTHON` to a Python executable to include VM file-editing fixture checks. The Electron check uses an isolated hidden window and local fixture server, not the user's VM. Native screenshots may be unavailable in a hidden compositor; that check reports a skip explicitly. Verify actual screenshot feedback and the complete VM project flow in a visible desktop window before release.
