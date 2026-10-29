import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  isIdentifier,
  isInterfaceDeclaration,
  isVariableDeclaration,
  isVariableStatement,
  ScriptTarget
} from 'typescript/ast';
import { ModuleKind, ModuleResolutionKind, SymbolFlags } from 'typescript/sync';
import { Semantic } from '../dist/semantic.js';
import { openProgram, temporaryProject } from './helpers.mjs';

/**
 * Writes TypeScript modules and opens a program over them with wire timing enabled. The files
 * are fetched through the returned `semantic`, which is what lets its symbol prefetches resolve
 * declarations in them eagerly.
 *
 * @param {import('node:test').TestContext} t Owning test; the directory and process close with it.
 * @param {Record<string, string>} files Module sources keyed by file name.
 */
function openFiles(t, files) {
  const directory = temporaryProject(t, files);
  const fileNames = Object.keys(files).map((fileName) => path.join(directory, fileName));
  const opened = openProgram(
    t,
    fileNames,
    {
      module: ModuleKind.NodeNext,
      moduleResolution: ModuleResolutionKind.NodeNext,
      target: ScriptTarget.ES2022
    },
    { collectTiming: true }
  );
  const sourceFiles = opened.semantic.prefetchSourceFiles(fileNames);
  assert.ok(sourceFiles.every(Boolean));
  return { ...opened, fileNames, sourceFiles };
}

/**
 * Opens a two-module project with resolved, missing-export and missing-module imports.
 *
 * @param {import('node:test').TestContext} t Owning test; the directory and process close with it.
 */
function openFixture(t) {
  const opened = openFiles(t, {
    'values.ts': `export const value = { label: 'Label' }
export function greet(name: string) { return name }
`,
    'usage.ts': `import { value, greet } from './values.js'
import { absent } from './values.js'
import { missing } from './nowhere.js'
const local = value.label
greet(local)
absent
missing
`
  });
  const [values, usage] = opened.sourceFiles;
  return { ...opened, values, usage };
}

/**
 * Opens a single module and returns its source file.
 *
 * @param {import('node:test').TestContext} t Owning test; the directory and process close with it.
 * @param {string} text Module source.
 */
function openModule(t, text) {
  const opened = openFiles(t, { 'module.ts': text });
  return { ...opened, sourceFile: opened.sourceFiles[0] };
}

/**
 * Collects every identifier under `root` in source order.
 *
 * @param {import('typescript/ast').Node} root
 */
function identifiers(root) {
  const found = [];
  const visit = (node) => {
    if (isIdentifier(node)) found.push(node);
    node.forEachChild(visit);
  };
  visit(root);
  return found;
}

/**
 * Returns the first identifier spelled `text`; in the fixture that is always its import specifier.
 *
 * @param {import('typescript/ast').Node[]} nodes
 * @param {string} text
 */
function named(nodes, text) {
  const node = nodes.find((candidate) => candidate.text === text);
  assert.ok(node, `identifier ${text}`);
  return node;
}

/**
 * Counts compiler round trips so far. Whether the snapshot request counts itself is up to the
 * API version, so callers measure that cost with two back-to-back snapshots and subtract it.
 *
 * @param {import('typescript/sync').API} api
 */
function wireRequests(api) {
  return api.getTimingInfo().totals.requestCount;
}

test('prefetched symbol and declaration lookups issue no further requests', (t) => {
  const { api, semantic, usage } = openFixture(t);
  const nodes = identifiers(usage);

  semantic.prefetchSymbols(nodes);
  assert.ok(semantic.stats.batchRequests > 0);
  assert.equal(semantic.stats.singleRequests, 0);

  const baseline = wireRequests(api);
  const snapshotCost = wireRequests(api) - baseline;
  const before = wireRequests(api);
  for (const node of nodes) {
    semantic.declarations(semantic.symbol(node));
    semantic.declarations(semantic.rawSymbol(node));
  }
  const after = wireRequests(api);

  assert.equal(semantic.stats.singleRequests, 0);
  assert.equal(after - before, snapshotCost);
});

test('prefetched results are identical to single lookups', (t) => {
  const { api, program, semantic: prefetched, usage } = openFixture(t);
  const nodes = identifiers(usage);
  const single = new Semantic(api, program);
  prefetched.prefetchSymbols(nodes);

  for (const node of nodes) {
    const symbol = prefetched.symbol(node);
    assert.equal(single.rawSymbol(node), prefetched.rawSymbol(node), node.text);
    assert.equal(single.symbol(node), symbol, node.text);
    const declarations = prefetched.declarations(symbol);
    assert.equal(single.declarations(symbol).length, declarations.length, node.text);
    single.declarations(symbol).forEach((declaration, index) => {
      assert.equal(declaration, declarations[index], node.text);
    });
  }
  assert.ok(single.stats.singleRequests >= nodes.length);
  assert.ok(nodes.some((node) => prefetched.symbol(node) !== undefined));
});

