# unused18n Linter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Ship an ESM-only, single-process Oclif linter named `unused18n` that yields TypeScript diagnostics, exits 1 for unused keys, and can remove source-backed unused properties.

**Architecture:** Keep one full TypeScript `Program` for semantic analysis. A generator owns project loading, compiler diagnostics, unused-key diagnostics, advisory dynamic-key warnings, and optional source edits; the Oclif command only parses flags, formats diagnostics, and selects the exit code.

**Tech Stack:** TypeScript 5.9, Node.js 22, Oclif 4, pnpm, Biome.

**Spec:** User request dated 2026-08-21 in the active session.

**PR Strategy:** Single PR; this standalone directory has no Git metadata.

## Constraints

- Remove compact engines, summary linking, semantic workers, batching, and timeout options.
- Export `lint(options)` as a generator yielding `ts.Diagnostic` values.
- Include tsconfig, compiler-option, and syntactic diagnostics when project construction is incomplete.
- Unused keys are diagnostic warnings but make the CLI exit 1 unless `--remove` fixes them.
- `--remove` edits only source-backed dictionary properties; unsupported edits remain diagnostics and exit 1.
- Keep the package ESM-only and expose one Oclif single command named `unused18n`.
- Use pnpm and `@arthurfiorette/biomejs-config`.

## Tasks

### Task 1: Single-process analysis API

- Rename the compatibility analyzer to the sole analyzer.
- Allow an already-created Program/checker to be analyzed without creating a second Program.
- Preserve concrete, possible, and unresolved usage evidence.
- Delete compact, summary, semantic-worker, and streaming-source modules.

### Task 2: Diagnostic lint generator

- Add stable diagnostic codes for unused keys, unresolved runtime references, removals, and configuration failures.
- Yield TypeScript config/options/syntactic diagnostics before i18n diagnostics.
- Locate unused diagnostics on their dictionary property declarations and dynamic warnings on their source call sites.
- Return no hidden result object; consumers derive failure from yielded diagnostic codes/categories.

### Task 3: Safe dictionary removal

- Track the active source property for every flattened dictionary leaf, including overwrite semantics.
- Collapse sibling edits and apply non-overlapping ranges from the end of each file.
- Refuse array-index, imported, computed, or otherwise ambiguous removals with an error diagnostic.
- Reparse the modified dictionary in tests and prove removed keys are absent while comments and surviving properties remain.

### Task 4: Oclif and package migration

- Implement a single Oclif command in `src/index.ts` with required project, dictionary, and export flags plus `--remove`.
- Print each yielded batch with `ts.formatDiagnosticsWithColorAndContext`.
- Exit 1 for compiler errors, removal failures, or remaining unused-key diagnostics; exit 0 after successful removal.
- Rename package/bin/branding to `unused18n`, add ESM `bin/run.js`, migrate scripts and lockfile to pnpm.

### Task 5: Biome, docs, and validation

- Extend `@arthurfiorette/biomejs-config` from `biome.json`.
- Add format/lint/lint-fix/lint-ci scripts and format the repository.
- Rewrite README around linter behavior and removal safety; remove obsolete streaming benchmark/spec docs.
- Run pnpm install, Biome, typecheck, tests, build, pack dry-run, exit-code integration tests, and one final review.
