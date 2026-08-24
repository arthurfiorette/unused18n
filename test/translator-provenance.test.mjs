import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DiagnosticCode, lint } from '../dist/index.js';

const project = fileURLToPath(new URL('./fixtures/provenance', import.meta.url));

test('recognizes proven first-party translators without accepting name-only lookalikes', () => {
  const diagnostics = [
    ...lint({ project, dictionary: path.join(project, 'dictionary.ts'), cache: false })
  ];
  const unused = diagnostics
    .filter(({ code }) => code === DiagnosticCode.UnusedKey)
    .map(({ messageText }) => String(messageText).match(/"(.+)"/)?.[1]);

  assert.deepEqual(unused, [
    'dynamic',
    'known',
    'knownSpread',
    'stale',
    'unknownOptions',
    'unrelatedFixed',
    'unrelatedHook',
    'unrelatedHookMethod',
    'unrelatedMethod',
    'unrelatedNamed'
  ]);
  assert.ok(diagnostics.some(({ code }) => code === DiagnosticCode.UnresolvedReference));
  assert.equal(
    diagnostics.some(
      ({ code, file }) =>
        code === DiagnosticCode.UnresolvedReference &&
        file?.fileName.endsWith('instance-methods.ts')
    ),
    false
  );
});

test('replays callback interpolation options without losing literal keys', (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unused18n-provenance-cache-'));
  t.after(() => fs.rmSync(cacheDir, { force: true, recursive: true }));
  const options = { project, dictionary: path.join(project, 'dictionary.ts') };
  const portable = (diagnostics) =>
    diagnostics.map(({ category, code, messageText }) => ({
      category,
      code,
      message: String(messageText)
    }));

  const uncached = portable([...lint({ ...options, cache: false })]);
  const cold = portable([...lint({ ...options, cache: true, cacheDir })]);
  const warm = portable([...lint({ ...options, cache: true, cacheDir })]);

  assert.deepEqual(cold, uncached);
  assert.deepEqual(warm, uncached);
  assert.equal(
    uncached.some(({ message }) => message.includes('callbackLiteral')),
    false
  );
});
