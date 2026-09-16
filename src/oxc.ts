import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Oxc from "oxc-parser";
import * as Model from "./model.js";
import * as SourceParser from "./sourceParser.js";

/** Native adapter. Import explicitly at the runtime boundary, never from core. */
export const layer = Layer.succeed(SourceParser.SourceParser, {
  parse: (file, source) =>
    Effect.try({
      try: () => {
        const parsed = Oxc.parseSync(file, source, { showSemanticErrors: true });
        if (parsed.errors.length)
          throw new Error(parsed.errors.map((error) => error.message).join("; "));
        return parsed.program;
      },
      catch: (cause) =>
        new Model.AnalysisError({
          message: `Unable to parse ${file}: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    }),
});
