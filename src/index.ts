import { Command, Flags } from '@oclif/core';
import ts from '@typescript/typescript6';
import { DiagnosticCode, lint } from './lint.js';

const formatHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (fileName) => fileName,
  getCurrentDirectory: () => process.cwd(),
  getNewLine: () => ts.sys.newLine
};

export default class Unused18n extends Command {
  static override description =
    'Lint a TypeScript i18next dictionary and report keys without statically recoverable usage.';

  static override examples = [
    '<%= config.bin %> lint --project ./tsconfig.json --dictionary ./src/i18n/pt.ts --export dictionary',
    '<%= config.bin %> lint --project . --dictionary ./src/i18n/pt.ts --export dictionary --remove'
  ];

  static override flags = {
    dictionary: Flags.string({
      char: 'd',
      helpValue: '<path>',
      required: true,
      summary: 'TypeScript source file containing the dictionary export'
    }),
    export: Flags.string({
      char: 'e',
      helpValue: '<name>',
      required: true,
      default: 'default',
      summary: 'Exported dictionary variable name'
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
      remove: flags.remove
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

export type { LintOptions } from './lint.js';
export { DiagnosticCode, lint };
