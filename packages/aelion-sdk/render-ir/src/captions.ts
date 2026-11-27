export interface CaptionCue {
  readonly id?: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly text: string;
  readonly settings?: Readonly<Record<string, string>>;
}

export interface CaptionSerialization {
  readonly text: string;
  readonly warnings: readonly string[];
}

function timestamp(value: string): number {
  const match = /^(?:(\d{1,3}):)?(\d{2}):(\d{2})[,.](\d{3})$/u.exec(value.trim());
  if (match === null) throw new TypeError(`CAPTION_TIMESTAMP_INVALID: ${value}`);
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4]);
  if (minutes >= 60 || seconds >= 60) throw new TypeError(`CAPTION_TIMESTAMP_INVALID: ${value}`);
  return ((hours * 60 * 60 + minutes * 60 + seconds) * 1_000 + milliseconds) * 1_000;
}

function formatTimestamp(timeUs: number, separator: ',' | '.'): string {
  if (!Number.isSafeInteger(timeUs) || timeUs < 0) throw new RangeError('Caption time is invalid');
  const milliseconds = Math.floor(timeUs / 1_000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}${separator}${millis.toString().padStart(3, '0')}`;
}

function validateCues(cues: readonly CaptionCue[]): void {
  for (const cue of cues) {
    if (
      !Number.isSafeInteger(cue.startUs) ||
      !Number.isSafeInteger(cue.endUs) ||
      cue.startUs < 0 ||
      cue.endUs <= cue.startUs
    ) {
      throw new RangeError('CAPTION_RANGE_INVALID');
    }
  }
}

export function parseSrt(input: string): readonly CaptionCue[] {
  const normalized = input.replaceAll('\r\n', '\n').trim();
  if (normalized.length === 0) return [];
  const cues = normalized.split(/\n{2,}/u).map((block) => {
    const lines = block.split('\n');
    const timelineIndex = lines.findIndex((line) => line.includes('-->'));
    const timeline = lines[timelineIndex];
    if (timelineIndex < 0 || timeline === undefined) throw new TypeError('SRT_CUE_INVALID');
    const parts = timeline.split(/\s+-->\s+/u);
    if (parts.length !== 2) throw new TypeError('SRT_CUE_INVALID');
    const start = parts[0];
    const end = parts[1];
    if (start === undefined || end === undefined) throw new TypeError('SRT_CUE_INVALID');
    const id = timelineIndex > 0 ? lines[0]?.trim() : undefined;
    return {
      ...(id === undefined || id.length === 0 ? {} : { id }),
      startUs: timestamp(start),
      endUs: timestamp(end),
      text: lines.slice(timelineIndex + 1).join('\n'),
    };
  });
  validateCues(cues);
  return cues;
}

export function serializeSrt(cues: readonly CaptionCue[]): CaptionSerialization {
  validateCues(cues);
  const warnings = cues.some((cue) => cue.settings !== undefined)
    ? ['SRT does not preserve WebVTT cue settings; settings were omitted.']
    : [];
  return {
    text: `${cues
      .map(
        (cue, index) =>
          `${(index + 1).toString()}\n${formatTimestamp(cue.startUs, ',')} --> ${formatTimestamp(cue.endUs, ',')}\n${cue.text}`,
      )
      .join('\n\n')}\n`,
    warnings,
  };
}

export function parseWebVtt(input: string): readonly CaptionCue[] {
  const normalized = input
    .replaceAll('\r\n', '\n')
    .replace(/^\uFEFF/u, '')
    .trim();
  if (!normalized.startsWith('WEBVTT')) throw new TypeError('WEBVTT_HEADER_MISSING');
  const body = normalized.slice(normalized.indexOf('\n') + 1).trim();
  if (body.length === 0) return [];
  const cues = body
    .split(/\n{2,}/u)
    .filter((block) => !/^(NOTE|STYLE|REGION)(?:\s|$)/u.test(block))
    .map((block) => {
      const lines = block.split('\n');
      const timelineIndex = lines.findIndex((line) => line.includes('-->'));
      const timeline = lines[timelineIndex];
      if (timelineIndex < 0 || timeline === undefined) throw new TypeError('WEBVTT_CUE_INVALID');
      const match = /^(\S+)\s+-->\s+(\S+)(?:\s+(.*))?$/u.exec(timeline);
      if (match?.[1] === undefined || match[2] === undefined) {
        throw new TypeError('WEBVTT_CUE_INVALID');
      }
      const settings = Object.fromEntries(
        (match[3] ?? '')
          .split(/\s+/u)
          .filter(Boolean)
          .map((value) => {
            const separator = value.indexOf(':');
            return separator < 1 ? [value, ''] : [value.slice(0, separator), value.slice(separator + 1)];
          }),
      );
      const id = timelineIndex > 0 ? lines[0]?.trim() : undefined;
      return {
        ...(id === undefined || id.length === 0 ? {} : { id }),
        startUs: timestamp(match[1]),
        endUs: timestamp(match[2]),
        text: lines.slice(timelineIndex + 1).join('\n'),
        ...(Object.keys(settings).length === 0 ? {} : { settings }),
      };
    });
  validateCues(cues);
  return cues;
}

export function serializeWebVtt(cues: readonly CaptionCue[]): CaptionSerialization {
  validateCues(cues);
  return {
    text: `WEBVTT\n\n${cues
      .map((cue) => {
        const settings = Object.entries(cue.settings ?? {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => `${key}:${value}`)
          .join(' ');
        return `${cue.id === undefined ? '' : `${cue.id}\n`}${formatTimestamp(cue.startUs, '.')} --> ${formatTimestamp(cue.endUs, '.')}${settings.length === 0 ? '' : ` ${settings}`}\n${cue.text}`;
      })
      .join('\n\n')}\n`,
    warnings: [],
  };
}
