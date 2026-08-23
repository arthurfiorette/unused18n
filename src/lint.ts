import path from 'node:path';
import ts from '@typescript/typescript6';
import { analyzeLoadedProject } from './analyzer.js';
import {
  type CacheEvent,
  ensureCacheDirectory,
  type PreparedAnalysisCache,
  prepareAnalysisCache,
  resolveCachePaths
} from './cache.js';
import { DiagnosticCode } from './diagnostic-codes.js';
import { type DictionaryKeySource, readDictionary } from './dictionary.js';
import {
  applyDictionaryRemoval,
  type DictionaryRemovalFailure,
  planDictionaryRemoval
} from './dictionary-removal.js';
import { loadProjectWithDiagnostics } from './project.js';
import type { UsageEvidence } from './types.js';

export interface LintOptions {
  project: string;
  dictionary: string;
  dictionaryExport?: string;
  maxExpansions?: number;
  remove?: boolean;
  /** Enables persistent compiler and analysis caches. @defaultValue true */
  cache?: boolean;
  /** Overrides the default `<tsconfig-dir>/node_modules/.cache/unused18n` directory. */
  cacheDir?: string;
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
  const dictionaryPath = path.resolve(options.dictionary);
  const dictionaryExport = options.dictionaryExport ?? 'default';
  const cacheEnabled = options.cache ?? true;
  const cachePaths = cacheEnabled
    ? resolveCachePaths(options.project, dictionaryPath, dictionaryExport, options.cacheDir)
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
    [dictionaryPath],
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

  let analysis: ReturnType<typeof analyzeLoadedProject>;
  let preparedCache: PreparedAnalysisCache | undefined;
  try {
    const analysisOptions = {
      project: options.project,
      dictionary: dictionaryPath,
      dictionaryExport,
      includeEvidence: true
    };
    const normalizedOptions =
      options.maxExpansions === undefined
        ? analysisOptions
        : { ...analysisOptions, maxExpansions: options.maxExpansions };
    const dictionary = readDictionary(
      project.loaded.program,
      project.loaded.checker,
      dictionaryPath,
      dictionaryExport
    );
    if (cachePaths && cacheEnabled && !options.remove) {
      // Removal always needs live AST provenance; only read-only runs may replay usage facts.
      preparedCache = prepareAnalysisCache(project.loaded, dictionary, {
        dictionaryPath,
        dictionaryExport,
        maxExpansions: options.maxExpansions ?? 1_000,
        paths: cachePaths
      });
      notify(preparedCache.event);
    }
    analysis = analyzeLoadedProject(
      project.loaded,
      normalizedOptions,
      preparedCache?.reuse ?? {
        dictionary
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

  for (const warning of analysis.result.unresolvedReferences) {
    yield diagnosticFromEvidence(project.loaded.program, project.loaded.configPath, warning);
  }

  const unusedKeys = new Set(
    analysis.result.keys.filter(({ status }) => status === 'unused').map(({ key }) => key)
  );
  if (!options.remove) {
    for (const key of unusedKeys) {
      yield unusedDiagnostic(key, analysis.dictionary.keySources.get(key));
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

  const removal = planDictionaryRemoval(analysis.dictionary, unusedKeys);
  if (!removal.ok) {
    for (const failure of removal.failures) {
      yield removalFailureDiagnostic(failure, analysis.dictionary.keySources.get(failure.key));
    }
    return;
  }

  try {
    applyDictionaryRemoval(removal.plan);
  } catch (error) {
    yield diagnosticAtNode(
      analysis.dictionary.declaration,
      DiagnosticCode.RemovalFailure,
      ts.DiagnosticCategory.Error,
      error instanceof Error ? error.message : String(error)
    );
    return;
  }

  for (const key of removal.plan.removedKeys) {
    yield diagnosticAtSource(
      analysis.dictionary.keySources.get(key),
      DiagnosticCode.RemovedKey,
      ts.DiagnosticCategory.Message,
      `Removed unused translation key "${key}".`
    );
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
