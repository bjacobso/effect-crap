import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Coverage from "./coverage.js";
import * as Model from "./model.js";
import * as Parser from "./parser.js";
import * as Exclusions from "./exclusions.js";
import type * as SourceParser from "./sourceParser.js";

export interface AnalyzeOptions {
  paths?: readonly string[];
  /** Defaults to '.', interpreted by the supplied FileSystem and Path services. */
  root?: string;
  coverage?: string;
  threshold?: number;
  exclude?: readonly string[];
  useDefaultExclusions?: boolean;
}

export type Services = FileSystem.FileSystem | Path.Path | SourceParser.SourceParser;

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
const io = <A, E, R>(message: string, operation: Effect.Effect<A, E, R>) =>
  operation.pipe(
    Effect.mapError(
      (cause) => new Model.AnalysisError({ message: `${message}: ${String(cause)}`, cause }),
    ),
  );

function selectFiles(
  inputs: readonly string[],
  root: string,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  exclude: (path: string) => boolean,
) {
  return Effect.gen(function* () {
    const files = new Set<string>();
    const visited = new Set<string>();
    const excludedPaths = new Set<string>();
    const visit = (input: string, explicit: boolean): Effect.Effect<void, Model.AnalysisError> =>
      Effect.gen(function* () {
        const relative = path.relative(root, input).split(path.sep).join("/");
        if (exclude(relative)) {
          excludedPaths.add(relative);
          return;
        }
        // FileSystem.stat follows links on Node. Probe readLink first, including dangling
        // links; ordinary files fail this probe and are validated by realPath/stat below.
        if (!explicit && Option.isSome(yield* fs.readLink(input).pipe(Effect.option))) return;
        const file = yield* io(`Unable to resolve ${input}`, fs.realPath(input));
        if (visited.has(file)) return;
        visited.add(file);
        const info = yield* io(`Unable to stat ${file}`, fs.stat(file));
        if (info.type === "Directory") {
          const entries = yield* io(`Unable to list ${file}`, fs.readDirectory(file));
          for (const entry of entries) {
            if (ignored.has(entry) || entry.startsWith(".")) continue;
            yield* visit(path.join(file, entry), false);
          }
        } else if (info.type === "File" && sourceFile(file)) files.add(file);
        else if (explicit)
          return yield* new Model.AnalysisError({
            message: `Not an analyzable TypeScript file: ${input}`,
          });
      });
    for (const input of inputs) yield* visit(path.resolve(root, input), true);
    return { files: [...files].sort(), excludedPaths: [...excludedPaths].sort() };
  });
}

export const analyze = (
  options: AnalyzeOptions = {},
): Effect.Effect<Model.AnalysisReport, Model.AnalysisError, Services> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* io("Unable to resolve project root", fs.realPath(options.root ?? "."));
    const threshold = options.threshold ?? 6;
    if (!Number.isFinite(threshold) || threshold < 0)
      return yield* new Model.AnalysisError({
        message: "Threshold must be a finite non-negative number",
      });
    const defaults = options.useDefaultExclusions ?? true;
    const patterns = [...(defaults ? Exclusions.defaults : []), ...(options.exclude ?? [])];
    const exclude = yield* Effect.try({
      try: () => Exclusions.matcher(patterns),
      catch: (cause) =>
        new Model.AnalysisError({ message: `Invalid exclusions: ${String(cause)}`, cause }),
    });
    const { files, excludedPaths } = yield* selectFiles(
      options.paths?.length ? options.paths : ["src"],
      root,
      fs,
      path,
      exclude,
    );
    if (files.length === 0)
      return yield* new Model.AnalysisError({ message: "No analyzable TypeScript files selected" });
    const coverage = options.coverage
      ? yield* io(
          `Unable to read coverage: ${options.coverage}`,
          fs.readFileString(path.resolve(root, options.coverage)),
        ).pipe(Effect.flatMap(Coverage.parseCoverage))
      : undefined;
    const results = yield* Effect.forEach(
      files,
      (file) =>
        Effect.gen(function* () {
          const source = yield* io(`Unable to read ${file}`, fs.readFileString(file));
          const units = yield* Parser.parseSource(file, source);
          const coverages = Coverage.attributeCoverage(
            units,
            coverage ? Coverage.findCoverage(coverage, file, root, path) : undefined,
            source,
          );
          return units.map((unit, i): Model.FunctionResult => {
            const measured = coverages[i]!;
            const crap = Coverage.calculateCrap(unit.complexity, measured.ratio);
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
      exclusions: { defaults, patterns, excludedPaths },
      functions,
      summary: {
        total: functions.length,
        failed: functions.filter((fn) => fn.status === "failed").length,
        unknown: functions.filter((fn) => fn.status === "unknown").length,
      },
    };
  });
