# unused18n

Type-aware unused i18next dictionary linter for TypeScript projects.

`unused18n` creates one TypeScript `Program`, follows translation aliases and finite key types, and emits source-located TypeScript diagnostics. It is ESM-only and requires Node.js 22.18 or newer.

## Install

```sh
pnpm add --save-dev unused18n
```

## Usage

```sh
pnpm unused18n \
  --project ./tsconfig.json \
  --dictionary ./src/i18n/pt.ts \
  --export dictionary
```

Flags:

```text
-p, --project <path>        tsconfig.json or its directory
-d, --dictionary <path>     TypeScript dictionary source file
-e, --export <name>         exported dictionary variable
    --max-expansions <n>    finite string-union expansion limit (default: 1000)
    --remove                remove every safely editable unused key
```

The command exits with code `1` when unused keys remain or analysis produces an error. Dynamic keys that cannot be bounded statically are warning diagnostics but do not fail the command by themselves. Invalid flags exit with code `2`.

## Remove

`--remove` deletes unused object properties directly from the dictionary source. Edits are planned atomically, checked against the original text, and applied without printing the AST, so unrelated formatting and comments remain untouched.

Removal is refused when a key comes from an array, computed property, imported/shared object, spread, or ambiguous overwrite. If any unused key is unsafe, the file is left unchanged and the command exits `1` with an error diagnostic.

## Diagnostics API

```ts
import { lint } from 'unused18n'

for (const diagnostic of lint({
  project: './tsconfig.json',
  dictionary: './src/i18n/pt.ts',
  dictionaryExport: 'dictionary',
})) {
  // Every result is a standard TypeScript Diagnostic.
  console.log(diagnostic)
}
```

The generator also yields tsconfig, compiler-option, and source syntax diagnostics before running dictionary analysis. Source edits happen only while the generator is consumed.

## Supported Usage

- Literal, conditional, asserted, concatenated, and template-literal keys
- Finite string unions inferred from parameters, helpers, maps, and indexed access
- `useTranslation()` aliases, custom hooks, and `keyPrefix`
- Direct `i18n.t()` calls and `<Trans i18nKey>`
- Translation functions passed through helpers and wrappers
- `returnObjects: true`, property access, destructuring, enumeration, and spreads
- Direct dictionary access

Review unresolved runtime-key warnings before deleting related dictionary prefixes.
