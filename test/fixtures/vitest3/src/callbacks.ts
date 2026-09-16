import * as Effect from "effect/Effect";

export const covered = () => 42;
export const uncovered = () => 0;

export const evaluate = (enabled: boolean) =>
  Effect.gen(function* () {
    const value = yield* Effect.succeed(1);
    if (enabled) return value;
    return 0;
  });

export const recover = () => Effect.fail("failure").pipe(Effect.catchAll(() => Effect.succeed(0)));

export const constructed = Effect.gen(function* () {
  yield* Effect.void;
  return 42;
});

export const pair = () => ({ first: () => 1, second: () => 2 });
