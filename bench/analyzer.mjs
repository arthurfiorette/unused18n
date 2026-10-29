import fs from 'node:fs';
import path from 'node:path';
import { bench, do_not_optimize, run } from 'mitata';
import { API } from 'typescript/sync';
import { lint } from '../dist/index.js';
import { inventorySource } from '../dist/source-inventory.js';

const options = parseArguments(process.argv.slice(2));
const project = path.resolve(options.project);
const dictionary = path.resolve(project, options.dictionary);
const usagePath = path.resolve(project, options.source);
const usageText = fs.readFileSync(usagePath, 'utf8');
/** Semantic lookup counts from the latest measured `lint()` call; every call makes the same lookups. */
let semanticLookups;

// Parsing happens once, outside the measured function, so the inventory case times traversal only.
const api = new API();
try {
  const usageSource = api.createSourceFile(usagePath, usageText).sourceFile;

  bench('inventorySource()', () => {
    return do_not_optimize(inventorySource(usageSource).usageNodes.length);
  });

  bench('lint() analyzer', () => {
    let diagnosticCount = 0;
    for (const _diagnostic of lint({
      project,
      dictionaries: dictionary,
      dictionaryExport: options.export,
      cache: false,
      onEvent: (event) => {
        if (event.type === 'semantic') semanticLookups = event;
      }
    })) {
      diagnosticCount += 1;
    }
    return do_not_optimize(diagnosticCount);
  }).gc('inner');

  await run({ throw: true });
  if (semanticLookups) {
    process.stdout.write(
      `lint() analyzer semantic lookups: single=${semanticLookups.singleRequests} batch=${semanticLookups.batchRequests}\n`
    );
  }
} finally {
  api.close();
}

/**
 * Reads `--name value` and `--name=value` flags.
 *
 * @param {string[]} arguments_ Process arguments after the script path.
 */
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
