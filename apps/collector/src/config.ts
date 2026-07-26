import { z } from "zod";

const booleanEnvironmentSchema = z
  .union([z.boolean(), z.string(), z.number()])
  .optional()
  .transform((value) => {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return value !== 0;
    }

    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off", ""].includes(normalized)) {
      return false;
    }

    throw new Error(`Invalid boolean environment value: ${value}`);
  });

export const collectorConfigSchema = z.object({
  concurrency: z.coerce.number().int().positive().default(2),
  databaseUrl: z.string().optional(),
  debug: booleanEnvironmentSchema.default(false),
  dryRun: booleanEnvironmentSchema.default(true),
  geminiApiKey: z.string().optional(),
  geminiModelDefault: z.string().default("gemini-3.1-flash-lite"),
  geminiModelImportant: z.string().default("gemini-3.0-flash"),
  maxItemsPerFeed: z.coerce.number().int().positive().default(20),
  summaryChunkChars: z.coerce.number().int().min(2000).default(12000),
});

export type CollectorConfig = z.infer<typeof collectorConfigSchema>;

export function readCollectorConfig(environment: NodeJS.ProcessEnv = process.env): CollectorConfig {
  return collectorConfigSchema.parse({
    concurrency: environment.COLLECTOR_CONCURRENCY,
    databaseUrl: environment.DATABASE_URL,
    debug: environment.DEBUG,
    dryRun: environment.COLLECTOR_DRY_RUN,
    geminiApiKey: environment.GEMINI_API_KEY,
    geminiModelDefault: environment.GEMINI_MODEL_DEFAULT,
    geminiModelImportant: environment.GEMINI_MODEL_IMPORTANT,
    maxItemsPerFeed: environment.COLLECTOR_MAX_ITEMS_PER_FEED,
    summaryChunkChars: environment.SUMMARY_CHUNK_CHARS,
  });
}
