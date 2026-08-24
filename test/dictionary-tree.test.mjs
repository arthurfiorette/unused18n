import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from '@typescript/typescript6';
import { readDictionary } from '../dist/dictionary.js';
import { ActiveDictionaryTree } from '../dist/dictionary-tree.js';

function source(keyPrefix, marker = keyPrefix) {
  return {
    valueNode: { marker },
    propertyChain: [{ node: { marker }, keyPrefix, barriers: [] }]
  };
}

function addBarrier(sourceValue, barrier) {
  return {
    ...sourceValue,
    propertyChain: sourceValue.propertyChain.map((property) => ({
      ...property,
      barriers: property.barriers.includes(barrier)
        ? property.barriers
        : [...property.barriers, barrier]
    }))
  };
}

function flatHasSubtree(keySources, prefix) {
  for (const key of keySources.keys()) {
    if (key === prefix || key.startsWith(`${prefix}.`)) return true;
  }
  return false;
}

function flatDeleteSubtree(keySources, prefix) {
  for (const key of keySources.keys()) {
    if (key === prefix || key.startsWith(`${prefix}.`)) keySources.delete(key);
  }
}

function flatAddBarrier(keySources, prefix, barrier) {
  for (const [key, sourceValue] of keySources) {
    if (prefix && key !== prefix && !key.startsWith(`${prefix}.`)) continue;
    keySources.set(key, addBarrier(sourceValue, barrier));
  }
}

function summarize(keySources) {
  return [...keySources].map(([key, sourceValue]) => ({
    key,
    marker: sourceValue.valueNode.marker,
    chain: sourceValue.propertyChain.map(({ keyPrefix, barriers }) => ({ keyPrefix, barriers }))
  }));
}

test('matches flat active-state overwrite, subtree, barrier, and insertion behavior', () => {
  const tree = new ActiveDictionaryTree();
  const flat = new Map();
  const set = (segments, sourceValue) => {
    tree.set(segments, sourceValue);
    flat.set(segments.join('.'), sourceValue);
  };
  const deleteSubtree = (segments) => {
    tree.deleteSubtree(segments);
    flatDeleteSubtree(flat, segments.join('.'));
  };
  const barrier = (segments, value) => {
    tree.addBarrier(segments, value);
    flatAddBarrier(flat, segments.join('.'), value);
  };

  set(['flat'], source('flat'));
  set(['nested', 'first'], source('nested.first'));
  set(['nested', 'second'], source('nested.second'));
  assert.equal(tree.has(['flat']), true);
  assert.equal(tree.has(['nested']), false);
  assert.equal(tree.hasSubtree(['nested']), flatHasSubtree(flat, 'nested'));

  barrier(['nested'], 'spread');
  deleteSubtree(['nested']);
  set(['nested', 'winner'], addBarrier(source('nested.winner'), 'overwrite'));
  set(['array', '0'], addBarrier(source('array.0'), 'array'));
  set(['array', '1', 'label'], addBarrier(source('array.1.label'), 'array'));
  set(['unresolved', 'before'], source('unresolved.before'));
  set(['unresolved'], source('unresolved'));
  set(['unresolved', 'after'], source('unresolved.after'));
  set(['literal.key'], source('literal.key'));
  assert.equal(tree.has(['literal', 'key']), true);
  assert.equal(tree.hasSubtree(['literal']), flatHasSubtree(flat, 'literal'));
  deleteSubtree(['literal']);
  set(['interleaved.first'], source('interleaved.first'));
  set(['outside'], source('outside'));
  set(['interleaved.last'], source('interleaved.last'));
  barrier([], 'shared-source-property');
  deleteSubtree(['array', '0']);
  set(['array', '0'], addBarrier(source('array.0', 'reinserted'), 'array'));

  assert.deepEqual(summarize(tree.toKeySources()), summarize(flat));
});

