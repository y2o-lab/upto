import { GoogleGenAI } from "@google/genai";
import { beforeAll, afterAll, expect, it } from "vitest";

import { createCollectorServer } from "../src/http/node-adapter.js";
import { createGeminiGenerationAdapter } from "../src/stages/gemini-adapter.js";
let server: ReturnType<typeof createCollectorServer>;
let origin: string;
const counts = new Map<string, number>();
let settled!: () => void;
let settlement: Promise<void>;
const bodies: Record<string, unknown>[] = [];
beforeAll(async () => {
  settlement = new Promise<void>((resolve) => {
    settled = resolve;
  });
  server = createCollectorServer(
    async (request) => {
      const path = new URL(request.url).pathname;
      counts.set(path, (counts.get(path) ?? 0) + 1);
      const body = await request.json();
      bodies.push(body);
      if (path.includes("fixture-stall")) {
        await new Promise<void>((resolve) =>
          request.signal.addEventListener(
            "abort",
            () => {
              settled();
              resolve();
            },
            { once: true },
          ),
        );
        return Response.json({});
      }
      if (path.includes("fixture-429"))
        return Response.json(
          { error: { code: 429, message: "fixture-private-token", status: "RESOURCE_EXHAUSTED" } },
          { status: 429 },
        );
      if (path.includes("fixture-503"))
        return Response.json(
          { error: { code: 503, message: "fixture-private-token", status: "UNAVAILABLE" } },
          { status: 503 },
        );
      if (path.endsWith(":countTokens")) return Response.json({ totalTokens: 100 });
      const text = path.includes("fixture-invalid")
        ? "fixture-non-json"
        : JSON.stringify({ kind: "chunk", text: "架空要約" });
      return Response.json({
        candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text }] } }],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 15,
          thoughtsTokenCount: 5,
          totalTokenCount: 120,
        },
      });
    },
    () => origin,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});
function adapter() {
  return createGeminiGenerationAdapter({
    apiKey: "fixture-dummy-key",
    ai: new GoogleGenAI({ apiKey: "fixture-dummy-key", httpOptions: { baseUrl: origin } }),
  });
}
function input(model = "fixture-model") {
  return {
    model,
    prompt: "架空の完全promptとschema",
    outputKind: "chunk" as const,
    maxOutputTokens: 1000,
    signal: new AbortController().signal,
  };
}
it("runs the actual SDK with identical prompt contents and includes thought tokens in output usage", async () => {
  const value = adapter();
  expect(await value.count(input())).toEqual({ inputTokens: 100 });
  expect(await value.generate(input())).toEqual({
    output: { kind: "chunk", text: "架空要約" },
    usage: { inputTokens: 100, outputTokens: 20 },
  });
  expect(JSON.stringify(bodies[0])).toContain(input().prompt);
  expect(JSON.stringify(bodies[1])).toContain(input().prompt);
  expect(bodies[1]).toMatchObject({
    generationConfig: {
      maxOutputTokens: 1000,
      responseMimeType: "application/json",
      candidateCount: 1,
    },
  });
});
it("disables SDK retries and sanitizes 429 and unknown 5xx", async () => {
  await expect(adapter().generate(input("fixture-429"))).rejects.toMatchObject({
    outcome: "rate_limited",
    message: "GEMINI_RATE_LIMITED",
  });
  await expect(adapter().generate(input("fixture-503"))).rejects.toThrow("GEMINI_OUTCOME_UNKNOWN");
  expect(
    [...counts].filter(([path]) => path.includes("fixture-429")).map(([, count]) => count),
  ).toEqual([1]);
  expect(
    [...counts].filter(([path]) => path.includes("fixture-503")).map(([, count]) => count),
  ).toEqual([1]);
});
it("returns invalid completed output for terminal validation instead of treating JSON failure as an uncertain send", async () => {
  expect(await adapter().generate(input("fixture-invalid"))).toEqual({
    output: null,
    usage: { inputTokens: 100, outputTokens: 20 },
  });
});
it("propagates AbortSignal through the real SDK HTTP request", async () => {
  const signal = AbortSignal.timeout(100);
  await expect(adapter().generate({ ...input("fixture-stall"), signal })).rejects.toThrow(
    "GEMINI_OUTCOME_UNKNOWN",
  );
  await settlement;
});
