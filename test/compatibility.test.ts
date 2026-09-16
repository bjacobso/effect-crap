import * as ChildProcess from "node:child_process";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import { expect, it } from "vitest";
import * as Analyze from "../src/analyze.js";
import * as Runtime from "./runtime.js";

it("attributes actual Vitest 3.2.7 V8 coverage without borrowing sibling hits", async () => {
  const coverage = await Fs.mkdtemp(Path.join(Os.tmpdir(), "effect-crap-v3-"));
  const root = Path.resolve("test/fixtures/vitest3");
  try {
    ChildProcess.execFileSync(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        "--coverage",
        "--coverage.reportsDirectory",
        coverage,
      ],
      { cwd: root, timeout: 60_000, stdio: "pipe" },
    );
    const report = await Runtime.runPromise(
      Analyze.analyze({ root, coverage: Path.join(coverage, "coverage-final.json") }),
    );
    const byName = (name: string) => report.functions.find((fn) => fn.name === name)!;
    expect(byName("covered").coverage.ratio).toBe(1);
    expect(byName("uncovered").coverage.ratio).toBe(0);
    expect(byName("constructed").coverage.ratio).toBe(0);
    expect(report.functions.find((fn) => fn.name.startsWith("evaluate::effect.gen"))).toMatchObject(
      { complexity: 2, coverage: { ratio: 1 } },
    );
    expect(report.functions.find((fn) => fn.name.includes("Effect.catchAll[arg1]"))).toMatchObject({
      coverage: { ratio: 1 },
    });
    expect(byName("first").coverage.ratio).toBe(1);
    expect(byName("second").coverage.ratio).toBe(0);
  } finally {
    await Fs.rm(coverage, { recursive: true, force: true });
  }
}, 90_000);
