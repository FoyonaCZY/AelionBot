import type { WireMessage } from './core';
import type { PreviewAnnotation } from './preview-editor-types';
/**
 * Retired: every Bot now runs the same engine and can take on design work. Older profiles may still carry
 * `type: 'designer'`; it is kept on disk so an older app version still finds its designers, and nothing reads it.
 */
export type BotType = 'general' | 'designer';
const DESIGN_TASK_KINDS = ['prototype', 'ppt', 'clone', 'mobile', 'document'] as const;
export type DesignTaskKind = (typeof DESIGN_TASK_KINDS)[number];
export function isDesignTaskKind(value: unknown): value is DesignTaskKind {
  return typeof value === 'string' && (DESIGN_TASK_KINDS as readonly string[]).includes(value);
}
export type DesignOrigin = { kind: 'bot'; id: string } | { kind: 'group'; id: string } | { kind: 'peer'; id: string };
export type DesignSystemOrigin = 'bundled' | 'custom';
/** A design system's own surface, ink, accent, type and corner, read from its tokens.css for a specimen. */
export interface DesignSystemPreview {
  bg?: string;
  surface?: string;
  fg?: string;
  muted?: string;
  accent?: string;
  border?: string;
  radius?: string;
  display?: string;
  body?: string;
}
export interface DesignSystemSummary {
  id: string;
  name: string;
  category: string;
  description: string;
  version: string;
  bytes: number;
  colors: string[];
  source: string;
  license: string;
  origin?: DesignSystemOrigin;
  preview?: DesignSystemPreview;
}
interface DesignSystemFile {
  path: string;
  sha256: string;
  bytes: number;
}
export interface DesignSystemManifest extends DesignSystemSummary {
  files: DesignSystemFile[];
}
export interface DesignSystemCatalog {
  version: 1;
  sourceCommit: string;
  sourceUrl: string;
  systems: DesignSystemManifest[];
}
export interface DesignArtifact {
  path: string;
  name: string;
  kind: 'html' | 'pptx' | 'pdf' | 'other';
  revision: string;
  bytes: number;
  verifiedAt: string;
}
interface DesignUserEdit {
  id: string;
  path: string;
  revision: string;
  time: string;
  summary: string;
}
interface DesignCheck {
  id: string;
  label: string;
  status: 'pending' | 'passed' | 'failed';
  executionId?: string;
  detail?: string;
}
export interface DesignComment {
  id: string;
  path: string;
  text: string;
  createdAt: string;
  status: 'open' | 'resolved';
  designId?: string;
  selector?: string;
  page?: number;
  annotation?: PreviewAnnotation;
}
/** Static design-check results. P0 blocks publication; P1/P2 are advisory and surface as badges. */
export type DesignFindingLevel = 'P0' | 'P1' | 'P2';
export interface DesignFinding {
  id: string;
  level: DesignFindingLevel;
  message: string;
  hint: string;
  craft?: string;
}
/** Findings for one file, refreshed on every write so the workspace shows live quality state. */
interface DesignFileFindings {
  path: string;
  findings: DesignFinding[];
}
export interface DesignSession {
  location?: 'host' | 'vm';
  workspaceDir?: string;
  workflowVersion?: string;
  id: string;
  botId: string;
  origin: DesignOrigin;
  title: string;
  kind: DesignTaskKind;
  brief: string;
  engineVersion: 'designer-v1';
  systemId: string | null;
  systemVersion: string | null;
  status: 'draft' | 'running' | 'awaiting-input' | 'review' | 'completed' | 'paused' | 'failed';
  stage: 'brief' | 'build' | 'verify' | 'delivery';
  revision: number;
  createdAt: string;
  updatedAt: string;
  designSpec: string;
  constraints: string[];
  artifacts: DesignArtifact[];
  userEdits: DesignUserEdit[];
  checks: DesignCheck[];
  comments?: DesignComment[];
  findings?: DesignFileFindings[];
  /** Files each run wrote, keyed by run id then virtual path. */
  changes?: import('../designer/design-changes').DesignRunChanges;
  runIds: string[];
  activeRunId?: string;
  workspacePath: string;
  lastError?: string;
}
export interface DesignSessionInput {
  botId: string;
  origin?: DesignOrigin;
  kind: DesignTaskKind;
  title?: string;
  brief: string;
  systemId?: string | null;
}
export interface DesignSessionUpdate {
  id: string;
  revision: number;
  title?: string;
  systemId?: string | null;
  designSpec?: string;
  constraints?: string[];
}
export interface DesignerSnapshot {
  systems: DesignSystemSummary[];
  sessions: DesignSession[];
}
export interface DesignHistory {
  messages: WireMessage[];
  summary: string;
}
export interface DesignSystemDetail extends DesignSystemSummary {
  design: string;
  tokens: string;
  components: string;
}
/** A page's first screen for the canvas card. `path` is the page's workspace path. */
export interface DesignThumbnail {
  path: string;
  dataUrl: string;
}
