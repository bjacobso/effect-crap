import * as Path from "@effect/platform/Path";
import * as Coverage from "../src/coverage.js";
import * as Parser from "../src/parser.js";
import * as Runtime from "./runtime.js";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

const path = Runtime.runSync(Path.Path.pipe(Effect.provide(Path.layer)));

const range = (start: number, end: number) => ({
  start: { line: 1, column: start },
  end: { line: 1, column: end },
});
const emptyFile: Coverage.CoverageFile = {
  path: "/project/a.ts",
  statementMap: {},
  s: {},
  branchMap: {},
  b: {},
  fnMap: {},
  f: {},
};

describe("CRAP", () => {
  it("uses the canonical formula and preserves unknown coverage", () => {
    expect(Coverage.calculateCrap(4, 0)).toBe(20);
    expect(Coverage.calculateCrap(4, 0.5)).toBe(6);
    expect(Coverage.calculateCrap(4, 1)).toBe(4);
    expect(Coverage.calculateCrap(4, null)).toBeNull();
  });
  it.each([-1, 1.1, NaN, Infinity])("rejects invalid coverage %s", (value) =>
    expect(() => Coverage.calculateCrap(2, value)).toThrow("Coverage must be between 0 and 1"),
  );
});

describe("coverage attribution", () => {
  it("uses exact V8 execution ranges, not shared whole-line hits", () => {
    const source = "const pair = () => [() => 1, () => 2];";
    const units = Runtime.runSync(Parser.parseSource("a.ts", source));
    const file: Coverage.CoverageFile = {
      ...emptyFile,
      statementMap: { "0": range(0, source.length) },
      s: { "0": 10 },
      branchMap: {
        "0": { type: "branch", loc: units[1]!.range, locations: [units[1]!.range] },
        "1": { type: "branch", loc: units[2]!.range, locations: [units[2]!.range] },
      },
      b: { "0": [2], "1": [0] },
    };
    const result = Coverage.attributeCoverage(units, file, source);
    expect(result[1]).toMatchObject({ ratio: 1, statementBasis: "v8-function-range" });
    expect(result[2]).toMatchObject({ ratio: 0, statementBasis: "v8-function-range" });
    expect(result[0]!.ratio).toBeNull();
  });

  it("does not infer expression branch coverage from a function execution hit", () => {
    const source = "const choose = (x: boolean) => x ? 1 : 0;";
    const units = Runtime.runSync(Parser.parseSource("a.ts", source));
    const result = Coverage.attributeCoverage(
      units,
      { ...emptyFile, fnMap: { "0": { name: "choose", loc: units[0]!.range } }, f: { "0": 1 } },
      source,
    );
    expect(result[0]!.ratio).toBeNull();
  });

  it("matches trailing punctuation without assigning the child entry to its parent", () => {
    const source = "function outer() { const inner = () => 1; return inner; }";
    const units = Runtime.runSync(Parser.parseSource("a.ts", source));
    const child = units[1]!;
    const expanded = {
      start: child.range.start,
      end: { ...child.range.end, column: child.range.end.column + 1 },
    };
    const file: Coverage.CoverageFile = {
      ...emptyFile,
      fnMap: { "0": { name: "inner", loc: expanded } },
      f: { "0": 0 },
    };
    const result = Coverage.attributeCoverage(units, file, source);
    expect(result[1]).toMatchObject({ ratio: 0, statementBasis: "function-entry" });
    expect(result[0]!.ratio).toBeNull();
    expect(Coverage.attributeCoverage(units, file)[1]!.ratio).toBeNull();
  });

  it("rejects function ranges that extend into executable code", () => {
    const source = "const f = () => 1; console.log(2);";
    const units = Runtime.runSync(Parser.parseSource("a.ts", source));
    const expanded = { start: units[0]!.range.start, end: { line: 1, column: source.length } };
    const result = Coverage.attributeCoverage(
      units,
      { ...emptyFile, fnMap: { "0": { name: "f", loc: expanded } }, f: { "0": 1 } },
      source,
    );
    expect(result[0]!.ratio).toBeNull();
  });

  it("preserves unknown when execution metadata conflicts", () => {
    const units = Runtime.runSync(Parser.parseSource("a.ts", "const f = () => 1;"));
    const location = units[0]!.range;
    const result = Coverage.attributeCoverage(units, {
      ...emptyFile,
      fnMap: { "0": { name: "f", loc: location } },
      f: { "0": 1 },
      branchMap: { "0": { type: "branch", loc: location, locations: [location] } },
      b: { "0": [0] },
    });
    expect(result[0]).toMatchObject({
      ratio: null,
      reason: "Conflicting function execution counters",
    });
  });

  it("does not borrow nested callback statements", () => {
    const source = "const outer = () => { const inner = () => 1; return inner(); };";
    const units = Runtime.runSync(Parser.parseSource("a.ts", source));
    const covered = Coverage.attributeCoverage(units, {
      ...emptyFile,
      statementMap: { "0": range(21, 43), "1": units[1]!.body, "2": range(44, 59) },
      s: { "0": 1, "1": 0, "2": 1 },
    });
    expect(covered.map((item) => item.ratio)).toEqual([1, 0]);
    expect(covered.map((item) => item.statements.total)).toEqual([2, 1]);
  });

  it("requires branch counters when source has branching", () => {
    const units = Runtime.runSync(
      Parser.parseSource("a.ts", "const f = (x: boolean) => x ? 1 : 0;"),
    );
    const result = Coverage.attributeCoverage(units, {
      ...emptyFile,
      statementMap: { "0": units[0]!.body },
      s: { "0": 1 },
    });
    expect(result[0]).toMatchObject({
      status: "unknown",
      ratio: null,
      statements: { ratio: 1 },
      branches: { ratio: null },
    });
  });

  it("uses function hits for empty bodies and does not assume empty means covered", () => {
    const units = Runtime.runSync(Parser.parseSource("a.ts", "function a() {} function b() {}"));
    const result = Coverage.attributeCoverage(units, {
      ...emptyFile,
      fnMap: { "0": { name: "a", loc: units[0]!.body }, "1": { name: "b", loc: units[1]!.body } },
      f: { "0": 1, "1": 0 },
    });
    expect(result.map((item) => item.ratio)).toEqual([1, 0]);
    expect(Coverage.attributeCoverage(units, emptyFile).every((item) => item.ratio === null)).toBe(
      true,
    );
  });

  it("uses the minimum of statement and branch ratios", () => {
    const units = Runtime.runSync(
      Parser.parseSource("a.ts", "const f = (x: boolean) => x ? 1 : 0;"),
    );
    const body = units[0]!.body;
    const [result] = Coverage.attributeCoverage(units, {
      ...emptyFile,
      statementMap: { "0": body },
      s: { "0": 1 },
      branchMap: { "0": { loc: body, locations: [body, body] } },
      b: { "0": [1, 0] },
    });
    expect(result!.ratio).toBe(0.5);
  });

  it("matches paths exactly, including report-relative paths, without guessing suffixes", () => {
    expect(Coverage.findCoverage({ "a.ts": emptyFile }, "/project/a.ts", "/project", path)).toBe(
      emptyFile,
    );
    expect(
      Coverage.findCoverage(
        { "/other/a.ts": { ...emptyFile, path: "/other/a.ts" } },
        "/project/a.ts",
        "/project",
        path,
      ),
    ).toBeUndefined();
    expect(
      Coverage.findCoverage(
        { "a.ts": emptyFile, "./a.ts": emptyFile },
        "/project/a.ts",
        "/project",
        path,
      ),
    ).toBeUndefined();
  });

  it.each([
    "not json",
    JSON.stringify({ x: {} }),
    JSON.stringify({ x: { ...emptyFile, s: { "0": 1 } } }),
    JSON.stringify({ x: { ...emptyFile, statementMap: { "0": range(0, 1) }, s: { "0": -1 } } }),
    JSON.stringify({
      x: {
        ...emptyFile,
        branchMap: { "0": { loc: range(0, 1), locations: [range(0, 1)] } },
        b: { "0": [1, 0] },
      },
    }),
  ])("rejects corrupt coverage: %s", (json) => {
    expect(Runtime.runSync(Effect.either(Coverage.parseCoverage(json)))._tag).toBe("Left");
  });
});
