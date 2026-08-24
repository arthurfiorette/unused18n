import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeLoadedProjectMany } from '../dist/analyzer.js';
import { prepareAnalysisCache, resolveCachePaths } from '../dist/cache.js';
import { readDictionary } from '../dist/dictionary.js';
import { DiagnosticCode, lint } from '../dist/index.js';
import { loadProject } from '../dist/project.js';

const cli = fileURLToPath(new URL('../bin/run.js', import.meta.url));

function temporaryProject(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'unused18n-cache-'));
  t.after(() => fs.rmSync(project, { force: true, recursive: true }));
  fs.writeFileSync(
    path.join(project, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { strict: true }, include: ['*.ts'] })
  );
  fs.writeFileSync(
    path.join(project, 'dictionary.ts'),
    `export default { used: 'Used', unused: 'Unused' }\n`
  );
  fs.writeFileSync(
    path.join(project, 'usage.ts'),
    `import dictionary from './dictionary.js'\ndictionary.used\n`
  );
  fs.writeFileSync(path.join(project, 'other.ts'), `export const unrelated = 1\n`);
  return project;
}

function runLint(project, cacheDir, overrides = {}) {
  const events = [];
  const diagnostics = [
    ...lint({
      project,
      dictionary: path.join(project, 'dictionary.ts'),
      cacheDir,
      onCacheEvent: (event) => events.push(event),
      ...overrides
    })
  ];
  return { diagnostics, events };
}

function portableDiagnostics(diagnostics) {
  return diagnostics.map((diagnostic) => ({
    category: diagnostic.category,
    code: diagnostic.code,
    file: diagnostic.file?.fileName,
    length: diagnostic.length,
    message: String(diagnostic.messageText),
    start: diagnostic.start
  }));
}

function filesUnder(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { recursive: true }).map((entry) => path.join(directory, entry));
}

test('persists compiler build info and reuses complete analysis facts', (t) => {
  const project = temporaryProject(t);
  const cacheDir = path.join(project, 'cache');

  const cold = runLint(project, cacheDir);
  const warm = runLint(project, cacheDir);

  assert.deepEqual(portableDiagnostics(warm.diagnostics), portableDiagnostics(cold.diagnostics));
  assert.deepEqual(
    cold.events.map(({ type }) => type),
    ['miss', 'write']
  );
  assert.equal(cold.events[0]?.analyzedFiles, 3);
  assert.equal(cold.events[0]?.reusedFiles, 0);
  assert.deepEqual(
    warm.events.map(({ type }) => type),
    ['hit']
  );
  assert.equal(warm.events[0]?.analyzedFiles, 0);
  assert.equal(warm.events[0]?.reusedFiles, 3);

  const cacheFiles = filesUnder(cacheDir);
  assert.ok(cacheFiles.some((file) => file.endsWith('.tsbuildinfo')));
  assert.ok(cacheFiles.some((file) => file.endsWith('.json')));
  assert.equal(fs.existsSync(path.join(project, 'usage.js')), false);
  assert.equal(fs.existsSync(path.join(project, 'dictionary.js')), false);
});

test('persists compact subtree observations and replays deterministic evidence', (t) => {
  const project = temporaryProject(t);
  const cacheDir = path.join(project, 'cache');
  const dictionaryPath = path.join(project, 'dictionary.ts');
  const entries = Array.from({ length: 200 }, (_, index) => `key${index}: 'Value ${index}'`);
  fs.writeFileSync(dictionaryPath, `export default { group: { ${entries.join(', ')} } }\n`);
  fs.writeFileSync(
    path.join(project, 'usage.ts'),
    `import dictionary from './dictionary.js'\ndeclare const suffix: string\nObject.values(dictionary.group)\ndictionary.group[\`key\${suffix}\`]\n`
  );

  const cold = runLint(project, cacheDir);
  const warm = runLint(project, cacheDir);
  assert.deepEqual(portableDiagnostics(warm.diagnostics), portableDiagnostics(cold.diagnostics));

  const entryPath = filesUnder(cacheDir).find((file) => file.endsWith('.json'));
  assert.ok(entryPath);
  const entry = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
  assert.equal(entry.schemaVersion, 4);
  assert.equal(entry.analysisVersion, 9);
  const usageFacts = entry.sources[path.join(project, 'usage.ts')].facts;
  assert.equal(Object.hasOwn(usageFacts, 'facts'), false);
  assert.ok(usageFacts.observations.length < 10);
  assert.ok(
    usageFacts.observations.some(
      ({ kind, value, dictionaryIds }) =>
        kind === 'prefix' && value === 'group.' && dictionaryIds?.length === 1
    )
  );
  assert.ok(
    usageFacts.observations.some(
      ({ kind, value, dictionaryIds }) =>
        kind === 'pattern' && value === 'group.key*' && dictionaryIds?.length === 1
    )
  );

  const loaded = loadProject(project, [dictionaryPath]);
  const info = readDictionary(loaded.program, loaded.checker, dictionaryPath);
  const target = {
    id: `${dictionaryPath}\0${info.exportName}`,
    path: dictionaryPath,
    exportName: info.exportName,
    locale: 'dictionary',
    info
  };
  const prepared = prepareAnalysisCache(loaded, [target], {
    maxExpansions: 1_000,
    paths: resolveCachePaths(project, [dictionaryPath], undefined, cacheDir)
  });
  assert.equal(prepared.event.type, 'hit');
  const fresh = analyzeLoadedProjectMany(loaded, [target], {}, { dictionaries: [target] });
  const replayed = analyzeLoadedProjectMany(loaded, [target], {}, prepared.reuse);
  assert.deepEqual(replayed.analyses[0].result, fresh.analyses[0].result);
  assert.deepEqual(replayed.unresolvedReferences, fresh.unresolvedReferences);
});

