import path from 'node:path';
import {
  type AsExpression,
  type CallExpression,
  type Expression,
  isAsExpression,
  isCallExpression,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAssignment,
  isSatisfiesExpression,
  isShorthandPropertyAssignment,
  isTypeAssertion,
  type Node,
  type ObjectLiteralElementLike,
  type SourceFile,
  type TypeAssertion
} from 'typescript/ast';
import { type Diagnostic, DiagnosticCategory } from 'typescript/sync';
import { analyzeLoadedProjectMany, type LoadedDictionaryTarget } from './analyzer.js';
import {
  type CacheEvent,
  ensureCacheDirectory,
  type PreparedAnalysisCache,
  prepareAnalysisCache,
  resolveCachePaths
} from './cache.js';
import { DiagnosticCode } from './diagnostic-codes.js';
import {
  diagnosticAt,
  diagnosticAtNode,
  diagnosticWithoutFile,
  lineEndOfPosition
} from './diagnostics.js';
import { resolveDictionaryTargets } from './dictionaries.js';
import { type DictionaryKeySource, readDictionary } from './dictionary.js';
import {
  applyDictionaryRemoval,
  type DictionaryRemovalEdit,
  type DictionaryRemovalFailure,
  planDictionaryRemoval
} from './dictionary-removal.js';
import { loadProjectWithDiagnostics } from './project.js';
import type { Semantic } from './semantic.js';
import { isSourceAssertion } from './syntax.js';
import type { Unused18nConfig, UsageEvidence } from './types.js';

export type LintEvent =
  | { type: 'phase'; phase: 'project' | 'analysis' | 'results' }
  | {
      type: 'summary';
      unusedKeys: number;
      removedKeys: number;
      unresolvedReferences: number;
      removalFailures: number;
      translationObjectCasts: number;
      removedCasts: number;
    }
  | {
      type: 'stage';
      stage: 'project' | 'dictionary' | 'discovery' | 'usage' | 'replay' | 'removal';
      status: 'start' | 'end';
      timestamp: number;
    }
  | { type: 'file-progress'; fileName: string; completedFiles: number; totalFiles: number }
  | { type: 'cache'; event: CacheEvent }
  /**
   * Semantic-layer lookups up to the end of analysis: cache misses resolved one at a time and
   * batched prefetches. They approximate compiler requests; see `SemanticStats` in semantic.ts.
   */
  | { type: 'semantic'; singleRequests: number; batchRequests: number };

export interface LintOptions
  extends Omit<Unused18nConfig, '$schema' | 'cacheStats' | 'logLevel' | 'project'> {
  project?: string;
  /** @deprecated Use `dictionaries`; retained for the published single-dictionary API. */
  dictionary?: string;
  /** Receives cache lifecycle events without changing diagnostic output. */
  onCacheEvent?: (event: CacheEvent) => void;
  /** Receives synchronous lifecycle events without changing lint behavior. */
  onEvent?: (event: LintEvent) => void;
  /** Supplies monotonic benchmark timestamps; production callers use `performance.now()`. */
  now?: () => number;
}

export type { CacheEvent };
export { DiagnosticCode };

/**
 * Owns the complete lint lifecycle so consuming the iterator performs project loading, analysis,
 * optional edits, and diagnostic production in one compiler process.
 *
 * The compiler process is spawned only once iteration reaches project loading, so a `lint()`
 * call that is never iterated starts nothing. The generator closes the process before it yields
 * the first diagnostic, so an iterator abandoned at any `yield` holds no process. A `finally`
 * also closes it when loading or analysis throws. Yielded diagnostics are plain data and stay
 * valid after the process exits.
 */
