import { useState } from "react";
import { useGT } from "gt-react";
import {
  AuthSettingsWriteScope,
  ReadAloudCleanerRule,
  type EnvironmentId,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

type CleanerPatch = NonNullable<ServerSettingsPatch["readAloudCleaner"]>;

/** A key the environment keeps in its secret store: it never comes back, only that one is saved. */
function SecretKeyControl({
  label,
  saved,
  disabled,
  save,
}: {
  label: string;
  saved: boolean;
  disabled: boolean;
  save: (value: string) => void;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState("");
  return (
    <div className="flex items-center gap-1.5">
      <Input
        type="password"
        size="sm"
        aria-label={label}
        placeholder={saved ? gt("Saved") : gt("Not set")}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || !draft.trim()}
        onClick={() => {
          save(draft.trim());
          setDraft("");
        }}
      >
        {gt("Save")}
      </Button>
      {saved && (
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => save("")}>
          {gt("Remove")}
        </Button>
      )}
    </div>
  );
}

/** Text saved when the field loses focus, so typing does not save every keystroke. */
function TextSettingControl({
  label,
  placeholder,
  value,
  disabled,
  save,
}: {
  label: string;
  placeholder: string;
  value: string;
  disabled: boolean;
  save: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      size="sm"
      aria-label={label}
      placeholder={placeholder}
      value={draft === null ? value : draft}
      disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null && draft.trim() !== value) save(draft.trim());
        setDraft(null);
      }}
    />
  );
}

/**
 * The speech cleaner on the read-aloud environment: it rewrites replies so cloud voices read
 * paths, links, hashes, and code naturally. Its keys stay on that environment.
 */
export function ReadAloudCleanerSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const cleaner = useEnvironmentSettings(environmentId, (settings) => settings.readAloudCleaner);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const canManage = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const update = (patch: CleanerPatch) => updateSettings({ readAloudCleaner: patch });
  const rules: Record<ReadAloudCleanerRule, { title: string; description: string }> = {
    "code-blocks": {
      title: gt("Code blocks"),
      description: gt(
        "Summarize code blocks with the narration model, instead of reading the code.",
      ),
    },
    urls: {
      title: gt("Links"),
      description: gt("Read web addresses as their site name, without the path."),
    },
    "migration-files": {
      title: gt("Migration files"),
      description: gt("Read a database migration filename as its revision suffix."),
    },
    hashes: {
      title: gt("Hashes"),
      description: gt("Read commit hashes and checksums as their last four characters."),
    },
    "file-paths": {
      title: gt("File paths"),
      description: gt("Read the slashes in file paths as spaces."),
    },
    separators: {
      title: gt("Names and identifiers"),
      description: gt(
        "Read underscores and hyphens in identifiers, and the slash in repository and branch names, as spaces.",
      ),
    },
    "markdown-tables": {
      title: gt("Tables", { $context: "Markdown tables in a reply" }),
      description: gt("Narrate whole Markdown tables with the narration model."),
    },
    blockquotes: {
      title: gt("Quotes", { $context: "quoted text in a reply" }),
      description: gt("Read quoted text without the quote markers."),
    },
    comparisons: {
      title: gt("Comparisons"),
      description: gt("Read symbols such as >= and != as words."),
    },
    numbers: {
      title: gt("Numbers"),
      description: gt("Read numbers with commas, such as 4,064,078, as words."),
    },
  };
  const enabled = cleaner.jevApiKey !== "";
  return (
    <>
      <SettingsRow
        title={gt("Speech cleaner")}
        description={
          enabled
            ? gt(
                "Rewrites each reply so the voice reads paths, links, hashes, and code naturally. Jev, and the narration model when set, receive the reply text.",
              )
            : gt(
                "Add a Jev API key to rewrite replies for speech. Without one, replies read as written, unless the environment sets {variable}.",
                { variable: "TYPESAFE_API_KEY" },
              )
        }
        control={
          <SecretKeyControl
            label={gt("Jev API key")}
            saved={enabled}
            disabled={!canManage}
            save={(jevApiKey) => update({ jevApiKey })}
          />
        }
      />
      <SettingsRow
        title={gt("Narration model")}
        description={gt(
          "An OpenAI-compatible model that summarizes code blocks and tables. Leave it empty to read them as written.",
        )}
        control={
          <TextSettingControl
            label={gt("Narration model")}
            placeholder={gt("Model ID")}
            value={cleaner.narrationModel}
            disabled={!canManage}
            save={(narrationModel) => update({ narrationModel })}
          />
        }
      />
      <SettingsRow
        title={gt("Narration base URL")}
        description={gt("Leave it empty to use OpenAI.")}
        control={
          <TextSettingControl
            label={gt("Narration base URL")}
            placeholder="https://api.openai.com/v1"
            value={cleaner.narrationBaseUrl}
            disabled={!canManage}
            save={(narrationBaseUrl) => update({ narrationBaseUrl })}
          />
        }
      />
      <SettingsRow
        title={gt("Narration API key")}
        description={gt("The key for the narration model.")}
        control={
          <SecretKeyControl
            label={gt("Narration API key")}
            saved={cleaner.narrationApiKey !== ""}
            disabled={!canManage}
            save={(narrationApiKey) => update({ narrationApiKey })}
          />
        }
      />
      {ReadAloudCleanerRule.literals.map((rule) => (
        <SettingsRow
          key={rule}
          title={rules[rule].title}
          description={rules[rule].description}
          control={
            <Switch
              aria-label={rules[rule].title}
              checked={!cleaner.disabledRules.includes(rule)}
              disabled={!canManage}
              onCheckedChange={(on) =>
                update({
                  disabledRules: on
                    ? cleaner.disabledRules.filter((entry) => entry !== rule)
                    : [...cleaner.disabledRules, rule],
                })
              }
            />
          }
        />
      ))}
    </>
  );
}
