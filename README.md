# effect-crap

Analyze TypeScript and Effect function bodies with Oxc. Compute CRAP from existing test coverage, with Effect handling file I/O, errors, validation, and bounded concurrency.

This is a standalone prototype inspired by [crap-typescript](https://github.com/fabian-barney/crap-typescript), with an original implementation. It uses `oxc-parser` at runtime, Oxlint for linting, and Oxfmt for formatting. It does not depend on the TypeScript compiler at runtime. Effect 3.22 is the currently tested API version.

## Run locally

The bundled CLI requires Node.js 22.18 or later. The core library uses injected Effect Platform services and has no Node runtime imports.

```sh
npm ci
npm run build
node dist/bin.js --help

# Inspect complexity without coverage. CRAP will be N/A.
node dist/bin.js src

# Generate coverage for this project, then analyze it.
npm run test:coverage
node dist/bin.js src --coverage coverage/coverage-final.json

# Analyze another project and enforce coverage in CI.
node dist/bin.js --root ../my-app src \
  --coverage coverage/coverage-final.json \
  --threshold 6 --require-coverage --format json
```

During development, use `npm run dev -- <arguments>` instead of building first. The package is private and has not been published to npm.

The analyzer reads coverage you supply; it does not run the target project's tests. Enable the `json` coverage reporter in Vitest or Jest to produce Istanbul-format `coverage-final.json`. Vitest 5 V8/Istanbul and Vitest 3.2.7 V8 are tested end to end. Raw V8 JSON and LCOV are not accepted.

## Effect-aware discovery

```ts
import * as Effect from "effect/Effect";

const checkout = Effect.gen(function* () {
  const quantity = yield* Effect.succeed(2);
  if (quantity > 0) return quantity;
  return 0;
});
```

The generator is reported as `checkout`, kind `effect.gen`, complexity **2**. A yield is sequencing and does not add a decision. Constructing the Effect does not count as executing the generator body.

Supported inline forms:

- `Effect.gen(function* () { ... })`, including the context overload.
- `Effect.fn(function* () { ... })` and `Effect.fn("name")(function* () { ... })`.
- `Effect.fn` with an ordinary function or arrow callback.
- `Effect.fnUntraced(function* () { ... })`.
- Import aliases, namespace imports from `effect` and `effect/Effect`, and direct named imports from `effect/Effect`.
- TypeScript expression wrappers and a following `.pipe(...)`.

Recognition follows lexical bindings, including parameters, destructuring, blocks, catch clauses, loops, and hoisted `var` declarations. An unrelated object called `Effect` is not classified as the library. Type-only imports do not establish a runtime binding.

All ordinary function bodies are analyzed too: declarations, arrows, anonymous callbacks, constructors, methods, and accessors. Overload signatures and declarations without a body are omitted. A wrapper such as `() => Effect.gen(...)` and its generator have separate rows. Nested decisions and coverage counters are attributed once, to the innermost containing function. Anonymous names include their call context, argument position, source location, and enclosing function where available. For example, a handler becomes `handlers.handle("createTask")[arg2]@12:4`, and a recovery callback includes `Effect.catchTag("Missing")[arg2]`.

## Scoring

```text
CRAP = CC² × (1 − coverage)³ + CC
coverage = min(statement coverage, branch coverage)
```

Coverage is a ratio between 0 and 1. Complexity starts at 1 and increases for each `if`, loop, catch clause, ternary, non-default switch case, logical expression, logical assignment, default value, and optional-chain operation. Nested function and class bodies do not increase their enclosing function's complexity. This policy includes default parameters and is not intended to reproduce every upstream score exactly.

For complexity 2, no coverage produces CRAP 6; 50% coverage produces 2.5; full coverage produces 2. Scores fail only when **strictly greater than** the configured threshold, which defaults to 6. The threshold is a project policy, not a universal quality guarantee.

Missing coverage is `null` in JSON and `N/A` in text, never silently zero or full coverage. A missing branch counter is only treated as structurally inapplicable when no branch-producing syntax was found. Empty function bodies require an unambiguous function-entry counter; its hit status supplies the coverage ratio, with zero statement counters still reported. Malformed coverage JSON or mismatched counter maps fails the run.

Vitest 3 V8 reports can represent statements as whole lines, including lines shared by several callbacks. For a branch-free expression body, an exact function-entry counter or exact V8 function execution range establishes whether its single expression ran. We never use a sibling's line hits for this fallback. JSON `coverage.statementBasis` identifies `statements`, `function-entry`, or `v8-function-range` (or `null` when unavailable). Functions with actual branching still need branch counters. Conflicting execution counters stay unknown. Function/branch ranges extending beyond a body are normalized only when the source confirms the extra characters are whitespace or closing punctuation; line numbers alone are insufficient.

JSON has `schemaVersion: 1`, selected `files`, a `functions` array, summary counts, and an `exclusions` audit with active patterns and skipped paths. Each function includes its name, kind, source and body ranges, complexity, coverage counts and ratios, CRAP, and status. Lines are one-based and JSON columns are zero-based UTF-16 offsets; text locations use one-based columns. Functions sort by descending measured CRAP, followed by unknown scores.

## CLI options

| Option                    | Behavior                                                      |
| ------------------------- | ------------------------------------------------------------- |
| `[paths...]`              | Files or recursively scanned directories; defaults to `src`   |
| `--root <path>`           | Base directory for inputs and relative coverage file entries  |
| `--coverage <path>`       | Existing Istanbul JSON report                                 |
| `--threshold <number>`    | Maximum allowed CRAP; default 6                               |
| `--format text\|json`     | Output format; default text                                   |
| `--exclude <glob>`        | Exclude a project-relative path glob; repeatable              |
| `--no-default-exclusions` | Disable generated-source defaults; retain explicit exclusions |
| `--require-coverage`      | Fail if any analyzed function has unknown coverage            |
| `--help`, `-h`            | Print usage                                                   |

Directory scans include `.ts`, `.tsx`, `.mts`, and `.cts`. They skip declaration files, `.test`/`.spec` files, hidden entries, symlinks, and `node_modules`, `dist`, `build`, `coverage`, `.next`, and `__tests__` directories. Overlapping inputs are deduplicated. No matching source files is an error.

Generated-source defaults exclude `**/generated/**`, `**/gen/**`, `**/*.generated.{ts,tsx,mts,cts}`, and `**/*.gen.{ts,tsx,mts,cts}`. Additional globs match normalized project-relative paths, including explicit file inputs. Use forward slashes and quote patterns to prevent shell expansion. Globs support `*`, `**`, `?`, character classes, and braces; leading `!` is literal, not a re-inclusion rule. An excluded directory is reported once without enumerating its contents.

```sh
node dist/bin.js apps packages --exclude '**/*.stories.tsx' --exclude 'apps/web/e2e/**'
node dist/bin.js src --no-default-exclusions --exclude '**/legacy/**'
```

Library callers use `exclude: string[]` and `useDefaultExclusions: false` for the same behavior. Disabling generated defaults does not disable the baseline directory and test-file filters.

| Exit code | Meaning                                                                              |
| --------- | ------------------------------------------------------------------------------------ |
| 0         | No measured threshold failures; unknown scores can exist unless coverage is required |
| 1         | Invalid input, parse failure, file error, or invalid coverage                        |
| 2         | At least one measured score exceeds the threshold                                    |
| 3         | Coverage required, but at least one score is unknown                                 |

Threshold failure takes precedence over incomplete coverage; JSON includes both counts. Reports go to stdout, errors to stderr.

## Library API

```ts
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Analyzer from "effect-crap";
import * as Oxc from "effect-crap/oxc";

const runtime = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, Oxc.layer);

const report = await Effect.runPromise(
  Analyzer.analyze({
    root: ".",
    paths: ["src"],
    coverage: "coverage/coverage-final.json",
    threshold: 6,
  }).pipe(Effect.provide(runtime)),
);
```

`analyze` returns `Effect<AnalysisReport, AnalysisError, FileSystem | Path | SourceParser>`. Callers supply those services explicitly; the core does not choose a runtime or read `process.cwd()`. `root` defaults to `"."`, interpreted by the supplied filesystem. `parseSource(file, source)` requires only `SourceParser`. `calculateCrap(complexity, coverage)` remains pure.

For other environments, supply their Effect Platform filesystem/path layers (or an in-memory filesystem and `@effect/platform/Path.layer`). The native `effect-crap/oxc` adapter is a separate opt-in entrypoint and is never imported by the core. A browser or WASM integration must provide a `SourceParser` layer with a `parse(file, source)` method returning an Effect containing an Oxc-compatible ESTree program with UTF-16 offsets. The parser adapter must reject invalid syntax through `AnalysisError`. No browser/WASM parser is bundled yet.

Tests exercise analysis with an in-memory filesystem and injected parser, and verify that the core and CLI logic bundle for browsers without Node or native Oxc modules. Node-specific argv/output/exit handling lives only in `src/bin.ts`.

## Limits and next steps

- This measures standard syntactic complexity. Calls such as `Effect.catchTag`, `Effect.match`, retries, races, or `Match.when` do not add semantic branch weights. Their callback bodies are analyzed, but this does not establish that every Effect outcome was tested. A future semantic metric should be separate from standard CRAP.
- Recognition is local and import-based. Re-exports, dynamically selected APIs, CommonJS imports, reassigned namespace properties, and aliases such as `const E = Effect` are not resolved. Their functions still receive ordinary analysis. Effect 4 and additional APIs need dedicated compatibility fixtures.
- Coverage must correspond to the current source and be remapped to TypeScript. Absolute paths or paths resolved against `--root` must match; no suffix guessing is performed. Reports from another checkout need regenerated or remapped paths. Stale reports cannot be reliably detected from Istanbul metadata alone.
- Source-map end columns of `null` are matched using the start position and ending line. Implicit-else placeholders use their parent branch's location. Complex source transformations can still leave functions with unknown coverage; use `--require-coverage` for a strict gate.
- There is no project-wide type checker, editor integration, automatic test execution, or test-runner plugin yet. Some transformed or uninstrumented callbacks still have unknown coverage.

## Develop

```sh
npm run check          # Typecheck, Oxlint, Oxfmt check, tests, build
npm run fmt            # Format with Oxfmt
npm run test:coverage  # Generate this analyzer's coverage
npm run setup:compat   # Install the isolated, pinned Vitest 3 fixture dependencies
npm run test:compat    # Exercise actual Vitest 3 V8 reports
```

The tests include real Effect programs run under both Vitest 5 coverage providers and an isolated Vitest 3.2.7 V8 fixture, with fully covered, partially covered, never-executed, nested, and empty functions. Parser tests cover aliases, shadowing, TSX, Unicode positions, and complexity boundaries. Synthetic attribution regressions deliberately include shared-line hits, punctuation-expanded ranges, missing branch counters, and conflicting metadata. Compatibility fixtures contain no private application code.

GitHub Actions runs the standard checks (including browser bundling and Vitest 5 integration tests) on Node 22 and 24, with a separate job for the pinned Vitest 3 fixture.
