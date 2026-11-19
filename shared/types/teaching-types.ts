// Teach by Showing: shared data types for recording a host or VM demonstration with optional spoken narration,
// reviewing the timestamped timeline, and sending it to a Bot so it learns a reusable private skill.

export type TeachingTarget = 'host' | 'vm';

type TeachingActionKind =
  | 'window_focus'
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'middle_click'
  | 'drag'
  | 'scroll'
  | 'type_text'
  | 'press_key';

interface TeachingWindowOption {
  id: number;
  app: string;
  title: string;
  minimized?: boolean;
}

export interface TeachingListWindowsResult {
  available: boolean;
  permissionIssue?: string;
  windows: TeachingWindowOption[];
}

export interface TeachingHostControl {
  type: string;
  name?: string;
  value?: string;
  password?: boolean;
}

export interface TeachingStep {
  id: string;
  atMs: number;
  clock: string;
  kind: TeachingActionKind;
  summary: string;
  target: TeachingTarget;
  windowTitle?: string;
  appName?: string;
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  text?: string;
  key?: string;
  control?: TeachingHostControl;
  keyframeId?: string;
}

export interface TeachingNarrationSegment {
  startMs: number;
  endMs: number;
  clock: string;
  text: string;
}

export interface TeachingKeyframePreview {
  id: string;
  atMs: number;
  clock: string;
  label: string;
  width: number;
  height: number;
  dataUrl: string;
}

export interface TeachingStartInput {
  botId: string;
  chatSessionId?: string;
  target: TeachingTarget;
  /** Host target: specific window ID, or null/undefined to follow active windows. */
  windowId?: number | null;
}

export interface TeachingSessionInfo {
  sessionId: string;
  botId: string;
  chatSessionId?: string;
  target: TeachingTarget;
  startedAt: number;
  targetWindowId?: number;
  targetWindowLabel?: string;
  stepCount: number;
  keyframeCount: number;
}

export interface TeachingClientEvent {
  atMs: number;
  kind: 'click' | 'double_click' | 'right_click' | 'middle_click' | 'drag' | 'scroll' | 'key';
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  key?: string;
  printable?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
  windowTitle?: string;
  keyframeId?: string;
}

export interface TeachingClientKeyframe {
  id: string;
  atMs: number;
  label: string;
  pngBase64: string;
}

export interface TeachingFinishInput {
  sessionId: string;
  durationMs: number;
  audio?: Uint8Array;
  events?: TeachingClientEvent[];
  keyframes?: TeachingClientKeyframe[];
}

export interface TeachingDraft {
  draftId: string;
  botId: string;
  chatSessionId?: string;
  target: TeachingTarget;
  durationMs: number;
  steps: TeachingStep[];
  narration: TeachingNarrationSegment[];
  narrationWarning?: string;
  keyframes: TeachingKeyframePreview[];
}

export interface TeachingSendInput {
  draftId: string;
  title?: string;
  notes?: string;
  narration: TeachingNarrationSegment[];
  selectedKeyframeIds: string[];
}

export const TEACHING_LIMITS = {
  /** Maximum demonstration recording duration: 10 minutes. */
  maxDurationMs: 10 * 60 * 1000,
  /** Maximum keyframes kept in a teaching draft. */
  maxKeyframes: 12,
  /** Maximum keyframe attachments sent in one Bot message (matches ATTACHMENT_LIMITS.count). */
  maxAttachedKeyframes: 10,
  /** Maximum client-side VM events accepted per session. */
  maxClientEvents: 2000,
} as const;
