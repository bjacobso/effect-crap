import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { attributeCoverage, calculateCrap, findCoverage, parseCoverage } from "./coverage.js";
import { AnalysisError, type AnalysisReport, type FunctionResult } from "./model.js";
import { parseSource } from "./parser.js";

export interface AnalyzeOptions {
  paths?: readonly string[];
  root?: string;
  coverage?: string;
  threshold?: number;
}

const ignored = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
  ".next",
  "__tests__",
]);
const sourceFile = (file: string) =>
  /\.(?:[cm]?ts|tsx)$/.test(file) && !/\.(?:d|test|spec)\.(?:[cm]?ts|tsx)$/.test(file);
const io = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new AnalysisError({
        message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });

function selectFiles(inputs: readonly string[], root: string) {
  return io("Unable to select source files", async () => {
    const files = new Set<string>();
    const visited = new Set<string>();
    const visit = async (input: string, explicit: boolean): Promise<void> => {
      const file = await realpath(input);
      if (visited.has(file)) return;
      visited.add(file);
      const info = await stat(file);
      if (info.isDirectory()) {
        for (const entry of await readdir(file, { withFileTypes: true })) {
          if (entry.isSymbolicLink() || ignored.has(entry.name) || entry.name.startsWith("."))
            continue;
          if (entry.isDirectory() || sourceFile(entry.name))
            await visit(path.join(file, entry.name), false);
        }
      } else if (sourceFile(file)) files.add(file);
      else if (explicit) throw new Error(`Not an analyzable TypeScript file: ${input}`);
    };
    for (const input of inputs) await visit(path.resolve(root, input), true);
    return [...files].sort();
  });
}

export const analyze = (
  options: AnalyzeOptions = {},
): Effect.Effect<AnalysisReport, AnalysisError> =>
  Effect.gen(function* () {
    const root = yield* io("Unable to resolve project root", () =>
      realpath(options.root ?? process.cwd()),
    );
    const threshold = options.threshold ?? 6;
    if (!Number.isFinite(threshold) || threshold < 0)
      return yield* new AnalysisError({
        message: "Threshold must be a finite non-negative number",
      });
    const files = yield* selectFiles(options.paths?.length ? options.paths : ["src"], root);
    if (files.length === 0)
      return yield* new AnalysisError({ message: "No analyzable TypeScript files selected" });
    const coverage = options.coverage
      ? yield* io(`Unable to read coverage: ${options.coverage}`, () =>
          readFile(path.resolve(root, options.coverage!), "utf8"),
        ).pipe(Effect.flatMap(parseCoverage))
      : undefined;
    const results = yield* Effect.forEach(
      files,
      (file) =>
        Effect.gen(function* () {
          const source = yield* io(`Unable to read ${file}`, () => readFile(file, "utf8"));
          const units = yield* parseSource(file, source);
          const coverages = attributeCoverage(
            units,
            coverage ? findCoverage(coverage, file, root) : undefined,
          );
          return units.map((unit, i): FunctionResult => {
            const measured = coverages[i]!;
            const crap = calculateCrap(unit.complexity, measured.ratio);
            return {
              ...unit,
              file: path.relative(root, file).split(path.sep).join("/"),
              coverage: measured,
              crap,
              status: crap === null ? "unknown" : crap > threshold ? "failed" : "passed",
            };
          });
        }),
      { concurrency: 8 },
    );
    const functions = results
      .flat()
      .sort(
        (a, b) =>
          (b.crap ?? -1) - (a.crap ?? -1) ||
          a.file.localeCompare(b.file) ||
          a.range.start.line - b.range.start.line ||
          a.range.start.column - b.range.start.column,
      );
    return {
      schemaVersion: 1,
      threshold,
      files: files.map((file) => path.relative(root, file).split(path.sep).join("/")),
      functions,
      summary: {
        total: functions.length,
        failed: functions.filter((fn) => fn.status === "failed").length,
        unknown: functions.filter((fn) => fn.status === "unknown").length,
      },
    };
  });
