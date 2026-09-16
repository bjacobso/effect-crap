import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  attributeCoverage,
  calculateCrap,
  findCoverage,
  parseCoverage,
  type CoverageFile,
} from "../src/coverage.js";
import { parseSource } from "../src/parser.js";

const range = (start: number, end: number) => ({
  start: { line: 1, column: start },
  end: { line: 1, column: end },
});
const emptyFile: CoverageFile = {
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
    expect(calculateCrap(4, 0)).toBe(20);
    expect(calculateCrap(4, 0.5)).toBe(6);
    expect(calculateCrap(4, 1)).toBe(4);
    expect(calculateCrap(4, null)).toBeNull();
  });
  it.each([-1, 1.1, NaN, Infinity])("rejects invalid coverage %s", (value) =>
    expect(() => calculateCrap(2, value)).toThrow("Coverage must be between 0 and 1"),
  );
});

describe("coverage attribution", () => {
  it("does not borrow nested callback statements", () => {
    const source = "const outer = () => { const inner = () => 1; return inner(); };";
    const units = Effect.runSync(parseSource("a.ts", source));
    const covered = attributeCoverage(units, {
      ...emptyFile,
      statementMap: { "0": range(21, 43), "1": units[1]!.body, "2": range(44, 59) },
      s: { "0": 1, "1": 0, "2": 1 },
    });
    expect(covered.map((item) => item.ratio)).toEqual([1, 0]);
    expect(covered.map((item) => item.statements.total)).toEqual([2, 1]);
  });

  it("requires branch counters when source has branching", () => {
    const units = Effect.runSync(parseSource("a.ts", "const f = (x: boolean) => x ? 1 : 0;"));
    const result = attributeCoverage(units, {
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
    const units = Effect.runSync(parseSource("a.ts", "function a() {} function b() {}"));
    const result = attributeCoverage(units, {
      ...emptyFile,
      fnMap: { "0": { name: "a", loc: units[0]!.body }, "1": { name: "b", loc: units[1]!.body } },
      f: { "0": 1, "1": 0 },
    });
    expect(result.map((item) => item.ratio)).toEqual([1, 0]);
    expect(attributeCoverage(units, emptyFile).every((item) => item.ratio === null)).toBe(true);
  });

  it("uses the minimum of statement and branch ratios", () => {
    const units = Effect.runSync(parseSource("a.ts", "const f = (x: boolean) => x ? 1 : 0;"));
    const body = units[0]!.body;
    const [result] = attributeCoverage(units, {
      ...emptyFile,
      statementMap: { "0": body },
      s: { "0": 1 },
      branchMap: { "0": { loc: body, locations: [body, body] } },
      b: { "0": [1, 0] },
    });
    expect(result!.ratio).toBe(0.5);
  });

  it("matches paths exactly, including report-relative paths, without guessing suffixes", () => {
    expect(findCoverage({ "a.ts": emptyFile }, "/project/a.ts", "/project")).toBe(emptyFile);
    expect(
      findCoverage(
        { "/other/a.ts": { ...emptyFile, path: "/other/a.ts" } },
        "/project/a.ts",
        "/project",
      ),
    ).toBeUndefined();
    expect(
      findCoverage({ "a.ts": emptyFile, "./a.ts": emptyFile }, "/project/a.ts", "/project"),
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
    expect(Effect.runSync(Effect.either(parseCoverage(json)))._tag).toBe("Left");
  });
});
