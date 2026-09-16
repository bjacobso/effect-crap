import * as Parser from "../src/parser.js";
import * as Runtime from "./runtime.js";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

const parse = (source: string, file = "sample.ts") =>
  Runtime.runSync(Parser.parseSource(file, source));

describe("Effect function discovery", () => {
  it("finds a named generator and counts its branches, not its yields", () => {
    const [unit] = parse(`import * as Effect from "effect/Effect";
      const checkout = Effect.gen(function* () {
        const x = yield* Effect.succeed(1);
        if (x) return yield* Effect.succeed(2);
        return 0;
      });`);
    expect(unit).toMatchObject({ name: "checkout", kind: "effect.gen", complexity: 2 });
  });

  it.each([
    ['import { Effect as E } from "effect"', "E.gen", "effect.gen"],
    ['import * as E from "effect/Effect"', "E.gen", "effect.gen"],
    ['import * as lib from "effect"', "lib.Effect.gen", "effect.gen"],
    ['import { gen as g } from "effect/Effect"', "g", "effect.gen"],
    ['import { Effect } from "effect"', "Effect.fn", "effect.fn"],
    ['import { Effect } from "effect"', 'Effect.fn("trace")', "effect.fn"],
    ['import { Effect } from "effect"', "Effect.fnUntraced", "effect.fnUntraced"],
    ['import { fn as f } from "effect/Effect"', 'f("trace")', "effect.fn"],
  ])("recognizes %s / %s", (imports, call, kind) => {
    expect(parse(`${imports}; const task = ${call}(function* () { return 1; });`)).toMatchObject([
      { name: "task", kind, complexity: 1 },
    ]);
  });

  it("supports gen with context, fn with ordinary callbacks and pipe wrappers", () => {
    const units = parse(`import * as Effect from "effect/Effect";
      const a = Effect.gen(this, function* () { return 1; }).pipe(Effect.asVoid);
      const b = Effect.fn((x: boolean) => x ? Effect.void : Effect.void);
      const c = Effect.fn("c")(function* () { return 1 }, (effect) => effect);`);
    expect(units.map(({ name, kind, complexity }) => ({ name, kind, complexity }))).toMatchObject([
      { name: "a", kind: "effect.gen", complexity: 1 },
      { name: "b", kind: "effect.fn", complexity: 2 },
      { name: "c", kind: "effect.fn", complexity: 1 },
      { kind: "function", complexity: 1 },
    ]);
  });

  it("scores wrapper, generator, and nested helper independently", () => {
    const units = parse(`import * as Effect from "effect/Effect";
      const task = () => Effect.gen(function* () {
        const helper = (x: boolean) => x ? 1 : 0;
        if (helper(true)) return 1;
        return 0;
      });`);
    expect(units.map((unit) => [unit.kind, unit.complexity])).toEqual([
      ["function", 1],
      ["effect.gen", 2],
      ["function", 2],
    ]);
    expect(units[1]!.name).toContain("task::effect.gen@");
  });

  it.each([
    "function outer(Effect: any) { return Effect.gen(function* () { return 1; }); }",
    "function outer({ Effect }: any) { return Effect.gen(function* () { return 1; }); }",
    "function outer() { return Effect.gen(function* () { return 1; }); var Effect; }",
    "{ const Effect = other; Effect.gen(function* () { return 1; }); }",
    "try {} catch (Effect) { Effect.gen(function* () { return 1; }); }",
    "for (const Effect of things) { Effect.gen(function* () { return 1; }); }",
    "const outer = function Effect() { return Effect.gen(function* () { return 1; }); };",
  ])("respects shadowing: %s", (source) => {
    expect(
      parse(`import * as Effect from "effect/Effect"; ${source}`).every(
        (unit) => unit.kind === "function",
      ),
    ).toBe(true);
  });

  it("keeps outer imports visible outside a shadowing block", () => {
    const units = parse(`import * as Effect from "effect/Effect";
      { const Effect = other; Effect.gen(function* () { return 0; }); }
      const real = Effect.gen(function* () { return 1; });`);
    expect(units.map((unit) => unit.kind)).toEqual(["function", "effect.gen"]);
  });

  it.each([
    'import { Effect } from "other";',
    'import type { Effect } from "effect";',
    'import { type Effect } from "effect";',
    "const Effect = other;",
    "",
  ])("does not recognize unrelated or type-only Effect: %s", (prefix) => {
    expect(parse(`${prefix} const x = Effect.gen(function* () { return 1; });`)[0]!.kind).toBe(
      "function",
    );
  });
});

describe("ordinary TypeScript", () => {
  it("counts classic decisions and excludes nested functions", () => {
    const [unit, inner] = parse(`function f(x = 0, o?: { x: number }) {
      if (x && o) x++;
      for (; x < 3; x++) {}
      while (x) break;
      do { x++ } while (false);
      for (const y of []) {}
      for (const z in {}) {}
      try {} catch {}
      switch (x) { case 1: break; case 2: break; default: break; }
      x ||= 1;
      const value = o?.x ?? 0;
      const child = () => x ? 1 : 0;
      return x ? value : 0;
    }`);
    expect(unit!.complexity).toBe(16);
    expect(inner!.complexity).toBe(2);
  });

  it("names class methods, object methods and default exports", () => {
    const units =
      parse(`class Service { constructor() {} get value() { return 1; } run = () => 1; method() { return 1; } }
      const obj = { f() { return 1; }, g: () => 1 };
      export default function () { return 1; }`);
    expect(units.map((unit) => unit.name)).toEqual([
      "Service.constructor",
      "Service.get value",
      "Service.run",
      "Service.method",
      "obj.f",
      "obj.g",
      "default",
    ]);
  });

  it("handles TSX, unicode UTF-16 positions and CRLF", () => {
    const units = parse(
      '// 🌟\r\nconst label = "🌟"; const View = () => <p>{true ? "a" : "b"}</p>;',
      "view.tsx",
    );
    expect(units[0]).toMatchObject({
      name: "View",
      complexity: 2,
      range: { start: { line: 2, column: 33 } },
    });
  });

  it("ignores overload declarations and types in complexity", () => {
    expect(
      parse(`function f(x: string): string;
      function f(x: unknown) { type X<T> = T extends string ? 1 : 0; return x as string; }`),
    ).toMatchObject([{ name: "f", complexity: 1 }]);
  });

  it("fails on malformed input instead of reporting partial results", () => {
    const result = Runtime.runSync(Effect.either(Parser.parseSource("broken.ts", "const x = (")));
    expect(result._tag).toBe("Left");
    expect(result).toMatchObject({
      _tag: "Left",
      left: { message: expect.stringContaining("broken.ts") },
    });
  });
});
