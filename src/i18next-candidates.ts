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
    unresolved ||= branches.unresolved;
    const seen = new Set<string>();
    for (const base of key.values) {
      for (const branch of branches.values) {
        const winner = firstExisting(buildLookupChain(base, branch), dictionary.keys);
        if (!winner || seen.has(winner)) continue;
        seen.add(winner);
        observations.push({
          dictionaryId: dictionary.id,
          key: winner,
          confidence: key.complete && branch.complete ? 'used' : 'possibly-used'
        });
      }
    }
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
): { values: VariantBranch[]; unresolved: boolean } {
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
    unresolved: contexts.unresolved || plurals.unresolved
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
): { values: VariantBranch[]; unresolved: boolean } {
  if (count === undefined) {
    return { values: [{ ordinal: false, zero: false, complete: true }], unresolved: false };
  }
  const rules = pluralRules(locale, ordinal === true ? 'ordinal' : 'cardinal');
  const numbers = count && [...count.values].map(Number).filter(Number.isFinite);
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
    if (!ordinalMode) categories.add('zero');
    for (const category of categories) {
      values.push({
        category,
        ordinal: ordinalMode,
        zero: !ordinalMode && category === 'zero',
        complete: false
      });
    }
  }
  return { values, unresolved: incomplete || !rules || ordinal === null };
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
  return [...new Set(chain)];
}

function firstExisting(chain: readonly string[], keys: ReadonlySet<string>): string | undefined {
  return chain.find((key) => keys.has(key));
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
