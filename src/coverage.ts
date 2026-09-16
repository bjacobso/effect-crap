import path from "node:path";
import { Effect, Schema } from "effect";
import {
  AnalysisError,
  type CoverageCount,
  type FunctionCoverage,
  type FunctionUnit,
  type Position,
  type SourceRange,
} from "./model.js";

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
    Schema.Struct({ loc: RangeSchema, locations: Schema.Array(BranchRangeSchema) }),
  ),
  b: record(Schema.Array(Counter)),
  fnMap: record(Schema.Struct({ name: Schema.String, loc: RangeSchema })),
  f: record(Counter),
});
const ReportSchema = record(FileSchema);
export type CoverageFile = typeof FileSchema.Type;
export type CoverageReport = typeof ReportSchema.Type;

export const parseCoverage = (text: string): Effect.Effect<CoverageReport, AnalysisError> =>
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
        new AnalysisError({ message: `Invalid Istanbul coverage JSON: ${String(cause)}`, cause }),
    ),
  );

function compare(a: Position, b: Position): number {
  return a.line - b.line || a.column - b.column;
}

function contains(outer: SourceRange, inner: SourceRange): boolean {
  return compare(outer.start, inner.start) <= 0 && compare(outer.end, inner.end) >= 0;
}

type CoverageRange = typeof RangeSchema.Type;

function containsCoverage(outer: SourceRange, inner: CoverageRange): boolean {
  return (
    compare(outer.start, inner.start) <= 0 &&
    compare(inner.start, outer.end) < 0 &&
    (inner.end.column === null
      ? inner.end.line <= outer.end.line
      : compare(outer.end, { line: inner.end.line, column: inner.end.column }) >= 0)
  );
}

function count(hits: readonly number[], empty: number | null): CoverageCount {
  const covered = hits.filter((hit) => hit > 0).length;
  return { covered, total: hits.length, ratio: hits.length ? covered / hits.length : empty };
}

export function unknownCoverage(reason: string): FunctionCoverage {
  return {
    status: "unknown",
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
): CoverageFile | undefined {
  const matches = Object.entries(report).filter(
    ([key, value]) => path.resolve(root, key) === file || path.resolve(root, value.path) === file,
  );
  return matches.length === 1 ? matches[0]![1] : undefined;
}

/** Assign a counter to the innermost containing function, never both child and parent. */
export function attributeCoverage(
  units: readonly FunctionUnit[],
  file?: CoverageFile,
): FunctionCoverage[] {
  if (!file) return units.map(() => unknownCoverage("No unambiguous coverage entry for this file"));
  const statements = units.map(() => [] as number[]);
  const branches = units.map(() => [] as number[]);
  const entries = units.map(() => [] as number[]);
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
    const index = owner(branch.loc);
    if (index >= 0) branches[index]!.push(...file.b[id]!);
  }
  for (const [id, fn] of Object.entries(file.fnMap)) {
    const index = owner(fn.loc);
    // A nested or transformed fnMap range must not prove the parent ran.
    if (index >= 0) entries[index]!.push(file.f[id]!);
  }
  return units.map((unit, index) => {
    const entry = entries[index]!;
    if (entry.length > 1) return unknownCoverage("Ambiguous function coverage metadata");
    const statement = count(statements[index]!, null);
    // Empty bodies still require evidence that the function was actually invoked.
    if (!statement.total && !unit.expectsStatements && entry.length === 1) {
      statement.ratio = entry[0]! > 0 ? 1 : 0;
    }
    const branch = count(branches[index]!, unit.expectsBranches ? null : 1);
    const ratio =
      statement.ratio === null || branch.ratio === null
        ? null
        : Math.min(statement.ratio, branch.ratio);
    return {
      status: ratio === null ? "unknown" : "measured",
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
