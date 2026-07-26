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
});
