# File mentions and video understanding

## File references

Typing `@` in a main or group composer offers Bot matches and files in that conversation's selected host workspace (or the configured default workspace). File discovery reuses the existing bounded worker search and ignore/sensitive-path policy. Searches are debounced and stale results discarded. Keyboard arrows, Enter/Tab and Escape follow the existing mention picker behavior.

Selecting a file inserts its quoted absolute path, as a live reference. It does not upload, duplicate, hash or embed the original contents. A later workspace change does not redirect the reference. The model reads the referenced file with normal host tools and their existing permission policy. Moving, deleting or modifying the source affects future reads. Existing drag/drop and attachment uploads keep their original behavior; this change specifically adds path-based `@` selection.

## Video tool

`video_frames` accepts either a host `path` (absolute or relative to the run workspace) or a received `attachmentId`, plus a `reason`. Optional `count` is 1–24 (default 12). Use `startSeconds`/`endSeconds` for a range, or `timestamps` for explicit positions; these forms are mutually exclusive. Optional `frameWidth` is 160–1280 pixels; single-frame requests default to 960 pixels for detailed reading, other requests to 320. Total sheet pixels and dimensions are bounded; reduce the count for high-resolution frames.

The tool returns video dimensions, duration, sampled timestamps and a PNG contact sheet through the existing image-observation channel. The PNG is actually included in the next model request, not just returned as a filename. Direct calls and `code_exec` support this image flow. It is intentionally not in the generic `tools_batch` read enum, which does not flatten image observations.

Example arguments:

```json
{"path":"C:/project/demo.mp4","count":12,"reason":"Inspect the video's main visual content"}
```

```json
{"attachmentId":"<received attachment ID>","timestamps":[1.5,4.0,7.25],"reason":"Inspect the selected moments"}
```

Frames are sampled near the requested timestamps. They do not prove unseen events, exact scene boundaries, audio content, speech transcription, or that the entire video has been watched. The selected model must support image inputs. MP4 and WebM were tested with the bundled Electron runtime; other accepted container extensions depend on its installed codecs. Unsupported files produce an explicit decoding error.

## Runtime and storage

The original video is read locally through a sandboxed hidden Electron page, with no Node integration, no remote analysis service, and no copy of a path-referenced original. Host files use normal read permission checks; received attachments use existing ownership checks and integrity validation. Source changes during decoding invalidate the result.

One inspection runs at a time, with at most eight outstanding jobs. Requests can be cancelled while queued or decoding. Each window is destroyed on completion, cancellation or a 60-second deadline. Metadata and seeks also have bounded waits. References can inspect videos up to 4 GiB; uploaded attachments retain the existing 25 MiB limit.

Derived PNGs are under `screenshots/video-frames`, using a stable key based on Bot, source identity, file stamp and extraction options. Identical inspections reuse the image after rechecking access. The cache is capped at 128 images / 128 MiB; each output is at most 8 MiB. Files absent from the index still count toward limits. Images without conversation/run references can be reclaimed after a one-hour grace period; referenced images are preserved. At capacity, new generation stops rather than silently deleting referenced history. The original video is never a cleanup target.

## Validation

- `tests/file-mentions.test.ts`: quoting, ignored files, file discovery, no source copies.
- `tests/video-frames.test.ts`: timestamp bounds, caching, source-change checks, authorization, cancellation, storage cap and cleanup.
- `tests/attachments.test.ts`: contact-sheet images reach the next model request.
- An isolated Electron fixture generated red/blue MP4 and WebM clips and verified that samples at 0.2 and 1.8 seconds produced different colored frames and timestamped contact sheets.
- An isolated browser fixture checked `@` search, keyboard selection, sending a file reference without uploading, and existing Bot mention insertion.
