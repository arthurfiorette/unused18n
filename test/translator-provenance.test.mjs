import assert from 'node:assert/strict';
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
    'stale',
    'unknownOptions',
    'unrelatedFixed',
    'unrelatedHook',
    'unrelatedHookMethod',
    'unrelatedMethod',
    'unrelatedNamed'
  ]);
  assert.ok(diagnostics.some(({ code }) => code === DiagnosticCode.UnresolvedReference));
});
