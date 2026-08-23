import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from '@typescript/typescript6';
import type { AnalysisReuse, SourceUsageFacts } from './analyzer.js';
import type { DictionaryInfo } from './dictionary.js';
import type { LoadedProject } from './project.js';

// Bump either version whenever persisted shape or analyzer semantics would make old facts unsafe.
const CACHE_SCHEMA_VERSION = 1;
const ANALYSIS_ALGORITHM_VERSION = 1;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;

/** Cache observability stays separate from TypeScript diagnostics and never affects lint status. */
export type CacheEvent =
  | { type: 'bypass'; reason: 'disabled' | 'remove' }
  | {
      type: 'hit' | 'miss';
      reason?: 'absent' | 'changed' | 'incompatible' | 'corrupt';
      analyzedFiles: number;
      reusedFiles: number;
    }
  | { type: 'write'; files: number }
  | { type: 'error'; operation: 'read' | 'write' | 'compiler'; message: string };

export interface CachePaths {
  directory: string;
  entryFile: string;
  tsBuildInfoFile: string;
}

export interface PreparedAnalysisCache {
  event: CacheEvent;
  reuse: AnalysisReuse;
  write(sourceFacts: SourceUsageFacts[]): CacheEvent;
}

/** Facts are reusable only while content, dependency edges, and global scope behavior stay stable. */
interface CachedSource {
  hash: string;
  dependencies: string[];
  global: boolean;
  facts: SourceUsageFacts;
}

interface CacheEntry {
  schemaVersion: number;
  analysisVersion: number;
  packageVersion: string;
  typescriptVersion: string;
  compatibilityHash: string;
  sources: Record<string, CachedSource>;
}

interface CurrentSource {
  hash: string;
  dependencies: string[];
  global: boolean;
}

const packageVersion = readPackageVersion();

/** Keeps different projects, dictionaries, and exports from sharing compiler or analysis state. */
export function resolveCachePaths(
  project: string,
  dictionary: string,
  dictionaryExport: string,
  cacheDir?: string
): CachePaths {
  const resolvedProject = path.resolve(project);
  const configPath = ts.sys.directoryExists(resolvedProject)
    ? (ts.findConfigFile(resolvedProject, ts.sys.fileExists, 'tsconfig.json') ??
      path.join(resolvedProject, 'tsconfig.json'))
    : resolvedProject;
  const projectDirectory = path.dirname(configPath);
  const directory = cacheDir
    ? path.resolve(cacheDir)
    : path.join(projectDirectory, 'node_modules', '.cache', 'unused18n');
  const identity = hash(
    canonicalJson({
      project: configPath,
      dictionary: path.resolve(dictionary),
      dictionaryExport
    })
  );
  return {
    directory,
    entryFile: path.join(directory, `analysis-${identity}.json`),
    tsBuildInfoFile: path.join(directory, `compiler-${identity}.tsbuildinfo`)
  };
}

export function ensureCacheDirectory(paths: CachePaths): void {
  fs.mkdirSync(paths.directory, { mode: 0o700, recursive: true });
}

/**
 * Chooses reusable source facts conservatively: uncertain semantic inputs invalidate everything,
 * while ordinary module edits invalidate their complete connected component in both directions.
 */
export function prepareAnalysisCache(
  loaded: LoadedProject,
  dictionary: DictionaryInfo,
  options: {
    dictionaryPath: string;
    dictionaryExport: string;
    maxExpansions: number;
    paths: CachePaths;
  }
): PreparedAnalysisCache {
  const currentSources = snapshotSources(loaded.program);
  const compatibilityHash = computeCompatibilityHash(loaded, dictionary, options);
  const cached = readEntry(options.paths.entryFile);
  const currentNames = Object.keys(currentSources).sort(comparePaths);

  let reason: 'absent' | 'changed' | 'incompatible' | 'corrupt' = 'absent';
  let filesToAnalyze = new Set(currentNames);
  let cachedFacts = new Map<string, SourceUsageFacts>();

  if (cached === 'corrupt') {
    reason = 'corrupt';
  } else if (cached) {
    if (cached.compatibilityHash !== compatibilityHash) {
      reason = 'incompatible';
    } else {
      const changed = changedFiles(currentSources, cached.sources);
      if (changed.size === 0) {
        cachedFacts = factsForCurrentSources(currentSources, cached.sources);
        return prepared(
          { type: 'hit', analyzedFiles: 0, reusedFiles: currentNames.length },
          new Set(),
          cachedFacts
        );
      }

      reason = 'changed';
      // Any global script or augmentation can connect otherwise-unrelated files outside import edges.
      const hasGlobalScope = [
        ...Object.values(currentSources),
        ...Object.values(cached.sources)
      ].some((source) => source.global);
      filesToAnalyze = hasGlobalScope
        ? new Set(currentNames)
        : connectedDirtyFiles(changed, currentSources, cached.sources, currentNames);
      cachedFacts = factsForCurrentSources(currentSources, cached.sources, filesToAnalyze);
    }
  }

  return prepared(
    {
      type: 'miss',
      reason,
      analyzedFiles: filesToAnalyze.size,
      reusedFiles: currentNames.length - filesToAnalyze.size
    },
    filesToAnalyze,
    cachedFacts
  );

  function prepared(
    event: CacheEvent,
    dirty: Set<string>,
    reusable: Map<string, SourceUsageFacts>
  ): PreparedAnalysisCache {
    return {
      event,
      reuse: { dictionary, cachedFacts: reusable, filesToAnalyze: dirty },
      write(sourceFacts) {
        const facts = new Map(sourceFacts.map((entry) => [path.resolve(entry.fileName), entry]));
        const sources = Object.fromEntries(
          Object.entries(currentSources).map(([fileName, source]) => [
            fileName,
            {
              ...source,
              facts: facts.get(fileName) ?? {
                fileName,
                facts: [],
                unresolvedReferences: []
              }
            }
          ])
        );
        // Persist the merged fresh/replayed view so the next process needs only one complete entry.
        const entry: CacheEntry = {
          schemaVersion: CACHE_SCHEMA_VERSION,
          analysisVersion: ANALYSIS_ALGORITHM_VERSION,
          packageVersion,
          typescriptVersion: ts.version,
          compatibilityHash,
          sources
        };
        writeEntry(options.paths.entryFile, entry);
        return { type: 'write', files: currentNames.length };
      }
    };
  }
}

