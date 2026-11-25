import * as Effect from "effect/Effect";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { RootContent } from "mdast";
import { defineReplacer } from "../engine/Replacer.ts";

const SPOKEN = new Map([
  [">", "greater than"],
  ["<", "less than"],
  [">=", "greater than or equal to"],
  ["<=", "less than or equal to"],
  ["≥", "greater than or equal to"],
  ["≤", "less than or equal to"],
]);
// `1 < x` says the same as `x > 1`, which puts the middle of a range first when it is spoken.
const FLIPPED = new Map([
  [">", "<"],
  ["<", ">"],
  [">=", "<="],
  ["<=", ">="],
  ["≥", "≤"],
  ["≤", "≥"],
]);

const SYMBOL = "(?:>=|<=|≥|≤|>|<)";
// Leave `=>`, `>>`, `<>`, `|>`, `->` and the like alone.
const GUARDED_SYMBOL = String.raw`(?<![-=<>!~|\\])(${SYMBOL})(?![=<>|])`;
const OPERATOR = new RegExp(String.raw`[ \t]*${GUARDED_SYMBOL}[ \t]*`, "gu");
// 3, -1.5, $5, 1,000, 90%, 200ms, but not 3.txt or 2/dev.
const NUMBER = String.raw`[-+]?[$£€]?\d[\d,]*(?:\.\d+)?(?:%|\p{L}{1,3})?`;
const NAME = String.raw`[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*(?:\(\)|\[[\p{L}\p{N}_]+\])?`;
const OPERAND_END = String.raw`(?![\p{L}\p{N}_/-]|\.[\p{L}\p{N}])`;
const LEFT_NUMBER = new RegExp(String.raw`(?:^|[^\p{L}\p{N}_.])${NUMBER}$`, "u");
const LEFT_OPERAND = /[\p{L}\p{N}_$%)\]]$/u;
const LEFT_WORD = /[\p{L}_$][\p{L}\p{N}_$.]*$/u;
const LEFT_NOTHING = /(?:^|[([{:,;])$/u;
const RIGHT_NUMBER = new RegExp(`^${NUMBER}${OPERAND_END}`, "u");
const RIGHT_NAME = new RegExp(`^${NAME}${OPERAND_END}`, "u");
const CHAIN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_.$-])(${NUMBER}|${NAME})[ \t]*${GUARDED_SYMBOL}[ \t]*(${NUMBER}|${NAME})[ \t]*${GUARDED_SYMBOL}[ \t]*(${NUMBER}|${NAME})${OPERAND_END}`,
  "gu",
);
// `Settings > General` is a menu path, not a comparison.
const MENU_WORD = /^\p{Lu}\p{Ll}/u;
// `ls > out.txt` is a shell redirect.
const OUTPUT_FILE = /\.(?:csv|err|html|json|log|md|out|py|sh|sql|tmp|ts|js|txt|xml|ya?ml)$/iu;
// "x is > 3" and "fails when > 3" already read well without another "is".
const NO_VERB_AFTER =
  /(?:^|[^\p{L}\p{N}_])(?:all|and|any|are|at|be|being|by|for|has|have|if|is|of|or|than|to|unless|until|was|were|when|where|while|with)$/iu;
const PLURAL = /\p{Ll}{2,}s$/u;
const NOT_PLURAL = /(?:ss|us|is)$/u;

/**
 * `>` and `<` also mark menus (`Settings > General`), generics (`Array<string>`) and shell
 * redirects (`echo 3 > out.txt`). Two names therefore need spaces and no menu-style capital.
 */
const isComparison = (operator: string, before: string, after: string, spaced: boolean) => {
  const leftMissing = LEFT_NOTHING.test(before);
  if (RIGHT_NUMBER.test(after)) return leftMissing || LEFT_OPERAND.test(before);
  const right = RIGHT_NAME.exec(after)?.[0];
  if (right === undefined || leftMissing || !LEFT_OPERAND.test(before)) return false;
  if (operator !== ">" && operator !== "<") return true;
  if (operator === "<" && LEFT_NUMBER.test(before)) return true;
  if (!spaced || MENU_WORD.test(right) || (operator === ">" && OUTPUT_FILE.test(right))) {
    return false;
  }
  const left = LEFT_WORD.exec(before)?.[0];
  return left === undefined || !MENU_WORD.test(left);
};

const verbAfter = (left: string) => {
  if (NO_VERB_AFTER.test(left)) return "";
  if (!LEFT_NUMBER.test(left) && PLURAL.test(left) && !NOT_PLURAL.test(left)) return "are ";
  return "is ";
};

const speakChain = (text: string) =>
  text.replace(
    CHAIN,
    (match: string, low: string, first: string, middle: string, second: string, high: string) => {
      const flipped = FLIPPED.get(first);
      const toLow = flipped === undefined ? undefined : SPOKEN.get(flipped);
      const toHigh = SPOKEN.get(second);
      if (toLow === undefined || toHigh === undefined) return match;
      const spaced = match.includes(" ");
      const valid =
        isComparison(first, low, middle, spaced) && isComparison(second, middle, high, spaced);
      return valid ? `${middle} ${verbAfter(middle)}${toLow} ${low} and ${toHigh} ${high}` : match;
    },
  );

/** `lead` is the same line's source before `text`, so `` `x` > 3 `` still has its left side. */
const speakOperators = (text: string, lead = "") =>
  speakChain(text).replace(
    OPERATOR,
    (match: string, operator: string, offset: number, whole: string) => {
      const spoken = SPOKEN.get(operator);
      const before = `${lead}${whole.slice(0, offset)}`.trimEnd().replace(/[*_`~]+$/u, "");
      const after = whole.slice(offset + match.length);
      if (spoken === undefined) return match;
      const spaced = match.startsWith(" ") && match.endsWith(" ");
      if (!isComparison(operator, before, after, spaced)) return match;
      const hasLeft = !LEFT_NOTHING.test(before);
      const gap = match.startsWith(" ") || hasLeft ? " " : "";
      return `${gap}${hasLeft ? verbAfter(before) : ""}${spoken} `;
    },
  );

