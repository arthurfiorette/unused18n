import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isIdentifier, isVariableDeclaration, ScriptTarget } from 'typescript/ast';
import { ModuleKind, ModuleResolutionKind, SymbolFlags } from 'typescript/sync';
import { Semantic } from '../dist/semantic.js';
import { openProgram } from './helpers.mjs';

/**
 * Writes a two-module project with resolved, missing-export and missing-module imports, then
 * opens a program over it with wire timing enabled.
 *
 * @param {import('node:test').TestContext} t Owning test; the directory and process close with it.
 */
function openFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unused18n-semantic-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const valuesPath = path.join(directory, 'values.ts');
  const usagePath = path.join(directory, 'usage.ts');
  fs.writeFileSync(
    valuesPath,
    `export const value = { label: 'Label' }
export function greet(name: string) { return name }
`
  );
  fs.writeFileSync(
    usagePath,
    `import { value, greet } from './values.js'
import { absent } from './values.js'
import { missing } from './nowhere.js'
const local = value.label
greet(local)
absent
missing
`
  );
  const opened = openProgram(
    t,
    [valuesPath, usagePath],
    {
      module: ModuleKind.NodeNext,
      moduleResolution: ModuleResolutionKind.NodeNext,
      target: ScriptTarget.ES2022
    },
    { collectTiming: true }
  );
  const [values, usage] = opened.api.batch(
    opened.program.getSourceFile.gen(valuesPath),
    opened.program.getSourceFile.gen(usagePath)
  );
  assert.ok(values && usage);
  return { ...opened, values, usage };
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
  const { api, program, usage } = openFixture(t);
  const nodes = identifiers(usage);
  const semantic = new Semantic(api, program);

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
  const { api, program, usage } = openFixture(t);
  const nodes = identifiers(usage);
  const prefetched = new Semantic(api, program);
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
  assert.ok(single.stats.batchRequests > 0);
  assert.ok(single.stats.singleRequests >= nodes.length);
  assert.ok(nodes.some((node) => prefetched.symbol(node) !== undefined));
});

test('aliased resolves imports to the exported symbol and unresolvable imports to undefined', (t) => {
  const { api, program, usage, values } = openFixture(t);
  const semantic = new Semantic(api, program);
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
