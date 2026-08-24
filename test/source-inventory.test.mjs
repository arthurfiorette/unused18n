import assert from 'node:assert/strict';
import test from 'node:test';
import ts from '@typescript/typescript6';
import { inventorySource } from '../dist/source-inventory.js';

test('inventories sparse syntax categories in source order with lexical owners', () => {
  const source = ts.createSourceFile(
    'usage.tsx',
    `const top = hook()
function outer(value) {
  value = translate('first')
  const inner = () => {
    value = translate('second')
    return <Trans i18nKey="jsx" />
  }
  return object.child
}
`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const inventory = inventorySource(source);
  const text = (node) => node.getText(source);

  assert.deepEqual(inventory.calls.map(text), [
    'hook()',
    "translate('first')",
    "translate('second')"
  ]);
  assert.deepEqual(inventory.translatorCandidates.map(text), ['top = hook()']);
  assert.deepEqual([...inventory.returnsByFunction.values()].flat().map(text), [
    '<Trans i18nKey="jsx" />',
    'object.child'
  ]);
  assert.equal(inventory.assignments[0].owner, inventory.functions[0]);
  assert.equal(inventory.assignments[1].owner, inventory.functions[1]);
  assert.equal(inventory.callEdges[1].owner, inventory.functions[0]);
  assert.equal(inventory.callEdges[2].owner, inventory.functions[1]);
  const starts = inventory.usageNodes.map((node) => node.getStart(source));
  assert.deepEqual(
    starts,
    [...starts].sort((left, right) => left - right)
  );
});
