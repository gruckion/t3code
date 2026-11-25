import * as Effect from "effect/Effect";
import { visibleCandidates } from "./visibleCandidates.ts";
import * as HashClassifier from "../ai/HashClassifier.ts";
import { CleanerTimeouts } from "../engine/CleanerTimeouts.ts";
import { defineReplacer } from "../engine/Replacer.ts";

// Exclude parts of identifiers, filenames, URL paths, colors and signed values.
const candidatePattern =
  /(?<![\p{L}\p{N}_/@#.-])[a-f\d]{7,64}(?![\p{L}\p{N}_/-]|\.[\p{L}\p{N}])/giu;

export const hashes = defineReplacer({
  id: "hashes",
  description: "Use context to recognise hashes and speak only their last four characters",
  matches: (text) => /[a-f\d]{7,64}/i.test(text),
  replace: Effect.fn("hashes.replace")(function* (text: string) {
    const candidates = visibleCandidates(text, candidatePattern);
    if (!candidates.length) return text;
    const timeouts = yield* CleanerTimeouts;
    const classifier = yield* HashClassifier.HashClassifier;
    const decisions = yield* classifier
      .classify(candidates.map(({ value, context }) => ({ value, context })))
      .pipe(
        Effect.timeout(timeouts.classifierMs),
        Effect.orElseSucceed(() => candidates.map(() => false)),
      );
    let output = "";
    let cursor = 0;
    for (const [index, candidate] of candidates.entries()) {
      if (decisions[index] !== true) continue;
      output += text.slice(cursor, candidate.start) + `hash ending ${candidate.value.slice(-4)}`;
      cursor = candidate.end;
    }
    return output + text.slice(cursor);
  }),
});
