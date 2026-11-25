import * as Context from "effect/Context";

/**
 * Deadlines in milliseconds. Table narration took up to 10.6 s in testing, so a rule gets 12 s.
 * A table gets 11 s, so it can fall back to its own spoken form before the rule deadline.
 */
export const CleanerTimeouts = Context.Reference<{
  readonly ruleMs: number;
  readonly classifierMs: number;
  readonly codeNarrationMs: number;
  readonly tableNarrationMs: number;
}>("t3/speech/cleaner/engine/CleanerTimeouts", {
  defaultValue: () => ({
    ruleMs: 12_000,
    classifierMs: 1_500,
    codeNarrationMs: 3_500,
    tableNarrationMs: 11_000,
  }),
});