test('does not touch the cache until the lint generator is consumed', (t) => {
  const project = temporaryProject(t);
  const cacheDir = path.join(project, 'cache');

  lint({
    project,
    dictionary: path.join(project, 'dictionary.ts'),
    cacheDir
  });

  assert.equal(fs.existsSync(cacheDir), false);
});

test('reanalyzes only the changed disconnected component', (t) => {
  const project = temporaryProject(t);
  const cacheDir = path.join(project, 'cache');
  runLint(project, cacheDir);
  runLint(project, cacheDir);

  fs.writeFileSync(path.join(project, 'other.ts'), `export const unrelated = 2\n`);
  const partial = runLint(project, cacheDir);
  const uncached = runLint(project, path.join(project, 'uncached'), { cache: false });

  assert.equal(partial.events[0]?.type, 'miss');
  assert.equal(partial.events[0]?.reason, 'changed');
  assert.equal(partial.events[0]?.analyzedFiles, 1);
  assert.equal(partial.events[0]?.reusedFiles, 2);
  assert.deepEqual(
    portableDiagnostics(partial.diagnostics),
    portableDiagnostics(uncached.diagnostics)
  );
});

test('reanalyzes everything when global scope can cross graph edges', (t) => {
  for (const [fileName, contents] of [
    ['global.ts', `const globallyVisible = 1\n`],
    ['augmentation.ts', `export {}\ndeclare module './dictionary.js' { interface Marker {} }\n`]
  ]) {
    const project = temporaryProject(t);
    const cacheDir = path.join(project, 'cache');
    fs.writeFileSync(path.join(project, fileName), contents);
    runLint(project, cacheDir);

    fs.writeFileSync(path.join(project, 'other.ts'), `export const unrelated = 2\n`);
    const changed = runLint(project, cacheDir);
    const uncached = runLint(project, path.join(project, 'uncached'), { cache: false });

    assert.equal(changed.events[0]?.type, 'miss');
    assert.equal(changed.events[0]?.reason, 'changed');
    assert.equal(changed.events[0]?.analyzedFiles, 4);
    assert.equal(changed.events[0]?.reusedFiles, 0);
    assert.deepEqual(
      portableDiagnostics(changed.diagnostics),
      portableDiagnostics(uncached.diagnostics)
    );
  }
});

test('invalidates connected dependents and dictionary shape changes', (t) => {
  const project = temporaryProject(t);
  const cacheDir = path.join(project, 'cache');
  runLint(project, cacheDir);

  fs.writeFileSync(
    path.join(project, 'usage.ts'),
    `import dictionary from './dictionary.js'\ndictionary.unused\n`
  );
  const connected = runLint(project, cacheDir);
  assert.equal(connected.events[0]?.analyzedFiles, 2);
  assert.equal(connected.events[0]?.reusedFiles, 1);

  fs.writeFileSync(
    path.join(project, 'dictionary.ts'),
    `export default { used: 'Used', unused: 'Unused', added: 'Added' }\n`
  );
  const dictionaryChanged = runLint(project, cacheDir);
  assert.equal(dictionaryChanged.events[0]?.reason, 'incompatible');
  assert.equal(dictionaryChanged.events[0]?.analyzedFiles, 3);
  assert.ok(
    dictionaryChanged.diagnostics.some(({ messageText }) => String(messageText).includes('"added"'))
  );
});

