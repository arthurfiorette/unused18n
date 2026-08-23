# unused18n

Type-aware unused i18next dictionary linter for TypeScript projects.

`unused18n` creates one TypeScript program, follows translation aliases and finite key types, and reports unused keys at their dictionary declarations. It is ESM-only and requires Node.js 24 or newer.

## Install

```sh
pnpm add --save-dev unused18n
```

## Usage

Given a default-exported dictionary:

```ts
// src/i18n/en.ts

export default {
  common: {
    save: 'Save',
    cancel: 'Cancel'
  }
};
```

Run:

```sh
pnpm unused18n lint \
  --project=./tsconfig.json \
  --dictionary=./src/i18n/en.ts \
  --export=default
```

Named exports work too:

```ts
export const dictionary = {
  common: { save: 'Save' }
};
```

```sh
pnpm unused18n lint \
  --project=./tsconfig.json \
  --dictionary=./src/i18n/en.ts \
  --export=dictionary
```

Flags:

```text
-p, --project <path>        tsconfig.json or its directory
-d, --dictionary <path>     TypeScript dictionary source file
-e, --export <name>         named export, or "default" for the default export
    --max-expansions <n>    finite string-union expansion limit (default: 1000)
    --remove                remove every safely editable unused key
```

Run `unused18n help` for command help or `unused18n autocomplete` to install shell completion for Bash, Zsh, or PowerShell. Completion-aware invocations use `unused18n lint`; bare `unused18n --flags` calls remain supported for compatibility.

## Supported patterns

### Literals and finite keys

Literal, conditional, asserted, concatenated, and finite template-literal keys are resolved:

```ts
const { t } = useTranslation();

t('common.save');
t(isEditing ? 'form.update' : 'form.create');
t(apiKey as 'errors.notFound' | 'errors.unauthorized');

function statusLabel(status: 'pending' | 'complete') {
  return t(`status.${status}`);
}
```

Finite values can also flow through helpers, maps, indexed access, and reassigned local variables.

### Aliases, prefixes, and custom hooks

Hook aliases, destructured translators, `keyPrefix`, and wrappers around `useTranslation()` retain their translation provenance:

```ts
import { useTranslation as useI18n } from 'react-i18next';

const { t: commonT } = useI18n(undefined, { keyPrefix: 'common' });
commonT('save');

function useCheckoutTranslation() {
  return useI18n(undefined, { keyPrefix: 'checkout' });
}

const { t: checkoutT } = useCheckoutTranslation();
checkoutT('title');
```

Custom hooks may return the translation result directly or expose the translator inside another object.

### Components and forwarded translators

`Trans` aliases and translation functions passed through typed helpers are followed:

```tsx
import { Trans as Message, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

const { t } = useTranslation();

function translateButton(
  translate: TFunction,
  key: 'buttons.save' | 'buttons.cancel'
) {
  return translate(key);
}

translateButton(t, 'buttons.save');

export function EmptyState() {
  return <Message i18nKey='empty.title' />;
}
```

### Object translations and dictionary access

Object-returning translations track the properties that are actually consumed:

```ts
const dashboard = t('dashboard', {
  returnObjects: true
}) as typeof dictionary.dashboard;

dashboard.title;
const { description } = dashboard;
```

Direct dictionary access, destructuring, spreads, enumeration, and finite indexed access are also recognized:

```ts
dictionary.common.save;
const { cancel } = dictionary.common;
Object.keys(dictionary.categories);
```

Unbounded runtime keys produce source-located warnings. They do not hide unrelated unused keys.

## Removing unused keys

```sh
pnpm unused18n lint \
  --project=. \
  --dictionary=./src/i18n/en.ts \
  --export=default \
  --remove
```

`--remove` plans all edits before changing the dictionary, verifies the original source text, and deletes properties without reprinting the AST. Unrelated formatting and comments remain untouched.

Removal is refused when an unused key comes from an array, computed property, imported or shared object, unresolved spread, or ambiguous overwrite. If any requested edit is unsafe, the file remains unchanged.

## Exit codes

- `0`: no unused keys remain, or every requested removal succeeded
- `1`: unused keys remain or analysis/removal produced an error
- `2`: CLI arguments or flags are invalid
- `127`: the requested Oclif command does not exist

Unresolved runtime-key warnings alone do not fail the command.

## Programmatic usage

Use `lint()` when diagnostics need to be consumed by another tool instead of printed by the CLI:

```ts
import { DiagnosticCode, lint } from 'unused18n';

for (const diagnostic of lint({
  project: './tsconfig.json',
  dictionary: './src/i18n/en.ts',
  dictionaryExport: 'default'
})) {
  if (diagnostic.code === DiagnosticCode.UnusedKey) {
    console.log(diagnostic.file?.fileName, diagnostic.messageText);
  }
}
```

`lint()` is a lazy generator. Consuming it loads the project, analyzes usage, and optionally applies `remove: true`. It yields standard TypeScript diagnostics, including project configuration and syntax errors that prevent safe analysis.
