import * as Model from "./model.js";
import type * as Path from "@effect/platform/Path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Counter = Schema.Number.pipe(Schema.int(), Schema.nonNegative());
const PositionSchema = Schema.Struct({
  line: Schema.Number.pipe(Schema.int(), Schema.positive()),
  column: Counter,
});
// Source-map remapping serializes end-of-line Infinity columns as JSON null.
const RangeSchema = Schema.Struct({
  start: PositionSchema,
  end: Schema.Struct({
    line: Schema.Number.pipe(Schema.int(), Schema.positive()),
    column: Schema.NullOr(Counter),
  }),
});
const BranchPositionSchema = Schema.Struct({
  line: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())),
  column: Schema.optional(Schema.NullOr(Counter)),
});
// An implicit else legitimately has { start: {}, end: {} }. Its parent loc owns it.
const BranchRangeSchema = Schema.Struct({ start: BranchPositionSchema, end: BranchPositionSchema });
const record = <A, I>(value: Schema.Schema<A, I>) => Schema.Record({ key: Schema.String, value });
const FileSchema = Schema.Struct({
  path: Schema.String,
  statementMap: record(RangeSchema),
  s: record(Counter),
  branchMap: record(
    Schema.Struct({
      type: Schema.optional(Schema.String),
      loc: RangeSchema,
      locations: Schema.Array(BranchRangeSchema),
    }),
  ),
  b: record(Schema.Array(Counter)),
  fnMap: record(Schema.Struct({ name: Schema.String, loc: RangeSchema })),
  f: record(Counter),
});
const ReportSchema = record(FileSchema);
export type CoverageFile = typeof FileSchema.Type;
export type CoverageReport = typeof ReportSchema.Type;

export const parseCoverage = (text: string): Effect.Effect<CoverageReport, Model.AnalysisError> =>
  Schema.decodeUnknown(Schema.parseJson(ReportSchema))(text).pipe(
    Effect.flatMap((report) =>
      Effect.try({
        try: () => {
          for (const file of Object.values(report)) {
            for (const [map, counts] of [
              [file.statementMap, file.s],
              [file.branchMap, file.b],
              [file.fnMap, file.f],
            ] as const) {
              const keys = Object.keys(map);
              if (
                keys.length !== Object.keys(counts).length ||
                keys.some((key) => !(key in counts))
              )
                throw new Error(`Mismatched coverage counters in ${file.path}`);
            }
            for (const [id, branch] of Object.entries(file.branchMap)) {
              if (branch.locations.length !== file.b[id]!.length || branch.locations.length === 0)
                throw new Error(`Mismatched branch locations in ${file.path}`);
            }
            const ranges = [
              ...Object.values(file.statementMap),
              ...Object.values(file.fnMap).map((fn) => fn.loc),
              ...Object.values(file.branchMap).map((branch) => branch.loc),
            ];
            if (
              ranges.some(
                (range) =>
                  range.start.line > range.end.line ||
                  (range.start.line === range.end.line &&
                    range.end.column !== null &&
                    range.start.column > range.end.column),
              )
            )
              throw new Error(`Reversed coverage range in ${file.path}`);
          }
          return report;
        },
        catch: (cause) => cause,
      }),
    ),
    Effect.mapError(
      (cause) =>
        new Model.AnalysisError({
          message: `Invalid Istanbul coverage JSON: ${String(cause)}`,
          cause,
        }),
    ),
  );

function compare(a: Model.Position, b: Model.Position): number {
  return a.line - b.line || a.column - b.column;
}

function contains(outer: Model.SourceRange, inner: Model.SourceRange): boolean {
  return compare(outer.start, inner.start) <= 0 && compare(outer.end, inner.end) >= 0;
}

type CoverageRange = typeof RangeSchema.Type;

function containsCoverage(outer: Model.SourceRange, inner: CoverageRange): boolean {
  return (
    compare(outer.start, inner.start) <= 0 &&
    compare(inner.start, outer.end) < 0 &&
    (inner.end.column === null
      ? inner.end.line <= outer.end.line
      : compare(outer.end, { line: inner.end.line, column: inner.end.column }) >= 0)
  );
}

function count(hits: readonly number[], empty: number | null): Model.CoverageCount {
  const covered = hits.filter((hit) => hit > 0).length;
  return { covered, total: hits.length, ratio: hits.length ? covered / hits.length : empty };
}

export function unknownCoverage(reason: string): Model.FunctionCoverage {
  return {
    status: "unknown",
    statementBasis: null,
    reason,
    statements: count([], null),
    branches: count([], null),
    ratio: null,
  };
}

export function findCoverage(
  report: CoverageReport,
  file: string,
  root: string,
  path: Path.Path,
): CoverageFile | undefined {
  const matches = Object.entries(report).filter(
    ([key, value]) => path.resolve(root, key) === file || path.resolve(root, value.path) === file,
  );
  return matches.length === 1 ? matches[0]![1] : undefined;
}

