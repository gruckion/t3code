import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { createSpeechCleaner, type Replacer, type ReplacementResult } from "./Replacer.ts";

export class SpeechCleaner extends Context.Service<
  SpeechCleaner,
  { readonly replace: (text: string) => Effect.Effect<ReplacementResult> }
>()("t3/speech/cleaner/engine/SpeechCleaner") {}

export const layer = <E, R>(replacers: ReadonlyArray<Replacer<E, R>>) =>
  Layer.effect(
    SpeechCleaner,
    Effect.gen(function* () {
      const services = yield* Effect.context<R>();
      const replace = yield* createSpeechCleaner(replacers);
      return SpeechCleaner.of({
        // The inner cleaner already opens the `SpeechCleaner.replace` span.
        replace: Effect.fnUntraced(function* (text: string) {
          return yield* replace(text).pipe(Effect.provideContext(services));
        }),
      });
    }),
  );
