import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from '@typescript/typescript6';
import { DiagnosticCode, lint } from '../dist/index.js';

const project = fileURLToPath(new URL('./fixtures/object-flow', import.meta.url));

test('tracks translation objects through parameters, JSX props, and returned objects', () => {
  const diagnostics = [
    ...lint({ project, dictionary: path.join(project, 'dictionary.ts'), cache: false })
  ];
  const unused = diagnostics
    .filter(({ code }) => code === DiagnosticCode.UnusedKey)
    .map(({ messageText }) => String(messageText).match(/"(.+)"/)?.[1]);

  assert.deepEqual(unused, [
    'billingHistory.stale',
    'defaultFlow.unused',
    'destructuredFlow.unused',
    'hiddenJsxFlow',
    'hiddenReturnFlow',
    'jsxFlow.unused',
    'jsxReturnedFlow.unused',
    'jsxSpreadFlow.unused',
    'memoBagFlow.funnelActions.unused',
    'memoBagFlow.productList.nested.unused',
    'memoBagFlow.productList.unused',
    'memoFlow.unused',
    'parameterFlow.unused',
    'returnedFlow.unused'
  ]);
  assert.deepEqual(
    diagnostics
      .filter(({ code }) => code === DiagnosticCode.TranslationObjectCast)
      .map(({ category, file, messageText }) => ({
        category,
        file: path.basename(file.fileName),
        message: String(messageText)
      }))
      .sort((left, right) => left.file.localeCompare(right.file)),
    [
      {
        category: ts.DiagnosticCategory.Error,
        file: 'cast-assertion.ts',
        message: 'Translation object casts hide the inferred dictionary shape; remove this cast.'
      },
      {
        category: ts.DiagnosticCategory.Error,
        file: 'usage.tsx',
        message: 'Translation object casts hide the inferred dictionary shape; remove this cast.'
      },
      {
        category: ts.DiagnosticCategory.Error,
        file: 'usage.tsx',
        message: 'Translation object casts hide the inferred dictionary shape; remove this cast.'
      }
    ]
  );
  const dynamicIndexWarning = diagnostics.find(
    ({ code, file, length, messageText, start }) =>
      code === DiagnosticCode.UnresolvedReference &&
      path.basename(file?.fileName ?? '') === 'usage.tsx' &&
      String(messageText) ===
        'translation object dynamic property access: unresolved runtime key' &&
      file.text.slice(start, start + length).startsWith('indexedLabels[')
  );
  assert.ok(dynamicIndexWarning);
  assert.equal(dynamicIndexWarning.category, ts.DiagnosticCategory.Warning);
});

test('preserves object-flow classifications across cold and warm cache replay', (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unused18n-object-flow-cache-'));
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
});

test('--remove deletes cached translation object casts in the same atomic plan', (t) => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'unused18n-object-flow-remove-'));
  t.after(() => fs.rmSync(copy, { force: true, recursive: true }));
  fs.cpSync(project, copy, { recursive: true });
  const dictionary = path.join(copy, 'dictionary.ts');
  const cacheDir = path.join(copy, 'cache');
  [...lint({ project: copy, dictionary, cache: true, cacheDir })];
  const events = [];

  const diagnostics = [
    ...lint({
      project: copy,
      dictionary,
      cache: true,
      cacheDir,
      remove: true,
      onEvent: (event) => events.push(event)
    })
  ];

  assert.equal(
    diagnostics.some(({ code }) => code === DiagnosticCode.TranslationObjectCast),
    false
  );
  const usage = fs.readFileSync(path.join(copy, 'usage.tsx'), 'utf8');
  assert.doesNotMatch(usage, /as never|as unknown|as \{/);
  assert.match(usage, /translate\('castFlow', \{ returnObjects: true \}\)/);
  assert.match(usage, /\{ returnObjects: true \} as const/);
  const updatedDictionary = fs.readFileSync(dictionary, 'utf8');
  assert.match(updatedDictionary, /first: 'First dynamic label'/);
  assert.match(updatedDictionary, /second: 'Second dynamic label'/);
  assert.match(fs.readFileSync(dictionary, 'utf8'), /page_templates/);
  assert.doesNotMatch(fs.readFileSync(path.join(copy, 'cast-assertion.ts'), 'utf8'), /<\{/);
  assert.equal(events.find(({ type }) => type === 'summary')?.removedCasts, 4);
  assert.equal(
    [...lint({ project: copy, dictionary, cache: false })].some(
      ({ code }) => code === DiagnosticCode.TranslationObjectCast
    ),
    false
  );
});
