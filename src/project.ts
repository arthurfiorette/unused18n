import fs from 'node:fs';
import path from 'node:path';
import type { SourceFile } from 'typescript/ast';
import { API, type Diagnostic, DiagnosticCategory, type Program } from 'typescript/sync';
import { DiagnosticCode } from './diagnostic-codes.js';
import { diagnosticWithoutFile, flattenDiagnosticText } from './diagnostics.js';
import { Semantic } from './semantic.js';

/**
 * One compiler process and program shared by diagnostics, semantic analysis, and optional fixes.
 *
 * Disposing closes the compiler process; disposing again does nothing. Nodes stay readable
 * afterwards, but every checker query, including lazy ones behind {@link semantic}, throws once
 * disposed.
 */
export interface LoadedProject extends Disposable {
  api: API;
  program: Program;
  semantic: Semantic;
  configPath: string;
  /** Every program file, including default libraries and package typings, in program order. */
  fileNames: readonly string[];
  /** Non-declaration program files outside `node_modules`, in program order. */
  sourceFiles: readonly SourceFile[];
}

export interface ProjectLoadResult {
  loaded?: LoadedProject;
  diagnostics: Diagnostic[];
}

/** Convenience wrapper for internal callers that treat project configuration failures as exceptions. */
export function loadProject(projectPath: string, extraFiles: string[] = []): LoadedProject {
  const result = loadProjectWithDiagnostics(projectPath, extraFiles);
  if (result.loaded) return result.loaded;
  throw new Error(
    result.diagnostics.map((diagnostic) => flattenDiagnosticText(diagnostic)).join('\n')
  );
}

/**
 * Preserves native configuration diagnostics for linter output instead of flattening expected
 * project failures into thrown strings that lose source context.
 *
 * The compiler process starts here and is closed before returning whenever no project is
 * loaded, so callers only own a process when they receive `loaded`.
 *
 * @param projectPath A `tsconfig.json` path, or a directory searched upwards for one.
 * @param extraFiles Root files added on top of the configuration, such as JSON dictionaries.
 */
export function loadProjectWithDiagnostics(
  projectPath: string,
  extraFiles: string[] = []
): ProjectLoadResult {
  const resolved = path.resolve(projectPath);
  const configPath = isDirectory(resolved) ? findConfigFile(resolved) : resolved;
  if (!configPath || !isFile(configPath)) {
    return {
      diagnostics: [
        diagnosticWithoutFile(
          DiagnosticCode.ConfigurationFailure,
          DiagnosticCategory.Error,
          `TypeScript project not found: ${projectPath}`
        )
      ]
    };
  }

  let api: API;
  try {
    api = new API();
  } catch (error) {
    return {
      diagnostics: [
        diagnosticWithoutFile(
          DiagnosticCode.ConfigurationFailure,
          DiagnosticCategory.Error,
          `Cannot start the TypeScript compiler: ${error instanceof Error ? error.message : String(error)}`
        )
      ]
    };
  }
  try {
    // parseConfigFile tolerates JSON syntax errors and throws on unreadable files, so the raw
    // read runs first and reports both as diagnostics, the way tsc does.
    const read = api.readConfigFile(configPath);
    if (read.error) {
      closeQuietly(api);
      return { diagnostics: [read.error] };
    }
    const parsed = api.parseConfigFile(configPath);
    if (parsed.errors.length > 0) {
      closeQuietly(api);
      return { diagnostics: [...parsed.errors] };
    }

    const roots = new Set(parsed.fileNames.map((file) => path.resolve(file)));
    for (const file of extraFiles) roots.add(path.resolve(file));
    const program = api.createProgram(
      [...roots].sort(comparePaths),
      {
        ...parsed.options,
        // Referenced projects contribute their built declarations, as with `tsc -p`. Loading
        // their sources instead would analyze another project's files as application code:
        // keys used only there would count as used, and fixes could edit them.
        disableSourceOfProjectReferenceRedirect: true,
        // Dictionaries may be JSON files the project never imports, so they must be accepted as
        // roots regardless of the project's own module settings.
        ...(extraFiles.some((file) => path.extname(file).toLowerCase() === '.json')
          ? { allowNonTsExtensions: true, resolveJsonModule: true }
          : {})
      },
      { projectReferences: parsed.projectReferences, configFileParsingDiagnostics: parsed.errors }
    );
    const semantic = new Semantic(api, program);
    const fileNames = program.getSourceFileNames();
    const sourceFiles = semantic
      .prefetchSourceFiles(fileNames.filter((fileName) => isApplicationFileName(fileName)))
      .filter((sourceFile): sourceFile is SourceFile => sourceFile !== undefined);
    let closed = false;
    return {
      loaded: {
        api,
        program,
        semantic,
        configPath,
        fileNames,
        sourceFiles,
        /** lint closes early and again in a `finally`; only the first call reaches the API. */
        [Symbol.dispose]() {
          if (closed) return;
          closed = true;
          closeQuietly(api);
        }
      },
      diagnostics: []
    };
  } catch (error) {
    closeQuietly(api);
    throw error;
  }
}

/**
 * Closes the compiler process without throwing.
 *
 * Closing releases remote snapshots first, which fails with EPIPE when the process already
 * died. The client is torn down regardless, and cleanup must not replace the error or
 * diagnostic that explains the crash.
 */
function closeQuietly(api: API): void {
  try {
    api.close();
  } catch {
    // The process is gone either way; nothing is left to release.
  }
}

/**
 * Selects files the analyzer treats as application code. Declaration files are recognized by
 * name so lib and package typings never have to be transferred from the compiler.
 */
export function isApplicationFileName(fileName: string): boolean {
  const resolved = path.resolve(fileName);
  return (
    !isDeclarationFileName(resolved) && !resolved.includes(`${path.sep}node_modules${path.sep}`)
  );
}

/**
 * Mirrors the compiler's case-sensitive declaration file test: `.d.ts`, `.d.mts`, `.d.cts`, and
 * any `.ts` file whose base name contains `.d.`, such as `styles.d.css.ts`.
 */
function isDeclarationFileName(fileName: string): boolean {
  return /\.d\.(?:[cm]?ts|.*\.ts)$/.test(path.basename(fileName));
}

/** Walks up from `directory` to the nearest `tsconfig.json`, like `tsc` without `--project`. */
export function findConfigFile(directory: string): string | undefined {
  let current = path.resolve(directory);
  while (true) {
    const candidate = path.join(current, 'tsconfig.json');
    if (isFile(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Returns whether `fileName` exists and is a directory, treating access errors as absence. */
export function isDirectory(fileName: string): boolean {
  try {
    return fs.statSync(fileName).isDirectory();
  } catch {
    return false;
  }
}

/** Returns whether `fileName` exists and is a regular file, treating access errors as absence. */
function isFile(fileName: string): boolean {
  try {
    return fs.statSync(fileName).isFile();
  } catch {
    return false;
  }
}

/** Orders paths by code unit so root order, and therefore program order, is deterministic. */
function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
