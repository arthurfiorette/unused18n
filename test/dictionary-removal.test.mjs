import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ScriptTarget } from 'typescript/ast';
import { ModuleKind, ModuleResolutionKind } from 'typescript/sync';
import { readDictionary } from '../dist/dictionary.js';
import {
  applyDictionaryRemoval,
  planDictionaryRemoval,
  validateAndGroupEdits
} from '../dist/dictionary-removal.js';
import { openProgram } from './helpers.mjs';

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

function openDictionary(t, dictionaryPath) {
  const directory = path.dirname(dictionaryPath);
  const rootNames = fs
    .readdirSync(directory)
    .filter((fileName) => fileName.endsWith('.ts'))
    .map((fileName) => path.join(directory, fileName));
  const { program, semantic } = openProgram(t, rootNames, {
    allowImportingTsExtensions: true,
    module: ModuleKind.NodeNext,
    moduleResolution: ModuleResolutionKind.NodeNext,
    target: ScriptTarget.ES2022
  });
  const syntacticDiagnostics = program.getSyntacticDiagnostics();
  assert.deepEqual(
    syntacticDiagnostics.map((diagnostic) => diagnostic.text),
    []
  );
  return readDictionary(semantic, dictionaryPath, 'dictionary');
}

function removeKeys(t, dictionaryPath, keys) {
  const dictionary = openDictionary(t, dictionaryPath);
  const result = planDictionaryRemoval(dictionary, new Set(keys));
  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.failures));
  applyDictionaryRemoval(result.plan);
  return {
    source: fs.readFileSync(dictionaryPath, 'utf8'),
    dictionary: openDictionary(t, dictionaryPath)
  };
}