export function* lint(options: LintOptions): Generator<Diagnostic, void, void> {
  const now = options.now ?? performance.now.bind(performance);
  const projectPath = options.project ?? './tsconfig.json';
  const dictionaryExport = options.dictionaryExport;
  let targets: ReturnType<typeof resolveDictionaryTargets>;
  try {
    const patterns = options.dictionaries ?? options.dictionary;
    if (!patterns) throw new Error('At least one dictionary path or glob is required');
    targets = resolveDictionaryTargets(patterns, dictionaryExport);
  } catch (error) {
    yield diagnosticWithoutFile(
      DiagnosticCode.ConfigurationFailure,
      DiagnosticCategory.Error,
      error instanceof Error ? error.message : String(error)
    );
    return;
  }
  emit({ type: 'phase', phase: 'project' });
  stage('project', 'start');
  const cacheEnabled = options.cache ?? true;
  const cachePaths = cacheEnabled
    ? resolveCachePaths(
        projectPath,
        targets.map((target) => target.path),
        dictionaryExport,
        options.cacheDir
      )
    : undefined;
  if (!cacheEnabled) notify({ type: 'bypass', reason: 'disabled' });
  if (cachePaths) {
    // An unusable directory surfaces again as read or write errors from the analysis cache,
    // which already degrade to a full analysis.
    try {
      ensureCacheDirectory(cachePaths);
    } catch (error) {
      notify({
        type: 'error',
        operation: 'directory',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  let analysis: ReturnType<typeof analyzeLoadedProjectMany>;
  let preparedCache: PreparedAnalysisCache | undefined;
  const project = loadProjectWithDiagnostics(
    projectPath,
    targets.map((target) => target.path)
  );
  // Every path closes the compiler process before its first `yield`. A consumer that abandons
  // the iterator without `return()` never resumes it, so neither code after a `yield` nor the
  // `finally` below would ever run to close the process.
  const closeCompiler = (): void => project.loaded?.[Symbol.dispose]();
  try {
    stage('project', 'end');
    const loaded = project.loaded;
    // Without a project, loadProjectWithDiagnostics has already closed the process.
    if (!loaded) {
      yield* project.diagnostics;
      return;
    }

    // One batched request instead of three round trips to the compiler process.
    const [configDiagnostics, programDiagnostics, syntacticDiagnostics] = loaded.api.batch(
      loaded.program.getConfigFileParsingDiagnostics.gen(),
      loaded.program.getProgramDiagnostics.gen(),
      loaded.program.getSyntacticDiagnostics.gen()
    );
    const compilerDiagnostics = [
      ...configDiagnostics,
      ...programDiagnostics,
      ...syntacticDiagnostics
    ];
    if (
      compilerDiagnostics.some((diagnostic) => diagnostic.category === DiagnosticCategory.Error)
    ) {
      closeCompiler();
      yield* compilerDiagnostics;
      return;
    }
    emit({ type: 'phase', phase: 'analysis' });

    let loadedDictionaries: LoadedDictionaryTarget[];
    let dictionaryStageOpen = false;
    try {
      stage('dictionary', 'start');
      dictionaryStageOpen = true;
      loadedDictionaries = targets.map((target) => {
        const info = readDictionary(loaded.semantic, target.path, target.requestedExport);
        return {
          ...target,
          id: `${target.path}\0${info.exportName}`,
          exportName: info.exportName,
          info
        };
      });
      stage('dictionary', 'end');
      dictionaryStageOpen = false;
      if (cachePaths && cacheEnabled) {
        // Dictionary provenance is rebuilt above; only serializable usage facts are replayed.
        preparedCache = prepareAnalysisCache(loaded, loadedDictionaries, {
          maxExpansions: options.maxExpansions ?? 1_000,
          paths: cachePaths
        });
        notify(preparedCache.event);
      }
      analysis = analyzeLoadedProjectMany(
        loaded,
        loadedDictionaries,
        {
          project: projectPath,
          includeEvidence: true,
          ...(options.maxExpansions === undefined ? {} : { maxExpansions: options.maxExpansions }),
          onFileAnalyzed: (fileName, completedFiles, totalFiles) =>
            emit({ type: 'file-progress', fileName, completedFiles, totalFiles }),
          onStage: stage
        },
        preparedCache?.reuse ?? {
          dictionaries: loadedDictionaries
        }
      );
    } catch (error) {
      if (dictionaryStageOpen) stage('dictionary', 'end');
      closeCompiler();
      yield* compilerDiagnostics;
      yield diagnosticWithoutFile(
        DiagnosticCode.ConfigurationFailure,
        DiagnosticCategory.Error,
        error instanceof Error ? error.message : String(error)
      );
      return;
    }
    emit({
      type: 'semantic',
      singleRequests: loaded.semantic.stats.singleRequests,
      batchRequests: loaded.semantic.stats.batchRequests
    });
    emit({ type: 'phase', phase: 'results' });
    // Evidence is serializable and may come from the cache, so it carries only file positions.
    // The files it points at are the last compiler data needed: from here on, diagnostics and
    // edits read only AST nodes and text, which stay readable once the process is closed.
    const evidenceFiles = sourceFilesForEvidence(loaded.semantic, loaded.configPath, [
      ...analysis.unresolvedReferences,
      ...analysis.translationObjectCasts
    ]);
    closeCompiler();
    yield* compilerDiagnostics;
    let unusedKeyCount = 0;
    for (const { result } of analysis.analyses) {
      for (const key of result.keys) {
        if (key.status === 'unused') unusedKeyCount += 1;
      }
    }

    if (analysis.unresolvedReferences.length > 0) {
      for (const warning of analysis.unresolvedReferences) {
        yield diagnosticFromEvidence(evidenceFiles, loaded.configPath, warning);
      }
    }
    if (!options.remove) {
      for (const cast of analysis.translationObjectCasts) {
        yield diagnosticFromEvidence(
          evidenceFiles,
          loaded.configPath,
          cast,
          DiagnosticCode.TranslationObjectCast,
          DiagnosticCategory.Error
        );
      }

      for (const { target, result } of analysis.analyses) {
        yield* unusedDiagnostics(
          result.keys.filter(({ status }) => status === 'unused').map(({ key }) => key),
          target.info.keySources
        );
      }
      writeAnalysisCache();
      emit({
        type: 'summary',
        unusedKeys: unusedKeyCount,
        removedKeys: 0,
        unresolvedReferences: analysis.unresolvedReferences.length,
        removalFailures: 0,
        translationObjectCasts: analysis.translationObjectCasts.length,
        removedCasts: 0
      });
      return;
    }

    stage('removal', 'start');
    const castRemoval = planTranslationObjectCastRemoval(
      analysis.translationObjectCasts,
      loaded.configPath,
      evidenceFiles
    );
    if (castRemoval.failures.length > 0) {
      for (const failure of castRemoval.failures) {
        yield diagnosticFromEvidence(
          evidenceFiles,
          loaded.configPath,
          failure,
          DiagnosticCode.RemovalFailure,
          DiagnosticCategory.Error
        );
      }
      writeAnalysisCache();
      stage('removal', 'end');
      emit({
        type: 'summary',
        unusedKeys: unusedKeyCount,
        removedKeys: 0,
        unresolvedReferences: analysis.unresolvedReferences.length,
        removalFailures: castRemoval.failures.length,
        translationObjectCasts: analysis.translationObjectCasts.length,
        removedCasts: 0
      });
      return;
    }
    const removals = analysis.analyses.map(({ target, result }) => ({
      target,
      removal: planDictionaryRemoval(
        target.info,
        new Set(result.keys.filter(({ status }) => status === 'unused').map(({ key }) => key))
      )
    }));
    const failedRemovals = removals.filter(({ removal }) => !removal.ok);
    if (failedRemovals.length > 0) {
      for (const { target, removal } of failedRemovals) {
        if (removal.ok) continue;
        for (const failure of removal.failures) {
          yield removalFailureDiagnostic(failure, target.info.keySources.get(failure.key));
        }
      }
      writeAnalysisCache();
      stage('removal', 'end');
      emit({
        type: 'summary',
        unusedKeys: unusedKeyCount,
        removedKeys: 0,
        unresolvedReferences: analysis.unresolvedReferences.length,
        removalFailures: failedRemovals.reduce(
          (count, { removal }) => count + (removal.ok ? 0 : removal.failures.length),
          0
        ),
        translationObjectCasts: analysis.translationObjectCasts.length,
        removedCasts: 0
      });
      return;
    }

    const combinedPlan = {
      edits: [
        ...castRemoval.edits,
        ...removals.flatMap(({ removal }) => (removal.ok ? [...removal.plan.edits] : []))
      ],
      removedKeys: new Set(
        removals.flatMap(({ removal }) => (removal.ok ? [...removal.plan.removedKeys] : []))
      )
    };
    let removedKeyCount = 0;
    for (const { removal } of removals) {
      if (removal.ok) removedKeyCount += removal.plan.removedKeys.size;
    }
    try {
      applyDictionaryRemoval(combinedPlan);
    } catch (error) {
      stage('removal', 'end');
      yield diagnosticAtNode(
        loadedDictionaries[0]!.info.declaration,
        DiagnosticCode.RemovalFailure,
        DiagnosticCategory.Error,
        error instanceof Error ? error.message : String(error)
      );
      emit({
        type: 'summary',
        unusedKeys: unusedKeyCount,
        removedKeys: 0,
        unresolvedReferences: analysis.unresolvedReferences.length,
        removalFailures: 1,
        translationObjectCasts: analysis.translationObjectCasts.length,
        removedCasts: 0
      });
      return;
    }
    if (combinedPlan.edits.length === 0) writeAnalysisCache();
    stage('removal', 'end');

    for (const { target, removal } of removals) {
      if (!removal.ok) continue;
      for (const key of removal.plan.removedKeys) {
        yield diagnosticAtSource(
          target.info.keySources.get(key),
          DiagnosticCode.RemovedKey,
          DiagnosticCategory.Message,
          `Removed unused translation key "${key}".`
        );
      }
    }
    emit({
      type: 'summary',
      unusedKeys: 0,
      removedKeys: removedKeyCount,
      unresolvedReferences: analysis.unresolvedReferences.length,
      removalFailures: 0,
      translationObjectCasts: 0,
      removedCasts: castRemoval.edits.length
    });
  } finally {
    // Covers exceptions thrown before the explicit close; closing twice is a no-op.
    closeCompiler();
  }

  /** Persists fresh source facts unless the cache was disabled or every file was reused. */
  function writeAnalysisCache(): void {
    if (!preparedCache || preparedCache.event.type === 'hit') return;
    try {
      notify(preparedCache.write(analysis.sourceFacts));
    } catch (error) {
      notify({
        type: 'error',
        operation: 'write',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /** Forwards a cache event to both the lifecycle and the dedicated cache callbacks. */
  function notify(event: CacheEvent): void {
    emit({ type: 'cache', event });
    try {
      options.onCacheEvent?.(event);
    } catch {
      // Observability callbacks never change lint correctness or exit behavior.
    }
  }

  /** Delivers a lifecycle event to the caller's observer. */
  function emit(event: LintEvent): void {
    try {
      options.onEvent?.(event);
    } catch {
      // Observability callbacks never change lint correctness or exit behavior.
    }
  }

  /** Timestamps a stage boundary for the reporter's debug timings. */
  function stage(
    stageName: Extract<LintEvent, { type: 'stage' }>['stage'],
    status: 'start' | 'end'
  ): void {
    emit({ type: 'stage', stage: stageName, status, timestamp: now() });
  }
}

/** Reports one unused key at its dictionary property, or without a file when provenance is lost. */
function unusedDiagnostic(key: string, source: DictionaryKeySource | undefined): Diagnostic {
  return diagnosticAtSource(
    source,
    DiagnosticCode.UnusedKey,
    DiagnosticCategory.Error,
    `Translation key "${key}" is unused.`
  );
}

/** Exact source-node identity survives barrier decoration without merging same-prefix literals. */
function* unusedDiagnostics(
  orderedUnusedKeys: readonly string[],
  keySources: ReadonlyMap<string, DictionaryKeySource>
): Generator<Diagnostic, void, void> {
  const unusedKeys = new Set(orderedUnusedKeys);
  const coverage = new Map<ObjectLiteralElementLike, { total: number; unused: number }>();
  for (const [key, source] of keySources) {
    for (const property of source.propertyChain) {
      const current = coverage.get(property.node) ?? { total: 0, unused: 0 };
      current.total += 1;
      if (unusedKeys.has(key)) current.unused += 1;
      coverage.set(property.node, current);
    }
  }

  const boundaries = new Map<string, DictionaryKeySource['propertyChain'][number]>();
  const groupedNodes = new Set<ObjectLiteralElementLike>();
  for (const key of orderedUnusedKeys) {
    const source = keySources.get(key);
    const boundary = source?.propertyChain.find((property, index) => {
      const counts = coverage.get(property.node);
      return index < source.propertyChain.length - 1 && counts?.total === counts?.unused;
    });
    if (boundary) {
      boundaries.set(key, boundary);
      groupedNodes.add(boundary.node);
    }
  }

  const emitted = new Set<ObjectLiteralElementLike>();
  for (const key of orderedUnusedKeys) {
    const source = keySources.get(key);
    if (!source) {
      yield unusedDiagnostic(key, undefined);
      continue;
    }
    const boundary = boundaries.get(key);
    if (!boundary) {
      if (source.propertyChain.some(({ node }) => groupedNodes.has(node))) continue;
      yield unusedDiagnostic(key, source);
      continue;
    }
    if (emitted.has(boundary.node)) continue;
    emitted.add(boundary.node);
    yield diagnosticAtNode(
      boundary.node,
      DiagnosticCode.UnusedKey,
      DiagnosticCategory.Error,
      `Translation subtree "${boundary.keyPrefix}" is unused.`
    );
  }
}

/** Explains why a key could not be removed, listing the provenance barriers that blocked it. */
function removalFailureDiagnostic(
  failure: DictionaryRemovalFailure,
  source: DictionaryKeySource | undefined
): Diagnostic {
  const constraints =
    failure.barriers.length > 0 ? failure.barriers.join(', ') : 'no safe source property';
  return diagnosticAtSource(
    source,
    DiagnosticCode.RemovalFailure,
    DiagnosticCategory.Error,
    `Cannot remove unused translation key "${failure.key}": ${constraints}.`
  );
}

/** Resolves an evidence location, which is relative to the project directory, to an absolute path. */
function evidencePath(configPath: string, evidence: UsageEvidence): string {
  return path.resolve(path.dirname(configPath), evidence.file);
}

/**
 * Fetches the program source files that evidence points at, keyed by {@link evidencePath}, in
 * one batched request. lint runs this before closing the compiler process, so relocating
 * evidence afterwards needs no compiler access. Files outside the program are left out.
 */
function sourceFilesForEvidence(
  semantic: Semantic,
  configPath: string,
  evidence: readonly UsageEvidence[]
): ReadonlyMap<string, SourceFile> {
  const fileNames = [...new Set(evidence.map((entry) => evidencePath(configPath, entry)))];
  const files = new Map<string, SourceFile>();
  semantic.prefetchSourceFiles(fileNames).forEach((file, index) => {
    if (file) files.set(fileNames[index]!, file);
  });
  return files;
}

/**
 * Turns cast evidence back into source edits. Evidence carries only file, line and column, so
 * each cast is relocated in the program's source file before it is edited.
 *
 * @param files Source files from {@link sourceFilesForEvidence}; a missing file fails the cast.
 */
function planTranslationObjectCastRemoval(
  casts: readonly UsageEvidence[],
  configPath: string,
  files: ReadonlyMap<string, SourceFile>
): { edits: DictionaryRemovalEdit[]; failures: UsageEvidence[] } {
  const edits: DictionaryRemovalEdit[] = [];
  const failures: UsageEvidence[] = [];
  for (const evidence of casts) {
    const file = files.get(evidencePath(configPath, evidence));
    const line = file
      ? Math.max(0, Math.min(evidence.line - 1, file.getLineStarts().length - 1))
      : 0;
    const start = file
      ? file.getPositionOfLineAndCharacter(line, Math.max(0, evidence.column - 1))
      : 0;
    const cast = file ? castExpressionStartingAt(file, start) : undefined;
    if (!file || !cast) {
      failures.push({
        ...evidence,
        reason: 'Cannot remove translation object cast: source location no longer matches.'
      });
      continue;
    }
    // Each assertion gets its own non-overlapping range so wrappers such as parentheses survive
    // while chained `as unknown as Type` assertions disappear in the same atomic transaction.
    let expression: Expression = cast;
    while (true) {
      if (isSourceAssertion(expression)) {
        const editStart = isAsExpression(expression)
          ? expression.expression.end
          : expression.getStart(file);
        const editEnd = isAsExpression(expression)
          ? expression.end
          : expression.expression.getStart(file);
        if (editEnd <= editStart) {
          failures.push({
            ...evidence,
            reason: 'Cannot remove translation object cast: assertion range is empty.'
          });
          break;
        }
        edits.push({
          fileName: file.fileName,
          start: editStart,
          end: editEnd,
          expectedText: file.text.slice(editStart, editEnd)
        });
        expression = expression.expression;
        continue;
      }
      if (
        isParenthesizedExpression(expression) ||
        isNonNullExpression(expression) ||
        isSatisfiesExpression(expression) ||
        // JSDoc type comments in JavaScript parse as assertions but have nothing to delete.
        isAsExpression(expression) ||
        isTypeAssertion(expression)
      ) {
        expression = expression.expression;
        continue;
      }
      break;
    }
  }
  return { edits, failures };
}

/**
 * Anchors a key diagnostic on the innermost property name, falling back to the value node and
 * then to a file-less diagnostic when the key has no recoverable source.
 */
function diagnosticAtSource(
  source: DictionaryKeySource | undefined,
  code: number,
  category: DiagnosticCategory,
  text: string
): Diagnostic {
  const property = source?.propertyChain.at(-1)?.node;
  return property
    ? diagnosticAtNode(propertyNameNode(property), code, category, text)
    : source
      ? diagnosticAtNode(source.valueNode, code, category, text)
      : diagnosticWithoutFile(code, category, text);
}

/** Narrows the span to the key name where one exists, so the squiggle stays on a single line. */
function propertyNameNode(property: ObjectLiteralElementLike): Node {
  if (isPropertyAssignment(property) || isShorthandPropertyAssignment(property)) {
    return property.name;
  }
  return property;
}

/**
 * Rebuilds a positioned diagnostic from serializable evidence, which may come from the analysis
 * cache. The span covers the cast or call starting at the evidence column, or the rest of the
 * line (at least one character) when neither is found there.
 *
 * @param files Source files from {@link sourceFilesForEvidence}; a missing file yields a
 *   diagnostic without a location.
 */
function diagnosticFromEvidence(
  files: ReadonlyMap<string, SourceFile>,
  configPath: string,
  evidence: UsageEvidence,
  code: number = DiagnosticCode.UnresolvedReference,
  category: DiagnosticCategory = DiagnosticCategory.Warning
): Diagnostic {
  const file = files.get(evidencePath(configPath, evidence));
  if (!file) {
    return diagnosticWithoutFile(code, category, evidence.reason);
  }
  const line = Math.max(0, Math.min(evidence.line - 1, file.getLineStarts().length - 1));
  const lineStart = file.getPositionOfLineAndCharacter(line, 0);
  const lineEnd = lineEndOfPosition(file, lineStart);
  const start = Math.min(lineEnd, lineStart + Math.max(0, evidence.column - 1));
  const target = castExpressionStartingAt(file, start) ?? callExpressionStartingAt(file, start);
  const length = target?.getWidth(file) ?? Math.max(1, lineEnd - start);
  return diagnosticAt(file, start, start + length, code, category, evidence.reason);
}

/** Finds the outermost call expression whose first token begins exactly at `start`. */
function callExpressionStartingAt(file: SourceFile, start: number): CallExpression | undefined {
  let result: CallExpression | undefined;
  /** Prunes subtrees that end before `start` or begin after it. */
  function visit(node: Node): void {
    if (result || node.end < start || node.getStart(file) > start) return;
    if (isCallExpression(node) && node.getStart(file) === start) {
      result = node;
      return;
    }
    node.forEachChild(visit);
  }
  visit(file);
  return result;
}

/** Finds the outermost `as` or angle-bracket assertion whose first token begins at `start`. */
function castExpressionStartingAt(
  file: SourceFile,
  start: number
): AsExpression | TypeAssertion | undefined {
  let result: AsExpression | TypeAssertion | undefined;
  /** Prunes subtrees that end before `start` or begin after it. */
  function visit(node: Node): void {
    if (result || node.end < start || node.getStart(file) > start) return;
    if (isSourceAssertion(node) && node.getStart(file) === start) {
      result = node;
      return;
    }
    node.forEachChild(visit);
  }
  visit(file);
  return result;
}
