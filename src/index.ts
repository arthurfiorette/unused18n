import { Command, Flags } from '@oclif/core';
import ts from '@typescript/typescript6';
import { ConfigFileError, loadConfig } from './config.js';
import { DiagnosticCode, type LintOptions, lint } from './lint.js';
import { createReporter } from './reporter.js';
import type { Unused18nConfig } from './types.js';

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
    summary: 'TypeScript export name; otherwise prefer default or infer the sole export'
  }),
  'max-expansions': Flags.integer({
    min: 1,
    summary: 'Maximum finite string-union expansion (default: 1000)'
  }),
  'log-level': Flags.string({
    options: ['silent', 'info', 'debug'],
    summary: 'Operational logging level (default: info)'
  }),
  project: Flags.string({
    char: 'p',
    helpValue: '<path>',
    summary: 'tsconfig.json path or directory (default: ./tsconfig.json)'
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
  cacheStats: 'cache-stats',
  logLevel: 'log-level'
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

    const project = flags.project ?? fileConfig.project ?? './tsconfig.json';
    const dictionaries = flags.dictionary ?? fileConfig.dictionaries;
    if (!dictionaries) {
      this.error('Missing required option: provide --dictionary or set "dictionaries" in config.', {
        exit: 2
      });
    }

    const dictionaryExport = flags.export ?? fileConfig.dictionaryExport;
    const maxExpansions = flags['max-expansions'] ?? fileConfig.maxExpansions ?? 1_000;
    const remove = flags.remove ?? fileConfig.remove ?? false;
    const cache = flags.cache ?? fileConfig.cache ?? true;
    const cacheDir = flags['cache-dir'] ?? fileConfig.cacheDir;
    const cacheStats = flags['cache-stats'] ?? fileConfig.cacheStats ?? false;
    const requestedLogLevel = flags['log-level'] ?? fileConfig.logLevel;
    const logLevel =
      requestedLogLevel === 'silent' || requestedLogLevel === 'debug'
        ? requestedLogLevel
        : cacheStats
          ? 'debug'
          : 'info';
    let failed = false;
    const reporter = createReporter({
      level: logLevel,
      isTTY: process.stderr.isTTY === true,
      write: (message) => this.logToStderr(message)
    });

    const lintOptions = {
      project,
      dictionaries,
      ...(dictionaryExport === undefined ? {} : { dictionaryExport }),
      maxExpansions,
      remove,
      cache,
      ...(cacheDir ? { cacheDir } : {}),
      onEvent: reporter.event
    } satisfies LintOptions;

    for (const diagnostic of lint(lintOptions)) {
      reporter.diagnostic(diagnostic);
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

export type { CacheEvent, LintEvent, LintOptions } from './lint.js';
export type { LogLevel, Unused18nConfig } from './types.js';
export { DiagnosticCode, lint };
