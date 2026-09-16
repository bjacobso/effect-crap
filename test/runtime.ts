import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Analyze from "../src/analyze.js";
import * as Oxc from "../src/oxc.js";

const layer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, Oxc.layer);

export const runPromise = <A, E>(effect: Effect.Effect<A, E, Analyze.Services>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)));

export const runSync = <A, E>(effect: Effect.Effect<A, E, Analyze.Services>) =>
  Effect.runSync(effect.pipe(Effect.provide(layer)));
