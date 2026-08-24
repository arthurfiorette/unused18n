import fs from 'node:fs';
import path from 'node:path';
import ts from '@typescript/typescript6';
import { bench, do_not_optimize, run } from 'mitata';
import { lint } from '../dist/index.js';
import { inventorySource } from '../dist/source-inventory.js';

const options = parseArguments(process.argv.slice(2));
const project = path.resolve(options.project);
const dictionary = path.resolve(project, options.dictionary);
const usagePath = path.resolve(project, options.source);
const usageText = fs.readFileSync(usagePath, 'utf8');
const usageSource = ts.createSourceFile(
  usagePath,
  usageText,
  ts.ScriptTarget.Latest,
  true,
  usagePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
);

bench('inventorySource()', () => {
  return do_not_optimize(inventorySource(usageSource).usageNodes.length);
});

bench('lint() analyzer', () => {
  let diagnosticCount = 0;
  for (const _diagnostic of lint({
    project,
    dictionaries: dictionary,
    dictionaryExport: options.export,
    cache: false
  })) {
    diagnosticCount += 1;
  }
  return do_not_optimize(diagnosticCount);
}).gc('inner');

await run({ throw: true });

function parseArguments(arguments_) {
  const values = Object.create(null);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--') continue;
    if (!argument?.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const [name, inlineValue] = argument.slice(2).split('=', 2);
    const value = inlineValue ?? arguments_[++index];
    if (value === undefined) throw new Error(`Missing value for --${name}`);
    values[name] = value;
  }
  if (!values.project) throw new Error('--project <path> is required');
  return {
    project: values.project,
    dictionary: values.dictionary ?? 'dictionary.ts',
    export: values.export ?? 'default',
    source: values.source ?? 'usage.ts'
  };
}
