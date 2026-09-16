#!/usr/bin/env node
import { Effect } from "effect";
import { runCli } from "./cli.js";

const result = await Effect.runPromise(Effect.either(runCli(process.argv.slice(2))));
if (result._tag === "Left") {
  process.stderr.write(`effect-crap: ${result.left.message}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(result.right.stdout);
  process.exitCode = result.right.exitCode;
}
