import { describe, expect, it } from "vitest";

import { readCollectorConfig } from "./config.js";

describe("readCollectorConfig", () => {
  it("parses COLLECTOR_DRY_RUN=false as false", () => {
    expect(
      readCollectorConfig({
        COLLECTOR_DRY_RUN: "false",
      }).dryRun,
    ).toBe(false);
  });

  it("defaults to dry-run mode", () => {
    expect(readCollectorConfig({}).dryRun).toBe(true);
  });

  it("parses DEBUG=true as debug mode", () => {
    expect(
      readCollectorConfig({
        DEBUG: "true",
      }).debug,
    ).toBe(true);
  });

  it("defaults debug mode to false", () => {
    expect(readCollectorConfig({}).debug).toBe(false);
  });

  it("defaults to the production Gemini models", () => {
    expect(readCollectorConfig({})).toMatchObject({
      geminiModelDefault: "gemini-3.1-flash-lite",
      geminiModelImportant: "gemini-3.0-flash",
    });
  });

  it("defaults Gemini request limiting and retry settings", () => {
    expect(readCollectorConfig({})).toMatchObject({
      geminiRateLimitMaxRetries: 2,
      geminiRequestsPerMinute: 5,
    });
  });

  it("reads explicit Gemini request limiting and retry settings", () => {
    expect(
      readCollectorConfig({
        GEMINI_RATE_LIMIT_MAX_RETRIES: "4",
        GEMINI_REQUESTS_PER_MINUTE: "10",
      }),
    ).toMatchObject({
      geminiRateLimitMaxRetries: 4,
      geminiRequestsPerMinute: 10,
    });
  });

  it.each([
    { GEMINI_REQUESTS_PER_MINUTE: "0" },
    { GEMINI_REQUESTS_PER_MINUTE: "1.5" },
    { GEMINI_RATE_LIMIT_MAX_RETRIES: "0" },
    { GEMINI_RATE_LIMIT_MAX_RETRIES: "invalid" },
  ])("rejects invalid Gemini rate limiting settings: %o", (environment) => {
    expect(() => readCollectorConfig(environment)).toThrow();
  });
});
