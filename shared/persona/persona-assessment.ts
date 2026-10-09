/** Model opinions about this candidate in this situation; never psychological measurements or growth deltas. */
export interface CandidateSemantic {
  version: 1;
  status: 'supported' | 'uncertain';
  /** Coarse compatibility with the supplied persona: conflicts / neutral / fits. Not decision quality. */
  fit?: -1 | 0 | 1;
  summary: string;
  evidence: { source: 'shared_log' | 'personal_log'; id: number; quote: string }[];
}
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const keysOnly = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).every((k) => keys.includes(k));
const text = (x: unknown, max: number): x is string => typeof x === 'string' && !!x.trim() && x.length <= max;

/** Malformed optional advice cannot fail an otherwise legal game action. ZIP import may reject it explicitly. */
export function parseCandidateSemantic(raw: unknown): CandidateSemantic | undefined {
  if (
    !object(raw) ||
    !keysOnly(raw, ['version', 'status', 'fit', 'summary', 'evidence']) ||
    raw.version !== 1 ||
    (raw.status !== 'supported' && raw.status !== 'uncertain') ||
    !text(raw.summary, 400) ||
    !Array.isArray(raw.evidence) ||
    raw.evidence.length > 4
  )
    return;
  if (raw.status === 'supported') {
    if (![-1, 0, 1].includes(raw.fit as number) || !raw.evidence.length) return;
  } else if (raw.fit !== undefined) return;
  const evidence: CandidateSemantic['evidence'] = [];
  for (const e of raw.evidence) {
    if (
      !object(e) ||
      !keysOnly(e, ['source', 'id', 'quote']) ||
      (e.source !== 'shared_log' && e.source !== 'personal_log') ||
      !Number.isSafeInteger(e.id) ||
      Number(e.id) < 1 ||
      !text(e.quote, 240)
    )
      return;
    evidence.push({ source: e.source as 'shared_log' | 'personal_log', id: Number(e.id), quote: e.quote });
  }
  return {
    version: 1,
    status: raw.status as CandidateSemantic['status'],
    summary: raw.summary,
    evidence,
    ...(raw.status === 'supported' ? { fit: raw.fit as -1 | 0 | 1 } : {}),
  };
}

/** Verify references against the ACTUAL dispatched input, never the later/revealed match state.
 * Existence of an exact quote establishes provenance only; it does not prove the model's interpretation. */
export function semanticEvidenceMatches(
  semantic: CandidateSemantic,
  input: string | undefined,
  seatId: string,
  kind: string,
) {
  if (!input || !parseCandidateSemantic(semantic)) return false;
  try {
    const v = JSON.parse(input);
    if (v.you !== seatId || v.request?.seatId !== seatId || v.request?.kind !== kind) return false;
    return semantic.evidence.every((e) => {
      const logs = e.source === 'shared_log' ? v.context?.shared?.logs : v.context?.personal?.logs;
      return (
        Array.isArray(logs) &&
        logs.some((l) => object(l) && l.id === e.id && typeof l.text === 'string' && l.text.includes(e.quote))
      );
    });
  } catch {
    return false;
  }
}
