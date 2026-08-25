import type { StringResolution } from './strings.js';
import type { UsageConfidence } from './types.js';

export interface TranslationVariantOptions {
  count?: StringResolution | null;
  context?: StringResolution | null;
  ordinal?: boolean | null;
}

export interface CandidateDictionary {
  id: string;
  locale: string;
  keys: ReadonlySet<string>;
}

export interface CandidateObservation {
  dictionaryId: string;
  key: string;
  confidence: UsageConfidence;
}

export interface CandidateExpansion {
  observations: CandidateObservation[];
  unresolved: boolean;
}

const allCategories = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;

/** Variant suffixes are generated from source options, so literal suffix-like keys stay literal. */
export function expandI18nextCandidates(
  key: StringResolution,
  options: TranslationVariantOptions,
  dictionaries: readonly CandidateDictionary[]
): CandidateExpansion {
  const observations: CandidateObservation[] = [];
  let unresolved = false;

  for (const dictionary of dictionaries) {
    const branches = optionBranches(options, dictionary.locale);
    let covered = key.values.size > 0;
    const seen = new Set<string>();
    for (const base of key.values) {
      for (const branch of branches.values) {
        const winner = firstExisting(buildLookupChain(base, branch), dictionary.keys);
        if (!winner) {
          covered = false;
          continue;
        }
        if (seen.has(winner)) continue;
        seen.add(winner);
        observations.push({
          dictionaryId: dictionary.id,
          key: winner,
          confidence: key.complete && branch.complete ? 'used' : 'possibly-used'
        });
      }
    }
    if (branches.unresolved && (!branches.coverageCanResolve || !covered)) unresolved = true;
    for (const pattern of key.patterns) {
      const matcher = globMatcher(pattern);
      for (const candidate of dictionary.keys) {
        if (!matcher.test(candidate) || seen.has(candidate)) continue;
        seen.add(candidate);
        observations.push({
          dictionaryId: dictionary.id,
          key: candidate,
          confidence: 'possibly-used'
        });
      }
    }
    if (options.context === null || (options.context && !options.context.complete)) {
      for (const base of key.values) {
        for (const candidate of dictionary.keys) {
          if (!candidate.startsWith(`${base}_`) || seen.has(candidate)) continue;
          seen.add(candidate);
          observations.push({
            dictionaryId: dictionary.id,
            key: candidate,
            confidence: 'possibly-used'
          });
        }
      }
    }
  }
  return { observations, unresolved };
}

interface VariantBranch {
  context?: string;
  category?: string;
  ordinal: boolean;
  zero: boolean;
  complete: boolean;
}

function optionBranches(
  options: TranslationVariantOptions,
  locale: string
): { values: VariantBranch[]; unresolved: boolean; coverageCanResolve: boolean } {
  const contexts = contextBranches(options.context);
  const plurals = pluralBranches(options.count, options.ordinal, locale);
  return {
    values: contexts.values.flatMap((context) =>
      plurals.values.map((plural) => ({
        ...plural,
        ...(context.value === undefined ? {} : { context: context.value }),
        complete: context.complete && plural.complete
      }))
    ),
    unresolved: contexts.unresolved || plurals.unresolved,
    coverageCanResolve: !contexts.unresolved && plurals.coverageCanResolve
  };
}

function contextBranches(resolution: StringResolution | null | undefined): {
  values: Array<{ value?: string; complete: boolean }>;
  unresolved: boolean;
} {
  if (resolution === undefined) return { values: [{ complete: true }], unresolved: false };
  if (resolution === null) return { values: [{ complete: false }], unresolved: true };
  const values: Array<{ value?: string; complete: boolean }> = [...resolution.values]
    .filter((value) => value.length > 0)
    .map((value) => ({ value, complete: resolution.complete }));
  if (values.length === 0 || !resolution.complete) values.push({ complete: false });
  return { values, unresolved: !resolution.complete || resolution.patterns.size > 0 };
}