/** Assign a counter to the innermost containing function, never both child and parent. */
export function attributeCoverage(
  units: readonly Model.FunctionUnit[],
  file?: CoverageFile,
  source?: string,
): Model.FunctionCoverage[] {
  if (!file) return units.map(() => unknownCoverage("No unambiguous coverage entry for this file"));
  const statements = units.map(() => [] as number[]);
  const branches = units.map(() => [] as number[]);
  const entries = units.map(() => [] as number[]);
  const executionRanges = units.map(() => [] as number[]);
  const lines = source?.split(/\r\n|[\n\r\u2028\u2029]/);
  const samePosition = (a: Model.Position, b: Model.Position) => compare(a, b) === 0;
  // v8-to-istanbul may extend a function through its declaration's comma/semicolon.
  // Require an exact start and verify every extra source character, never a line-only match.
  const matchesFunction = (range: CoverageRange, unit: Model.FunctionUnit): boolean => {
    if (!samePosition(range.start, unit.range.start) && !samePosition(range.start, unit.body.start))
      return false;
    if (range.end.line !== unit.range.end.line) return false;
    if (range.end.column === null) return false;
    if (range.end.column === unit.range.end.column) return true;
    const line = lines?.[range.end.line - 1];
    return (
      line !== undefined &&
      range.end.column <= line.length &&
      range.end.column > unit.range.end.column &&
      /^[\s,;)]+$/.test(line.slice(unit.range.end.column, range.end.column))
    );
  };
  const exactOwner = (range: CoverageRange): number => {
    const matches = units.flatMap((unit, index) => (matchesFunction(range, unit) ? [index] : []));
    return matches.length === 1 ? matches[0]! : -1;
  };
  const trimBranchEnd = (range: CoverageRange): CoverageRange => {
    let result = range;
    for (const unit of units) {
      const end = result.end.column;
      const line = lines?.[result.end.line - 1];
      if (
        end === null ||
        line === undefined ||
        end > line.length ||
        result.end.line !== unit.range.end.line
      )
        continue;
      if (
        compare(result.start, unit.range.start) < 0 ||
        compare(result.start, unit.range.end) >= 0 ||
        end <= unit.range.end.column
      )
        continue;
      if (/^[\s,;)]+$/.test(line.slice(unit.range.end.column, end)))
        result = { start: result.start, end: unit.range.end };
    }
    return result;
  };
  const owner = (range: CoverageRange): number => {
    let found = -1;
    for (let i = 0; i < units.length; i++) {
      if (
        containsCoverage(units[i]!.range, range) &&
        (found < 0 || contains(units[found]!.range, units[i]!.range))
      )
        found = i;
    }
    return found;
  };
  for (const [id, range] of Object.entries(file.statementMap)) {
    const index = owner(range);
    if (index >= 0) statements[index]!.push(file.s[id]!);
  }
  for (const [id, branch] of Object.entries(file.branchMap)) {
    const execution =
      branch.type === "branch" && file.b[id]!.length === 1 ? exactOwner(branch.loc) : -1;
    if (execution >= 0) executionRanges[execution]!.push(file.b[id]![0]!);
    const index = owner(trimBranchEnd(branch.loc));
    if (index >= 0) branches[index]!.push(...file.b[id]!);
  }
  for (const [id, fn] of Object.entries(file.fnMap)) {
    let index = exactOwner(fn.loc);
    // Modern Istanbul sometimes ends a body at an unknown end-of-line column.
    if (index < 0 && fn.loc.end.column === null) {
      const candidates = units.flatMap((unit, i) =>
        fn.loc.end.line === unit.range.end.line &&
        (samePosition(fn.loc.start, unit.body.start) ||
          samePosition(fn.loc.start, unit.range.start))
          ? [i]
          : [],
      );
      if (candidates.length === 1) index = candidates[0]!;
    }
    if (index >= 0) entries[index]!.push(file.f[id]!);
  }
  return units.map((unit, index) => {
    const entry = entries[index]!;
    if (entry.length > 1) return unknownCoverage("Ambiguous function coverage metadata");
    const statement = count(statements[index]!, null);
    let statementBasis: Model.FunctionCoverage["statementBasis"] = statement.total
      ? "statements"
      : null;
    const execution = entry.length === 1 ? entry : executionRanges[index]!;
    if (entry.length === 1 && executionRanges[index]!.some((hit) => hit > 0 !== entry[0]! > 0))
      return unknownCoverage("Conflicting function execution counters");
    // An exact execution hit proves a single branch-free expression was evaluated.
    // Whole-line counters can instead reflect closure creation or a sibling callback.
    if (unit.expressionBody && !unit.expectsBranches && execution.length === 1) {
      statement.covered = execution[0]! > 0 ? 1 : 0;
      statement.total = 1;
      statement.ratio = statement.covered;
      statementBasis = entry.length === 1 ? "function-entry" : "v8-function-range";
    }
    // Empty bodies still require evidence that the function was actually invoked.
    if (!statement.total && !unit.expectsStatements && execution.length === 1) {
      statement.ratio = execution[0]! > 0 ? 1 : 0;
      statementBasis = entry.length === 1 ? "function-entry" : "v8-function-range";
    }
    const branch = count(branches[index]!, unit.expectsBranches ? null : 1);
    const ratio =
      statement.ratio === null || branch.ratio === null
        ? null
        : Math.min(statement.ratio, branch.ratio);
    return {
      status: ratio === null ? "unknown" : "measured",
      statementBasis,
      reason: ratio === null ? "Missing attributable statement or branch counters" : null,
      statements: statement,
      branches: branch,
      ratio,
    };
  });
}

export function calculateCrap(complexity: number, coverage: number | null): number | null {
  if (!Number.isInteger(complexity) || complexity < 1)
    throw new RangeError("Complexity must be a positive integer");
  if (coverage === null) return null;
  if (!Number.isFinite(coverage) || coverage < 0 || coverage > 1)
    throw new RangeError("Coverage must be between 0 and 1");
  return complexity ** 2 * (1 - coverage) ** 3 + complexity;
}
