import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from '@typescript/typescript6';
import { DiagnosticCode } from './diagnostic-codes.js';

/** One compiler graph shared by diagnostics, semantic analysis, and optional fixes. */
export interface LoadedProject {
  program: ts.Program;
  checker: ts.TypeChecker;
  configPath: string;
  /** Persists compiler graph/signature state only after current diagnostics are known to be usable. */
  saveBuildInfo?: () => void;
  /** Incremental setup failures are advisory because a normal Program remains fully correct. */
  cacheError?: string;
}

export interface ProjectLoadResult {
  loaded?: LoadedProject;
  diagnostics: ts.Diagnostic[];
}

export interface ProjectLoadOptions {
  /** Enables cross-process compiler reuse without writing project build artifacts. */
  tsBuildInfoFile?: string;
}

/** Convenience wrapper for internal callers that treat project configuration failures as exceptions. */
export function loadProject(projectPath: string, extraFiles: string[] = []): LoadedProject {
  const result = loadProjectWithDiagnostics(projectPath, extraFiles);
  if (result.loaded) return result.loaded;
  throw new Error(
    result.diagnostics
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      .join('\n')
  );
}

/**
 * Preserves native configuration diagnostics for linter output instead of flattening expected
 * project failures into thrown strings that lose source context.
 */
export function loadProjectWithDiagnostics(
  projectPath: string,
  extraFiles: string[] = [],
  loadOptions: ProjectLoadOptions = {}
): ProjectLoadResult {
  const resolved = path.resolve(projectPath);
  const configPath = ts.sys.directoryExists(resolved)
    ? ts.findConfigFile(resolved, ts.sys.fileExists, 'tsconfig.json')
    : resolved;
  if (!configPath || !ts.sys.fileExists(configPath)) {
    return {
      diagnostics: [createConfigurationDiagnostic(`TypeScript project not found: ${projectPath}`)]
    };
  }

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) return { diagnostics: [configFile.error] };
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath
  );
  if (parsed.errors.length > 0) return { diagnostics: parsed.errors };

  const roots = new Set(parsed.fileNames.map((file) => path.resolve(file)));
  for (const file of extraFiles) roots.add(path.resolve(file));
  const resolveJsonModule = extraFiles.some((file) => path.extname(file).toLowerCase() === '.json');
  const jsonOptions: ts.CompilerOptions = {
    ...parsed.options,
    allowNonTsExtensions: true
  };
  if (parsed.options.moduleResolution !== ts.ModuleResolutionKind.Classic) {
    jsonOptions.resolveJsonModule = true;
  }
  const createOptions: ts.CreateProgramOptions = {
    rootNames: [...roots].sort(comparePaths),
    options: resolveJsonModule ? jsonOptions : parsed.options
  };
  if (parsed.projectReferences) createOptions.projectReferences = parsed.projectReferences;
  let program: ts.Program;
  let saveBuildInfo: (() => void) | undefined;
  let cacheError: string | undefined;
  if (loadOptions.tsBuildInfoFile) {
    try {
      const tsBuildInfoFile = path.resolve(loadOptions.tsBuildInfoFile);
      const incrementalOptions: ts.CompilerOptions = {
        ...createOptions.options,
        incremental: true,
        tsBuildInfoFile
      };
      const host = ts.createIncrementalCompilerHost(incrementalOptions);
      let pendingBuildInfo: string | undefined;
      // Builder emit is needed to save `.tsbuildinfo`; discard every normal project output.
      host.writeFile = (fileName, data, writeByteOrderMark) => {
        if (path.resolve(fileName) === tsBuildInfoFile) {
          pendingBuildInfo = writeByteOrderMark ? `\uFEFF${data}` : data;
        }
      };
      const builderOptions: ts.IncrementalProgramOptions<ts.EmitAndSemanticDiagnosticsBuilderProgram> =
        {
          rootNames: createOptions.rootNames,
          options: incrementalOptions,
          host
        };
      if (createOptions.projectReferences) {
        builderOptions.projectReferences = createOptions.projectReferences;
      }
      let builder: ts.EmitAndSemanticDiagnosticsBuilderProgram | undefined =
        ts.createIncrementalProgram(builderOptions);
      program = builder.getProgram();
      // Defer emit so malformed projects never establish trusted compiler cache state.
      saveBuildInfo = () => {
        const currentBuilder = builder;
        if (!currentBuilder) return;
        pendingBuildInfo = undefined;
        try {
          const result = currentBuilder.emit();
          if (result.diagnostics.length > 0) {
            throw new Error(
              ts.formatDiagnostics(result.diagnostics, {
                getCanonicalFileName: (fileName) => fileName,
                getCurrentDirectory: () => process.cwd(),
                getNewLine: () => ts.sys.newLine
              })
            );
          }
          if (pendingBuildInfo !== undefined)
            writeBuildInfoAtomically(tsBuildInfoFile, pendingBuildInfo);
        } finally {
          // Analysis needs the Program, not builder-only emit queues or pending serialized state.
          builder = undefined;
          pendingBuildInfo = undefined;
        }
      };
    } catch (error) {
      cacheError = error instanceof Error ? error.message : String(error);
      program = ts.createProgram(createOptions);
    }
  } else {
    program = ts.createProgram(createOptions);
  }
  return {
    loaded: {
      program,
      checker: program.getTypeChecker(),
      configPath: path.resolve(configPath),
      ...(saveBuildInfo ? { saveBuildInfo } : {}),
      ...(cacheError ? { cacheError } : {})
    },
    diagnostics: []
  };
}

/** Concurrent readers see either the previous complete compiler state or the next complete state. */
function writeBuildInfoAtomically(fileName: string, contents: string): void {
  fs.mkdirSync(path.dirname(fileName), { mode: 0o700, recursive: true });
  const temporary = path.join(
    path.dirname(fileName),
    `.${path.basename(fileName)}.${randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, fileName);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function createConfigurationDiagnostic(messageText: string): ts.Diagnostic {
  return {
    category: ts.DiagnosticCategory.Error,
    code: DiagnosticCode.ConfigurationFailure,
    file: undefined,
    length: undefined,
    messageText,
    source: 'unused18n',
    start: undefined
  };
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
