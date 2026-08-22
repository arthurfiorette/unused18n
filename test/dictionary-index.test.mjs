import assert from 'node:assert/strict';
import test from 'node:test';
import { DictionaryIndex } from '../dist/dictionary-index.js';

function evidence(index, confidence = 'possibly-used') {
  return {
    confidence,
    file: 'src/example.ts',
    line: index + 1,
    column: 3,
    reason: `observation ${index}`
  };
}

test('sorts and deduplicates keys while exact lookup preserves status precedence', () => {
  const dictionary = DictionaryIndex.create(['z', 'a', 'z', 'middle'], true);
  dictionary.markExact('middle', 'possibly-used', evidence(0));
  dictionary.markExact('middle', 'used', evidence(1, 'used'));
  dictionary.markExact('middle', 'possibly-used', evidence(2));
  dictionary.markExact('missing', 'used', evidence(3, 'used'));

  assert.deepEqual(dictionary.toKeyAnalysis(), [
    { key: 'a', status: 'unused', evidence: [] },
    {
      key: 'middle',
      status: 'used',
      evidence: [evidence(1, 'used')]
    },
    { key: 'z', status: 'unused', evidence: [] }
  ]);
});

test('marks only the sorted range sharing a prefix', () => {
  const dictionary = DictionaryIndex.create(
    ['outside', 'account', 'accounting', 'account.name', 'account.profile.title'],
    false
  );
  dictionary.markPrefix('account.', 'possibly-used');

  assert.deepEqual(
    dictionary.toKeyAnalysis().map(({ key, status }) => [key, status]),
    [
      ['account', 'unused'],
      ['account.name', 'possibly-used'],
      ['account.profile.title', 'possibly-used'],
      ['accounting', 'unused'],
      ['outside', 'unused']
    ]
  );
});

test('matches globs inside the range selected by their static prefix', () => {
  const dictionary = DictionaryIndex.create(
    ['admin.users.detail', 'users.detail', 'users.list', 'users.list.title', 'users.listing'],
    false
  );
  dictionary.markPattern('users.*.title', 'possibly-used');
  dictionary.markPattern('users.detail', 'used');

  assert.deepEqual(
    dictionary
      .toKeyAnalysis()
      .filter(({ status }) => status !== 'unused')
      .map(({ key, status }) => [key, status]),
    [
      ['users.detail', 'used'],
      ['users.list.title', 'possibly-used']
    ]
  );
});

test('deduplicates sparse evidence and caps each confidence at 20 entries', () => {
  const dictionary = DictionaryIndex.create(['key', 'without-evidence'], true);
  dictionary.markExact('key', 'possibly-used', evidence(0));
  dictionary.markExact('key', 'possibly-used', { ...evidence(0) });
  for (let index = 1; index < 25; index += 1) {
    dictionary.markExact('key', 'possibly-used', evidence(index));
  }

  const [key, withoutEvidence] = dictionary.toKeyAnalysis();
  assert.equal(key?.status, 'possibly-used');
  assert.equal(key?.evidence.length, 20);
  assert.deepEqual(key?.evidence[0], evidence(0));
  assert.deepEqual(key?.evidence[19], evidence(19));
  assert.deepEqual(withoutEvidence?.evidence, []);
});

test('omits evidence when collection is disabled', () => {
  const dictionary = DictionaryIndex.create(['key'], false);
  dictionary.markExact('key', 'used', evidence(0, 'used'));

  assert.deepEqual(dictionary.toKeyAnalysis(), [{ key: 'key', status: 'used', evidence: [] }]);
});
