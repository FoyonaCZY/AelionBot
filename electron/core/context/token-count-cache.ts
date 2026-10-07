import { createHash } from 'node:crypto';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

// Only hashes and counts are retained, never prompt text. Long transcripts must
// not evict the entire working set when one more message is added.
export class TokenCountCache {
  private entries = new Map<string, number>();
  constructor(
    private tokenize: (text: string) => number,
    private capacity = 16384,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid token cache capacity');
  }
  count(text: string) {
    if (!text) return 0;
    const key = hash(text),
      known = this.entries.get(key);
    if (known !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, known);
      return known;
    }
    const tokens = this.tokenize(text);
    this.store(key, tokens);
    return tokens;
  }
  /** The texts among `texts` that have no count yet, each once, with the key to remember its count by. */
  unknown(texts: string[]) {
    const seen = new Set<string>(),
      missing: { text: string; key: string }[] = [];
    for (const text of texts) {
      if (!text || seen.has(text)) continue;
      seen.add(text);
      const key = hash(text);
      if (!this.entries.has(key)) missing.push({ text, key });
    }
    return missing;
  }
  /** Records a count made elsewhere (another thread) under the key unknown() gave, as if this cache had counted it. */
  remember(key: string, tokens: number) {
    this.store(key, tokens);
  }
  private store(key: string, tokens: number) {
    this.entries.delete(key);
    if (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, tokens);
  }
}
