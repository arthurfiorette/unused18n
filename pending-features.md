# Pending features

This document defines potential `unused18n` capabilities independently from the current public contract and architecture. It describes observable behavior and implementation constraints.

## Design principles

- Prefer TypeScript symbols, types, and syntax over text or regular-expression matching.
- Never let an uncertain reference silently suppress unrelated unused-key diagnostics.
- Preserve the distinction between exact usage, possible usage, and unresolved runtime usage.
- Analyze one TypeScript `Program` per invocation and share source observations across dictionaries.
- Persist only serializable facts. Never cache AST, `ts.Symbol`, or `ts.Type` identities.
- Cache compatibility must include every option that changes key interpretation or diagnostics.
- Keep removal formatting-preserving and all-or-nothing. New input formats are read-only until they have equivalent edit provenance and safety barriers.
- Add CLI behavior through the programmatic API first so both surfaces share one contract.

## Recommended sequence

1. Namespace model.
2. Missing-key diagnostics.
3. Plural, ordinal, and context semantics.
4. Multiple dictionaries and key exclusions.
5. Typed registration for opaque translators.
6. Source filtering and framework adapters.
7. Additional dictionary loaders and configuration discovery.

Namespace identity must precede missing-key reporting: a statically resolved key cannot be declared missing until the analyzer knows which dictionary owns its namespace. Multiple dictionaries should follow dictionary-independent source facts so source analysis is not repeated for every locale.

## 1. Namespace model

### Goal

Associate a selected dictionary with an i18next namespace and prevent calls targeting another namespace from marking its keys as used.

### Public contract

The API needs explicit namespace configuration rather than inferring it from filenames or directory names. Candidate options:

```ts
interface LintOptions {
  dictionaryNamespace?: string;
  defaultNamespace?: string;
  namespaceSeparator?: string | false;
}
```

Equivalent CLI flags should use `--dictionary-namespace`, `--default-namespace`, and `--namespace-separator`. A disabled separator needs an unambiguous CLI representation rather than overloading an empty string.

### Required semantics

- `useTranslation('checkout')` binds its translator to `checkout`.
- `useTranslation(['checkout', 'common'])` uses the first finite namespace as the default while retaining fallback namespaces as possible targets where i18next semantics require it.
- `t('title', { ns: 'account' })` overrides the translator's bound namespace.
- `t('account:title')` honors the configured namespace separator.
- Calls proven to target a different namespace do not affect the selected dictionary.
- Calls with an unresolved namespace produce source-located unresolved evidence instead of marking every dictionary key used.
- Calls without namespace information use `defaultNamespace` only when configured. The analyzer must not guess the runtime default.
- Namespace handling remains separate from `keyPrefix`; the final reference is `{ namespace, keyPrefix, key }` rather than one concatenated string.

### Internal model

Introduce a structured source reference before flattening:

```ts
interface TranslationReference {
  namespaces: StringResolution;
  key: StringResolution;
  confidence: 'used' | 'possibly-used';
  evidence: UsageEvidence;
}
```

The selected dictionary descriptor decides whether a reference applies. Namespace and key separators should only be rendered at public reporting boundaries.

### Tests

- Selected, different, default, and overridden namespaces.
- Named and aliased `useTranslation` imports.
- Namespace arrays and finite namespace unions.
- Explicit namespace-qualified keys.
- Custom and disabled namespace separators.
- Unknown namespaces and unknown `ns` option spreads.
- Consistent diagnostics across cached, uncached, and partially invalidated runs.

## 2. Missing-key diagnostics

### Goal

Report finite source references that target the selected dictionary but do not exist in it.

### Public contract

- Add a source-located missing-key diagnostic distinct from unresolved runtime references.
- Add `failOnMissing?: boolean` and `--fail-on-missing` for CI enforcement.
- Keep missing-key collection enabled by default if it is advisory; the flag controls exit status, not whether analysis occurs.
- Missing diagnostics identify the key, namespace when configured, and source expression.
- Programmatic consumers receive standard TypeScript diagnostics through `lint()`.

