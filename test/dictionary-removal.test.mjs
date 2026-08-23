import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from '@typescript/typescript6';
import { readDictionary } from '../dist/dictionary.js';
import { applyDictionaryRemoval, planDictionaryRemoval } from '../dist/dictionary-removal.js';

function temporaryDictionary(t, source, files = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unused18n-removal-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const dictionaryPath = path.join(directory, 'dictionary.ts');
  fs.writeFileSync(dictionaryPath, source);
  for (const [fileName, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, fileName), contents);
  }
  return dictionaryPath;
}

function openDictionary(dictionaryPath) {
  const directory = path.dirname(dictionaryPath);
  const rootNames = fs
    .readdirSync(directory)
    .filter((fileName) => fileName.endsWith('.ts'))
    .map((fileName) => path.join(directory, fileName));
  const program = ts.createProgram(rootNames, {
    allowImportingTsExtensions: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022
  });
  const syntacticDiagnostics = program.getSyntacticDiagnostics();
  assert.deepEqual(
    syntacticDiagnostics.map((diagnostic) => diagnostic.messageText),
    []
  );
  return readDictionary(program, program.getTypeChecker(), dictionaryPath, 'dictionary');
}

function removeKeys(dictionaryPath, keys) {
  const dictionary = openDictionary(dictionaryPath);
  const result = planDictionaryRemoval(dictionary, new Set(keys));
  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.failures));
  applyDictionaryRemoval(result.plan);
  return {
    source: fs.readFileSync(dictionaryPath, 'utf8'),
    dictionary: openDictionary(dictionaryPath)
  };
}

function expectRefusal(dictionaryPath, keys, expectedBarrier) {
  const original = fs.readFileSync(dictionaryPath, 'utf8');
  const result = planDictionaryRemoval(openDictionary(dictionaryPath), new Set(keys));
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => failure.barriers.includes(expectedBarrier)));
  assert.equal(fs.readFileSync(dictionaryPath, 'utf8'), original);
}

test('removes middle, adjacent, and trailing properties with comma-aware ranges', (t) => {
  const dictionaryPath = temporaryDictionary(
    t,
    `export const dictionary = {
  first: 'first',
  middle: 'middle',
  // This comment belongs to the surviving property.
  keep: 'keep',
  adjacentA: 'a',
  adjacentB: 'b',
  trailing: 'tail',
}
`
  );

  const { source, dictionary } = removeKeys(dictionaryPath, [
    'middle',
    'adjacentA',
    'adjacentB',
    'trailing'
  ]);

  assert.deepEqual([...dictionary.keys], ['first', 'keep']);
  assert.match(source, /This comment belongs to the surviving property/);
  assert.doesNotMatch(source, /middle|adjacentA|adjacentB|trailing/);
});

test('removes nested leaves and shorthand leaves while preserving siblings', (t) => {
  const dictionaryPath = temporaryDictionary(
    t,
    `const shorthand = 'short'
export const dictionary = {
  nested: {
    keep: 'keep',
    remove: 'remove',
  },
  shorthand,
  last: 'last',
}
`
  );

  const { dictionary, source } = removeKeys(dictionaryPath, ['nested.remove', 'shorthand']);

  assert.deepEqual([...dictionary.keys], ['nested.keep', 'last']);
  assert.match(source, /keep: 'keep'/);
  assert.match(source, /last: 'last'/);
  assert.doesNotMatch(source, /remove: 'remove'|\n {2}shorthand,/);
});

test('collapses a safe parent when every active descendant is unused', (t) => {
  const dictionaryPath = temporaryDictionary(
    t,
    `export const dictionary = {
  group: {
    first: 'first',
    second: 'second',
  },
  // Keep this sibling and its comment.
  survivor: 'survivor',
}
`
  );

  const { dictionary, source } = removeKeys(dictionaryPath, ['group.first', 'group.second']);

  assert.deepEqual([...dictionary.keys], ['survivor']);
  assert.doesNotMatch(source, /group:/);
  assert.match(source, /Keep this sibling and its comment/);
});