function snapshotSources(program: ts.Program): Record<string, CurrentSource> {
  const applicationFiles = program.getSourceFiles().filter(isApplicationSource);
  const applicationNames = new Set(applicationFiles.map((source) => path.resolve(source.fileName)));
  return Object.fromEntries(
    applicationFiles.map((source) => {
      const fileName = path.resolve(source.fileName);
      return [
        fileName,
        {
          hash: hash(source.text),
          dependencies: dependenciesFor(source, program.getCompilerOptions(), applicationNames),
          global: affectsGlobalScope(source)
        }
      ];
    })
  );
}

/** Inputs that can alter semantic extraction without changing an application source force a miss. */
function computeCompatibilityHash(
  loaded: LoadedProject,
  dictionary: DictionaryInfo,
  options: { dictionaryPath: string; dictionaryExport: string; maxExpansions: number }
): string {
  const externalSources = loaded.program
    .getSourceFiles()
    .filter((source) => !isApplicationSource(source))
    .map((source) => [path.resolve(source.fileName), hash(source.text)])
    .sort(([left], [right]) => comparePaths(left ?? '', right ?? ''));
  const compilerOptions = Object.fromEntries(
    Object.entries(loaded.program.getCompilerOptions()).filter(
      ([key, value]) =>
        value !== undefined &&
        key !== 'configFile' &&
        key !== 'incremental' &&
        key !== 'tsBuildInfoFile'
    )
  );
  return hash(
    canonicalJson({
      schemaVersion: CACHE_SCHEMA_VERSION,
      analysisVersion: ANALYSIS_ALGORITHM_VERSION,
      packageVersion,
      typescriptVersion: ts.version,
      configPath: path.resolve(loaded.configPath),
      compilerOptions,
      dictionaryPath: path.resolve(options.dictionaryPath),
      dictionaryExport: options.dictionaryExport,
      dictionaryKeys: [...dictionary.keys].sort(comparePaths),
      maxExpansions: options.maxExpansions,
      externalSources
    })
  );
}

function dependenciesFor(
  source: ts.SourceFile,
  compilerOptions: ts.CompilerOptions,
  applicationNames: ReadonlySet<string>
): string[] {
  // Static preprocessing gives stable path edges without persisting process-local Symbols or Types.
  const dependencies = new Set<string>();
  const preprocessed = ts.preProcessFile(source.text, true, true);
  for (const imported of preprocessed.importedFiles) {
    const resolved = ts.resolveModuleName(
      imported.fileName,
      source.fileName,
      compilerOptions,
      ts.sys
    ).resolvedModule?.resolvedFileName;
    if (!resolved) continue;
    const fileName = path.resolve(resolved);
    if (applicationNames.has(fileName)) dependencies.add(fileName);
  }
  for (const reference of preprocessed.referencedFiles) {
    const fileName = path.resolve(path.dirname(source.fileName), reference.fileName);
    if (applicationNames.has(fileName)) dependencies.add(fileName);
  }
  return [...dependencies].sort(comparePaths);
}

function changedFiles(
  current: Record<string, CurrentSource>,
  cached: Record<string, CachedSource>
): Set<string> {
  const changed = new Set<string>();
  for (const [fileName, source] of Object.entries(current)) {
    const previous = cached[fileName];
    if (
      previous?.hash !== source.hash ||
      previous.global !== source.global ||
      !sameStrings(previous.dependencies, source.dependencies)
    )
      changed.add(fileName);
  }
  for (const fileName of Object.keys(cached)) {
    if (!current[fileName]) changed.add(fileName);
  }
  return changed;
}

