import { expect, it } from "vite-plus/test";

import { spokenTextMap } from "./spokenTextMap.ts";

/** The plain text each spoken word reads. */
const read = (plain: string, spoken: string, narrated = false) => {
  const place = spokenTextMap(plain, spoken, narrated);
  return [...spoken.matchAll(/\S+/g)].map((match) => {
    const range = place(match.index, match.index + match[0].length);
    return [match[0], range && plain.slice(range.start, range.end)];
  });
};

it("maps a rewritten path to the path it replaced and keeps equal words in place", () => {
  expect(read("Open src/main.ts now.", "Open src main.ts now.")).toEqual([
    ["Open", "Open"],
    ["src", "src/main.ts"],
    ["main.ts", "src/main.ts"],
    ["now.", "now."],
  ]);
});

it("joins an added word to the word before it, or to the first match at the start", () => {
  expect(read("See 1a2b3c4d.", "See the hash ending 3c4d.")).toEqual([
    ["See", "See"],
    ["the", "1a2b3c4d."],
    ["hash", "1a2b3c4d."],
    ["ending", "1a2b3c4d."],
    ["3c4d.", "1a2b3c4d."],
  ]);
  expect(read("Done.", "Well, done.")).toEqual([
    ["Well,", "Done."],
    ["done.", "Done."],
  ]);
});

it("reads unchanged text in place and a narrated summary as the whole block", () => {
  const place = spokenTextMap("Same text.", "Same text.", false);
  expect(place(5, 10)).toEqual({ start: 5, end: 10 });
  expect(read("| a | b |", "A table of a and b.", true).map(([, plain]) => plain)).toEqual(
    Array.from({ length: 6 }, () => "a | b"),
  );
});
