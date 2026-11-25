import { diffArrays } from "diff";

/** A UTF-16 range of a text. */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

type Word = TextRange & { readonly key: string };

/** Words compared by letters and digits only, so punctuation and markup do not count. */
function words(text: string): Array<Word> {
  const result: Array<Word> = [];
  for (const match of text.matchAll(/\S+/g)) {
    const key = match[0].toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (key) result.push({ key, start: match.index, end: match.index + match[0].length });
  }
  return result;
}

/**
 * Maps a range of `spoken`, a rewrite of `plain` for speech, to the range of `plain` it reads,
 * or null when no word of the range has a place there. Equal words map to each other; a rewritten
 * run maps to the words it replaced, and an added word joins the word before it. A narrated block
 * is a summary, so each of its words reads the whole block.
 */
export function spokenTextMap(plain: string, spoken: string, narrated: boolean) {
  if (spoken === plain) return (start: number, end: number): TextRange | null => ({ start, end });
  const source = words(plain);
  const said = words(spoken);
  const first = source[0];
  const last = source.at(-1);
  const whole = first && last ? { start: first.start, end: last.end } : null;
  const places: Array<TextRange | null> = said.map(() => (narrated ? whole : null));
  if (!narrated && whole) {
    let sourceIndex = 0;
    let saidIndex = 0;
    let removed: { from: number; to: number } | null = null;
    const placeAdded = (count: number) => {
      const from = removed && source[removed.from];
      const to = removed && source[removed.to - 1];
      for (let index = saidIndex; index < saidIndex + count; index++)
        places[index] =
          from && to ? { start: from.start, end: to.end } : (places[index - 1] ?? null);
    };
    for (const part of diffArrays(
      source.map((word) => word.key),
      said.map((word) => word.key),
    )) {
      const count = part.value.length;
      if (part.removed) {
        removed = { from: sourceIndex, to: sourceIndex + count };
        sourceIndex += count;
        continue;
      }
      if (part.added) placeAdded(count);
      else
        for (let offset = 0; offset < count; offset++) {
          const word = source[sourceIndex + offset];
          places[saidIndex + offset] = word ? { start: word.start, end: word.end } : null;
        }
      if (!part.added) sourceIndex += count;
      saidIndex += count;
      removed = null;
    }
    // Words added before any match read where the first match does.
    const firstPlace = places.find((place) => place !== null);
    for (let index = 0; index < places.length && places[index] === null; index++)
      places[index] = firstPlace ?? whole;
  }
  return (start: number, end: number): TextRange | null => {
    let range: TextRange | null = null;
    said.forEach((word, index) => {
      const place = places[index];
      if (!place || word.end <= start || word.start >= end) return;
      range = range
        ? { start: Math.min(range.start, place.start), end: Math.max(range.end, place.end) }
        : place;
    });
    return range;
  };
}
