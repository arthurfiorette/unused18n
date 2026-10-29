import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DiagnosticCategory } from 'typescript/sync';
import { analyzeProject } from '../dist/analyzer.js';
import { DiagnosticCode, lint } from '../dist/index.js';
import { copyFixture, diagnosticSource, temporaryProject } from './helpers.mjs';

const project = fileURLToPath(new URL('./fixtures/object-flow', import.meta.url));

test('tracks translation objects through parameters, JSX props, and returned objects', () => {
  const diagnostics = [
    ...lint({ project, dictionary: path.join(project, 'dictionary.ts'), cache: false })
  ];
  const unused = diagnostics
    .filter(({ code }) => code === DiagnosticCode.UnusedKey)
    .map(({ text }) => text.match(/"(.+)"/)?.[1]);

  assert.deepEqual(unused, [
    'billingHistory.stale',
    'contaminatedFlow',
    'defaultFlow.unused',
    'destructuredFlow.unused',
    'forwardRefFlow.unused',
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
      .map(({ category, fileName, text }) => ({
        category,
        file: path.basename(fileName),
        message: text
      }))
      .sort((left, right) => left.file.localeCompare(right.file)),
    [
      {
        category: DiagnosticCategory.Error,
        file: 'cast-assertion.ts',
        message: 'Translation object casts hide the inferred dictionary shape; remove this cast.'
      },
      {
        category: DiagnosticCategory.Error,
        file: 'usage.tsx',
        message: 'Translation object casts hide the inferred dictionary shape; remove this cast.'
      },
      {
        category: DiagnosticCategory.Error,
        file: 'usage.tsx',
        message: 'Translation object casts hide the inferred dictionary shape; remove this cast.'
      }
    ]
  );
  const dynamicIndexWarning = diagnostics.find(
    (diagnostic) =>
      diagnostic.code === DiagnosticCode.UnresolvedReference &&
      path.basename(diagnostic.fileName ?? '') === 'usage.tsx' &&
      diagnostic.text === 'translation object dynamic property access: unresolved runtime key' &&
      diagnosticSource(diagnostic).startsWith('indexedLabels[')
  );
  assert.ok(dynamicIndexWarning);
  assert.equal(dynamicIndexWarning.category, DiagnosticCategory.Warning);
  assert.equal(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.code === DiagnosticCode.UnresolvedReference &&
        path.basename(diagnostic.fileName ?? '') === 'usage.tsx' &&
        diagnosticSource(diagnostic).includes('message.trim')
    ),
    false
  );
});

test('preserves object-flow classifications across cold and warm cache replay', (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unused18n-object-flow-cache-'));
  t.after(() => fs.rmSync(cacheDir, { force: true, recursive: true }));
  const options = { project, dictionary: path.join(project, 'dictionary.ts') };
  const portable = (diagnostics) =>
    diagnostics.map(({ category, code, text }) => ({
      category,
      code,
      message: text
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

/**
 * Returns the analysis status of every key of `dictionary.ts` in `directory`.
 *
 * @param {string} directory Project directory.
 */
function keyStatuses(directory) {
  const { keys } = analyzeProject({
    project: directory,
    dictionary: path.join(directory, 'dictionary.ts')
  });
  return Object.fromEntries(keys.map(({ key, status }) => [key, status]));
}

const cycleConfig = JSON.stringify({
  compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', skipLibCheck: true },
  include: ['*.ts']
});

// Expected statuses are v0.2.2's output. `a` and `b` initialize from each other, so the statuses
// depend on where analysis cuts the cycle, and a different traversal order changes them.
test('mutually referencing annotated variables resolve in v0.2.2 order', (t) => {
  const directory = temporaryProject(t, {
    'tsconfig.json': cycleConfig,
    'dictionary.ts': `export const dictionary = {
  one: { k: 'one.k', m: 'one.m' },
  two: { k: 'two.k', m: 'two.m' }
};
`,
    'usage.ts': `import { dictionary } from './dictionary.js';
declare const flag: boolean;
declare function use(value: unknown): void;
var a: any = flag ? dictionary.one : b;
var b: any = flag ? dictionary.two : a;
const { k } = b;
use(k);
use(a.m);
`
  });

  assert.deepEqual(keyStatuses(directory), {
    'one.k': 'used',
    'one.m': 'used',
    'two.k': 'used',
    'two.m': 'possibly-used'
  });
});

test('mutually referencing inferred variables resolve in v0.2.2 order', (t) => {
  const directory = temporaryProject(t, {
    'tsconfig.json': cycleConfig,
    'dictionary.ts': `export const dictionary = {
  foo: { x: 'Foo X', y: 'Foo Y' },
  bar: { x: 'Bar X', y: 'Bar Y' }
};
`,
    'usage.ts': `import { dictionary } from './dictionary.js';

declare const cond: boolean;
var a = cond ? dictionary.foo : b;
var b = cond ? dictionary.bar : a;
const { y } = b;
void y;
void a.x;
`
  });

  assert.deepEqual(keyStatuses(directory), {
    'bar.x': 'possibly-used',
    'bar.y': 'used',
    'foo.x': 'used',
    'foo.y': 'used'
  });
});

test('JSDoc type casts in JavaScript are not translation object casts', (t) => {
  const fixture = fileURLToPath(new URL('./fixtures/js-casts', import.meta.url));
  const run = (directory, remove = false) =>
    [
      ...lint({
        project: directory,
        dictionary: path.join(directory, 'dictionary.ts'),
        cache: false,
        remove
      })
    ].map(({ code, text }) => ({ code, text }));

  assert.deepEqual(run(fixture), [
    { code: DiagnosticCode.UnusedKey, text: 'Translation subtree "nested" is unused.' },
    { code: DiagnosticCode.UnusedKey, text: 'Translation key "other.q" is unused.' },
    { code: DiagnosticCode.UnusedKey, text: 'Translation key "unused" is unused.' }
  ]);

  const copy = copyFixture(t, fixture);
  const app = fs.readFileSync(path.join(copy, 'app.js'), 'utf8');
  assert.deepEqual(
    run(copy, true).map(({ code }) => code),
    Array(4).fill(DiagnosticCode.RemovedKey)
  );
  assert.equal(
    fs.readFileSync(path.join(copy, 'dictionary.ts'), 'utf8'),
    `export const dictionary = {
  a: 'A',
  b: 'B',
  other: { p: 'P' }
};
`
  );
  assert.equal(fs.readFileSync(path.join(copy, 'app.js'), 'utf8'), app);
});
