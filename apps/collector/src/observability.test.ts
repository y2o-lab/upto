import { expect, it, vi } from "vitest";

import { createBatchObserver, readSlackConfig } from "./observability.js";

const incident = {
  event: "stage_finished" as const,
  environment: "staging" as const,
  requestId: "00000000-0000-4000-8000-000000000001",
  operationKey: "a".repeat(64),
  stage: "summarize-chunk" as const,
  status: "failed" as const,
  errorCode: "GENERATION_OUTCOME_UNKNOWN",
};
it("validates paired optional Slack settings without exposing values", () => {
  expect(readSlackConfig({})).toBeUndefined();
  expect(readSlackConfig({ SLACK_BOT_TOKEN: "", SLACK_CHANNEL_ID: "" })).toBeUndefined();
  expect(() => readSlackConfig({ SLACK_BOT_TOKEN: "private" })).toThrow(
    "SLACK_CONFIGURATION_INVALID",
  );
  expect(readSlackConfig({ SLACK_BOT_TOKEN: "xoxb-fixture", SLACK_CHANNEL_ID: "C123ABC" })).toEqual(
    { token: "xoxb-fixture", channel: "C123ABC" },
  );
});
it("writes JSON and sends only safe fields with recovery guidance, deduplicating replays", async () => {
  const lines: string[] = [];
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
  const observe = createBatchObserver({
    slack: { token: "fixture-private-token", channel: "C123ABC" },
    write: (line) => lines.push(line),
    fetcher,
  });
  await observe({
    ...incident,
    prompt: "private-prompt",
    error: "private-error",
  } as typeof incident);
  await observe({ ...incident, requestId: "00000000-0000-4000-8000-000000000002" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe("https://slack.com/api/chat.postMessage");
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(init?.redirect).toBe("error");
  expect(String(init?.body)).toContain("自動再送しない");
  expect(String(init?.body)).toContain(incident.operationKey);
  expect(lines.map((line) => JSON.parse(line))).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ level: "error", service: "collector", event: "stage_finished" }),
    ]),
  );
  expect(lines.join("")).not.toMatch(/private/);
  expect(String(init?.body)).not.toMatch(/private/);
});
it.each([
  Response.json({ ok: false, error: "private-error" }),
  new Response("private-body", { status: 429, headers: { "Retry-After": "60" } }),
])(
  "logs Slack failure without retrying or exposing response and can retry next incident",
  async (response) => {
    const lines: string[] = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response)
      .mockResolvedValue(Response.json({ ok: true }));
    const observe = createBatchObserver({
      slack: { token: "private", channel: "C123ABC" },
      write: (line) => lines.push(line),
      fetcher,
    });
    await expect(observe(incident)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(lines.join("")).toContain("slack_notification_failed");
    expect(lines.join("")).not.toContain("private");
    await observe(incident);
    expect(fetcher).toHaveBeenCalledTimes(response.status === 429 ? 1 : 2);
  },
);
it("keeps routine quota waits and successes log-only and isolates logging failure", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const observe = createBatchObserver({
    slack: { token: "private", channel: "C123ABC" },
    write: () => {
      throw new Error("private");
    },
    fetcher,
  });
  await observe({ ...incident, status: "succeeded", errorCode: undefined });
  await observe({ ...incident, status: "waiting", errorCode: "GEMINI_RATE_LIMITED" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("contains network errors and holds concurrent duplicate deliveries", async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("private"));
  const observe = createBatchObserver({
    slack: { token: "private", channel: "C123ABC" },
    write: () => {},
    fetcher,
  });
  await Promise.all([observe(incident), observe(incident)]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("expires dedup entries and respects Slack Retry-After before subsequent notifications", async () => {
  let time = Date.now();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "60" } }))
    .mockImplementation(async () => Response.json({ ok: true }));
  const observe = createBatchObserver({
    slack: { token: "private", channel: "C123ABC" },
    write: () => {},
    fetcher,
    now: () => time,
  });
  await observe(incident);
  time += 59000;
  await observe(incident);
  expect(fetcher).toHaveBeenCalledTimes(1);
  time += 1000;
  await observe(incident);
  await observe(incident);
  expect(fetcher).toHaveBeenCalledTimes(2);
  time += 300000;
  await observe(incident);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("alerts infrastructure waits, partial job failures and runtime config errors", async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ok: true }));
  const observe = createBatchObserver({
    slack: { token: "private", channel: "C123ABC" },
    write: () => {},
    fetcher,
  });
  await observe({ ...incident, status: "waiting", errorCode: "GATE_UNAVAILABLE" });
  await observe({ ...incident, stage: "job-finalize", status: "succeeded", failedCount: 2 });
  await observe({ event: "runtime_failed", errorCode: "NODE_CONFIGURATION_INVALID" });
  await observe({ event: "runtime_failed", errorCode: "NODE_EXECUTION_DISABLED" });
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("aborts a stalled Slack request and records failure without failing the batch", async () => {
  const lines: string[] = [];
  let signal: AbortSignal | undefined;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    signal = init!.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new Error("private-transport-error")), {
        once: true,
      });
    });
  });
  const observe = createBatchObserver({
    slack: { token: "private", channel: "C123ABC" },
    write: (line) => lines.push(line),
    fetcher,
  });
  await expect(observe(incident)).resolves.toBeUndefined();
  expect(signal?.aborted).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(lines.join("")).toContain("slack_notification_failed");
  expect(lines.join("")).not.toContain("private");
});
