import { Command, Flags } from '@oclif/core';
import ts from '@typescript/typescript6';
import { ConfigFileError, loadConfig } from './config.js';
import { type CacheEvent, DiagnosticCode, type LintOptions, lint } from './lint.js';
import type { Unused18nConfig } from './types.js';

const formatHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => process.cwd(),
  getNewLine: () => ts.sys.newLine
};

const cliFlags = {
  cache: Flags.boolean({
    allowNo: true,
    summary: 'Reuse persistent compiler and per-file analysis caches (default: true)'
  }),
  'cache-dir': Flags.string({
    helpValue: '<path>',
    summary: 'Override the persistent cache directory'
  }),
  'cache-stats': Flags.boolean({
    allowNo: true,
    summary: 'Report cache hits, misses, reuse, and bypasses'
  }),
  config: Flags.string({
    helpValue: '<path>',
    summary: 'Load JSON options from this file instead of .unused18nrc'
  }),
  dictionary: Flags.string({
    char: 'd',
    helpValue: '<path>',
    multiple: true,
    summary: 'TypeScript or JSON dictionary path or glob; repeat for multiple patterns'
  }),
  export: Flags.string({
    char: 'e',
    helpValue: '<name>',
    summary: 'TypeScript dictionary export name (default: default); JSON uses default'
  }),
  'max-expansions': Flags.integer({
    min: 1,
    summary: 'Maximum finite string-union expansion (default: 1000)'
  }),
  project: Flags.string({
    char: 'p',
    helpValue: '<path>',
    summary: 'tsconfig.json path or its containing directory'
  }),
  remove: Flags.boolean({
    allowNo: true,
    summary: 'Remove every safely editable unused dictionary key'
  }),
  version: Flags.version({ char: 'v' })
};

type ConfigOptionName = Exclude<keyof Unused18nConfig, '$schema'>;
type ConfigurableCliFlag = Exclude<keyof typeof cliFlags, 'config' | 'version'>;

// Both directions are checked so adding either a config field or configurable flag breaks typecheck.
const configFlagNames = {
  project: 'project',
  dictionaries: 'dictionary',
  dictionaryExport: 'export',
  maxExpansions: 'max-expansions',
  remove: 'remove',
  cache: 'cache',
  cacheDir: 'cache-dir',
  cacheStats: 'cache-stats'
} as const satisfies Record<ConfigOptionName, ConfigurableCliFlag>;

type MappedCliFlag = (typeof configFlagNames)[ConfigOptionName];
const allConfigurableFlagsMapped: Exclude<ConfigurableCliFlag, MappedCliFlag> extends never
  ? true
  : never = true;
void allConfigurableFlagsMapped;

export default class Unused18n extends Command {
  static override description =
    'Lint a TypeScript or JSON i18next dictionary and report keys without statically recoverable usage.';

  static override examples = [
    '<%= config.bin %> lint --project ./tsconfig.json --dictionary "./src/i18n/*.json"',
    '<%= config.bin %> lint --project . --dictionary ./src/i18n/en.ts --export dictionary --remove'
  ];

  static override flags = cliFlags;

  async run(): Promise<void> {
    const { flags } = await this.parse(Unused18n);
    let fileConfig: Unused18nConfig;
    try {
      fileConfig = loadConfig(flags.config).config;
    } catch (error) {
      this.error(error instanceof ConfigFileError ? error.message : String(error), { exit: 2 });
    }

    const project = flags.project ?? fileConfig.project;
    const dictionaries = flags.dictionary ?? fileConfig.dictionaries;
    if (!project)
      this.error('Missing required option: provide --project or set "project" in config.', {
        exit: 2
      });
    if (!dictionaries) {
      this.error('Missing required option: provide --dictionary or set "dictionaries" in config.', {
        exit: 2
      });
    }

    const dictionaryExport = flags.export ?? fileConfig.dictionaryExport ?? 'default';
    const maxExpansions = flags['max-expansions'] ?? fileConfig.maxExpansions ?? 1_000;
    const remove = flags.remove ?? fileConfig.remove ?? false;
    const cache = flags.cache ?? fileConfig.cache ?? true;
    const cacheDir = flags['cache-dir'] ?? fileConfig.cacheDir;
    const cacheStats = flags['cache-stats'] ?? fileConfig.cacheStats ?? false;
    let failed = false;

    const lintOptions = {
      project,
      dictionaries,
      dictionaryExport,
      maxExpansions,
      remove,
      cache,
      ...(cacheDir ? { cacheDir } : {}),
      ...(cacheStats
        ? { onCacheEvent: (event: CacheEvent) => this.logToStderr(formatCacheEvent(event)) }
        : {})
    } satisfies LintOptions;

    for (const diagnostic of lint(lintOptions)) {
      this.logToStderr(ts.formatDiagnosticsWithColorAndContext([diagnostic], formatHost).trimEnd());
      if (
        diagnostic.category === ts.DiagnosticCategory.Error ||
        diagnostic.code === DiagnosticCode.UnusedKey
      ) {
        failed = true;
      }
    }

    if (failed) this.exit(1);
  }
}

export const COMMANDS = { lint: Unused18n };

export type { CacheEvent, LintOptions } from './lint.js';
export type { Unused18nConfig } from './types.js';
export { DiagnosticCode, lint };

function formatCacheEvent(event: CacheEvent): string {
  if (event.type === 'write') return `[cache] write files=${event.files}`;
  if (event.type === 'bypass') return `[cache] bypass (${event.reason})`;
  if (event.type === 'error') return `[cache] ${event.operation} error: ${event.message}`;
  const reason = event.reason ? ` (${event.reason})` : '';
  return `[cache] ${event.type}${reason} analyzed=${event.analyzedFiles} reused=${event.reusedFiles}`;
}
