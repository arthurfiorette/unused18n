import { bench, do_not_optimize, run } from 'mitata';
import { ActiveDictionaryTree } from '../dist/dictionary-tree.js';

const keyCount = parseKeyCount(process.argv.slice(2));
const paths = Array.from({ length: keyCount }, (_, index) => [
  `group${Math.floor(index / 100)}`,
  `section${Math.floor(index / 10) % 10}`,
  `key${index}`
]);
const source = {
  valueNode: {},
  propertyChain: [{ node: {}, keyPrefix: '', barriers: [] }]
};

bench(`ActiveDictionaryTree ${keyCount.toLocaleString()} leaves`, () => {
  const tree = new ActiveDictionaryTree();
  for (const path of paths) tree.set(path, source);
  tree.addBarrier(['group0'], 'spread');
  tree.deleteSubtree(['group1']);
  return do_not_optimize(tree.toKeySources().size);
}).gc('inner');

await run({ throw: true });

function parseKeyCount(arguments_) {
  const argument = arguments_.find((value) => value.startsWith('--keys='));
  const inlineValue = argument?.slice('--keys='.length);
  const separateIndex = arguments_.indexOf('--keys');
  const value = inlineValue ?? (separateIndex >= 0 ? arguments_[separateIndex + 1] : undefined);
  const parsed = Number(value ?? 10_000);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error('--keys must be a positive integer');
  return parsed;
}