function pluralBranches(
  count: StringResolution | null | undefined,
  ordinal: boolean | null | undefined,
  locale: string
): { values: VariantBranch[]; unresolved: boolean; coverageCanResolve: boolean } {
  if (count === undefined) {
    return {
      values: [{ ordinal: false, zero: false, complete: true }],
      unresolved: false,
      coverageCanResolve: false
    };
  }
  const rules = pluralRules(locale, ordinal === true ? 'ordinal' : 'cardinal');
  const numbers: number[] | undefined = count ? [] : undefined;
  if (count && numbers) {
    for (const value of count.values) {
      const number = Number(value);
      if (Number.isFinite(number)) numbers.push(number);
    }
  }
  const incomplete = count === null || !count.complete || numbers?.length !== count.values.size;
  const ordinalModes = ordinal === null ? [false, true] : [ordinal ?? false];
  const values: VariantBranch[] = [];
  for (const ordinalMode of ordinalModes) {
    const modeRules = ordinalMode ? pluralRules(locale, 'ordinal') : rules;
    if (numbers && numbers.length > 0 && !incomplete) {
      if (!modeRules) {
        for (const category of allCategories) {
          values.push({
            category,
            ordinal: ordinalMode,
            zero: !ordinalMode && category === 'zero',
            complete: false
          });
        }
        continue;
      }
      for (const number of numbers) {
        values.push({
          category: modeRules.select(number),
          ordinal: ordinalMode,
          zero: !ordinalMode && number === 0,
          complete: Boolean(modeRules)
        });
      }
      continue;
    }
    const categories = new Set(modeRules?.resolvedOptions().pluralCategories ?? allCategories);
    for (const category of categories) {
      values.push({
        category,
        ordinal: ordinalMode,
        zero: !ordinalMode && category === 'zero',
        complete: false
      });
    }
    if (!ordinalMode) {
      if (modeRules) {
        values.push({
          category: modeRules.select(0),
          ordinal: false,
          zero: true,
          complete: false
        });
      } else {
        for (const category of allCategories) {
          values.push({ category, ordinal: false, zero: true, complete: false });
        }
      }
    }
  }
  return {
    values,
    unresolved: incomplete || !rules || ordinal === null,
    coverageCanResolve: Boolean(rules)
  };
}

function buildLookupChain(base: string, branch: VariantBranch): string[] {
  const contextBase = branch.context ? `${base}_${branch.context}` : base;
  const suffix = branch.category
    ? branch.ordinal
      ? `_ordinal_${branch.category}`
      : `_${branch.category}`
    : '';
  const chain: string[] = [];
  if (branch.zero) chain.push(`${contextBase}_zero`);
  if (suffix) chain.push(`${contextBase}${suffix}`);
  if (branch.ordinal && branch.category) chain.push(`${contextBase}_${branch.category}`);
  if (branch.context) chain.push(contextBase);
  if (branch.context && branch.zero) chain.push(`${base}_zero`);
  if (branch.context && suffix) chain.push(`${base}${suffix}`);
  if (branch.context && branch.ordinal && branch.category) chain.push(`${base}_${branch.category}`);
  chain.push(base);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const candidate of chain) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    unique.push(candidate);
  }
  return unique;
}

function firstExisting(chain: readonly string[], keys: ReadonlySet<string>): string | undefined {
  for (const key of chain) {
    if (keys.has(key)) return key;
  }
  return undefined;
}

function pluralRules(locale: string, type: Intl.PluralRuleType): Intl.PluralRules | undefined {
  try {
    const normalized = locale === 'dev' ? 'en' : locale.replaceAll('_', '-');
    const canonical = Intl.getCanonicalLocales(normalized)[0];
    if (!canonical || Intl.PluralRules.supportedLocalesOf([canonical]).length === 0)
      return undefined;
    return new Intl.PluralRules(canonical, { type });
  } catch {
    return undefined;
  }
}

function globMatcher(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`);
}