### Internal changes

Current usage facts are filtered through dictionary membership too early. Replace dictionary-expanded facts with dictionary-independent references:

```ts
interface SourceReferenceFacts {
  fileName: string;
  references: TranslationReference[];
  unresolvedReferences: UsageEvidence[];
}
```

Analysis should collect finite references once. A later comparison phase classifies each reference as present, missing, targeting another namespace, or unresolved.

This changes persisted fact semantics and requires a cache algorithm-version increment. Dictionary key-shape changes should rerun comparison without requiring source reanalysis.

### Diagnostic behavior

- One missing literal produces one diagnostic at its source expression.
- A finite union reports each absent member without duplicating present members.
- Duplicate references may produce separate source diagnostics but must not duplicate aggregate counts for the same location.
- Unbounded expressions remain unresolved warnings and are not converted into missing keys.
- Missing warnings fail only when `failOnMissing` is enabled.

### Tests

- Literal, conditional, union, and finite template keys.
- Mixed present and absent candidates.
- Namespace ownership and overrides.
- Duplicate references in one and multiple files.
- CLI exit behavior with and without `--fail-on-missing`.
- Cache hits after dictionary-only changes.

## 3. Plural, ordinal, and context semantics

### Goal

Interpret i18next call options so a base source key can account for the concrete dictionary variants used at runtime.

### Public contract

Plural selection may require locale information. A dictionary descriptor should support an explicit locale:

```ts
interface DictionaryDescriptor {
  path: string;
  export?: string;
  namespace?: string;
  locale?: string;
}
```

Do not expose arbitrary suffix-normalization regular expressions. Variant handling should follow documented i18next behavior and existing dictionary candidates.

### Required semantics

- `t('item', { count })` may reference cardinal variants such as `item_one` and `item_other` that exist in the dictionary.
- `ordinal: true` selects ordinal variants independently from cardinal variants.
- A configured locale narrows categories using `Intl.PluralRules` where possible.
- `count: 0` supports an existing exact zero variant when i18next would prefer it.
- A finite `context` value references matching context variants.
- Context and plural variants compose in the runtime order used by i18next.
- `t('item')` without `count` or `context` does not automatically mark suffixed variants used.
- `t('item_one')` remains an exact literal reference and is never forcibly normalized.
- Unknown count or finite context values weaken only matching variants to possible usage; they do not affect unrelated prefixes.

### Internal model

Attach proven call metadata to `TranslationReference`:

```ts
interface TranslationVariantOptions {
  count?: NumberResolution;
  ordinal?: BooleanResolution;
  context?: StringResolution;
}
```

Expand variants while comparing references with dictionary keys. Avoid modifying the original source key because missing-key diagnostics still need to distinguish an absent base from present variants.

### Tests

- Cardinal categories, ordinals, zero, finite context, and combined context/plural variants.
- Literal and finite numeric counts.
- Unknown counts and contexts.
- Keys ending in suffix-like text that are intentionally literal.
- Locale-specific categories.
- Object-returning translations and `keyPrefix` composition.

## 4. Multiple dictionaries

### Goal

Analyze several explicit dictionaries using one TypeScript program and one source-reference pass.

### Public contract

Add a plural API without making the existing single-dictionary call ambiguous:

```ts
interface LintManyOptions {
  project: string;
  dictionaries: DictionaryDescriptor[];
  failOnMissing?: boolean;
  cache?: boolean;
  cacheDir?: string;
  onCacheEvent?: (event: CacheEvent) => void;
}

declare function lintMany(options: LintManyOptions): Generator<ts.Diagnostic, void, void>;
```

The CLI may accept repeated `--dictionary` descriptors or a configuration file once descriptor syntax stabilizes. It should not recursively discover arbitrary locale files by default.

### Required semantics

