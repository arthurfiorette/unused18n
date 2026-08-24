import { bench, do_not_optimize, run } from 'mitata';
import { DictionaryIndex } from '../dist/dictionary-index.js';

const keyCount = parseKeyCount(process.argv.slice(2));
const keys = Array.from(
  { length: keyCount },
  (_, index) => `group${Math.floor(index / 100)}.section${Math.floor(index / 10) % 10}.key${index}`
);
const evidence = {
  confidence: 'possibly-used',
  file: 'src/usage.ts',
  line: 1,
  column: 1,
  reason: 'benchmark observation'
};
const observations = [
  {
    kind: 'exact',
    value: keys[Math.floor(keyCount / 2)],
    confidence: 'possibly-used',
    evidence
  },
  { kind: 'prefix', value: 'group0.', confidence: 'possibly-used', evidence },
  { kind: 'pattern', value: 'group1.*.key*', confidence: 'possibly-used', evidence }
];

bench(`compact observation replay ${keyCount.toLocaleString()} leaves`, () => {
  const index = DictionaryIndex.create(keys, true);
  for (const observation of observations) {
    if (observation.kind === 'exact') {
      index.markExact(observation.value, observation.confidence, observation.evidence);
    } else if (observation.kind === 'prefix') {
      index.markPrefix(observation.value, observation.confidence, observation.evidence);
    } else {
      index.markPattern(observation.value, observation.confidence, observation.evidence);
    }
  }
  return do_not_optimize(index.toKeyAnalysis().length);
}).gc('inner');

await run({ throw: true });

function parseKeyCount(arguments_) {
  const argument = arguments_.find((value) => value.startsWith('--keys='));
  const inlineValue = argument?.slice('--keys='.length);
  const separateIndex = arguments_.indexOf('--keys');
  const value = inlineValue ?? (separateIndex >= 0 ? arguments_[separateIndex + 1] : undefined);
  const parsed = Number(value ?? 10_000);
  if (!Number.isSafeInteger(parsed) || parsed < 2)
    throw new Error('--keys must be an integer greater than one');
  return parsed;
}
