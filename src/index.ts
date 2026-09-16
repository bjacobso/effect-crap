export { analyze, type AnalyzeOptions, type Services } from "./analyze.js";
export { SourceParser } from "./sourceParser.js";
export { parseSource } from "./parser.js";
export { calculateCrap } from "./coverage.js";
export { AnalysisError } from "./model.js";
export type {
  AnalysisReport,
  FunctionResult,
  FunctionUnit,
  FunctionCoverage,
  FunctionKind,
} from "./model.js";
