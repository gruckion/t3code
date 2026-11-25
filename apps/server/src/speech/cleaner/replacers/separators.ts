import * as Effect from "effect/Effect";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { RootContent } from "mdast";
import { defineReplacer } from "../engine/Replacer.ts";

// A conservative filename/path heuristic, not a filesystem lookup. Reject
// command strings, URLs and flags even when they use backticks.
const isFileReference = (value: string) =>
  /^(?:~\/)?[\p{L}\p{N}_./][\p{L}\p{N}_./-]*$/u.test(value) &&
  /\p{L}/u.test(value) &&
  (value.includes("/") || /\.[\p{L}][\p{L}\p{N}]*$/u.test(value));

const isIdentifier = (value: string) =>
  /^[\p{L}_][\p{L}\p{N}_]*_[\p{L}\p{N}_]+(?:\(\))?$/u.test(value);

// `owner/repo` (or a branch such as `feat/read-aloud`). Short pairs such as `km/h` and `A/B`
// stay intact, because there the slash is part of what is said. A name with a file extension
// is a path, which the file-paths rule reads.
const isRepository = (value: string) =>
  /^[\p{L}\p{N}][\p{L}\p{N}._-]+\/[\p{L}\p{N}][\p{L}\p{N}._-]+$/u.test(value) &&
  /\p{L}/u.test(value) &&
  !/\.[\p{L}][\p{L}\p{N}]*$/u.test(value) &&
  value.length >= 7;

// A link labelled with the repository it points to, such as `[owner/repo](https://github.com/owner/repo)`.
const isRepositoryLink = (label: string, url: string) =>
  isRepository(label) &&
  URL.canParse(url) &&
  new URL(url).pathname.toLowerCase().startsWith(`/${label.toLowerCase()}`);

const speakRepository = (value: string) => value.replace(/[/_-]+/g, " ");

/** Keep speech cleanup scoped to inline references, never code or command strings. */
export const separators = defineReplacer({
  id: "separators",
  description:
    "Read separators in backtick-wrapped filenames, paths, repositories and identifiers as spaces",
  matches: (text) => /[-_/]/.test(text) && (text.includes("`") || text.includes("](")),
  replace: (text) =>
    Effect.sync(() => {
      const tree = fromMarkdown(text);
      let output = "";
      let cursor = 0;
      function visit(nodes: ReadonlyArray<RootContent>) {
        for (const node of nodes) {
          const label = node.type === "link" ? node.children[0] : undefined;
          if (
            node.type === "link" &&
            node.children.length === 1 &&
            label?.type === "text" &&
            isRepositoryLink(label.value, node.url)
          ) {
            const start = label.position?.start.offset;
            const end = label.position?.end.offset;
            if (start === undefined || end === undefined) continue;
            output += text.slice(cursor, start) + speakRepository(label.value);
            cursor = end;
          } else if (
            node.type === "inlineCode" &&
            (isFileReference(node.value) || isIdentifier(node.value))
          ) {
            const start = node.position?.start.offset;
            const end = node.position?.end.offset;
            if (start === undefined || end === undefined) continue;
            output += text.slice(cursor, start);
            const source = text.slice(start, end);
            output += isIdentifier(node.value)
              ? source.replace(
                  node.value,
                  node.value.replace(/(^|_)id(?=_|\(\)$|$)/gi, "$1I D").replace(/_+/g, " "),
                )
              : isRepository(node.value)
                ? source.replace(node.value, speakRepository(node.value))
                : source.replace(/[-_]+/g, " ");
            cursor = end;
          } else if ("children" in node) visit(node.children);
        }
      }
      visit(tree.children);
      return output + text.slice(cursor);
    }),
});
