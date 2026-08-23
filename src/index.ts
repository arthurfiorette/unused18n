import { Command, Flags } from '@oclif/core';
import ts from '@typescript/typescript6';
import { type CacheEvent, DiagnosticCode, lint } from './lint.js';

const formatHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => process.cwd(),
  getNewLine: () => ts.sys.newLine
};

export default class Unused18n extends Command {
  static override description =
    'Lint a TypeScript or JSON i18next dictionary and report keys without statically recoverable usage.';

  static override examples = [
    '<%= config.bin %> lint --project ./tsconfig.json --dictionary ./src/i18n/pt.ts --export dictionary',
    '<%= config.bin %> lint --project . --dictionary ./src/i18n/en.json --remove'
  ];

  static override flags = {
    cache: Flags.boolean({
      allowNo: true,
      default: true,
      summary: 'Reuse persistent compiler and per-file analysis caches'
    }),
    'cache-dir': Flags.string({
      helpValue: '<path>',
      summary: 'Override the persistent cache directory'
    }),
    'cache-stats': Flags.boolean({
      default: false,
      summary: 'Report cache hits, misses, reuse, and bypasses'
    }),
    dictionary: Flags.string({
      char: 'd',
      helpValue: '<path>',
      required: true,
      summary: 'TypeScript or JSON source file containing the dictionary'
    }),
    export: Flags.string({
      char: 'e',
      helpValue: '<name>',
      default: 'default',
      summary: 'TypeScript dictionary export name; JSON uses default'
    }),
    'max-expansions': Flags.integer({
      default: 1_000,
      min: 1,
      summary: 'Maximum finite string-union expansion'
    }),
    project: Flags.string({
      char: 'p',
      helpValue: '<path>',
      required: true,
      summary: 'tsconfig.json path or its containing directory'
    }),
    remove: Flags.boolean({
      default: false,
      summary: 'Remove every safely editable unused dictionary key'
    }),
    version: Flags.version({ char: 'v' })
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Unused18n);
    let failed = false;

    for (const diagnostic of lint({
      project: flags.project,
      dictionary: flags.dictionary,
      dictionaryExport: flags.export,
      maxExpansions: flags['max-expansions'],
      remove: flags.remove,
      cache: flags.cache,
      ...(flags['cache-dir'] ? { cacheDir: flags['cache-dir'] } : {}),
      ...(flags['cache-stats']
        ? { onCacheEvent: (event: CacheEvent) => this.logToStderr(formatCacheEvent(event)) }
        : {})
    })) {
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
export { DiagnosticCode, lint };

function formatCacheEvent(event: CacheEvent): string {
  if (event.type === 'write') return `[cache] write files=${event.files}`;
  if (event.type === 'bypass') return `[cache] bypass (${event.reason})`;
  if (event.type === 'error') return `[cache] ${event.operation} error: ${event.message}`;
  const reason = event.reason ? ` (${event.reason})` : '';
  return `[cache] ${event.type}${reason} analyzed=${event.analyzedFiles} reused=${event.reusedFiles}`;
}
