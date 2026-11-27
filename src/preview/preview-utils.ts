export const previewErrorText = (error: unknown) =>
  String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': Error: /, '');
export function previewFormat(name: string) {
  return name.split('.').pop()?.toLowerCase() || '';
}
export function previewKind(name: string) {
  const ext = previewFormat(name);
  if (['ppt', 'pptx', 'odp'].includes(ext)) return '演示文稿';
  if (['html', 'htm'].includes(ext)) return '网页';
  if (['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp', 'bmp', 'avif'].includes(ext)) return '图片';
  if (['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv'].includes(ext)) return '视频';
  return '文档';
}

/** Formats seconds as MM:SS.ff (or H:MM:SS.ff) using the clip's frame rate for exact frame display. */
export function formatVideoTimecode(sec: number, fps = 30) {
  const safe = Number.isFinite(sec) && sec > 0 ? sec : 0;
  const rate = Number.isFinite(fps) && fps > 0 ? Math.round(fps) : 30;
  const totalFrames = Math.max(0, Math.round(safe * rate));
  const frames = totalFrames % rate;
  const totalSec = Math.floor(totalFrames / rate);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(frames).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

/** Compact timecode with tenths (e.g. 00:04.2) for pin badges and chips. */
export function formatPinTimecode(sec: number) {
  const safe = Number.isFinite(sec) && sec > 0 ? sec : 0;
  const totalTenths = Math.round(safe * 10);
  const tenths = totalTenths % 10;
  const totalSec = Math.floor(totalTenths / 10);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${tenths}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

/** Short duration badge for video attachment cards and timeline pills (e.g. 0:12, 1:05:30). */
export function formatShortDuration(sec: number) {
  const safe = Number.isFinite(sec) && sec > 0 ? Math.round(sec) : 0;
  const s = safe % 60;
  const m = Math.floor(safe / 60) % 60;
  const h = Math.floor(safe / 3600);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
export function csvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' && !quoted) {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows;
}

// The document stays in an opaque, script-free frame. Do not inherit its base URL
// or allow embedded content to navigate the application or submit forms.
export function previewHtml(content: string) {
  return (
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:; base-uri \'none\'; form-action \'none\'"><meta name="referrer" content="no-referrer">' +
    content
  );
}
