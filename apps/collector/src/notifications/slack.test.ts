import { describe, expect, it, vi } from "vitest";

import { buildSlackMessage, notifyCollector } from "./slack.js";

const environment = {
  COLLECTOR_DRY_RUN: "false",
  DEBUG: "false",
  SLACK_NOTIFICATIONS_ENABLED: "true",
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/test/example/secret",
  TRIGGER_RUN_URL_TEMPLATE: "https://trigger.example/runs/{runId}",
};
const context = { attemptNumber: 2, environment: "production", runId: "run_test" };
const report = {
  durationMs: 2500,
  issues: [],
  metricsFailedCount: 0,
  skippedDuplicateCount: 2,
};
const result = {
  articleCount: 3,
  dryRun: false,
  failedCount: 0,
  failedFeedCount: 0,
  feedCount: 2,
  successfulFeedCount: 2,
  notificationReport: report,
};

describe("collector Slack notifications", () => {
  it.each([result, { ...result, failedCount: 1 }, undefined])(
    "mentions the configured user for every notification outcome: %o",
    async (outcome) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
      await notifyCollector(
        { context, ...(outcome ? { result: outcome } : {}), report },
        {
          environment: { ...environment, SLACK_MENTION_USER_ID: " U012AB3CD " },
          fetcher,
          logger: { warn: vi.fn() },
        },
      );
      const payload = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
      expect(payload.text).toMatch(/^<@U012AB3CD>\n/);
    },
  );

  it.each([undefined, "", " ", "<!channel>", "U123><!channel", "U123\nU456", "S012AB3CD"])(
    "omits missing or invalid mention IDs without suppressing the message: %s",
    (id) => {
      const text = buildSlackMessage(
        { context, result, report },
        { ...environment, SLACK_MENTION_USER_ID: id },
      );
      expect(text).toMatch(/^✅ ニュース収集バッチ完了\n/);
      expect(text).not.toContain("<@");
      expect(text).not.toContain("<!channel>");
    },
  );

  it("formats successful results with counts, duration, context and a run link", () => {
    const text = buildSlackMessage({ context, result, report }, environment);
    expect(text).toContain("✅ ニュース収集バッチ完了");
    expect(text).toContain("処理成功: 3件");
    expect(text).toContain("重複スキップ: 2件");
    expect(text).toContain("所要時間: 2.5秒");
    expect(text).toContain("production");
    expect(text).toContain("https://trigger.example/runs/run_test");
  });

  it("separates article failures from feed failures and includes metrics warnings", () => {
    const text = buildSlackMessage(
      {
        context,
        result: { ...result, failedCount: 3, failedFeedCount: 1 },
        report: {
          ...report,
          metricsFailedCount: 1,
          issues: [{ stage: "summarize", kind: "rate_limit", httpStatus: 429, feed: "Zenn" }],
        },
      },
      environment,
    );
    expect(text).toContain("⚠️");
    expect(text).toContain("記事失敗: 2件");
    expect(text).toContain("feed取得失敗: 1件");
    expect(text).toContain("指標更新失敗: 1件");
    expect(text).toContain("Gemini要約 / Zenn / リクエスト上限超過 / HTTP 429");
  });

  it("posts a JSON payload without enabling mention parsing", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const logger = { warn: vi.fn() };
    await notifyCollector({ context, result, report }, { environment, fetcher, logger });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(environment.SLACK_WEBHOOK_URL);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      text: expect.stringContaining("✅"),
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    { SLACK_NOTIFICATIONS_ENABLED: "false" },
    { SLACK_NOTIFICATIONS_ENABLED: undefined },
    { SLACK_WEBHOOK_URL: undefined },
    { DEBUG: "true" },
    { DEBUG: "yes" },
    { COLLECTOR_DRY_RUN: "true" },
    { COLLECTOR_DRY_RUN: undefined },
    { SLACK_NOTIFICATIONS_ENABLED: "invalid" },
    { DEBUG: "invalid" },
  ])("suppresses notifications for disabled/debug/dry-run settings: %o", async (override) => {
    const fetcher = vi.fn<typeof fetch>();
    await notifyCollector(
      { context, result, report },
      {
        environment: { ...environment, ...override },
        fetcher,
        logger: { warn: vi.fn() },
      },
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("suppresses dry-run results even when environment settings say production", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await notifyCollector(
      { context, result: { ...result, dryRun: true }, report },
      {
        environment,
        fetcher,
        logger: { warn: vi.fn() },
      },
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retries transient failures with a bound and keeps transport secrets out of logs", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(environment.SLACK_WEBHOOK_URL));
    const logger = { warn: vi.fn() };
    const sleep = vi.fn(async () => undefined);
    await expect(
      notifyCollector({ context, report }, { environment, fetcher, logger, sleep }),
    ).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("/services/");
  });

  it("does not retry permanent errors or log response bodies", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private response", { status: 403 }));
    const logger = { warn: vi.fn() };
    await notifyCollector({ context, report }, { environment, fetcher, logger });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private response");
  });

  it("honors a short Retry-After and stops when Slack requests a longer delay", async () => {
    const sleep = vi.fn(async () => undefined);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("rate limited", { status: 429, headers: { "retry-after": "2" } }),
      )
      .mockResolvedValueOnce(new Response("ok"));
    await notifyCollector(
      { context, report },
      { environment, fetcher, sleep, logger: { warn: vi.fn() } },
    );
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher
      .mockClear()
      .mockResolvedValue(
        new Response("rate limited", { status: 429, headers: { "retry-after": "60" } }),
      );
    sleep.mockClear();
    await notifyCollector(
      { context, report },
      { environment, fetcher, sleep, logger: { warn: vi.fn() } },
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("escapes Slack markup in feed names to prevent mentions and injected links", () => {
    const text = buildSlackMessage(
      {
        context,
        report: {
          ...report,
          issues: [
            { stage: "feed_fetch", kind: "unknown", feed: "<!channel><https://example.com|click>" },
          ],
        },
      },
      environment,
    );
    expect(text).not.toContain("<!channel>");
    expect(text).toContain("&lt;!channel&gt;");
  });

  it.each([
    "http://localhost/internal",
    "not a URL",
    "https://hooks.slack.com.evil.example/services/test",
  ])("rejects invalid destinations without affecting the task: %s", async (url) => {
    const fetcher = vi.fn<typeof fetch>();
    await notifyCollector(
      { context, report },
      {
        environment: { ...environment, SLACK_WEBHOOK_URL: url },
        fetcher,
        logger: { warn: vi.fn() },
      },
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
