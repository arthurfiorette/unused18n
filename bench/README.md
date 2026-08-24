# Performance benchmarks

Use the benchmark suite to compare direct `lint()` calls on the same machine and otherwise-idle system. CLI parsing, diagnostic rendering, and subprocess startup are intentionally excluded.

## Generate a deterministic project

```sh
pnpm bench:generate -- \
  --output bench/generated/1k \
  --keys 1000 \
  --unused-ratio 0.5 \
  --depth 3 \
  --arrays 10
```

`--keys` is the total number of dictionary leaves. `--arrays` reserves up to four leaves per generated array and the matching usage iterates those arrays, keeping removal benchmarks safe. The remaining used object leaves are accessed directly.

## In-process synthetic benchmark

Build first, then run mitata against a generated project:

```sh
pnpm build
pnpm bench:synthetic -- \
  --project bench/generated/1k \
  --dictionary dictionary.ts \
  --export default

pnpm bench:synthetic -- \
  --project bench/generated/1k \
  --dictionary dictionary.ts \
  --export default \
  --remove
```

Mitata runs with manual GC exposed, handles warm-up and sampling, and reports estimated heap usage. Remove-mode setup restores the original dictionary outside the measured function before every iteration.
Pass `--cache` to make mitata's calibration call populate the normal persistent cache before measured direct `lint()` calls.
Use `--cache-dir <path>` to isolate benchmark cache state from the target project's normal cache.
For minute-scale real projects, pass `--samples 1`; this uses mitata's low-level `measure()` API to avoid the default twelve-sample calibration loop while still calling `lint()` directly.

## Sparse analyzer benchmark

Benchmark the checker-free source inventory and a direct `lint()` call without routing either measurement through the CLI:

```sh
pnpm build
pnpm bench:analyzer -- \
  --project bench/generated/1k \
  --dictionary dictionary.ts \
  --source usage.ts \
  --export default
```

The inventory case parses its source outside the measured traversal result, while the analyzer case includes project loading and all lint stages.

## Active dictionary benchmark

After building, exercise hierarchical dictionary insertion, a focused barrier update, subtree deletion, and final flat-map materialization directly in-process:

```sh
pnpm bench:dictionary-tree -- --keys 10000
```

Run multiple key counts separately when checking scaling. This benchmark imports `ActiveDictionaryTree` directly and does not include CLI, project creation, or TypeScript parsing time.

## Compact observation replay

After building, benchmark exact, prefix, and pattern replay directly through `DictionaryIndex`:

```sh
pnpm bench:observations -- --keys 10000
```

The measured function creates the index, replays compact serializable observations, and materializes final key analysis. It does not invoke the CLI or spawn benchmark children.

## Baseline summary

Record unprofiled mitata results here with the machine, Node version, scenario, key count, average, p75, and p99. Profiled CPU, heap, and GC runs are diagnostic data and must remain separate from this table.

| Machine | Node | Scenario | Keys | Average | p75 | p99 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Apple M4 Pro | 24.16.0 | Direct `lint()` read | 1,000 | 96.08 ms | — | — |
| Apple M4 Pro | 24.16.0 | Direct `lint()` cold read (`web/user`) | 29,968 | 33.42 s | 33.42 s | 33.42 s |
| Apple M4 Pro | 24.16.0 | Direct `lint()` warm cached read (`web/user`) | 29,968 | 6.65 s | 6.65 s | 6.65 s |
| Apple M4 Pro | 24.16.0 | Direct `lint()` warm cached remove | 10,000 | 297.40 ms | 297.40 ms | 297.40 ms |
| Apple M4 Pro | 24.16.0 | Direct `lint()` warm cached remove | 20,000 | 424.39 ms | 424.39 ms | 424.39 ms |
| Apple M4 Pro | 24.16.0 | Direct `lint()` warm cached remove | 40,000 | 724.04 ms | 724.04 ms | 724.04 ms |

The minute-scale rows use one measured mitata sample after its calibration call. Synthetic removal grows `1.43x` from `10K → 20K` and `1.71x` from `20K → 40K`, below the `2.5x` scaling limit.
| Apple M4 Pro | 24.16.0 | Direct `lint()` remove | 1,000 | 103.54 ms | 104.16 ms | 105.47 ms |
| Apple M4 Pro | 24.16.0 | Direct `inventorySource()` | 1,000 | 773.09 µs | 791.92 µs | 877.21 µs |
| Apple M4 Pro | 24.16.0 | Direct `lint()` sparse analyzer | 1,000 | 94.18 ms | 94.23 ms | 95.44 ms |
