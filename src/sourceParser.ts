import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Oxc from "oxc-parser";
import type * as Model from "./model.js";

/** Runtime-specific parsers supply an Oxc-compatible ESTree with UTF-16 offsets. */
export class SourceParser extends Context.Tag("effect-crap/SourceParser")<
  SourceParser,
  {
    readonly parse: (
      file: string,
      source: string,
    ) => Effect.Effect<Oxc.Program, Model.AnalysisError>;
  }
>() {}
