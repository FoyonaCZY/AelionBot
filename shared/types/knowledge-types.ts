// Knowledge bases: named sets of folders and files on this computer, indexed locally so Bots can search them.

/** The most files one knowledge base indexes; what comes after is left out and the page says so. */
export const KNOWLEDGE_FILE_LIMIT = 5000;
export const KNOWLEDGE_BASE_LIMIT = 30;
export const KNOWLEDGE_SOURCE_LIMIT = 40;

export interface KnowledgeSource {
  path: string;
  kind: 'folder' | 'file';
}
export interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  sources: KnowledgeSource[];
  /** The Bots that may search it; every Bot when absent. */
  botIds?: string[];
  createdAt: string;
  updatedAt: string;
}
export interface KnowledgeBaseInput {
  /** Absent for a new knowledge base. */
  id?: string;
  name: string;
  description?: string;
  sources: KnowledgeSource[];
  /** null or absent: every Bot. */
  botIds?: string[] | null;
}
export interface KnowledgeBaseView extends KnowledgeBase {
  files: number;
  /** Files that could not be read or were left out (too large, no text). */
  issues: number;
  state: 'idle' | 'queued' | 'indexing';
  progress?: { done: number; total: number };
  indexedAt?: string;
  /** It holds more files than the limit: only the first ones are indexed. */
  truncated?: boolean;
  /** Sources that are no longer on this computer. */
  missing?: string[];
  /** Why the last indexing stopped, when it did not finish. */
  error?: string;
}
export interface KnowledgeView {
  bases: KnowledgeBaseView[];
  /** Search by meaning is on (the local model of Settings → 记忆); by words only otherwise. */
  semantic: boolean;
}
export interface KnowledgeIssue {
  path: string;
  reason: string;
}
