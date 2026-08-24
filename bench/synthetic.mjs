import fs from 'node:fs';
import path from 'node:path';
import { bench, do_not_optimize, measure, run } from 'mitata';
import { lint } from '../dist/index.js';

const options = parseArguments(process.argv.slice(2));
const project = path.resolve(options.project);
const dictionary = path.resolve(project, options.dictionary);
const originalDictionary = fs.readFileSync(dictionary, 'utf8');

function* lintBenchmark() {
  yield {
    0() {
      if (options.remove) fs.writeFileSync(dictionary, originalDictionary);
    },
    bench() {
      return do_not_optimize(runLint());
    }
  };
}

function runLint() {
  let diagnosticCount = 0;
  for (const _diagnostic of lint({
    project,
    dictionaries: dictionary,
    dictionaryExport: options.export,
    cache: options.cache,
    ...(options.cacheDir ? { cacheDir: options.cacheDir } : {}),
    remove: options.remove
  })) {
    diagnosticCount += 1;
  }
  return diagnosticCount;
}

try {
  if (options.samples) {
    const stats = await measure(lintBenchmark, {
      min_samples: options.samples,
      max_samples: options.samples,
      min_cpu_time: 0,
      warmup_samples: 0,
      warmup_threshold: 0,
      batch_threshold: 0,
      inner_gc: true,
      gc: globalThis.gc,
      heap: () => process.memoryUsage().heapUsed
    });
    process.stdout.write(
      `${JSON.stringify({
        samples: stats.samples.length,
        averageMs: stats.avg / 1e6,
        p75Ms: stats.p75 / 1e6,
        p99Ms: stats.p99 / 1e6,
        heapBytes: stats.heap?.avg
      })}\n`
    );
  } else {
    bench(`lint() ${options.remove ? 'remove' : 'read'}`, lintBenchmark).gc('inner');
    await run({ throw: true });
  }
} finally {
  if (options.remove) fs.writeFileSync(dictionary, originalDictionary);
}

function parseArguments(arguments_) {
  const values = Object.create(null);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--') continue;
    if (argument === '--remove') {
      values.remove = true;
      continue;
    }
    if (argument === '--cache') {
      values.cache = true;
      continue;
    }
    if (!argument?.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const [name, inlineValue] = argument.slice(2).split('=', 2);
    const value = inlineValue ?? arguments_[++index];
    if (value === undefined) throw new Error(`Missing value for --${name}`);
    values[name] = value;
  }
  if (!values.project) throw new Error('--project <path> is required');
  const samples = values.samples === undefined ? undefined : Number(values.samples);
  if (samples !== undefined && (!Number.isSafeInteger(samples) || samples < 1)) {
    throw new Error('--samples must be a positive integer');
  }
  return {
    project: values.project,
    dictionary: values.dictionary ?? 'dictionary.ts',
    export: values.export ?? 'default',
    remove: values.remove === true,
    cache: values.cache === true,
    cacheDir: values['cache-dir'] ? path.resolve(values['cache-dir']) : undefined,
    samples
  };
}