test('recovers from corrupt entries and bypasses analysis cache when requested', (t) => {
  const project = temporaryProject(t);
  const cacheDir = path.join(project, 'cache');
  runLint(project, cacheDir);
  const entry = filesUnder(cacheDir).find((file) => file.endsWith('.json'));
  assert.ok(entry);
  fs.writeFileSync(entry, '{ corrupt');

  const recovered = runLint(project, cacheDir);
  assert.equal(recovered.events[0]?.type, 'miss');
  assert.equal(recovered.events[0]?.reason, 'corrupt');
  assert.equal(recovered.events.at(-1)?.type, 'write');

  const disabledDir = path.join(project, 'disabled-cache');
  const disabled = runLint(project, disabledDir, { cache: false });
  assert.deepEqual(disabled.events, [{ type: 'bypass', reason: 'disabled' }]);
  assert.equal(fs.existsSync(disabledDir), false);
});

test('caches JSON analysis and invalidates changed dictionary keys', (t) => {
  const project = temporaryProject(t);
  const cacheDir = path.join(project, 'cache');
  fs.rmSync(path.join(project, 'dictionary.ts'));
  fs.writeFileSync(
    path.join(project, 'messages.json'),
    JSON.stringify({ used: 'Used', unused: 'Unused' }, null, 2)
  );
  fs.writeFileSync(
    path.join(project, 'usage.ts'),
    `import messages from './messages.json' with { type: 'json' }\nmessages.used\n`
  );
  const run = () => {
    const events = [];
    const diagnostics = [
      ...lint({
        project,
        dictionary: path.join(project, 'messages.json'),
        cacheDir,
        onCacheEvent: (event) => events.push(event)
      })
    ];
    return { diagnostics, events };
  };

  run();
  const warm = run();
  assert.equal(warm.events[0]?.type, 'hit');

  fs.writeFileSync(
    path.join(project, 'messages.json'),
    JSON.stringify({ used: 'Used', unused: 'Unused', added: 'Added' }, null, 2)
  );
  const changed = run();
  assert.equal(changed.events[0]?.reason, 'incompatible');
  assert.ok(changed.diagnostics.some(({ messageText }) => String(messageText).includes('"added"')));
});

test('warm --remove replays facts and does not persist pre-mutation facts', (t) => {
  const project = temporaryProject(t);
  const cacheDir = path.join(project, 'cache');
  runLint(project, cacheDir);
  const entry = filesUnder(cacheDir).find((file) => file.endsWith('.json'));
  assert.ok(entry);
  const cachedBefore = fs.readFileSync(entry, 'utf8');

  const removed = runLint(project, cacheDir, { remove: true });
  assert.deepEqual(
    removed.events.map(({ type }) => type),
    ['hit']
  );
  assert.equal(removed.events[0]?.analyzedFiles, 0);
  assert.ok(removed.diagnostics.some(({ code }) => code === DiagnosticCode.RemovedKey));
  assert.equal(fs.readFileSync(entry, 'utf8'), cachedBefore);
  assert.equal(
    fs.readFileSync(path.join(project, 'dictionary.ts'), 'utf8').includes('unused'),
    false
  );

  const after = runLint(project, cacheDir);
  assert.equal(after.events[0]?.type, 'miss');
  assert.equal(after.events[0]?.reason, 'incompatible');
});

test('warm refused --remove preserves a reusable cache and matches uncached diagnostics', (t) => {
  const project = temporaryProject(t);
  const cacheDir = path.join(project, 'cache');
  fs.writeFileSync(
    path.join(project, 'dictionary.ts'),
    `export default { values: ['Used', 'Unsafe'] }\n`
  );
  fs.writeFileSync(
    path.join(project, 'usage.ts'),
    `import dictionary from './dictionary.js'\ndictionary.values[0]\n`
  );
  runLint(project, cacheDir);
  const before = fs.readFileSync(path.join(project, 'dictionary.ts'), 'utf8');

  const refused = runLint(project, cacheDir, { remove: true });
  const uncached = runLint(project, path.join(project, 'uncached'), {
    cache: false,
    remove: true
  });

  assert.deepEqual(
    refused.events.map(({ type }) => type),
    ['hit']
  );
  assert.equal(refused.events[0]?.analyzedFiles, 0);
  assert.deepEqual(
    portableDiagnostics(refused.diagnostics),
    portableDiagnostics(uncached.diagnostics)
  );
  assert.ok(refused.diagnostics.some(({ code }) => code === DiagnosticCode.RemovalFailure));
  assert.equal(fs.readFileSync(path.join(project, 'dictionary.ts'), 'utf8'), before);

  const after = runLint(project, cacheDir);
  assert.deepEqual(
    after.events.map(({ type }) => type),
    ['hit']
  );
});