test('removes every root property without leaving an invalid trailing comma', (t) => {
  const dictionaryPath = temporaryDictionary(
    t,
    `export const dictionary = {
  first: 'first',
  second: 'second',
}
`
  );
  const dictionary = openDictionary(dictionaryPath);
  const result = planDictionaryRemoval(dictionary, new Set(dictionary.keys));
  assert.equal(result.ok, true);
  applyDictionaryRemoval(result.plan);

  const source = fs.readFileSync(dictionaryPath, 'utf8');
  const sourceFile = ts.createSourceFile(
    dictionaryPath,
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS
  );
  assert.deepEqual(sourceFile.parseDiagnostics, []);
  assert.match(source, /dictionary = \{\s*\}/);
  assert.deepEqual([...openDictionary(dictionaryPath).keys], []);
});

test('refuses array-index and computed-property removals', (t) => {
  const arrayPath = temporaryDictionary(
    t,
    `export const dictionary = { list: ['first', 'second'] }
`
  );
  expectRefusal(arrayPath, ['list.0'], 'array');

  const computedPath = temporaryDictionary(
    t,
    `const name = 'computed' as const
export const dictionary = { [name]: 'value', keep: 'keep' }
`
  );
  expectRefusal(computedPath, ['computed'], 'computed-property');
});

test('refuses imported and shared source property removals', (t) => {
  const importedPath = temporaryDictionary(
    t,
    `import { imported } from './shared.ts'
export const dictionary = { imported }
`,
    { 'shared.ts': `export const imported = { leaf: 'value' }\n` }
  );
  expectRefusal(importedPath, ['imported.leaf'], 'imported-declaration');

  const reexportedPath = temporaryDictionary(
    t,
    `export { imported as dictionary } from './shared.ts'\n`,
    { 'shared.ts': `export const imported = { leaf: 'value' }\n` }
  );
  expectRefusal(reexportedPath, ['leaf'], 'imported-declaration');

  const sharedPath = temporaryDictionary(
    t,
    `const shared = { remove: 'remove', keep: 'keep' }
export const dictionary = { shared }
`
  );
  expectRefusal(sharedPath, ['shared.remove'], 'shared-source-property');
});

test('refuses an edit that would reveal an overwritten value', (t) => {
  const dictionaryPath = temporaryDictionary(
    t,
    `export const dictionary = {
  duplicate: 'shadowed',
  duplicate: 'active',
  keep: 'keep',
}
`
  );

  expectRefusal(dictionaryPath, ['duplicate'], 'overwrite');
});

test('refuses removals that could reveal values behind unknown spreads', (t) => {
  const beforeSpread = temporaryDictionary(
    t,
    `declare const shared: Record<string, string>
export const dictionary = { ...shared, removable: 'fallback' }
`
  );
  expectRefusal(beforeSpread, ['removable'], 'spread');

  const afterSpread = temporaryDictionary(
    t,
    `declare const shared: Record<string, string>
export const dictionary = { removable: 'fallback', ...shared }
`
  );
  expectRefusal(afterSpread, ['removable'], 'spread');
});

test('rejects a stale plan before changing the source file', (t) => {
  const dictionaryPath = temporaryDictionary(
    t,
    `export const dictionary = { remove: 'remove', keep: 'keep' }\n`
  );
  const result = planDictionaryRemoval(openDictionary(dictionaryPath), new Set(['remove']));
  assert.equal(result.ok, true);
  const changed = `// changed after planning\n${fs.readFileSync(dictionaryPath, 'utf8')}`;
  fs.writeFileSync(dictionaryPath, changed);

  assert.throws(
    () => applyDictionaryRemoval(result.plan),
    /source changed after removal was planned/
  );
  assert.equal(fs.readFileSync(dictionaryPath, 'utf8'), changed);
});