test('aliased resolves imports to the exported symbol and unresolvable imports to undefined', (t) => {
  const { semantic, usage, values } = openFixture(t);
  const usageNames = identifiers(usage);
  const valueDeclaration = values.statements
    .flatMap((statement) => statement.declarationList?.declarations ?? [])
    .find((declaration) => isVariableDeclaration(declaration));
  assert.ok(valueDeclaration);
  const exported = semantic.rawSymbol(valueDeclaration.name);
  assert.ok(exported);

  const importAlias = semantic.rawSymbol(named(usageNames, 'value'));
  assert.ok(importAlias);
  assert.notEqual(importAlias.flags & SymbolFlags.Alias, 0);
  assert.equal(semantic.aliased(importAlias), exported);
  const declarations = semantic.declarations(semantic.aliased(importAlias));
  assert.equal(declarations.length, 1);
  assert.equal(declarations[0], valueDeclaration);
  assert.equal(semantic.aliased(exported), exported);

  for (const unresolved of ['absent', 'missing']) {
    const alias = semantic.rawSymbol(named(usageNames, unresolved));
    assert.ok(alias, unresolved);
    assert.notEqual(alias.flags & SymbolFlags.Alias, 0, unresolved);
    assert.equal(semantic.aliased(alias), undefined, unresolved);
  }
});

/**
 * Asserts that two node lists hold the same nodes in the same order. Nodes are compared by
 * identity because deep comparison would walk their parent links.
 *
 * @param {readonly import('typescript/ast').Node[]} actual
 * @param {readonly import('typescript/ast').Node[]} expected
 */
function assertSameNodes(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((node, index) => {
    assert.ok(node === expected[index], `node ${index}`);
  });
}

test('prefetching an empty list sends nothing and duplicate nodes match single lookups', (t) => {
  const { api, program, semantic, usage } = openFixture(t);
  const stats = { ...semantic.stats };
  const baseline = wireRequests(api);
  const snapshotCost = wireRequests(api) - baseline;
  const before = wireRequests(api);
  semantic.prefetchSymbols([]);
  semantic.prefetchTypes([]);
  assert.equal(wireRequests(api) - before, snapshotCost);
  assert.deepEqual(semantic.stats, stats);

  const nodes = identifiers(usage);
  const duplicated = [...nodes, ...nodes.toReversed()];
  semantic.prefetchSymbols(duplicated);
  semantic.prefetchTypes(duplicated);
  const prefetched = { ...semantic.stats };
  semantic.prefetchSymbols(duplicated);
  semantic.prefetchTypes(duplicated);
  assert.deepEqual(semantic.stats, prefetched);

  const single = new Semantic(api, program);
  for (const node of nodes) {
    assert.equal(semantic.rawSymbol(node), single.rawSymbol(node), node.text);
    assert.equal(semantic.typeAt(node), single.typeAt(node), node.text);
  }
  assert.deepEqual(semantic.stats, prefetched);
});

test('a symbol without declarations resolves to an empty list', (t) => {
  const { api, program, semantic, sourceFile } = openModule(
    t,
    'export const nothing = undefined\n'
  );
  const node = named(identifiers(sourceFile), 'undefined');
  const single = new Semantic(api, program);
  const symbol = single.rawSymbol(node);
  assert.ok(symbol);
  assert.equal(symbol.declarations.length, 0);
  assert.deepEqual(single.declarations(symbol), []);
  assert.equal(single.valueDeclaration(symbol), undefined);

  semantic.prefetchSymbols([node]);
  const singleRequests = semantic.stats.singleRequests;
  assert.deepEqual(semantic.declarations(semantic.symbol(node)), []);
  assert.equal(semantic.stats.singleRequests, singleRequests);
});

test('a symbol merged within one file returns every declaration in source order', (t) => {
  const { api, program, semantic, sourceFile } = openModule(
    t,
    `interface Merged { a: string }
interface Merged { b: string }
interface Merged { c: string }
export declare const merged: Merged
`
  );
  const interfaces = sourceFile.statements.filter(isInterfaceDeclaration);
  const reference = identifiers(sourceFile).at(-1);
  assert.equal(reference?.text, 'Merged');
  assert.equal(interfaces.length, 3);

  const single = new Semantic(api, program);
  assertSameNodes(single.declarations(single.symbol(reference)), interfaces);
  semantic.prefetchSymbols([reference]);
  assertSameNodes(semantic.declarations(semantic.symbol(reference)), interfaces);
});

test('propertyOfType finds apparent members that propertiesOfType omits', (t) => {
  const { semantic, sourceFile } = openModule(
    t,
    `interface Shape { size: number }
export declare const shape: Shape
`
  );
  const statement = sourceFile.statements.find(isVariableStatement);
  const declaration = statement?.declarationList.declarations[0];
  assert.ok(declaration);
  const type = semantic.typeAt(declaration.name);

  const properties = semantic.propertiesOfType(type);
  assert.deepEqual(
    properties.map(({ name }) => name),
    ['size']
  );
  assert.equal(semantic.propertyOfType(type, 'toString')?.name, 'toString');
  assert.equal(semantic.propertyOfType(type, 'size'), properties[0]);
});

test('batch splits more than 4096 requests into chunks and keeps result order', (t) => {
  const count = 5_000;
  const { program, semantic, sourceFile } = openModule(
    t,
    Array.from({ length: count }, (_, index) => `export const v${index} = ${index}\n`).join('')
  );
  const names = sourceFile.statements.map(
    (statement) => statement.declarationList.declarations[0].name
  );
  assert.equal(names.length, count);
  const checker = program.getProject().checker;
  const before = { ...semantic.stats };

  const symbols = semantic.batch(names, (name) => checker.getSymbolAtLocation.gen(name));

  assert.deepEqual(
    symbols.map((symbol) => symbol?.name),
    names.map((name) => name.text)
  );
  assert.equal(semantic.stats.batchRequests - before.batchRequests, 2);
  assert.equal(semantic.stats.singleRequests, before.singleRequests);
});
