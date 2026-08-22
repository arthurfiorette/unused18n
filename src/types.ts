/** Internal analysis options shared by the public linter and regression tests. */
export interface AnalyzeOptions {
  project: string;
  dictionary: string;
  dictionaryExport: string;
  /**
   * Raise only when larger finite unions are worth the additional retained work;
   * exceeding the limit falls back to a pattern or advisory unresolved warning.
   * @defaultValue 1000
   */
  maxExpansions?: number;
  /**
   * Disable for lower-memory summary reporting when source-located key evidence
   * is unnecessary; classifications and warnings are unchanged.
   * @defaultValue true
   */
  includeEvidence?: boolean;
}

/** `possibly-used` is reserved for finite candidate sets; unbounded values become warnings. */
export type UsageConfidence = 'used' | 'possibly-used';

/**
 * Retained when callers request classification evidence or when an unresolved
 * value needs a warning.
 */
export interface UsageEvidence {
  confidence: UsageConfidence;
  file: string;
  line: number;
  column: number;
  reason: string;
}

/**
 * Status joins must preserve `used > possibly-used > unused` so traversal and
 * replay order cannot change a dictionary leaf's result.
 */
export interface KeyAnalysis {
  key: string;
  status: UsageConfidence | 'unused';
  evidence: UsageEvidence[];
}

/**
 * `unresolvedReferences` remains advisory so an unbounded runtime expression
 * cannot suppress or downgrade otherwise-unused keys without a finite candidate set.
 */
export interface AnalysisResult {
  dictionary: string;
  dictionaryExport: string;
  keys: KeyAnalysis[];
  unresolvedReferences: UsageEvidence[];
  summary: {
    total: number;
    used: number;
    possiblyUsed: number;
    unused: number;
    unresolvedReferences: number;
  };
}