test('cold refused --remove writes fresh facts for the next run', (t) => {
  const project = temporaryProject(t);
  const cacheDir = path.join(project, 'cache');
  fs.writeFileSync(
    path.join(project, 'dictionary.ts'),
    `export default { values: ['Used', 'Unsafe'] }\n`
  );
  fs.writeFileSync(
    path.join(project, 'usage.ts'),
    `import dictionary from './dictionary.js'\ndictionary.values[0]\n`
  );

  const refused = runLint(project, cacheDir, { remove: true });
  assert.deepEqual(
    refused.events.map(({ type }) => type),
    ['miss', 'write']
  );
  assert.ok(refused.diagnostics.some(({ code }) => code === DiagnosticCode.RemovalFailure));

  const warm = runLint(project, cacheDir, { remove: true });
  assert.deepEqual(
    warm.events.map(({ type }) => type),
    ['hit']
  );
  assert.equal(warm.events[0]?.analyzedFiles, 0);
});

test('refused --remove preserves cache parity after partial invalidation and corruption', (t) => {
  const project = temporaryProject(t);
  const cacheDir = path.join(project, 'cache');
  fs.writeFileSync(
    path.join(project, 'dictionary.ts'),
    `export default { values: ['Used', 'Unsafe'] }\n`
  );
  fs.writeFileSync(
    path.join(project, 'usage.ts'),
    `import dictionary from './dictionary.js'\ndictionary.values[0]\n`
  );
  runLint(project, cacheDir);

  fs.writeFileSync(path.join(project, 'other.ts'), `export const unrelated = 2\n`);
  const partial = runLint(project, cacheDir, { remove: true });
  assert.deepEqual(
    partial.events.map(({ type }) => type),
    ['miss', 'write']
  );
  assert.equal(partial.events[0]?.reason, 'changed');
  assert.equal(partial.events[0]?.analyzedFiles, 1);
  assert.ok(partial.diagnostics.some(({ code }) => code === DiagnosticCode.RemovalFailure));

  const entry = filesUnder(cacheDir).find((file) => file.endsWith('.json'));
  assert.ok(entry);
  fs.writeFileSync(entry, '{ corrupt');
  const corrupt = runLint(project, cacheDir, { remove: true });
  const uncached = runLint(project, path.join(project, 'uncached'), {
    cache: false,
    remove: true
  });
  assert.equal(corrupt.events[0]?.type, 'miss');
  assert.equal(corrupt.events[0]?.reason, 'corrupt');
  assert.equal(corrupt.events.at(-1)?.type, 'write');
  assert.deepEqual(
    portableDiagnostics(corrupt.diagnostics),
    portableDiagnostics(uncached.diagnostics)
  );
});

test('failed mutation rolls back and does not cache pre-mutation facts', (t) => {
  const project = temporaryProject(t);
  const cacheDir = path.join(project, 'cache');
  const dictionary = path.join(project, 'dictionary.ts');
  const before = fs.readFileSync(dictionary, 'utf8');
  const renameSync = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (String(destination).includes('.unused18n-') && String(destination).endsWith('.bak')) {
      throw new Error('injected replacement failure');
    }
    return renameSync(source, destination);
  };

  let failed;
  const lintEvents = [];
  try {
    failed = runLint(project, cacheDir, {
      remove: true,
      onEvent: (event) => lintEvents.push(event)
    });
  } finally {
    fs.renameSync = renameSync;
  }

  assert.ok(
    failed.diagnostics.some(
      ({ code, messageText }) =>
        code === DiagnosticCode.RemovalFailure &&
        String(messageText).includes('injected replacement failure')
    )
  );
  assert.deepEqual(
    failed.events.map(({ type }) => type),
    ['miss']
  );
  assert.deepEqual(
    lintEvents.find(({ type }) => type === 'summary'),
    {
      type: 'summary',
      unusedKeys: 1,
      removedKeys: 0,
      unresolvedReferences: 0,
      removalFailures: 1,
      translationObjectCasts: 0,
      removedCasts: 0
    }
  );
  assert.equal(fs.readFileSync(dictionary, 'utf8'), before);
  assert.equal(
    filesUnder(cacheDir).some((file) => file.endsWith('.json')),
    false
  );
});

test('CLI cache observability respects silent output without changing lint exit behavior', (t) => {
  const project = temporaryProject(t);
  const cacheDir = path.join(project, 'cache');
  const args = [
    cli,
    'lint',
    `--project=${project}`,
    `--dictionary=${path.join(project, 'dictionary.ts')}`,
    `--cache-dir=${cacheDir}`,
    '--cache-stats',
    '--log-level=silent'
  ];

  const cold = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const warm = spawnSync(process.execPath, args, { encoding: 'utf8' });

  assert.equal(cold.status, 1);
  assert.doesNotMatch(cold.stderr, /Cache (miss|write)/);
  assert.equal(warm.status, 1);
  assert.doesNotMatch(warm.stderr, /Cache hit/);
});