- Load and diagnose the TypeScript project once.
- Collect source references once, then compare them with each dictionary descriptor.
- Preserve dictionary paths in every unused or removal diagnostic.
- Namespace-aware dictionaries receive only references that can target them.
- Locale variants are evaluated per dictionary locale.
- Duplicate descriptors are rejected before analysis.
- Removal is planned across all selected dictionaries before any file changes. If any edit is unsafe or stale, no dictionary is changed.

### Cache design

- Compiler state is keyed by project/compiler compatibility, not by one dictionary.
- Source-reference facts are independent of dictionary key shape.
- Dictionary comparison entries are keyed by descriptor identity and content hash.
- Changing one dictionary does not invalidate source-reference facts or unrelated dictionary comparisons.

### Tests

- Two namespaces, two locales, and shared source references.
- One dictionary changing while another remains warm.
- Duplicate descriptors and conflicting namespace/locale identities.
- Aggregate diagnostics with stable ordering.
- Cross-file all-or-nothing removal.

## 5. Key exclusions

### Goal

Exclude intentionally retained dictionary keys from unused diagnostics and removal.

### Public contract

Prefer explicit exact keys and glob patterns:

```ts
interface DictionaryDescriptor {
  excludeKeys?: string[];
}
```

Patterns use normalized dictionary key paths and the same documented wildcard semantics as dynamic key matching. Exclusions are dictionary-specific and apply before unused diagnostics or removal planning.

### Constraints

- Exclusions do not mark a key used and must not affect usage evidence.
- An excluded parent pattern excludes matching descendants.
- Invalid patterns fail configuration rather than silently matching nothing.
- Exclusion configuration participates in cache compatibility.

### Tests

- Exact, subtree, and wildcard exclusions.
- Flat properties containing separator characters.
- Excluded keys under `--remove`.
- Different exclusions for multiple dictionaries.

## 6. Typed translator registration

### Goal

Support opaque application wrappers whose implementation is unavailable while retaining provenance guarantees.

### Public contract

Register module exports or global symbols structurally, not source-text regular expressions:

```ts
interface TranslatorRegistration {
  module?: string;
  export: string;
  kind: 'translator' | 'hook-object' | 'hook-tuple' | 'fixed-translator-factory';
  keyArgument?: number;
  prefix?: string;
}

interface LintOptions {
  translators?: TranslatorRegistration[];
}
```

Registrations resolve through TypeScript module symbols. A missing or ambiguous export is a configuration error.

### Required semantics

- Translator registrations identify the key argument and optional fixed prefix.
- Hook-object registrations identify the translator property.
- Hook-tuple registrations identify the translator index.
- Factory registrations identify the argument that binds `keyPrefix`.
- Registered symbols can be aliased and re-exported without losing provenance.
- Local functions with the same text name do not match.
- Registration changes invalidate cached analysis facts.

### Tests

- Declaration-only functions and hooks.
- Aliases, re-exports, overloads, and namespace imports.
- Incorrect module/export configuration.
- Key argument positions other than zero.
- Fixed and dynamic prefixes.
- Unregistered structural lookalikes.

## 7. Source filtering

### Goal

Let callers narrow application files already present in the TypeScript program without bypassing TypeScript semantics.

### Public contract

```ts
interface LintOptions {
  includeSources?: string[];
  excludeSources?: string[];
}
```

Patterns resolve relative to the `tsconfig.json` directory. Imported files remain eligible unless excluded explicitly. Declaration files and dependencies under `node_modules` remain excluded from application-fact collection.

### Constraints

- Filtering occurs after TypeScript constructs the program.
- Excluded files contribute no usage facts.
- Changes to filters invalidate analysis facts.
- Filtering cannot add arbitrary files that TypeScript cannot parse.

### Tests

- Included roots, imported files, exclusions, and overlapping patterns.
- Paths outside the current working directory.
- Cache invalidation after filter changes.
- Diagnostics from excluded source files are absent while project syntax diagnostics remain unchanged.

