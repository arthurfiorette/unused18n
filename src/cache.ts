import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { version as typescriptVersion } from 'typescript';
import {
  isExternalModule,
  isStringLiteralLikeNode,
  type SourceFile,
  type StringLiteralLikeNode
} from 'typescript/ast';
import type { AnalysisReuse, LoadedDictionaryTarget, SourceUsageFacts } from './analyzer.js';
import {
  findConfigFile,
  isApplicationFileName,
  isDirectory,
  type LoadedProject
} from './project.js';

// Bump either version whenever persisted shape or analyzer semantics would make old facts unsafe.
const CACHE_SCHEMA_VERSION = 5;
const ANALYSIS_ALGORITHM_VERSION = 12;
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
  | { type: 'error'; operation: 'read' | 'write' | 'directory'; message: string };

export interface CachePaths {
  directory: string;
  entryFile: string;
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

/**
 * Keeps different projects, dictionaries, and exports from sharing analysis state.
 *
 * The project is located the same way `loadProjectWithDiagnostics` locates it, so the identity
 * matches the configuration that is actually loaded.
 */
export function resolveCachePaths(
  project: string,
  dictionaries: readonly string[],
  dictionaryExport: string | undefined,
  cacheDir?: string
): CachePaths {
  const resolvedProject = path.resolve(project);
  const configPath = isDirectory(resolvedProject)
    ? (findConfigFile(resolvedProject) ?? path.join(resolvedProject, 'tsconfig.json'))
    : resolvedProject;
  const projectDirectory = path.dirname(configPath);
  const directory = cacheDir
    ? path.resolve(cacheDir)
    : path.join(projectDirectory, 'node_modules', '.cache', 'unused18n');
  const identity = hashCanonical({
    project: configPath,
    dictionaries: dictionaries.map((dictionary) => path.resolve(dictionary)).sort(comparePaths),
    dictionaryExport: dictionaryExport ?? '<infer>'
  });
  return {
    directory,
    entryFile: path.join(directory, `analysis-${identity}.json`)
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
  dictionaries: LoadedDictionaryTarget[],
  options: {
    maxExpansions: number;
    paths: CachePaths;
  }
): PreparedAnalysisCache {
  const currentSources = snapshotSources(loaded);
  const compatibilityHash = computeCompatibilityHash(loaded, dictionaries, options);
  let cached = readEntry(options.paths.entryFile);
  if (
    cached !== undefined &&
    cached !== 'corrupt' &&
    !factsTargetCurrentDictionaries(cached, dictionaries)
  ) {
    cached = 'corrupt';
  }
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

  /**
   * Packages one reuse decision. `write` closes over the snapshot taken above, so the persisted
   * hashes and edges describe exactly the sources this run analyzed.
   */
  function prepared(
    event: CacheEvent,
    dirty: Set<string>,
    reusable: Map<string, SourceUsageFacts>
  ): PreparedAnalysisCache {
    return {
      event,
      reuse: { dictionaries, cachedFacts: reusable, filesToAnalyze: dirty },
      /**
       * Stores fresh and replayed facts together. Sources without facts get an empty entry, so
       * the next run sees them as known and unchanged.
       */
      write(sourceFacts) {
        const facts = new Map(sourceFacts.map((entry) => [path.resolve(entry.fileName), entry]));
        const sources = Object.fromEntries(
          Object.entries(currentSources).map(([fileName, source]) => [
            fileName,
            {
              ...source,
              facts: facts.get(fileName) ?? {
                fileName,
                observations: [],
                unresolvedReferences: [],
                translationObjectCasts: []
              }
            }
          ])
        );
        // Persist the merged fresh/replayed view so the next process needs only one complete entry.
        const entry: CacheEntry = {
          schemaVersion: CACHE_SCHEMA_VERSION,
          analysisVersion: ANALYSIS_ALGORITHM_VERSION,
          packageVersion,
          typescriptVersion,
          compatibilityHash,
          sources
        };
        writeEntry(options.paths.entryFile, entry);
        return { type: 'write', files: currentNames.length };
      }
    };
  }
}

function factsTargetCurrentDictionaries(
  entry: CacheEntry,
  dictionaries: LoadedDictionaryTarget[]
): boolean {
  const dictionaryIds = new Set(dictionaries.map(({ id }) => id));
  return Object.values(entry.sources).every(({ facts }) =>
    facts.observations.every(
      (observation) => observation.dictionaryIds?.every((id) => dictionaryIds.has(id)) ?? true
    )
  );
}

/**
 * Fingerprints every application source, including JSON roots such as dictionaries, so cached
 * facts are replayed only for files whose content, edges, and global reach are unchanged.
 */
function snapshotSources(loaded: LoadedProject): Record<string, CurrentSource> {
  const dependencies = dependenciesFor(loaded);
  return Object.fromEntries(
    loaded.sourceFiles.map((source, index) => [
      path.resolve(source.fileName),
      {
        hash: hash(source.text),
        dependencies: dependencies[index] ?? [],
        global: affectsGlobalScope(source)
      }
    ])
  );
}

/** Inputs that can alter semantic extraction without changing an application source force a miss. */
function computeCompatibilityHash(
  loaded: LoadedProject,
  dictionaries: LoadedDictionaryTarget[],
  options: { maxExpansions: number }
): string {
  const externalNames = loaded.fileNames.filter((fileName) => !isApplicationFileName(fileName));
  const metadata = loaded.semantic.batch(externalNames, (fileName) =>
    loaded.program.getSourceFileMetadata.gen(fileName)
  );
  const externalSources = externalNames
    // Bundled lib files change only with the compiler, which `typescriptVersion` already covers.
    .filter((_, index) => metadata[index]?.isDefaultLibrary !== true)
    .map((fileName) => [path.resolve(fileName), externalSourceHash(loaded, fileName)])
    .sort(([left], [right]) => comparePaths(left ?? '', right ?? ''));
  const compilerOptions = Object.fromEntries(
    Object.entries(loaded.program.getCompilerOptions()).filter(
      ([key, value]) =>
        value !== undefined &&
        // `configFilePath` duplicates `configPath` below; the others only steer compiler caching.
        key !== 'configFile' &&
        key !== 'configFilePath' &&
        key !== 'incremental' &&
        key !== 'tsBuildInfoFile'
    )
  );
  return hashCanonical({
    schemaVersion: CACHE_SCHEMA_VERSION,
    analysisVersion: ANALYSIS_ALGORITHM_VERSION,
    packageVersion,
    typescriptVersion,
    configPath: path.resolve(loaded.configPath),
    compilerOptions,
    dictionaries: dictionaries.map(({ id, locale, info }) => ({
      id,
      locale,
      keys: [...info.keys].sort(comparePaths)
    })),
    maxExpansions: options.maxExpansions,
    externalSources
  });
}

/**
 * Hashes an external file from disk so large package typings never cross the compiler IPC
 * boundary. Files with no disk copy, such as ones the compiler synthesizes, fall back to the
 * program's text.
 */
function externalSourceHash(loaded: LoadedProject, fileName: string): string | null {
  let contents: Buffer;
  try {
    contents = fs.readFileSync(fileName);
  } catch {
    const text = loaded.semantic.sourceFile(fileName)?.text;
    return text === undefined ? null : hash(text);
  }
  return hash(contents);
}

/**
 * Collects the application files each application source imports, in `loaded.sourceFiles` order.
 *
 * Edges are file paths, so they persist without process-local Symbols or Types. Module
 * specifiers go through the program's own resolution, so an edge exists exactly when the
 * checker followed it; every source is resolved in a single batched request because each
 * resolution is otherwise one IPC round trip.
 */
function dependenciesFor(loaded: LoadedProject): string[][] {
  const { program, semantic, sourceFiles } = loaded;
  const applicationNames = new Set(sourceFiles.map((source) => path.resolve(source.fileName)));
  const requests: { index: number; fileName: string; specifier: StringLiteralLikeNode }[] = [];
  sourceFiles.forEach((source, index) => {
    // Augmentations of other modules are listed separately from imports; `declare global`
    // names are identifiers and drop out here.
    for (const node of [...source.imports, ...source.moduleAugmentations]) {
      if (isStringLiteralLikeNode(node)) {
        requests.push({ index, fileName: source.fileName, specifier: node });
      }
    }
  });
  const resolved = semantic.batch(requests, ({ fileName, specifier }) =>
    program.getResolvedModuleFromModuleSpecifier.gen(specifier, fileName)
  );

  const dependencies = sourceFiles.map(() => new Set<string>());
  requests.forEach(({ index }, position) => {
    const resolvedFileName = resolved[position]?.resolvedFileName;
    if (!resolvedFileName) return;
    const fileName = path.resolve(resolvedFileName);
    if (applicationNames.has(fileName)) dependencies[index]?.add(fileName);
  });
  sourceFiles.forEach((source, index) => {
    for (const reference of source.referencedFiles) {
      const fileName = path.resolve(path.dirname(source.fileName), reference.fileName);
      if (applicationNames.has(fileName)) dependencies[index]?.add(fileName);
    }
  });
  return dependencies.map((edges) => [...edges].sort(comparePaths));
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

/**
 * Validates an entry read from disk. Any version mismatch, including the TypeScript version,
 * makes the whole entry unusable because facts may depend on checker behavior.
 */
function isCacheEntry(value: unknown): value is CacheEntry {
  if (!isRecord(value) || !isRecord(value.sources)) return false;
  if (
    value.schemaVersion !== CACHE_SCHEMA_VERSION ||
    value.analysisVersion !== ANALYSIS_ALGORITHM_VERSION ||
    value.packageVersion !== packageVersion ||
    value.typescriptVersion !== typescriptVersion ||
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
    Array.isArray(value.observations) &&
    value.observations.every(
      (observation) =>
        isRecord(observation) &&
        (observation.kind === 'exact' ||
          observation.kind === 'prefix' ||
          observation.kind === 'pattern') &&
        typeof observation.value === 'string' &&
        (observation.confidence === 'used' || observation.confidence === 'possibly-used') &&
        (observation.dictionaryIds === undefined ||
          (Array.isArray(observation.dictionaryIds) &&
            observation.dictionaryIds.every((id) => typeof id === 'string'))) &&
        isEvidence(observation.evidence)
    ) &&
    Array.isArray(value.unresolvedReferences) &&
    value.unresolvedReferences.every(isEvidence) &&
    Array.isArray(value.translationObjectCasts) &&
    value.translationObjectCasts.every(isEvidence)
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

/**
 * Global scripts and module augmentations can affect files without resolvable import edges.
 *
 * The binder records both `declare global {}` and `declare module "x" {}` of a module in
 * `moduleAugmentations` while plain namespaces never appear there, so the check needs no AST
 * walk.
 */
function affectsGlobalScope(source: SourceFile): boolean {
  return !isExternalModule(source) || source.moduleAugmentations.length > 0;
}

function hashCanonical(value: unknown): string {
  const digest = createHash('sha256');
  updateCanonicalHash(digest, value);
  return digest.digest('hex');
}

/**
 * Feeds canonical JSON (sorted keys, `undefined` members dropped) to the digest in pieces, so
 * large inputs such as dictionary key lists never become one string.
 */
function updateCanonicalHash(digest: ReturnType<typeof createHash>, value: unknown): void {
  if (Array.isArray(value)) {
    digest.update('[');
    value.forEach((entry, index) => {
      if (index > 0) digest.update(',');
      updateCanonicalHash(digest, entry);
    });
    digest.update(']');
    return;
  }
  if (isRecord(value)) {
    digest.update('{');
    const keys = Object.keys(value)
      .sort(comparePaths)
      .filter((key) => value[key] !== undefined);
    keys.forEach((key, index) => {
      if (index > 0) digest.update(',');
      digest.update(JSON.stringify(key));
      digest.update(':');
      updateCanonicalHash(digest, value[key]);
    });
    digest.update('}');
    return;
  }
  digest.update(value === undefined ? 'null' : JSON.stringify(value));
}

/**
 * Fingerprints source contents. Raw bytes are accepted so external files read from disk are
 * hashed without decoding them first.
 */
function hash(value: string | Uint8Array): string {
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