const speakConnectives = (text: string) =>
  text.replace(/\s*&&\s*/g, " and ").replace(/\s*\|\|\s*/g, " or ");

const speakProse = (text: string, lead: string) => {
  const spoken = speakOperators(text, lead);
  return spoken === text ? text : speakConnectives(spoken);
};

const CLAUSE = new RegExp(
  String.raw`^[^\s<>=|&]+(?:\s*${GUARDED_SYMBOL}\s*[^\s<>=|&]+){1,2}$`,
  "u",
);

/** Code is often a command, so a code span must hold nothing but joined comparisons. */
const speakInlineCode = (value: string) => {
  const clauses = value.split(/\s*(?:&&|\|\|)\s*/u);
  const allSpoken = clauses.every(
    (clause) => CLAUSE.test(clause) && speakOperators(clause) !== clause,
  );
  return allSpoken ? speakConnectives(speakOperators(value)) : value;
};

export const comparisons = defineReplacer({
  id: "comparisons",
  description: "Read comparison operators as words, because speech models skip the symbols",
  matches: (text) => /[<>≤≥]/u.test(text),
  replace: (text) =>
    Effect.sync(() => {
      let output = "";
      let cursor = 0;
      function visit(nodes: ReadonlyArray<RootContent>) {
        for (const node of nodes) {
          const start = node.position?.start.offset;
          const end = node.position?.end.offset;
          if (start === undefined || end === undefined) continue;
          let replacement: string | undefined;
          const source = text.slice(start, end);
          if (node.type === "inlineCode") {
            replacement = source.replace(node.value, () => speakInlineCode(node.value));
          } else if (node.type === "text") {
            const line = text.slice(text.lastIndexOf("\n", start) + 1, start);
            replacement = speakProse(source, line);
          } else if ("children" in node) visit(node.children);
          if (replacement !== undefined) {
            output += text.slice(cursor, start) + replacement;
            cursor = end;
          }
        }
      }
      visit(fromMarkdown(text).children);
      return output + text.slice(cursor);
    }),
});
