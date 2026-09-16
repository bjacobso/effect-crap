import { Effect } from "effect";

export const ready = Effect.gen(function* () {
  const value = yield* Effect.succeed(2);
  if (value > 0) return value;
  return 0;
});

export const choose = Effect.fn("choose")(function* (enabled: boolean) {
  const value = yield* Effect.succeed(1);
  if (enabled) return value;
  return 0;
});

export const neverRun = Effect.gen(function* () {
  const value = yield* Effect.succeed(0);
  if (value > 0) return 1;
  return 0;
});

export const wrapped = (enabled: boolean) =>
  Effect.gen(function* () {
    yield* Effect.void;
    if (enabled) return 1;
    return 0;
  });

export function ordinary(enabled: boolean) {
  return enabled ? 1 : 0;
}

export function emptyCalled() {}
export function emptyUncalled() {}