## 8. Framework source adapters

### Goal

Analyze embedded TypeScript from framework files, beginning with Vue single-file components, without regex-scanning raw source.

### Architecture

Define an adapter that produces virtual TypeScript files and maps virtual ranges back to original source locations:

```ts
interface SourceAdapter {
  supports(fileName: string): boolean;
  transform(fileName: string, source: string): VirtualSource[];
}

interface VirtualSource {
  fileName: string;
  text: string;
  mapRange(start: number, length: number): OriginalRange | undefined;
}
```

Virtual files must enter the same TypeScript program used by normal analysis. Diagnostics and evidence are remapped before exposure or caching.

### Constraints

- No regular-expression fallback over full files.
- Adapter/version identity participates in cache compatibility.
- Unsupported template constructs produce unresolved evidence or no reference, never guessed exact usage.
- Removal remains disabled for virtual sources until edits can be mapped and validated safely.

### Tests

- `<script setup lang="ts">`, standard script blocks, and template translation expressions.
- Source maps for diagnostics and evidence.
- Multiple virtual files from one source.
- Adapter parse failures and cache invalidation.

## 9. Additional dictionary loaders

### Goal

Read explicit dictionary formats that cannot be represented by strict JSON or TypeScript object exports.

### Architecture

Introduce read-only loaders behind a stable descriptor:

```ts
interface DictionaryLoader<Result = unknown> {
  id: string;
  version: string;
  load(fileName: string, source: string): Result;
  enumerate(value: Result): DictionaryEntry[];
}
```

Built-in CommonJS compatibility can resolve `module.exports` and `exports.<name>` through the TypeScript AST. YAML or other formats should use explicit optional adapters rather than runtime `require()`.

### Constraints

- Loader output must preserve key locations for diagnostics.
- Loaders execute only for explicitly selected files.
- Loader identity, version, and source content participate in cache compatibility.
- A loader is read-only unless it also supplies formatting-preserving edit ranges and stale-source validation.
- Arbitrary module execution is not allowed during analysis.

## 10. Configuration discovery

### Goal

Make repeated multi-dictionary and registration configuration practical after those APIs stabilize.

### Contract

- Discover one documented configuration filename from the working directory or an explicit `--config` path.
- CLI flags override scalar configuration.
- Repeated CLI dictionary descriptors replace or extend configured descriptors according to one documented rule.
- Configuration is validated before project loading.
- JavaScript configuration must be ESM and should export a plain object. JSON configuration remains data-only.
- Configuration loading errors use the existing configuration diagnostic path and CLI failure status.

Do not add config discovery while the public model is still limited to one project and one dictionary; two required flags are simpler and more explicit.

## Demand-driven compatibility

These features may be useful but should not displace analyzer correctness work:

- A CommonJS package entry point for programmatic consumers.
- JavaScript dictionaries using statically analyzable CommonJS export assignments.
- A stable structured analysis-result API after namespace and missing-key result shapes settle.
- Shell-oriented reporting formats such as JSON or SARIF.
- Editor integrations consuming standard TypeScript diagnostics.

Each requires concrete consumer demand and independent packaging or API tests.

## Explicit non-goals

- User-provided regular expressions that scan source text for translation-like calls.
- Treating comments or strings as executable translation references.
- Matching every method named `.t()` without symbol or type provenance.
- Scanning arbitrary files outside the TypeScript program without a parser adapter.
- Mutating array indices when removal would shift later keys.
- Prefixing values with an unused marker.
- Synchronizing or merging locale files as a side effect of linting.
- Rewriting complete JSON or TypeScript dictionaries when source-range edits are unavailable.
- Depending on Git state for mutation safety.
- Estimating reclaimable bytes from key names without measuring the serialized removable ranges.
- Reproducing configurable suffix-normalization regexes that can reinterpret legitimate literal keys.
