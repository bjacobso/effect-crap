import { Effect } from "effect";
import { expect, it } from "vitest";
import { choose, emptyCalled, ordinary, ready, wrapped } from "./src/operations.js";

it("executes real Effect programs with intentionally partial coverage", async () => {
  expect(await Effect.runPromise(ready)).toBe(2);
  expect(await Effect.runPromise(choose(true))).toBe(1);
  expect(await Effect.runPromise(choose(false))).toBe(0);
  expect(await Effect.runPromise(wrapped(true))).toBe(1);
  expect(ordinary(true)).toBe(1);
  emptyCalled();
});
