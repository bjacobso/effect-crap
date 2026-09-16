import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import * as Callbacks from "./src/callbacks.js";

it("executes only the selected callbacks and Effect bodies", async () => {
  expect(Callbacks.covered()).toBe(42);
  expect(await Effect.runPromise(Callbacks.evaluate(true))).toBe(1);
  expect(await Effect.runPromise(Callbacks.evaluate(false))).toBe(0);
  expect(await Effect.runPromise(Callbacks.recover())).toBe(0);
  expect(Callbacks.pair().first()).toBe(1);
});
