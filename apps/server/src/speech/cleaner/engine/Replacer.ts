import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CleanerTimeouts } from "./CleanerTimeouts.ts";

/** Text the narration model wrote, rather than a word-for-word cleanup of the source. */
export interface Narrated {
  readonly text: string;
  readonly narrated: true;
}

export const narrated = (text: string): Narrated => ({ text, narrated: true });

/** A rule sees the output of the preceding rule. Never mutate the conversation. */
export interface Replacer<E = never, R = never> {
  readonly id: string;
  readonly description: string;
  readonly matches?: (text: string) => boolean;
  readonly replace: (text: string) => Effect.Effect<string | Narrated, E, R>;
}

export const defineReplacer = <E, R>(rule: Replacer<E, R>): Replacer<E, R> => rule;

export class InvalidRegistry extends Schema.TaggedError<InvalidRegistry>()("InvalidRegistry", {
  problem: Schema.Literals(["timeout", "empty-id", "duplicate-id"]),
  id: Schema.optional(Schema.String),
}) {
  override get message(): string {
    return this.problem === "timeout"
      ? "Speech cleaner timeout must be positive."
      : "Speech cleaner replacer ids must be unique and non-empty.";
  }
}

export interface ReplacementResult {
  readonly text: string;
  readonly applied: boolean;
  /** Ids of the rules that changed the text, in order. */
  readonly changes: ReadonlyArray<string>;
  /** The subset of `changes` whose new text a model wrote, so it is a summary of the source. */
  readonly narrated: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
}

/** Validate once; callers retain the union of their replacers' requirements. */
export const createSpeechCleaner = Effect.fnUntraced(function* <E, R>(
  rules: ReadonlyArray<Replacer<E, R>>,
  options: { readonly timeoutMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? (yield* CleanerTimeouts).ruleMs;
  const registry = [...rules];
  const names = new Set<string>();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return yield* new InvalidRegistry({ problem: "timeout" });
  for (const rule of registry) {
    if (!rule.id.trim() || names.has(rule.id))
      return yield* new InvalidRegistry({
        problem: rule.id.trim() ? "duplicate-id" : "empty-id",
        id: rule.id,
      });
    names.add(rule.id);
  }
  return Effect.fn("SpeechCleaner.replace")(function* (
    input: string,
  ): Effect.fn.Return<ReplacementResult, never, R> {
    let text = input;
    const changes: string[] = [];
    const narratedBy: string[] = [];
    const skipped: string[] = [];
    for (const rule of registry) {
      const before = text;
      const output = yield* Effect.suspend((): Effect.Effect<string | Narrated, E, R> =>
        rule.matches && !rule.matches(before) ? Effect.succeed(before) : rule.replace(before),
      ).pipe(
        Effect.timeout(timeoutMs),
        Effect.catchCause(() => {
          skipped.push(rule.id);
          return Effect.succeed(before);
        }),
      );
      text = typeof output === "string" ? output : output.text;
      if (text === before) continue;
      changes.push(rule.id);
      if (typeof output !== "string") narratedBy.push(rule.id);
    }
    return { text, applied: text !== input, changes, narrated: narratedBy, skipped };
  });
});
