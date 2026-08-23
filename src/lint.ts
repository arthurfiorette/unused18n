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
  type DictionaryRemovalFailure,
  planDictionaryRemoval
} from './dictionary-removal.js';
import { loadProjectWithDiagnostics } from './project.js';
import type { Unused18nConfig, UsageEvidence } from './types.js';

export interface LintOptions extends Omit<Unused18nConfig, '$schema' | 'cacheStats' | 'project'> {
  project: string;
  /** @deprecated Use `dictionaries`; retained for the published single-dictionary API. */
  dictionary?: string;
  /** Receives cache lifecycle events without changing diagnostic output. */
  onCacheEvent?: (event: CacheEvent) => void;
}

export type { CacheEvent };
export { DiagnosticCode };

/**
 * Owns the complete lint lifecycle so consuming the iterator performs project loading, analysis,
 * optional edits, and diagnostic production in one compiler process.
 */
export function* lint(options: LintOptions): Generator<ts.Diagnostic, void, void> {
  const dictionaryExport = options.dictionaryExport ?? 'default';
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
  const cacheEnabled = options.cache ?? true;
  const cachePaths = cacheEnabled
    ? resolveCachePaths(
        options.project,
        targets.map((target) => target.path),
        dictionaryExport,
        options.cacheDir
      )
    : undefined;
  if (!cacheEnabled) notify({ type: 'bypass', reason: 'disabled' });
  else if (options.remove) notify({ type: 'bypass', reason: 'remove' });
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
    options.project,
    targets.map((target) => target.path),
    cachePaths && fsCacheAvailable(cachePaths.directory)
      ? { tsBuildInfoFile: cachePaths.tsBuildInfoFile }
      : {}
  );
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

  let analysis: ReturnType<typeof analyzeLoadedProjectMany>;
  let loadedDictionaries: LoadedDictionaryTarget[];
  let preparedCache: PreparedAnalysisCache | undefined;
  try {
    loadedDictionaries = targets.map((target) => ({
      ...target,
      info: readDictionary(
        project.loaded!.program,
        project.loaded!.checker,
        target.path,
        target.exportName
      )
    }));
    if (cachePaths && cacheEnabled && !options.remove) {
      // Removal always needs live AST provenance; only read-only runs may replay usage facts.
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
        project: options.project,
        includeEvidence: true,
        ...(options.maxExpansions === undefined ? {} : { maxExpansions: options.maxExpansions })
      },
      preparedCache?.reuse ?? {
        dictionaries: loadedDictionaries
      }
    );
  } catch (error) {
    yield createDiagnostic(
      DiagnosticCode.ConfigurationFailure,
      ts.DiagnosticCategory.Error,
      error instanceof Error ? error.message : String(error)
    );
    return;
  }

  for (const warning of analysis.unresolvedReferences) {
    yield diagnosticFromEvidence(project.loaded.program, project.loaded.configPath, warning);
  }

  if (!options.remove) {
    for (const { target, result } of analysis.analyses) {
      for (const key of result.keys
        .filter(({ status }) => status === 'unused')
        .map(({ key }) => key)) {
        yield unusedDiagnostic(key, target.info.keySources.get(key));
      }
    }
    if (preparedCache && preparedCache.event.type !== 'hit') {
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
    return;
  }

  const combinedPlan = {
    edits: removals.flatMap(({ removal }) => (removal.ok ? [...removal.plan.edits] : [])),
    removedKeys: new Set(
      removals.flatMap(({ removal }) => (removal.ok ? [...removal.plan.removedKeys] : []))
    )
  };
  try {
    applyDictionaryRemoval(combinedPlan);
  } catch (error) {
    yield diagnosticAtNode(
      loadedDictionaries[0]!.info.declaration,
      DiagnosticCode.RemovalFailure,
      ts.DiagnosticCategory.Error,
      error instanceof Error ? error.message : String(error)
    );
    return;
  }

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

  function notify(event: CacheEvent): void {
    try {
      options.onCacheEvent?.(event);
    } catch {
      // Observability callbacks never change lint correctness or exit behavior.
    }
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
    ts.DiagnosticCategory.Warning,
    `Translation key "${key}" is unused.`
  );
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
  program: ts.Program,
  configPath: string,
  evidence: UsageEvidence
): ts.Diagnostic {
  const absolutePath = path.resolve(path.dirname(configPath), evidence.file);
  const file = program
    .getSourceFiles()
    .find((source) => path.resolve(source.fileName) === absolutePath);
  if (!file) {
    return createDiagnostic(
      DiagnosticCode.UnresolvedReference,
      ts.DiagnosticCategory.Warning,
      evidence.reason
    );
  }
  const line = Math.max(0, Math.min(evidence.line - 1, file.getLineStarts().length - 1));
  const lineStart = file.getPositionOfLineAndCharacter(line, 0);
  const lineEnd = file.getLineEndOfPosition(lineStart);
  const start = Math.min(lineEnd, lineStart + Math.max(0, evidence.column - 1));
  const call = callExpressionStartingAt(file, start);
  return {
    category: ts.DiagnosticCategory.Warning,
    code: DiagnosticCode.UnresolvedReference,
    file,
    length: call?.getWidth(file) ?? Math.max(1, lineEnd - start),
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
