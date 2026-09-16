import * as Data from "effect/Data";

export class AnalysisError extends Data.TaggedError("AnalysisError")<{
  message: string;
  cause?: unknown;
}> {}

export interface Position {
  line: number;
  column: number;
}

export interface SourceRange {
  start: Position;
  end: Position;
}

export type FunctionKind = "function" | "effect.gen" | "effect.fn" | "effect.fnUntraced";

export interface FunctionUnit {
  name: string;
  kind: FunctionKind;
  range: SourceRange;
  body: SourceRange;
  complexity: number;
  expectsStatements: boolean;
  expectsBranches: boolean;
  expressionBody: boolean;
}

export interface CoverageCount {
  covered: number;
  total: number;
  /** A ratio between 0 and 1; null means the metric could not be measured. */
  ratio: number | null;
}

export interface FunctionCoverage {
  statementBasis: "statements" | "function-entry" | "v8-function-range" | null;
  status: "measured" | "unknown";
  reason: string | null;
  statements: CoverageCount;
  branches: CoverageCount;
  ratio: number | null;
}

export interface FunctionResult extends FunctionUnit {
  file: string;
  coverage: FunctionCoverage;
  crap: number | null;
  status: "passed" | "failed" | "unknown";
}

export interface AnalysisReport {
  schemaVersion: 1;
  threshold: number;
  files: string[];
  exclusions: { defaults: boolean; patterns: string[]; excludedPaths: string[] };
  functions: FunctionResult[];
  summary: { total: number; failed: number; unknown: number };
}
