import * as Cli from "../src/cli.js";
import * as Analyze from "../src/analyze.js";
import * as Runtime from "./runtime.js";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";

const temporary: string[] = [];
async function temp() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "effect-crap-"));
  temporary.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("real coverage providers", () => {
  it.each(["v8", "istanbul"])(
    "attributes %s counters to generators and wrappers",
    async (provider) => {
      const directory = await temp();
      execFileSync(
        process.execPath,
        [
          "node_modules/vitest/vitest.mjs",
          "run",
          "--config",
          "test/fixtures/project/vitest.config.ts",
          "--coverage",
          "--coverage.provider",
          provider,
          "--coverage.reportsDirectory",
          directory,
        ],
        { timeout: 60_000, stdio: "pipe" },
      );
      const report = await Runtime.runPromise(
        Analyze.analyze({
          paths: ["test/fixtures/project/src"],
          coverage: path.join(directory, "coverage-final.json"),
          threshold: 5,
        }),
      );
      expect(report.summary).toEqual({ total: 8, failed: 1, unknown: 0 });
      const byName = (name: string) => report.functions.find((unit) => unit.name === name)!;
      expect(byName("choose")).toMatchObject({
        kind: "effect.fn",
        complexity: 2,
        crap: 2,
        coverage: { ratio: 1 },
      });
      expect(byName("neverRun")).toMatchObject({
        kind: "effect.gen",
        complexity: 2,
        crap: 6,
        coverage: { ratio: 0 },
      });
      expect(byName("ready")).toMatchObject({
        kind: "effect.gen",
        complexity: 2,
        crap: 2.5,
        coverage: { ratio: 0.5 },
      });
      expect(byName("wrapped")).toMatchObject({
        kind: "function",
        complexity: 1,
        coverage: { ratio: 1 },
      });
      expect(report.functions.find((unit) => unit.name.startsWith("wrapped::"))).toMatchObject({
        kind: "effect.gen",
        complexity: 2,
        coverage: { ratio: 0.5 },
      });
      expect(byName("emptyCalled").coverage.ratio).toBe(1);
      expect(byName("emptyUncalled").coverage.ratio).toBe(0);

      const cli = await Runtime.runPromise(
        Cli.runCli([
          "test/fixtures/project/src",
          "--coverage",
          path.join(directory, "coverage-final.json"),
          "--threshold",
          "5",
          "--format",
          "json",
        ]),
      );
      expect(cli.exitCode).toBe(2);
      expect(JSON.parse(cli.stdout).summary.failed).toBe(1);
    },
    90_000,
  );
});

describe("CLI and source selection", () => {
  it("excludes generated sources and reports the skipped paths", async () => {
    const root = await temp();
    await mkdir(path.join(root, "src/generated"), { recursive: true });
    await writeFile(path.join(root, "src/generated/client.ts"), "broken (");
    await writeFile(path.join(root, "src/client.generated.ts"), "broken (");
    await writeFile(path.join(root, "src/app.ts"), "export const app = () => 1;");
    const report = await Runtime.runPromise(Analyze.analyze({ root }));
    expect(report.files).toEqual(["src/app.ts"]);
    expect(report.exclusions.excludedPaths).toEqual(["src/client.generated.ts", "src/generated"]);
    const optOut = await Runtime.runPromise(
      Effect.either(Analyze.analyze({ root, useDefaultExclusions: false })),
    );
    expect(optOut._tag).toBe("Left");
  });

  it("applies repeated exclusion globs to explicit files as well as directories", async () => {
    const root = await temp();
    await mkdir(path.join(root, "src"));
    for (const name of ["a.ts", "b.ts", "c.ts"])
      await writeFile(path.join(root, "src", name), "export const f = () => 1;");
    const result = await Runtime.runPromise(
      Cli.runCli([
        "--root",
        root,
        "src",
        "src/a.ts",
        "--exclude",
        "**/a.ts",
        "--exclude=**/b.ts",
        "--format=json",
      ]),
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      files: ["src/c.ts"],
      exclusions: { excludedPaths: ["src/a.ts", "src/b.ts"] },
    });
    const empty = await Runtime.runPromise(
      Effect.either(Analyze.analyze({ root, exclude: ["**/*"] })),
    );
    expect(empty._tag).toBe("Left");
  });

  it("can disable generated defaults without disabling user exclusions", async () => {
    const root = await temp();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/client.generated.ts"), "export const f = () => 1;");
    await writeFile(path.join(root, "src/skip.ts"), "broken (");
    const result = await Runtime.runPromise(
      Cli.runCli([
        "--root",
        root,
        "--no-default-exclusions",
        "--exclude=**/skip.ts",
        "--format=json",
      ]),
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      files: ["src/client.generated.ts"],
      exclusions: { defaults: false, patterns: ["**/skip.ts"] },
    });
  });

  it("skips directory cycles and broken symlinks during traversal", async () => {
    const root = await temp();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/a.ts"), "export const f = () => 1;");
    await symlink(path.join(root, "src"), path.join(root, "src/cycle"), "dir");
    await symlink(path.join(root, "missing.ts"), path.join(root, "src/broken.ts"));
    const report = await Runtime.runPromise(Analyze.analyze({ root }));
    expect(report.files).toEqual(["src/a.ts"]);
  });

  it("accepts assigned options and the positional separator", async () => {
    const root = await temp();
    await writeFile(path.join(root, "-source.ts"), "export const f = () => 1;");
    const result = await Runtime.runPromise(
      Cli.runCli([`--root=${root}`, "--format=json", "--threshold=8", "--", "-source.ts"]),
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ files: ["-source.ts"], threshold: 8 });
  });
  it("reports unknown coverage honestly and can require it", async () => {
    const root = await temp();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/a.ts"), "export const f = () => 1;");
    await writeFile(path.join(root, "src/a.test.ts"), "invalid test syntax skipped");
    await writeFile(path.join(root, "src/types.d.ts"), "invalid declaration syntax skipped");
    const output = await Runtime.runPromise(
      Cli.runCli(["--root", root, "--format", "json", "--require-coverage"]),
    );
    expect(output.exitCode).toBe(3);
    expect(JSON.parse(output.stdout)).toMatchObject({
      files: ["src/a.ts"],
      summary: { total: 1, failed: 0, unknown: 1 },
    });
    const noGate = await Runtime.runPromise(Cli.runCli(["--root", root]));
    expect(noGate.exitCode).toBe(0);
    expect(noGate.stdout).toContain("N/A");
  });

  it("deduplicates overlapping paths and skips generated build directories", async () => {
    const root = await temp();
    await mkdir(path.join(root, "src/dist"), { recursive: true });
    await writeFile(path.join(root, "src/a.ts"), "export const f = () => 1;");
    await writeFile(path.join(root, "src/dist/ignored.ts"), "broken (");
    const result = await Runtime.runPromise(Analyze.analyze({ root, paths: ["src", "src/a.ts"] }));
    expect(result.functions).toHaveLength(1);
  });

  it.each([
    ["--format", "xml"],
    ["--threshold", "NaN"],
    ["--threshold", "-1"],
    ["--threshold", ""],
    ["--unknown"],
    ["does-not-exist.ts"],
    ["src", "--coverage", "missing.json"],
  ])("fails for %j", async (...args) => {
    const result = await Runtime.runPromise(Effect.either(Cli.runCli(args)));
    expect(result._tag).toBe("Left");
  });

  it("prints help without reading a project", async () => {
    const result = await Runtime.runPromise(Cli.runCli(["--help"]));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: effect-crap");
  });
});
