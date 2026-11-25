import * as Effect from "effect/Effect";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import type { RootContent, Table } from "mdast";
import * as TableNarrator from "../ai/TableNarrator.ts";
import { CleanerTimeouts } from "../engine/CleanerTimeouts.ts";
import { defineReplacer, narrated, type Narrated } from "../engine/Replacer.ts";
import { speakUrls } from "./urls.ts";

const parseTables = (text: string) =>
  fromMarkdown(text, { extensions: [gfmTable()], mdastExtensions: [gfmTableFromMarkdown()] });

/** Replace each link with its label, so a hidden destination is never sent or spoken. */
function linkLabels(text: string): string {
  let output = "";
  let cursor = 0;
  function visit(nodes: ReadonlyArray<RootContent>) {
    for (const node of nodes) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      // An autolink shows its URL, so the urls rule reads it.
      if ((node.type === "link" || node.type === "linkReference") && text[start] !== "<") {
        const labelStart = node.children[0]?.position?.start.offset;
        const labelEnd = node.children.at(-1)?.position?.end.offset;
        output +=
          text.slice(cursor, start) +
          (labelStart === undefined || labelEnd === undefined
            ? ""
            : text.slice(labelStart, labelEnd));
        cursor = end;
      } else if ("children" in node) visit(node.children);
    }
  }
  visit(parseTables(text).children);
  return output + text.slice(cursor);
}

const URL_IN_NARRATION =
  /(?:\s+(?:at|via|from|on|see))?\s*\(?<?(?:https?:\/\/|www\.)[^\s<>"'`]*[^\s<>"'`.,;:!?)]>?\)?/giu;

/** The model is told not to say URLs; drop any it says anyway, with the word that led into it. */
const withoutUrls = (text: string) =>
  text
    .replace(/\[([^\]]*)\]\([^)\s]*\)/g, "$1")
    .replace(URL_IN_NARRATION, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

const withStop = (text: string) => (/[.!?…:;]\**$/u.test(text) ? text : `${text}.`);

const spokenList = (items: ReadonlyArray<string>) =>
  items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** Spoken without a model: what the table compares, then each row with its column names. */
function describeTable(text: string, table: Table): string {
  const rows = table.children.map((row) =>
    row.children.map((cell) => {
      const start = cell.children[0]?.position?.start.offset;
      const end = cell.children.at(-1)?.position?.end.offset;
      return start === undefined || end === undefined
        ? ""
        : linkLabels(text.slice(start, end)).trim();
    }),
  );
  const header = (rows[0] ?? []).map((name) => (name === "#" ? "number" : name));
  const body = rows.slice(1);
  const columns = header.filter((name) => name !== "");
  const intro = `A table with ${body.length} ${body.length === 1 ? "row" : "rows"}${
    columns.length > 0 ? ` comparing ${spokenList(columns)}` : ""
  }.`;
  const spokenRows = body.map((cells, index) => {
    const parts = cells.flatMap((cell, column) => {
      if (cell === "") return [];
      const name = header[column];
      return [withStop(name === undefined || name === "" ? cell : `${name}: ${cell}`)];
    });
    return [`Row ${index + 1}.`, ...parts].join(" ");
  });
  return [intro, ...spokenRows].join(" ");
}

export const markdownTables = defineReplacer({
  id: "markdown-tables",
  description: "Narrate GFM tables while preserving surrounding Markdown",
  matches: (text) => text.includes("|") && text.includes("-"),
  replace: Effect.fn("markdownTables.replace")(function* (text: string) {
    const tables: Array<{ start: number; end: number; node: Table }> = [];
    function visit(nodes: ReadonlyArray<RootContent>) {
      for (const node of nodes) {
        if (node.type === "table") {
          const start = node.position?.start.offset;
          const end = node.position?.end.offset;
          if (start !== undefined && end !== undefined) tables.push({ start, end, node });
        } else if ("children" in node) visit(node.children);
      }
    }
    visit(parseTables(text).children);
    if (tables.length === 0) return text;
    const timeouts = yield* CleanerTimeouts;
    const narrator = yield* TableNarrator.TableNarrator;
    // A table the model cannot narrate in time is still spoken, never read as raw pipes.
    const spoken = yield* Effect.forEach(
      tables,
      (table): Effect.Effect<string | Narrated> =>
        narrator.narrate(speakUrls(linkLabels(text.slice(table.start, table.end)))).pipe(
          Effect.map(withoutUrls),
          Effect.timeout(timeouts.tableNarrationMs),
          Effect.map((narration) =>
            /[\p{L}\p{N}]/u.test(narration) ? narrated(narration) : describeTable(text, table.node),
          ),
          Effect.orElseSucceed(() => describeTable(text, table.node)),
        ),
      { concurrency: 2 },
    );
    let output = "";
    let cursor = 0;
    for (const [index, table] of tables.entries()) {
      const replacement = spoken[index]!;
      output +=
        text.slice(cursor, table.start) +
        (typeof replacement === "string" ? replacement : replacement.text);
      cursor = table.end;
    }
    output += text.slice(cursor);
    return spoken.some((replacement) => typeof replacement !== "string")
      ? narrated(output)
      : output;
  }),
});
