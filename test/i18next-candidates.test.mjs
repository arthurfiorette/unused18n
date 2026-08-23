import assert from 'node:assert/strict';
import test from 'node:test';
import { expandI18nextCandidates } from '../dist/i18next-candidates.js';

const exact = (...values) => ({ values: new Set(values), patterns: new Set(), complete: true });
const unknown = () => ({ values: new Set(), patterns: new Set(), complete: false });

test('expands unknown cardinal counts using each locale plural categories', () => {
  const result = expandI18nextCandidates(exact('item'), { count: unknown() }, [
    { id: 'en', locale: 'en', keys: new Set(['item_zero', 'item_one', 'item_other']) },
    {
      id: 'ar',
      locale: 'ar',
      keys: new Set(['item_zero', 'item_one', 'item_two', 'item_few', 'item_many', 'item_other'])
    },
    { id: 'ja', locale: 'ja', keys: new Set(['item_other']) }
  ]);

  assert.deepEqual(
    result.observations.map(({ dictionaryId, key, confidence }) => [dictionaryId, key, confidence]),
    [
      ['en', 'item_one', 'possibly-used'],
      ['en', 'item_other', 'possibly-used'],
      ['en', 'item_zero', 'possibly-used'],
      ['ar', 'item_zero', 'possibly-used'],
      ['ar', 'item_one', 'possibly-used'],
      ['ar', 'item_two', 'possibly-used'],
      ['ar', 'item_few', 'possibly-used'],
      ['ar', 'item_many', 'possibly-used'],
      ['ar', 'item_other', 'possibly-used'],
      ['ja', 'item_other', 'possibly-used']
    ]
  );
});

test('keeps unknown contexts and unknown locales conservative', () => {
  const context = expandI18nextCandidates(exact('friend'), { context: unknown() }, [
    {
      id: 'en',
      locale: 'en',
      keys: new Set(['friend', 'friend_male', 'friend_female'])
    }
  ]);
  const locale = expandI18nextCandidates(exact('item'), { count: exact('1') }, [
    { id: 'unknown', locale: 'not-a-locale', keys: new Set(['item_one', 'item_other']) }
  ]);

  assert.deepEqual(
    context.observations.map(({ key }) => key),
    ['friend', 'friend_male', 'friend_female']
  );
  assert.deepEqual(
    locale.observations.map(({ key }) => key),
    ['item_one', 'item_other']
  );
  assert.ok(context.observations.every(({ confidence }) => confidence === 'possibly-used'));
  assert.ok(locale.observations.every(({ confidence }) => confidence === 'possibly-used'));
});

test('composes context with cardinal and ordinal variants', () => {
  const cardinal = expandI18nextCandidates(
    exact('friend'),
    { count: exact('1'), context: exact('male') },
    [{ id: 'en', locale: 'en', keys: new Set(['friend_male_one', 'friend_one', 'friend']) }]
  );
  const ordinal = expandI18nextCandidates(
    exact('rank'),
    { count: exact('2'), context: exact('male'), ordinal: true },
    [{ id: 'en', locale: 'en', keys: new Set(['rank_male_ordinal_two', 'rank_male_two']) }]
  );

  assert.deepEqual(
    cardinal.observations.map(({ key }) => key),
    ['friend_male_one']
  );
  assert.deepEqual(
    ordinal.observations.map(({ key }) => key),
    ['rank_male_ordinal_two']
  );
});

test('uses the first existing fallback and never normalizes literal suffixed keys', () => {
  const fallback = expandI18nextCandidates(exact('item'), { count: exact('1') }, [
    { id: 'en', locale: 'en', keys: new Set(['item']) }
  ]);
  const literal = expandI18nextCandidates(exact('status_one'), {}, [
    { id: 'en', locale: 'en', keys: new Set(['status_one', 'status']) }
  ]);

  assert.deepEqual(
    fallback.observations.map(({ key }) => key),
    ['item']
  );
  assert.deepEqual(
    literal.observations.map(({ key }) => key),
    ['status_one']
  );
});
