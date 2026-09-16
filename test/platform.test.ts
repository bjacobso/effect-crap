import * as PlatformError from "@effect/platform/Error";
import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Esbuild from "esbuild";
import type * as Oxc from "oxc-parser";
import { expect, it } from "vitest";
import * as Analyze from "../src/analyze.js";
import * as SourceParser from "../src/sourceParser.js";

const source = "function answer() { return 42; }";
const program: Oxc.Program = {
  type: "Program",
  start: 0,
  end: source.length,
  sourceType: "module",
  hashbang: null,
  body: [
    {
      type: "FunctionDeclaration",
      start: 0,
      end: source.length,
      id: { type: "Identifier", name: "answer", start: 9, end: 15 },
      params: [],
      generator: false,
      async: false,
      expression: false,
      body: {
        type: "BlockStatement",
        start: 18,
        end: source.length,
        body: [
          {
            type: "ReturnStatement",
            start: 20,
            end: 30,
            argument: { type: "Literal", value: 42, raw: "42", start: 27, end: 29 },
          },
        ],
      },
    },
  ],
};

const info = (type: FileSystem.File.Type): FileSystem.File.Info => ({
  type,
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 0,
  ino: Option.none(),
  mode: 0,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(0),
  blksize: Option.none(),
  blocks: Option.none(),
});

const coverage = JSON.stringify({
  "src/answer.ts": {
    path: "src/answer.ts",
    statementMap: { "0": { start: { line: 1, column: 20 }, end: { line: 1, column: 30 } } },
    s: { "0": 1 },
    branchMap: {},
    b: {},
    fnMap: {},
    f: {},
  },
});

function memoryRuntime(denyRead = false) {
  const paths = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));
  const files = new Map([
    ["/project/src/answer.ts", source],
    ["/project/coverage.json", coverage],
  ]);
  const fs = FileSystem.layerNoop({
    realPath: (file) => Effect.succeed(paths.resolve("/project", file)),
    stat: (file) => Effect.succeed(info(files.has(file) ? "File" : "Directory")),
    readDirectory: () => Effect.succeed(["answer.ts", "dist", ".cache"]),
    readFileString: (file) =>
      denyRead
        ? Effect.fail(
            new PlatformError.SystemError({
              reason: "PermissionDenied",
              module: "FileSystem",
              method: "readFileString",
              pathOrDescriptor: file,
            }),
          )
        : Effect.succeed(files.get(file)!),
  });
  const parser = Layer.succeed(SourceParser.SourceParser, {
    parse: (file, contents) => {
      expect(file).toBe("/project/src/answer.ts");
      expect(contents).toBe(source);
      return Effect.succeed(program);
    },
  });
  return Layer.mergeAll(fs, Path.layer, parser);
}

it("analyzes an in-memory project with injected filesystem, paths and parser", async () => {
  const report = await Effect.runPromise(
    Analyze.analyze({ coverage: "coverage.json", paths: ["src", "src/answer.ts"] }).pipe(
      Effect.provide(memoryRuntime()),
    ),
  );
  expect(report.files).toEqual(["src/answer.ts"]);
  expect(report.summary).toEqual({ total: 1, failed: 0, unknown: 0 });
  expect(report.functions[0]).toMatchObject({
    name: "answer",
    complexity: 1,
    crap: 1,
    coverage: { ratio: 1 },
  });
});

it("preserves platform failures as typed analysis errors", async () => {
  const result = await Effect.runPromise(
    Analyze.analyze().pipe(Effect.provide(memoryRuntime(true)), Effect.either),
  );
  expect(result).toMatchObject({
    _tag: "Left",
    left: {
      _tag: "AnalysisError",
      message: expect.stringContaining("Unable to read /project/src/answer.ts"),
      cause: { reason: "PermissionDenied" },
    },
  });
});

it("bundles the library and CLI logic for browsers without Node or native parser modules", async () => {
  const bundle = await Esbuild.build({
    entryPoints: ["src/index.ts", "src/cli.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    outdir: "unused",
    metafile: true,
  });
  expect(bundle.outputFiles).toHaveLength(2);
  expect(
    Object.keys(bundle.metafile!.inputs).some(
      (file) => file.includes("oxc-parser") || file.includes("platform-node"),
    ),
  ).toBe(false);
});
