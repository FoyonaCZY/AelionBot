export type PreviewMode = 'browse' | 'annotate' | 'edit';
export type AnnotationTool = 'rect' | 'arrow' | 'pen' | 'text' | 'element';
interface AnnotationPoint {
  x: number;
  y: number;
}
export interface PreviewViewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  documentWidth: number;
  documentHeight: number;
}
export interface PreviewAnnotation {
  sourceWidth?: number;
  sourceHeight?: number;
  elementLabel?: string;
  elementText?: string;
  id: string;
  type: AnnotationTool;
  x: number;
  y: number;
  w?: number;
  h?: number;
  end?: AnnotationPoint;
  points?: AnnotationPoint[];
  text?: string;
  color: string;
  page?: number;
  /** Video playback timestamp in seconds for timecoded video/timeline annotations. */
  timestampSec?: number;
  selector?: string;
  designId?: string;
  /** The number on the pin. It stays when other pins are removed, so a reply's #n still finds its pin. */
  n?: number;
  /** After sending: waiting, the Bot at work, changed as asked, or left as it was (with the reason in `reply`). */
  status?: PinStatus;
  /** What the Bot's reply said about this pin. */
  reply?: string;
  /** A pin the Bot placed with preview_mark; its words are in `botNote`, the person's answer in `text`. */
  author?: 'bot';
  botNote?: string;
}
export type PinStatus = 'sent' | 'working' | 'done' | 'kept';
export interface DomTarget {
  tag: string;
  path: string[];
  html: string;
}
export interface DomEdit {
  before: DomTarget;
  after: string;
}
export interface PreviewElement {
  id: string;
  tag: string;
  label: string;
  parentId?: string;
  path: string[];
  attributes: Record<string, string>;
  html: string;
  truncated: boolean;
  text: string;
  leaf: boolean;
  styles: Record<string, string>;
  bounds: { x: number; y: number; width: number; height: number };
}
export interface PreviewTreeNode {
  id: string;
  label: string;
  tag: string;
  hasChildren: boolean;
}
export interface PreviewEditorState {
  selectedAnnotationId?: string;
  /** The selected pin's box in viewport CSS pixels while it is on screen, to place its bubble beside it. */
  selectedRect?: { x: number; y: number; width: number; height: number };
  /** Rises each time the person clicks or makes a pin in the page. */
  pinSeq?: number;
  annotationCanUndo?: boolean;
  annotationCanRedo?: boolean;
  viewport?: PreviewViewport;
  mode: PreviewMode;
  tool: AnnotationTool;
  selected?: PreviewElement;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  annotations: PreviewAnnotation[];
  revision: number;
  error?: string;
}
export type EditorCommand = (
  | { type: 'mode'; mode: PreviewMode; tool?: AnnotationTool }
  | { type: 'select'; id: string }
  /** Selects the element an element pin points at, to tune its style. */
  | { type: 'select-pin'; id: string }
  | { type: 'parent' }
  | { type: 'children'; id?: string; offset?: number }
  | { type: 'style'; values: Record<string, string> }
  | { type: 'css'; value: string }
  | { type: 'attributes'; values: Record<string, string> }
  | { type: 'text'; value: string }
  | { type: 'html'; value: string; preview?: boolean }
  | { type: 'revert-preview' }
  | { type: 'undo' | 'redo' | 'export' | 'commit' | 'cancel' | 'reset' | 'state' }
  | { type: 'feedback-state' }
  | { type: 'annotation-select'; id?: string }
  | { type: 'annotation-undo' | 'annotation-redo' }
  | { type: 'annotations'; annotations: PreviewAnnotation[] }
  | { type: 'capture'; hide: boolean }
  /** Scrolls a pin into view and returns its box in the viewport, for a close-up; without an id, scrolls back. */
  | { type: 'reveal'; id?: string; scroll?: { x: number; y: number } }
  | { type: 'lock'; locked: boolean }
) & { targetId?: string };
export interface EditorResult {
  state: PreviewEditorState;
  /** For `reveal`: the pin's box in viewport CSS pixels, and the scroll position to return to. */
  rect?: { x: number; y: number; width: number; height: number };
  scroll?: { x: number; y: number };
  nodes?: PreviewTreeNode[];
  more?: boolean;
  edits?: DomEdit[];
}
