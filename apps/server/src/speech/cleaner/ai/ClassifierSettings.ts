import * as Schema from "effect/Schema";

export const JEV_DEFAULT_API_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-latest";

export const ClassifierSettings = Schema.Struct({
  apiKey: Schema.Redacted(Schema.String),
  model: Schema.String,
  apiUrl: Schema.String,
});
