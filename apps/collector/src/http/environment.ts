import { z } from "zod";

import type { NodeRuntimeConfig } from "./runtime.js";
const version = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const model = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9./:_-]{0,127}$/);
function key(value: string): Uint8Array {
  if (value.length > 88 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("invalid");
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength < 32 || bytes.byteLength > 64 || bytes.toString("base64") !== value)
    throw new Error("invalid");
  return new Uint8Array(bytes);
}
const envSchema = z.object({
  COLLECTOR_ENVIRONMENT: z.enum(["staging", "production"]),
  COLLECTOR_EXECUTOR_VERSION: version,
  COLLECTOR_CONFIG_VERSION: version,
  COLLECTOR_PROMPT_VERSION: version,
  COLLECTOR_SCHEMA_VERSION: version,
  COLLECTOR_COUNT_VERSION: version,
  COLLECTOR_CHUNKER_VERSION: version,
  GEMINI_MODEL_PRIMARY: model,
  GEMINI_MODEL_FALLBACK: model,
  GEMINI_API_KEY: z.string().trim().min(1),
  COLLECTOR_NODE_AUTH_KEYS: z.string().min(1).max(4096),
  COLLECTOR_CURSOR_KEY: z.string(),
  COLLECTOR_GATE_KEY: z.string(),
  COLLECTOR_GATE_KEY_ID: version,
  COLLECTOR_GATE_ORIGIN: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  }),
  DATABASE_URL: z
    .url()
    .refine((value) => ["postgres:", "postgresql:"].includes(new URL(value).protocol)),
  DATABASE_SSL_CA: z.string().optional(),
  COLLECTOR_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(4).default(2),
  COLLECTOR_CHUNK_CHARS: z.coerce.number().int().min(1000).max(100000).default(12000),
  COLLECTOR_OUTPUT_TOKEN_LIMIT: z.coerce.number().int().min(1).max(32768).default(2048),
});
export function nodeExecutionEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment.COLLECTOR_NODE_ENABLED ?? "false";
  if (value !== "true" && value !== "false") throw new Error("NODE_CONFIGURATION_INVALID");
  return value === "true";
}
export function readNodeEnvironment(environment: NodeJS.ProcessEnv = process.env): {
  config: NodeRuntimeConfig;
  databaseUrl: string;
  databasePoolMax: number;
  databaseSslCa?: string;
} {
  try {
    const value = envSchema.parse(environment);
    const raw = z.record(version, z.string()).parse(JSON.parse(value.COLLECTOR_NODE_AUTH_KEYS));
    if (Object.keys(raw).length < 1 || Object.keys(raw).length > 2) throw new Error("invalid");
    const keys = new Map(Object.entries(raw).map(([id, value]) => [id, key(value)]));
    return {
      databaseUrl: value.DATABASE_URL,
      databasePoolMax: value.COLLECTOR_DATABASE_POOL_MAX,
      ...(value.DATABASE_SSL_CA ? { databaseSslCa: value.DATABASE_SSL_CA } : {}),
      config: {
        environment: value.COLLECTOR_ENVIRONMENT,
        executorVersion: value.COLLECTOR_EXECUTOR_VERSION,
        configVersion: value.COLLECTOR_CONFIG_VERSION,
        promptVersion: value.COLLECTOR_PROMPT_VERSION,
        schemaVersion: value.COLLECTOR_SCHEMA_VERSION,
        countVersion: value.COLLECTOR_COUNT_VERSION,
        chunkerVersion: value.COLLECTOR_CHUNKER_VERSION,
        primaryModel: value.GEMINI_MODEL_PRIMARY,
        fallbackModel: value.GEMINI_MODEL_FALLBACK,
        maxOutputTokens: value.COLLECTOR_OUTPUT_TOKEN_LIMIT,
        chunkChars: value.COLLECTOR_CHUNK_CHARS,
        keys,
        cursorKey: key(value.COLLECTOR_CURSOR_KEY),
        geminiApiKey: value.GEMINI_API_KEY,
        gateOrigin: value.COLLECTOR_GATE_ORIGIN,
        gateKeyId: value.COLLECTOR_GATE_KEY_ID,
        gateKey: key(value.COLLECTOR_GATE_KEY),
      },
    };
  } catch {
    throw new Error("NODE_CONFIGURATION_INVALID");
  }
}
