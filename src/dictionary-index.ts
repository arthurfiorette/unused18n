import type { KeyAnalysis, UsageConfidence, UsageEvidence } from './types.js';

const POSSIBLY_USED = 1;
const USED = 2;
const EVIDENCE_LIMIT = 20;

interface EvidenceBucket {
  entries: UsageEvidence[][];
  identities: Set<string>[];
}

/**
 * Used where replay order must not affect dictionary classifications and retained
 * state must remain compact. Sorted keys allow exact lookup plus binary-search
 * prefix ranges without the object overhead of a JavaScript trie or duplicate
 * arrays of key strings.
 * Status joins preserve `used > possibly-used > unused` regardless of replay order.
 */
export class DictionaryIndex {
  readonly #keys: string[];
  readonly #ids: Map<string, number>;
  readonly #statuses: Uint8Array;
  readonly #includeEvidence: boolean;

  // Evidence is sparse in typical runs, so eager per-key arrays and sets would
  // dominate retained memory.
  readonly #evidence = new Map<number, EvidenceBucket>();

  private constructor(keys: string[], includeEvidence: boolean) {
    this.#keys = keys;
    this.#ids = new Map(keys.map((key, id) => [key, id]));
    this.#statuses = new Uint8Array(keys.length);
    this.#includeEvidence = includeEvidence;
  }

  /**
   * Use `includeEvidence: false` for summary-only analysis so source-location
   * payloads are not retained. Sorting at this boundary keeps IDs and output
   * stable across dictionary traversal orders.
   */
  static create(keys: Iterable<string>, includeEvidence: boolean): DictionaryIndex {
    return new DictionaryIndex([...new Set(keys)].sort(compareKeys), includeEvidence);
  }

  /**
   * Use when an observation resolves to one finite leaf; unknown keys are
   * intentionally ignored.
   */
  markExact(key: string, confidence: UsageConfidence, evidence?: UsageEvidence): void {
    const id = this.#ids.get(key);
    if (id !== undefined) this.#mark(id, confidence, evidence);
  }

  /**
   * Use for conservative subtree usage where every leaf beginning with `prefix`
   * is a candidate rather than a definite reference.
   */
  markPrefix(prefix: string, confidence: UsageConfidence, evidence?: UsageEvidence): void {
    const [start, end] = this.#prefixRange(prefix);
    for (let id = start; id < end; id += 1) this.#mark(id, confidence, evidence);
  }

  /**
   * Use when syntax yields a `*` wildcard but still provides a finite static
   * prefix that can bound candidate matching.
   */
  markPattern(pattern: string, confidence: UsageConfidence, evidence?: UsageEvidence): void {
    const wildcard = pattern.indexOf('*');
    const staticPrefix = pattern.slice(0, wildcard < 0 ? pattern.length : wildcard);
    const [start, end] = this.#prefixRange(staticPrefix);
    const matcher = globMatcher(pattern);

    for (let id = start; id < end; id += 1) {
      const key = this.#keys[id];
      if (key !== undefined && matcher.test(key)) this.#mark(id, confidence, evidence);
    }
  }

  /**
   * Use at the result boundary to obtain deterministic order and evidence only
   * for each key's winning status.
   * Lower-confidence evidence is hidden once definite usage wins so callers cannot
   * misread stale conservative observations as part of the final classification.
   */
  toKeyAnalysis(): KeyAnalysis[] {
    return this.#keys.map((key, id) => {
      const status = this.#statuses[id];
      if (status === USED) {
        return { key, status: 'used', evidence: this.#evidenceFor(id, USED) };
      }
      if (status === POSSIBLY_USED) {
        return { key, status: 'possibly-used', evidence: this.#evidenceFor(id, POSSIBLY_USED) };
      }
      return { key, status: 'unused', evidence: [] };
    });
  }

  #mark(id: number, confidence: UsageConfidence, evidence: UsageEvidence | undefined): void {
    const status = confidence === 'used' ? USED : POSSIBLY_USED;
    // A numeric max makes classification independent of observation and file traversal order.
    if (status > (this.#statuses[id] ?? 0)) this.#statuses[id] = status;
    if (!this.#includeEvidence || evidence === undefined) return;

    let bucket = this.#evidence.get(id);
    if (!bucket) {
      bucket = { entries: [[], [], []], identities: [new Set(), new Set(), new Set()] };
      this.#evidence.set(id, bucket);
    }

    const entries = bucket.entries[status];
    const identities = bucket.identities[status];
    // The cap bounds diagnostic payload growth without affecting the status join above.
    if (!entries || !identities || entries.length >= EVIDENCE_LIMIT) return;

    const identity = evidenceIdentity(evidence);
    if (identities.has(identity)) return;
    identities.add(identity);
    entries.push(evidence);
  }

  #evidenceFor(id: number, status: number): UsageEvidence[] {
    return this.#evidence.get(id)?.entries[status] ?? [];
  }

  #prefixRange(prefix: string): [number, number] {
    const start = lowerBound(this.#keys, prefix);
    const successor = prefixSuccessor(prefix);
    return [start, successor === undefined ? this.#keys.length : lowerBound(this.#keys, successor)];
  }
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function lowerBound(keys: string[], target: string): number {
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const key = keys[middle];
    if (key !== undefined && key < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function prefixSuccessor(prefix: string): string | undefined {
  for (let index = prefix.length - 1; index >= 0; index -= 1) {
    const code = prefix.charCodeAt(index);
    if (code < 0xffff) return `${prefix.slice(0, index)}${String.fromCharCode(code + 1)}`;
  }
  return undefined;
}

function globMatcher(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`);
}

function evidenceIdentity(evidence: UsageEvidence): string {
  return JSON.stringify([
    evidence.confidence,
    evidence.file,
    evidence.line,
    evidence.column,
    evidence.reason
  ]);
}
