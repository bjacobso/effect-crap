import * as Model from "./model.js";
import * as Analyze from "./analyze.js";
import * as Effect from "effect/Effect";

export const usage = `Usage: effect-crap [paths...] [options]

Analyze TypeScript functions, Effect.gen and Effect.fn bodies.
Paths default to src. Directory inputs are searched recursively.

  --coverage <path>    Read an existing Istanbul coverage-final.json
  --root <path>        Resolve inputs and relative coverage paths from this root
  --threshold <n>      Fail for CRAP > n (default: 6)
  --format text|json   Output format (default: text)
  --exclude <glob>     Exclude a project-relative path glob; repeatable
  --no-default-exclusions  Include generated sources normally excluded
  --require-coverage  Fail when any function's coverage is unknown
  --help, -h          Show help

Exit codes: 0 = no measured failures; 1 = usage/analysis error;
            2 = threshold exceeded; 3 = required coverage missing.
No tests are executed automatically. Without coverage, CRAP is unknown.
`;

function textReport(report: Model.AnalysisReport): string {
  const rows = report.functions.map((fn) => {
    const cov = fn.coverage.ratio === null ? "N/A" : `${(fn.coverage.ratio * 100).toFixed(1)}%`;
    return `${fn.status.padEnd(7)} CC ${String(fn.complexity).padStart(3)}  Cov ${cov.padStart(6)}  CRAP ${(fn.crap?.toFixed(2) ?? "N/A").padStart(7)}  ${fn.file}:${fn.range.start.line}:${fn.range.start.column + 1}  ${fn.name} [${fn.kind}]`;
  });
  return (
    [
      ...rows,
      "",
      `${report.summary.total} functions; ${report.summary.failed} above ${report.threshold}; ${report.summary.unknown} with unknown coverage.`,
      ...(report.exclusions.excludedPaths.length
        ? [`Excluded ${report.exclusions.excludedPaths.length} matching paths.`]
        : []),
    ].join("\n") + "\n"
  );
}

export const runCli = (
  args: string[],
): Effect.Effect<{ stdout: string; exitCode: number }, Model.AnalysisError, Analyze.Services> =>
  Effect.gen(function* () {
    const { values, positionals } = yield* Effect.try({
      try: () => parseArguments(args),
      catch: (cause) => new Model.AnalysisError({ message: String(cause), cause }),
    });
    if (values.help) return { stdout: usage, exitCode: 0 };
    if (values.format !== "text" && values.format !== "json")
      return yield* new Model.AnalysisError({ message: "Format must be text or json" });
    if (values.threshold !== undefined && !values.threshold.trim())
      return yield* new Model.AnalysisError({ message: "Threshold must be a number" });
    const report = yield* Analyze.analyze({
      paths: positionals,
      root: values.root,
      coverage: values.coverage,
      threshold: values.threshold === undefined ? undefined : Number(values.threshold),
      exclude: values.exclude,
      useDefaultExclusions: !values["no-default-exclusions"],
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

interface Arguments {
  values: {
    help?: boolean;
    coverage?: string;
    root?: string;
    threshold?: string;
    format: string;
    "require-coverage": boolean;
    exclude: string[];
    "no-default-exclusions": boolean;
  };
  positionals: string[];
}

/** Small portable argument parser; no runtime-specific CLI dependencies. */
function parseArguments(args: readonly string[]): Arguments {
  const result: Arguments = {
    values: {
      format: "text",
      "require-coverage": false,
      exclude: [],
      "no-default-exclusions": false,
    },
    positionals: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      result.positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg === "--help" || arg === "-h") {
      result.values.help = true;
      continue;
    }
    if (arg === "--require-coverage") {
      result.values["require-coverage"] = true;
      continue;
    }
    if (arg === "--no-default-exclusions") {
      result.values["no-default-exclusions"] = true;
      continue;
    }
    if (!arg.startsWith("-")) {
      result.positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const key = (equals < 0 ? arg : arg.slice(0, equals)).slice(2);
    if (
      !arg.startsWith("--") ||
      !["coverage", "root", "threshold", "format", "exclude"].includes(key)
    )
      throw new Error(`Unknown option: ${arg}`);
    const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
    if (value === undefined || (equals < 0 && value.startsWith("--")))
      throw new Error(`Missing value for --${key}`);
    if (key === "exclude") result.values.exclude.push(value);
    else result.values[key as "coverage" | "root" | "threshold" | "format"] = value;
  }
  return result;
}