test('preserves dictionary provenance for overwrites, spreads, shorthand, imports, arrays, and computed names', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unused18n-tree-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const dictionaryPath = path.join(directory, 'dictionary.ts');
  const importedPath = path.join(directory, 'imported.ts');
  const dictionarySource = `import { imported } from './imported.js'
const spreadSource = { spreadLeaf: 'spread' }
const shorthand = 'short'
const shared = { sharedLeaf: 'shared' }
const computed = 'computed' as const
declare const unknown: Record<string, string>
export const dictionary = {
  flat: 'flat',
  nested: { old: 'old' },
  nested: { final: 'final' },
  ...spreadSource,
  shorthand,
  imported,
  shared,
  list: ['zero', { deep: 'deep' }],
  [computed]: 'computed',
  unknownGroup: { before: 'before', ...unknown, after: 'after' },
}
`;
  fs.writeFileSync(dictionaryPath, dictionarySource);
  fs.writeFileSync(importedPath, `export const imported = { leaf: 'imported' }\n`);

  const program = ts.createProgram([dictionaryPath, importedPath], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022
  });
  assert.deepEqual(program.getSyntacticDiagnostics(), []);
  const dictionary = readDictionary(
    program,
    program.getTypeChecker(),
    dictionaryPath,
    'dictionary'
  );

  assert.deepEqual(
    [...dictionary.keys],
    [
      'flat',
      'nested.final',
      'spreadLeaf',
      'shorthand',
      'imported.leaf',
      'shared.sharedLeaf',
      'list.0',
      'list.1.deep',
      'computed',
      'unknownGroup.before',
      'unknownGroup',
      'unknownGroup.after'
    ]
  );

  const chain = (key) =>
    dictionary.keySources.get(key)?.propertyChain.map((property) => ({
      text: property.node.getText(),
      keyPrefix: property.keyPrefix,
      barriers: property.barriers
    }));
  assert.deepEqual(chain('nested.final'), [
    {
      text: "nested: { final: 'final' }",
      keyPrefix: 'nested',
      barriers: ['overwrite']
    },
    { text: "final: 'final'", keyPrefix: 'nested.final', barriers: [] }
  ]);
  assert.deepEqual(chain('spreadLeaf'), [
    {
      text: "spreadLeaf: 'spread'",
      keyPrefix: 'spreadLeaf',
      barriers: ['shared-source-property']
    }
  ]);
  assert.deepEqual(chain('shorthand'), [
    { text: 'shorthand', keyPrefix: 'shorthand', barriers: [] }
  ]);
  assert.deepEqual(chain('imported.leaf'), [
    {
      text: 'imported',
      keyPrefix: 'imported',
      barriers: ['imported-declaration']
    },
    {
      text: "leaf: 'imported'",
      keyPrefix: 'imported.leaf',
      barriers: ['shared-source-property', 'imported-declaration']
    }
  ]);
  assert.deepEqual(chain('shared.sharedLeaf'), [
    { text: 'shared', keyPrefix: 'shared', barriers: [] },
    {
      text: "sharedLeaf: 'shared'",
      keyPrefix: 'shared.sharedLeaf',
      barriers: ['shared-source-property']
    }
  ]);
  assert.deepEqual(
    chain('list.1.deep')?.map(({ barriers }) => barriers),
    [['array'], ['array']]
  );
  assert.deepEqual(
    chain('computed')?.map(({ barriers }) => barriers),
    [['computed-property']]
  );
  assert.deepEqual(
    chain('unknownGroup.before')?.map(({ barriers }) => barriers),
    [['spread'], ['spread']]
  );
  assert.deepEqual(
    chain('unknownGroup.after')?.map(({ barriers }) => barriers),
    [[], ['spread']]
  );
  assert.deepEqual(chain('unknownGroup'), [
    {
      text: "unknownGroup: { before: 'before', ...unknown, after: 'after' }",
      keyPrefix: 'unknownGroup',
      barriers: ['spread']
    }
  ]);

  for (const sourceValue of dictionary.keySources.values()) {
    assert.equal(
      sourceValue.valueNode.getSourceFile().text.includes(sourceValue.valueNode.getText()),
      true
    );
    for (const property of sourceValue.propertyChain) {
      assert.equal(
        property.node.getSourceFile().text.slice(property.node.getStart(), property.node.getEnd()),
        property.node.getText()
      );
    }
  }
});
