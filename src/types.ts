/**
 * JSON options accepted by `.unused18nrc`. CLI flags override matching fields when both are set.
 */
export interface Unused18nConfig {
  /**
   * Enables editor completion and validation through the schema shipped with `unused18n`.
   * @minLength 1
   * @examples ["./node_modules/unused18n/schema.json"]
   */
  $schema?: string;
  /**
   * Path to `tsconfig.json` or its containing directory. Relative values resolve from `.unused18nrc`.
   * @minLength 1
   * @examples ["./tsconfig.json", "."]
   */
  project?: string;
  /**
   * TypeScript or strict JSON dictionary file. Relative values resolve from `.unused18nrc`.
   * @minLength 1
   * @examples ["./src/i18n/en.json", "./src/i18n/en.ts"]
   */
  dictionary?: string;
  /**
   * Export containing a TypeScript dictionary. JSON dictionaries always use `default`.
   * @minLength 1
   * @default "default"
   * @examples ["default", "dictionary"]
   */
  dictionaryExport?: string;
  /**
   * Positive integer limiting finite string combinations before a key becomes dynamic and advisory.
   * @minimum 1
   * @multipleOf 1
   * @default 1000
   * @examples [1000, 5000]
   */
  maxExpansions?: number;
  /**
   * Removes every unused key only when all planned dictionary edits are safe.
   * @default false
   * @examples [true, false]
   */
  remove?: boolean;
  /**
   * Reuses persistent compiler and per-file analysis state between runs.
   * @default true
   * @examples [true, false]
   */
  cache?: boolean;
  /**
   * Overrides the persistent cache directory. Relative values resolve from `.unused18nrc`.
   * @minLength 1
   * @default "<tsconfig-directory>/node_modules/.cache/unused18n"
   * @examples ["./node_modules/.cache/unused18n", "./.cache/unused18n"]
   */
  cacheDir?: string;
  /**
   * Prints cache hits, misses, bypasses, and reused file counts to stderr.
   * @default false
   * @examples [true, false]
   */
  cacheStats?: boolean;
}

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
