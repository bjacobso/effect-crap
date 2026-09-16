#!/usr/bin/env node
import * as Effect from "effect/Effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Layer from "effect/Layer";
import * as Cli from "./cli.js";
import * as Oxc from "./oxc.js";

const runtime = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, Oxc.layer);
const result = await Effect.runPromise(
  Cli.runCli(process.argv.slice(2)).pipe(Effect.provide(runtime), Effect.either),
);
if (result._tag === "Left") {
  process.stderr.write(`effect-crap: ${result.left.message}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(result.right.stdout);
  process.exitCode = result.right.exitCode;
}
