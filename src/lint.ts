import path from 'node:path';
import ts from '@typescript/typescript6';
import { analyzeLoadedProjectMany, type LoadedDictionaryTarget } from './analyzer.js';
import {
  type CacheEvent,
  ensureCacheDirectory,
  type PreparedAnalysisCache,
  prepareAnalysisCache,
  resolveCachePaths
} from './cache.js';
import { DiagnosticCode } from './diagnostic-codes.js';
import { resolveDictionaryTargets } from './dictionaries.js';
import { type DictionaryKeySource, readDictionary } from './dictionary.js';
import {
  applyDictionaryRemoval,
  type DictionaryRemovalEdit,
  type DictionaryRemovalFailure,
  planDictionaryRemoval
} from './dictionary-removal.js';
import { loadProjectWithDiagnostics } from './project.js';
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
  | { type: 'cache'; event: CacheEvent };

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
 */
export function* lint(options: LintOptions): Generator<ts.Diagnostic, void, void> {
  const now = options.now ?? performance.now.bind(performance);
  const projectPath = options.project ?? './tsconfig.json';
  const dictionaryExport = options.dictionaryExport;
  let targets: ReturnType<typeof resolveDictionaryTargets>;
  try {
    const patterns = options.dictionaries ?? options.dictionary;
    if (!patterns) throw new Error('At least one dictionary path or glob is required');
    targets = resolveDictionaryTargets(patterns, dictionaryExport);
  } catch (error) {
    yield createDiagnostic(
      DiagnosticCode.ConfigurationFailure,
      ts.DiagnosticCategory.Error,
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
    try {
      ensureCacheDirectory(cachePaths);
    } catch (error) {
      notify({
        type: 'error',
        operation: 'compiler',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const project = loadProjectWithDiagnostics(
    projectPath,
    targets.map((target) => target.path),
    cachePaths && fsCacheAvailable(cachePaths.directory)
      ? { tsBuildInfoFile: cachePaths.tsBuildInfoFile }
      : {}
  );
  stage('project', 'end');
  yield* project.diagnostics;
  if (!project.loaded) return;

  const compilerDiagnostics = [
    ...project.loaded.program.getConfigFileParsingDiagnostics(),
    ...project.loaded.program.getOptionsDiagnostics(),
    ...project.loaded.program.getSyntacticDiagnostics()
  ];
  yield* compilerDiagnostics;
  if (
    compilerDiagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  ) {
    return;
  }
  if (project.loaded.cacheError) {
    notify({ type: 'error', operation: 'compiler', message: project.loaded.cacheError });
  }
  if (project.loaded.saveBuildInfo) {
    try {
      project.loaded.saveBuildInfo();
    } catch (error) {
      notify({
        type: 'error',
        operation: 'compiler',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  emit({ type: 'phase', phase: 'analysis' });

  let analysis: ReturnType<typeof analyzeLoadedProjectMany>;
  let loadedDictionaries: LoadedDictionaryTarget[];
  let preparedCache: PreparedAnalysisCache | undefined;
  let dictionaryStageOpen = false;
  try {
    stage('dictionary', 'start');
    dictionaryStageOpen = true;
    loadedDictionaries = targets.map((target) => {
      const info = readDictionary(
        project.loaded!.program,
        project.loaded!.checker,
        target.path,
        target.requestedExport
      );
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
      preparedCache = prepareAnalysisCache(project.loaded, loadedDictionaries, {
        maxExpansions: options.maxExpansions ?? 1_000,
        paths: cachePaths
      });
      notify(preparedCache.event);
    }
    analysis = analyzeLoadedProjectMany(
      project.loaded,
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
    yield createDiagnostic(
      DiagnosticCode.ConfigurationFailure,
      ts.DiagnosticCategory.Error,
      error instanceof Error ? error.message : String(error)
    );
    return;
  }
  emit({ type: 'phase', phase: 'results' });
  let unusedKeyCount = 0;
  for (const { result } of analysis.analyses) {
    for (const key of result.keys) {
      if (key.status === 'unused') unusedKeyCount += 1;
    }
  }

  let sourceFilesByPath: Map<string, ts.SourceFile> | undefined;
  function getSourceFilesByPath(): Map<string, ts.SourceFile> {
    sourceFilesByPath ??= new Map(
      project
        .loaded!.program.getSourceFiles()
        .map((sourceFile) => [path.resolve(sourceFile.fileName), sourceFile])
    );
    return sourceFilesByPath;
  }

  if (analysis.unresolvedReferences.length > 0) {
    for (const warning of analysis.unresolvedReferences) {
      yield diagnosticFromEvidence(getSourceFilesByPath(), project.loaded.configPath, warning);
    }
  }
  if (!options.remove) {
    for (const cast of analysis.translationObjectCasts) {
      yield diagnosticFromEvidence(
        getSourceFilesByPath(),
        project.loaded.configPath,
        cast,
        DiagnosticCode.TranslationObjectCast,
        ts.DiagnosticCategory.Error
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
    project.loaded.configPath,
    getSourceFilesByPath()
  );
  if (castRemoval.failures.length > 0) {
    for (const failure of castRemoval.failures) {
      yield diagnosticFromEvidence(
        getSourceFilesByPath(),
        project.loaded.configPath,
        failure,
        DiagnosticCode.RemovalFailure,
        ts.DiagnosticCategory.Error
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
      ts.DiagnosticCategory.Error,
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
        ts.DiagnosticCategory.Message,
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

  function notify(event: CacheEvent): void {
    emit({ type: 'cache', event });
    try {
      options.onCacheEvent?.(event);
    } catch {
      // Observability callbacks never change lint correctness or exit behavior.
    }
  }

  function emit(event: LintEvent): void {
    try {
      options.onEvent?.(event);
    } catch {
      // Observability callbacks never change lint correctness or exit behavior.
    }
  }

  function stage(
    stageName: Extract<LintEvent, { type: 'stage' }>['stage'],
    status: 'start' | 'end'
  ): void {
    emit({ type: 'stage', stage: stageName, status, timestamp: now() });
  }
}

/** Cache filesystem failures must degrade to the same cold compiler path as `--no-cache`. */
function fsCacheAvailable(directory: string): boolean {
  try {
    return ts.sys.directoryExists(directory);
  } catch {
    return false;
  }
}

function unusedDiagnostic(key: string, source: DictionaryKeySource | undefined): ts.Diagnostic {
  return diagnosticAtSource(
    source,
    DiagnosticCode.UnusedKey,
    ts.DiagnosticCategory.Error,
    `Translation key "${key}" is unused.`
  );
}

/** Exact source-node identity survives barrier decoration without merging same-prefix literals. */
function* unusedDiagnostics(
  orderedUnusedKeys: readonly string[],
  keySources: ReadonlyMap<string, DictionaryKeySource>
): Generator<ts.Diagnostic, void, void> {
  const unusedKeys = new Set(orderedUnusedKeys);
  const coverage = new Map<ts.ObjectLiteralElementLike, { total: number; unused: number }>();
  for (const [key, source] of keySources) {
    for (const property of source.propertyChain) {
      const current = coverage.get(property.node) ?? { total: 0, unused: 0 };
      current.total += 1;
      if (unusedKeys.has(key)) current.unused += 1;
      coverage.set(property.node, current);
    }
  }

  const boundaries = new Map<string, DictionaryKeySource['propertyChain'][number]>();
  const groupedNodes = new Set<ts.ObjectLiteralElementLike>();
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

  const emitted = new Set<ts.ObjectLiteralElementLike>();
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
      ts.DiagnosticCategory.Error,
      `Translation subtree "${boundary.keyPrefix}" is unused.`
    );
  }
}

function removalFailureDiagnostic(
  failure: DictionaryRemovalFailure,
  source: DictionaryKeySource | undefined
): ts.Diagnostic {
  const constraints =
    failure.barriers.length > 0 ? failure.barriers.join(', ') : 'no safe source property';
  return diagnosticAtSource(
    source,
    DiagnosticCode.RemovalFailure,
    ts.DiagnosticCategory.Error,
    `Cannot remove unused translation key "${failure.key}": ${constraints}.`
  );
}

function planTranslationObjectCastRemoval(
  casts: readonly UsageEvidence[],
  configPath: string,
  sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>
): { edits: DictionaryRemovalEdit[]; failures: UsageEvidence[] } {
  const edits: DictionaryRemovalEdit[] = [];
  const failures: UsageEvidence[] = [];
  for (const evidence of casts) {
    const fileName = path.resolve(path.dirname(configPath), evidence.file);
    const file = sourceFilesByPath.get(fileName);
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
    let expression: ts.Expression = cast;
    while (true) {
      if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
        const editStart = ts.isAsExpression(expression)
          ? expression.expression.end
          : expression.getStart(file);
        const editEnd = ts.isAsExpression(expression)
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
        ts.isParenthesizedExpression(expression) ||
        ts.isNonNullExpression(expression) ||
        ts.isSatisfiesExpression(expression)
      ) {
        expression = expression.expression;
        continue;
      }
      break;
    }
  }
  return { edits, failures };
}

function diagnosticAtSource(
  source: DictionaryKeySource | undefined,
  code: number,
  category: ts.DiagnosticCategory,
  messageText: string
): ts.Diagnostic {
  const property = source?.propertyChain.at(-1)?.node;
  return property
    ? diagnosticAtNode(propertyNameNode(property), code, category, messageText)
    : source
      ? diagnosticAtNode(source.valueNode, code, category, messageText)
      : createDiagnostic(code, category, messageText);
}

function propertyNameNode(property: ts.ObjectLiteralElementLike): ts.Node {
  if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
    return property.name;
  }
  return property;
}

function diagnosticFromEvidence(
  sourceFilesByPath: ReadonlyMap<string, ts.SourceFile>,
  configPath: string,
  evidence: UsageEvidence,
  code: number = DiagnosticCode.UnresolvedReference,
  category: ts.DiagnosticCategory = ts.DiagnosticCategory.Warning
): ts.Diagnostic {
  const absolutePath = path.resolve(path.dirname(configPath), evidence.file);
  const file = sourceFilesByPath.get(absolutePath);
  if (!file) {
    return createDiagnostic(code, category, evidence.reason);
  }
  const line = Math.max(0, Math.min(evidence.line - 1, file.getLineStarts().length - 1));
  const lineStart = file.getPositionOfLineAndCharacter(line, 0);
  const lineEnd = file.getLineEndOfPosition(lineStart);
  const start = Math.min(lineEnd, lineStart + Math.max(0, evidence.column - 1));
  const target = castExpressionStartingAt(file, start) ?? callExpressionStartingAt(file, start);
  return {
    category,
    code,
    file,
    length: target?.getWidth(file) ?? Math.max(1, lineEnd - start),
    messageText: evidence.reason,
    source: 'unused18n',
    start
  };
}

function callExpressionStartingAt(
  file: ts.SourceFile,
  start: number
): ts.CallExpression | undefined {
  let result: ts.CallExpression | undefined;
  function visit(node: ts.Node): void {
    if (result || node.end < start || node.getStart(file) > start) return;
    if (ts.isCallExpression(node) && node.getStart(file) === start) {
      result = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return result;
}

function castExpressionStartingAt(
  file: ts.SourceFile,
  start: number
): ts.AsExpression | ts.TypeAssertion | undefined {
  let result: ts.AsExpression | ts.TypeAssertion | undefined;
  function visit(node: ts.Node): void {
    if (result || node.end < start || node.getStart(file) > start) return;
    if (
      (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) &&
      node.getStart(file) === start
    ) {
      result = node;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return result;
}

function diagnosticAtNode(
  node: ts.Node,
  code: number,
  category: ts.DiagnosticCategory,
  messageText: string
): ts.Diagnostic {
  const file = node.getSourceFile();
  return {
    category,
    code,
    file,
    length: node.getWidth(file),
    messageText,
    source: 'unused18n',
    start: node.getStart(file)
  };
}

function createDiagnostic(
  code: number,
  category: ts.DiagnosticCategory,
  messageText: string
): ts.Diagnostic {
  return {
    category,
    code,
    file: undefined,
    length: undefined,
    messageText,
    source: 'unused18n',
    start: undefined
  };
}