function connectedDirtyFiles(
  changed: ReadonlySet<string>,
  current: Record<string, CurrentSource>,
  cached: Record<string, CachedSource>,
  currentNames: readonly string[]
): Set<string> {
  // Old edges cover removed imports; current edges cover newly-resolved imports.
  const adjacency = new Map<string, Set<string>>();
  for (const source of [current, cached]) {
    for (const [fileName, entry] of Object.entries(source)) {
      for (const dependency of entry.dependencies) {
        addEdge(adjacency, fileName, dependency);
        addEdge(adjacency, dependency, fileName);
      }
    }
  }
  const dirty = new Set<string>();
  const pending = [...changed];
  while (pending.length > 0) {
    const fileName = pending.pop();
    if (!fileName || dirty.has(fileName)) continue;
    dirty.add(fileName);
    for (const related of adjacency.get(fileName) ?? []) pending.push(related);
  }
  return new Set(currentNames.filter((fileName) => dirty.has(fileName)));
}

function factsForCurrentSources(
  current: Record<string, CurrentSource>,
  cached: Record<string, CachedSource>,
  excluded = new Set<string>()
): Map<string, SourceUsageFacts> {
  const facts = new Map<string, SourceUsageFacts>();
  for (const fileName of Object.keys(current)) {
    if (excluded.has(fileName)) continue;
    const entry = cached[fileName];
    if (entry) facts.set(fileName, entry.facts);
  }
  return facts;
}

function readEntry(fileName: string): CacheEntry | 'corrupt' | undefined {
  try {
    const stats = fs.statSync(fileName);
    if (stats.size > MAX_CACHE_BYTES) return 'corrupt';
    const value: unknown = JSON.parse(fs.readFileSync(fileName, 'utf8'));
    return isCacheEntry(value) ? value : 'corrupt';
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    return 'corrupt';
  }
}

/** Readers observe either the previous complete entry or the new one, never a partial JSON write. */
function writeEntry(fileName: string, entry: CacheEntry): void {
  fs.mkdirSync(path.dirname(fileName), { mode: 0o700, recursive: true });
  const temporary = path.join(
    path.dirname(fileName),
    `.${path.basename(fileName)}.${process.pid}.${randomUUID()}.tmp`
  );
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(entry));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, fileName);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function isCacheEntry(value: unknown): value is CacheEntry {
  if (!isRecord(value) || !isRecord(value.sources)) return false;
  if (
    value.schemaVersion !== CACHE_SCHEMA_VERSION ||
    value.analysisVersion !== ANALYSIS_ALGORITHM_VERSION ||
    value.packageVersion !== packageVersion ||
    value.typescriptVersion !== ts.version ||
    typeof value.compatibilityHash !== 'string'
  )
    return false;
  return Object.entries(value.sources).every(
    ([fileName, source]) =>
      typeof fileName === 'string' && isCachedSource(source) && source.facts.fileName === fileName
  );
}

function isCachedSource(value: unknown): value is CachedSource {
  return (
    isRecord(value) &&
    typeof value.hash === 'string' &&
    typeof value.global === 'boolean' &&
    Array.isArray(value.dependencies) &&
    value.dependencies.every((entry) => typeof entry === 'string') &&
    isSourceFacts(value.facts)
  );
}

function isSourceFacts(value: unknown): value is SourceUsageFacts {
  return (
    isRecord(value) &&
    typeof value.fileName === 'string' &&
    Array.isArray(value.facts) &&
    value.facts.every(
      (fact) =>
        isRecord(fact) &&
        typeof fact.key === 'string' &&
        (fact.confidence === 'used' || fact.confidence === 'possibly-used') &&
        isEvidence(fact.evidence)
    ) &&
    Array.isArray(value.unresolvedReferences) &&
    value.unresolvedReferences.every(isEvidence)
  );
}

function isEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.confidence === 'used' || value.confidence === 'possibly-used') &&
    typeof value.file === 'string' &&
    typeof value.line === 'number' &&
    typeof value.column === 'number' &&
    typeof value.reason === 'string'
  );
}

function isApplicationSource(source: ts.SourceFile): boolean {
  const fileName = path.resolve(source.fileName);
  return !source.isDeclarationFile && !fileName.includes(`${path.sep}node_modules${path.sep}`);
}

/** Global scripts and module augmentations can affect files without resolvable import edges. */
function affectsGlobalScope(source: ts.SourceFile): boolean {
  if (!ts.isExternalModule(source)) return true;
  let found = false;
  function visit(node: ts.Node): void {
    if (
      ts.isModuleDeclaration(node) &&
      ((node.flags & ts.NodeFlags.GlobalAugmentation) !== 0 || ts.isStringLiteral(node.name))
    ) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(comparePaths)
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, normalize(value[key])])
  );
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function readPackageVersion(): string {
  try {
    const value: unknown = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    );
    return isRecord(value) && typeof value.version === 'string' ? value.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function addEdge(graph: Map<string, Set<string>>, from: string, to: string): void {
  const edges = graph.get(from) ?? new Set<string>();
  edges.add(to);
  graph.set(from, edges);
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
