import * as Effect from "effect/Effect";
import type { RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { defineReplacer } from "../engine/Replacer.ts";

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = ["", "thousand", "million", "billion", "trillion"];
const CURRENCIES = new Map([
  ["$", "dollars"],
  ["£", "pounds"],
  ["€", "euros"],
]);

// Only numbers with thousands separators: Kokoro drops the commas and reads the digits as one
// run. `1,2,3` (a list), `v1,000` and `1,000,0` stay as they are.
const GROUPED = /(?<![\p{L}\p{N}_.,])([$£€]?)(\d{1,3}(?:,\d{3})+)(\.\d+)?(?![\p{L}\p{N}_]|,\d)/gu;

const word = (list: ReadonlyArray<string>, index: number) => {
  const value = list[index];
  if (value === undefined) throw new RangeError(`No number word at ${index}`);
  return value;
};

const belowThousand = (value: number) => {
  const words: string[] = [];
  if (value >= 100) words.push(word(ONES, Math.floor(value / 100)), "hundred");
  const rest = value % 100;
  const tens = word(TENS, Math.floor(rest / 10));
  if (rest >= 20) words.push(rest % 10 ? `${tens}-${word(ONES, rest % 10)}` : tens);
  else if (rest > 0) words.push(word(ONES, rest));
  return words.join(" ");
};

/** `4,064,078` → `four million sixty-four thousand seventy-eight`. */
function spellGrouped(grouped: string): string | undefined {
  const groups = grouped.split(",").map(Number);
  if (groups.length > SCALES.length || groups[0] === 0) return;
  const words = groups.flatMap((group, index) => {
    if (group === 0) return [];
    const scale = SCALES[groups.length - 1 - index];
    return scale ? [belowThousand(group), scale] : [belowThousand(group)];
  });
  return words.join(" ");
}

const speakNumbers = (source: string) =>
  source.replace(GROUPED, (match, symbol: string, grouped: string, fraction?: string) => {
    const whole = spellGrouped(grouped);
    if (whole === undefined) return match;
    const decimals = fraction
      ? ` point ${fraction
          .slice(1)
          .split("")
          .map((digit) => word(ONES, Number(digit)))
          .join(" ")}`
      : "";
    const currency = CURRENCIES.get(symbol);
    return currency ? `${whole}${decimals} ${currency}` : `${whole}${decimals}`;
  });

/** Spell out grouped numbers in visible prose; code and link destinations stay as they are. */
function speakGroupedNumbers(text: string): string {
  let output = "";
  let cursor = 0;
  function visit(nodes: ReadonlyArray<RootContent>) {
    for (const node of nodes) {
      if (node.type === "text") {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start === undefined || end === undefined) continue;
        output += text.slice(cursor, start) + speakNumbers(text.slice(start, end));
        cursor = end;
      } else if ("children" in node) visit(node.children);
    }
  }
  visit(fromMarkdown(text).children);
  return output + text.slice(cursor);
}

export const numbers = defineReplacer({
  id: "numbers",
  description: "Spell out numbers with thousands separators so the voice reads them as amounts",
  matches: (text) => /\d,\d{3}/.test(text),
  replace: (text) => Effect.sync(() => speakGroupedNumbers(text)),
});