function expectRefusal(t, dictionaryPath, keys, expectedBarrier) {
  const original = fs.readFileSync(dictionaryPath, 'utf8');
  const result = planDictionaryRemoval(openDictionary(t, dictionaryPath), new Set(keys));
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

  const { source, dictionary } = removeKeys(t, dictionaryPath, [
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

  const { dictionary, source } = removeKeys(t, dictionaryPath, ['nested.remove', 'shorthand']);

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

  const { dictionary, source } = removeKeys(t, dictionaryPath, ['group.first', 'group.second']);

  assert.deepEqual([...dictionary.keys], ['survivor']);
  assert.doesNotMatch(source, /group:/);
  assert.match(source, /Keep this sibling and its comment/);
});

test('removes an array-valued property when every element is unused', (t) => {
  const dictionaryPath = temporaryDictionary(
    t,
    `export const dictionary = {
  group: {
    keep: 'keep',
    examples: ['first', 'second', 'third'],
  },
}
`
  );

  const { dictionary, source } = removeKeys(t, dictionaryPath, [
    'group.examples.0',
    'group.examples.1',
    'group.examples.2'
  ]);

  assert.deepEqual([...dictionary.keys], ['group.keep']);
  assert.doesNotMatch(source, /examples/);
  assert.match(source, /keep: 'keep'/);
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
  const dictionary = openDictionary(t, dictionaryPath);
  const result = planDictionaryRemoval(dictionary, new Set(dictionary.keys));
  assert.equal(result.ok, true);
  applyDictionaryRemoval(result.plan);

  const source = fs.readFileSync(dictionaryPath, 'utf8');
  const { program } = openProgram(t, [dictionaryPath], { target: ScriptTarget.ES2022 });
  assert.deepEqual(program.getSyntacticDiagnostics(dictionaryPath), []);
  assert.match(source, /dictionary = \{\s*\}/);
  assert.deepEqual([...openDictionary(t, dictionaryPath).keys], []);
});

test('refuses array-index and computed-property removals', (t) => {
  const arrayPath = temporaryDictionary(
    t,
    `export const dictionary = { list: ['first', 'second'] }
`
  );
  expectRefusal(t, arrayPath, ['list.0'], 'array');

  const computedPath = temporaryDictionary(
    t,
    `const name = 'computed' as const
export const dictionary = { [name]: 'value', keep: 'keep' }
`
  );
  expectRefusal(t, computedPath, ['computed'], 'computed-property');
});

test('refuses imported and shared source property removals', (t) => {
  const importedPath = temporaryDictionary(
    t,
    `import { imported } from './shared.ts'
export const dictionary = { imported }
`,
    { 'shared.ts': `export const imported = { leaf: 'value' }\n` }
  );
  expectRefusal(t, importedPath, ['imported.leaf'], 'imported-declaration');

  const reexportedPath = temporaryDictionary(
    t,
    `export { imported as dictionary } from './shared.ts'\n`,
    { 'shared.ts': `export const imported = { leaf: 'value' }\n` }
  );
  expectRefusal(t, reexportedPath, ['leaf'], 'imported-declaration');

  const sharedPath = temporaryDictionary(
    t,
    `const shared = { remove: 'remove', keep: 'keep' }
export const dictionary = { shared }
`
  );
  expectRefusal(t, sharedPath, ['shared.remove'], 'shared-source-property');
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

  expectRefusal(t, dictionaryPath, ['duplicate'], 'overwrite');
});

test('refuses removals that could reveal values behind unknown spreads', (t) => {
  const beforeSpread = temporaryDictionary(
    t,
    `declare const shared: Record<string, string>
export const dictionary = { ...shared, removable: 'fallback' }
`
  );
  expectRefusal(t, beforeSpread, ['removable'], 'spread');

  const afterSpread = temporaryDictionary(
    t,
    `declare const shared: Record<string, string>
export const dictionary = { removable: 'fallback', ...shared }
`
  );
  expectRefusal(t, afterSpread, ['removable'], 'spread');
});

test('rejects a stale plan before changing the source file', (t) => {
  const dictionaryPath = temporaryDictionary(
    t,
    `export const dictionary = { remove: 'remove', keep: 'keep' }\n`
  );
  const result = planDictionaryRemoval(openDictionary(t, dictionaryPath), new Set(['remove']));
  assert.equal(result.ok, true);
  const changed = `// changed after planning\n${fs.readFileSync(dictionaryPath, 'utf8')}`;
  fs.writeFileSync(dictionaryPath, changed);

  assert.throws(
    () => applyDictionaryRemoval(result.plan),
    /source changed after removal was planned/
  );
  assert.equal(fs.readFileSync(dictionaryPath, 'utf8'), changed);
});

test('rejects a stale multi-file plan before changing either dictionary', (t) => {
  const first = temporaryDictionary(t, `export const dictionary = { unused: 'first' }\n`);
  const second = temporaryDictionary(t, `export const dictionary = { unused: 'second' }\n`);
  const firstPlan = planDictionaryRemoval(openDictionary(t, first), new Set(['unused']));
  const secondPlan = planDictionaryRemoval(openDictionary(t, second), new Set(['unused']));
  assert.equal(firstPlan.ok, true);
  assert.equal(secondPlan.ok, true);
  const firstBefore = fs.readFileSync(first, 'utf8');
  fs.writeFileSync(second, fs.readFileSync(second, 'utf8').replace('second', 'changed'));

  assert.throws(() =>
    applyDictionaryRemoval({
      edits: [
        ...(firstPlan.ok ? firstPlan.plan.edits : []),
        ...(secondPlan.ok ? secondPlan.plan.edits : [])
      ],
      removedKeys: new Set(['unused'])
    })
  );
  assert.equal(fs.readFileSync(first, 'utf8'), firstBefore);
});

test('normalizes duplicate unordered edits and reconstructs output once', (t) => {
  const dictionaryPath = temporaryDictionary(t, 'abcdef');
  const removeB = { fileName: dictionaryPath, start: 1, end: 2, expectedText: 'b' };
  const removeDE = { fileName: dictionaryPath, start: 3, end: 5, expectedText: 'de' };

  const grouped = validateAndGroupEdits([removeDE, removeB, removeB]);
  assert.deepEqual(
    grouped.get(dictionaryPath)?.map(({ start, end }) => [start, end]),
    [
      [1, 2],
      [3, 5]
    ]
  );

  applyDictionaryRemoval({ edits: [removeDE, removeB, removeB], removedKeys: new Set() });
  assert.equal(fs.readFileSync(dictionaryPath, 'utf8'), 'acf');
});

test('rejects conflicting, overlapping, and out-of-bounds edits before mutation', (t) => {
  const dictionaryPath = temporaryDictionary(t, 'abcdef');
  const original = fs.readFileSync(dictionaryPath, 'utf8');
  const edit = (start, end, expectedText) => ({
    fileName: dictionaryPath,
    start,
    end,
    expectedText
  });

  assert.throws(() => validateAndGroupEdits([edit(1, 3, 'bc'), edit(1, 3, 'wrong')]), /disagree/);
  assert.throws(
    () =>
      applyDictionaryRemoval({
        edits: [edit(1, 4, 'bcd'), edit(3, 5, 'de')],
        removedKeys: new Set()
      }),
    /overlap/
  );
  assert.throws(
    () => applyDictionaryRemoval({ edits: [edit(5, 7, 'f')], removedKeys: new Set() }),
    /out of bounds/
  );
  assert.throws(
    () => applyDictionaryRemoval({ edits: [edit(-1, 1, 'a')], removedKeys: new Set() }),
    /invalid range/
  );
  assert.equal(fs.readFileSync(dictionaryPath, 'utf8'), original);
});
