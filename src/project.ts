import path from 'node:path';
import ts from '@typescript/typescript6';
import { DiagnosticCode } from './diagnostic-codes.js';

/** One compiler graph shared by diagnostics, semantic analysis, and optional fixes. */
export interface LoadedProject {
  program: ts.Program;
  checker: ts.TypeChecker;
  configPath: string;
}

export interface ProjectLoadResult {
  loaded?: LoadedProject;
  diagnostics: ts.Diagnostic[];
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
  extraFiles: string[] = []
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
  const program = ts.createProgram(createOptions);
  return {
    loaded: { program, checker: program.getTypeChecker(), configPath: path.resolve(configPath) },
    diagnostics: []
  };
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
