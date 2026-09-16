import { parseArgs } from "node:util";
import { Effect } from "effect";
import { analyze } from "./analyze.js";
import { AnalysisError, type AnalysisReport } from "./model.js";

export const usage = `Usage: effect-crap [paths...] [options]

Analyze TypeScript functions, Effect.gen and Effect.fn bodies.
Paths default to src. Directory inputs are searched recursively.

  --coverage <path>    Read an existing Istanbul coverage-final.json
  --root <path>        Resolve inputs and relative coverage paths from this root
  --threshold <n>      Fail for CRAP > n (default: 6)
  --format text|json   Output format (default: text)
  --require-coverage  Fail when any function's coverage is unknown
  --help, -h          Show help

Exit codes: 0 = no measured failures; 1 = usage/analysis error;
            2 = threshold exceeded; 3 = required coverage missing.
No tests are executed automatically. Without coverage, CRAP is unknown.
`;

function textReport(report: AnalysisReport): string {
  const rows = report.functions.map((fn) => {
    const cov = fn.coverage.ratio === null ? "N/A" : `${(fn.coverage.ratio * 100).toFixed(1)}%`;
    return `${fn.status.padEnd(7)} CC ${String(fn.complexity).padStart(3)}  Cov ${cov.padStart(6)}  CRAP ${(fn.crap?.toFixed(2) ?? "N/A").padStart(7)}  ${fn.file}:${fn.range.start.line}:${fn.range.start.column + 1}  ${fn.name} [${fn.kind}]`;
  });
  return (
    [
      ...rows,
      "",
      `${report.summary.total} functions; ${report.summary.failed} above ${report.threshold}; ${report.summary.unknown} with unknown coverage.`,
    ].join("\n") + "\n"
  );
}

export const runCli = (
  args: string[],
): Effect.Effect<{ stdout: string; exitCode: number }, AnalysisError> =>
  Effect.gen(function* () {
    const { values, positionals } = yield* Effect.try({
      try: () =>
        parseArgs({
          args,
          allowPositionals: true,
          options: {
            help: { type: "boolean", short: "h" },
            coverage: { type: "string" },
            root: { type: "string" },
            threshold: { type: "string" },
            format: { type: "string", default: "text" },
            "require-coverage": { type: "boolean", default: false },
          },
        }),
      catch: (cause) => new AnalysisError({ message: String(cause), cause }),
    });
    if (values.help) return { stdout: usage, exitCode: 0 };
    if (values.format !== "text" && values.format !== "json")
      return yield* new AnalysisError({ message: "Format must be text or json" });
    if (values.threshold !== undefined && !values.threshold.trim())
      return yield* new AnalysisError({ message: "Threshold must be a number" });
    const report = yield* analyze({
      paths: positionals,
      root: values.root,
      coverage: values.coverage,
      threshold: values.threshold === undefined ? undefined : Number(values.threshold),
    });
    return {
      stdout:
        values.format === "json" ? JSON.stringify(report, null, 2) + "\n" : textReport(report),
      exitCode:
        report.summary.failed > 0
          ? 2
          : values["require-coverage"] && report.summary.unknown > 0
            ? 3
            : 0,
    };
  });
