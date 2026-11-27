import * as Layer from "effect/Layer";

import type { BlockClassifier } from "./ai/BlockClassifier.ts";
import type { CodeNarrator } from "./ai/CodeNarrator.ts";
import type { HashClassifier } from "./ai/HashClassifier.ts";
import type { NarrationDisabled, NarrationFailed } from "./ai/Narration.ts";
import * as Provider from "./ai/Provider.ts";
import type { TableNarrator } from "./ai/TableNarrator.ts";
import { CleanerTimeouts } from "./engine/CleanerTimeouts.ts";
import type { Replacer } from "./engine/Replacer.ts";
import * as SpeechCleaner from "./engine/SpeechCleaner.ts";
import { blockquotes } from "./replacers/blockquotes.ts";
import { codeBlocks } from "./replacers/codeBlocks.ts";
import { comparisons } from "./replacers/comparisons.ts";
import { filePaths } from "./replacers/filePaths.ts";
import { hashes } from "./replacers/hashes.ts";
import { markdownTables } from "./replacers/markdownTables.ts";
import { migrationFiles } from "./replacers/migrationFiles.ts";
import { numbers } from "./replacers/numbers.ts";
import { separators } from "./replacers/separators.ts";
import { urls } from "./replacers/urls.ts";

/**
 * Unwrap blocks first. Clean inline references before tables: the narrator often drops the
 * backticks around a path, and later rules would then leave its slashes in.
 * Comparisons come last: a leading `>` must first be read as a quote marker, and a narrated
 * table can contain one. Numbers follow them, because both rules read digits such as `1,000`.
 */
const replacers: ReadonlyArray<
  Replacer<
    NarrationFailed | NarrationDisabled,
    TableNarrator | CodeNarrator | BlockClassifier | HashClassifier
  >
> = [
  codeBlocks,
  urls,
  migrationFiles,
  hashes,
  filePaths,
  separators,
  markdownTables,
  blockquotes,
  comparisons,
  numbers,
];

/** Settings name rules by these ids, in the order they run. */
export const ruleIds = replacers.map((rule) => rule.id);

/** Needs an `HttpClient`; the server provides `FetchHttpClient.layer` once for all features. */
export const layer = (
  settings: Provider.ProviderSettings,
  timeouts: (typeof CleanerTimeouts)["Service"] = CleanerTimeouts.defaultValue(),
  /** Rule ids that leave their text unchanged. */
  disabledRules: ReadonlyArray<string> = [],
) =>
  SpeechCleaner.layer(replacers.filter((rule) => !disabledRules.includes(rule.id))).pipe(
    Layer.provide(Provider.narratorLayer(settings)),
    Layer.provide(Layer.succeed(CleanerTimeouts, timeouts)),
  );
