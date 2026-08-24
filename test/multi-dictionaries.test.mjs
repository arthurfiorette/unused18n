import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DiagnosticCode, lint } from '../dist/index.js';

const project = fileURLToPath(new URL('./fixtures/locales', import.meta.url));
const cli = fileURLToPath(new URL('../bin/run.js', import.meta.url));

test('analyzes locale dictionaries with different valid plural shapes', () => {
  const diagnostics = [
    ...lint({
      project,
      dictionaries: path.join(project, '??.json'),
      cache: false
    })
  ];
  const unused = diagnostics.filter(({ code }) => code === DiagnosticCode.UnusedKey);

  assert.deepEqual(
    unused.map((diagnostic) => [
      path.basename(diagnostic.file?.fileName ?? ''),
      diagnostic.messageText
    ]),
    [
      ['ar.json', 'Translation key "unused" is unused.'],
      ['en.json', 'Translation key "shape" is unused.'],
      ['en.json', 'Translation key "unused" is unused.'],
      ['ja.json', 'Translation key "sharedDirect" is unused.'],
      ['ja.json', 'Translation key "unused" is unused.']
    ]
  );
  assert.equal(
    diagnostics.some(
      ({ messageText }) =>
        typeof messageText === 'string' && /item_(one|other|few|many|two|zero)/.test(messageText)
    ),
    false
  );
});

test('CLI accepts repeated dictionary flags', () => {
  const result = spawnSync(
    process.execPath,
    [
      cli,
      `--project=${project}`,
      `--dictionary=${path.join(project, 'en.json')}`,
      `--dictionary=${path.join(project, 'ja.json')}`,
      '--no-cache'
    ],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Summary: 4 unused/);
});

test('reuses one cached source analysis across every locale dictionary', (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unused18n-locales-cache-'));
  t.after(() => fs.rmSync(cacheDir, { force: true, recursive: true }));
  const run = () => {
    const events = [];
    const diagnostics = [
      ...lint({
        project,
        dictionaries: path.join(project, '??.json'),
        cacheDir,
        onCacheEvent: (event) => events.push(event)
      })
    ];
    return { diagnostics, events };
  };

  const cold = run();
  const warm = run();

  const portable = (diagnostics) =>
    diagnostics.map(({ code, messageText, file, start }) => ({
      code,
      messageText: String(messageText),
      file: file?.fileName,
      start
    }));
  assert.deepEqual(portable(warm.diagnostics), portable(cold.diagnostics));
  assert.deepEqual(
    cold.events.map(({ type }) => type),
    ['miss', 'write']
  );
  assert.deepEqual(
    warm.events.map(({ type }) => type),
    ['hit']
  );

  const entryPath = fs
    .readdirSync(cacheDir, { recursive: true })
    .map((entry) => path.join(cacheDir, entry))
    .find((entry) => entry.endsWith('.json'));
  assert.ok(entryPath);
  const entry = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
  const targetedIds = new Set(
    Object.values(entry.sources).flatMap(({ facts }) =>
      facts.observations.flatMap(({ dictionaryIds }) => dictionaryIds ?? [])
    )
  );
  assert.deepEqual([...targetedIds].map((id) => path.basename(id.split('\0')[0])).sort(), [
    'ar.json',
    'en.json',
    'ja.json'
  ]);
});

test('removes unused keys from every matched dictionary in one plan', (t) => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'unused18n-locales-'));
  t.after(() => fs.rmSync(copy, { force: true, recursive: true }));
  fs.cpSync(project, copy, { recursive: true });
  const cacheDir = path.join(copy, 'cache');
  const dictionaryPattern = path.join(copy, '??.json');
  [...lint({ project: copy, dictionaries: dictionaryPattern, cacheDir })];
  const events = [];
  const lintEvents = [];

  const diagnostics = [
    ...lint({
      project: copy,
      dictionaries: dictionaryPattern,
      remove: true,
      cacheDir,
      onEvent: (event) => lintEvents.push(event),
      onCacheEvent: (event) => events.push(event)
    })
  ];

  assert.deepEqual(
    events.map(({ type }) => type),
    ['hit']
  );
  assert.equal(events[0]?.analyzedFiles, 0);
  assert.equal(diagnostics.filter(({ code }) => code === DiagnosticCode.RemovedKey).length, 5);
  assert.equal(lintEvents.find(({ type }) => type === 'summary')?.removedKeys, 5);
  for (const locale of ['ar', 'en', 'ja']) {
    assert.equal(
      Object.hasOwn(JSON.parse(fs.readFileSync(path.join(copy, `${locale}.json`))), 'unused'),
      false
    );
  }
  assert.equal(
    Object.hasOwn(JSON.parse(fs.readFileSync(path.join(copy, 'en.json'))), 'shape'),
    false
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(copy, 'ja.json'))).shape.nested,
    'Japanese nested shape'
  );
});
