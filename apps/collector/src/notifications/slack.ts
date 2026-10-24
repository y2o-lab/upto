import { z } from "zod";

import type { RunCollectorResult } from "../run-collector.js";
import type { CollectorIssue, CollectorReport } from "./collector-report.js";

import { collectorConfigSchema } from "../config.js";

type NotificationContext = { attemptNumber: number; environment: string; runId: string };
export type CollectorNotification = {
  context: NotificationContext;
  result?: RunCollectorResult;
  report: CollectorReport;
};
type Dependencies = {
  environment?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  logger: { warn(message: string, attributes?: Record<string, unknown>): void };
  sleep?: (ms: number) => Promise<void>;
};
const stages: Record<CollectorIssue["stage"], string> = {
  execution: "バッチ実行",
  feed_job: "feedジョブ記録",
  feed_fetch: "feed取得",
  article_lookup: "記事検索",
  extract: "本文抽出",
  summarize: "Gemini要約",
  persist: "記事保存",
  metrics_update: "指標更新",
};
const reasons: Record<CollectorIssue["kind"], string> = {
  rate_limit: "リクエスト上限超過",
  unauthorized: "認証・権限エラー",
  upstream: "接続先サービス障害",
  http: "HTTPエラー",
  database: "DBエラー",
  network: "接続エラー",
  timeout: "タイムアウト",
  validation: "設定・データの検証エラー",
  configuration: "必須設定不足",
  all_feeds_failed: "全feed取得失敗",
  unknown: "未分類の処理エラー",
};

function escapeSlack(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function buildSlackMessage(
  input: CollectorNotification,
  environment: NodeJS.ProcessEnv,
): string {
  const { context, result, report } = input;
  const warning = (result?.failedCount ?? 0) > 0 || report.metricsFailedCount > 0;
  const title = !result
    ? "🚨 ニュース収集バッチ失敗（リトライ終了）"
    : warning
      ? "⚠️ ニュース収集バッチ完了（一部失敗）"
      : "✅ ニュース収集バッチ完了";
  const lines = [
    title,
    `環境: ${escapeSlack(context.environment)} / 試行: ${context.attemptNumber}`,
    `run ID: ${escapeSlack(context.runId)}`,
    `所要時間: ${(report.durationMs / 1000).toFixed(1)}秒（最終試行）`,
  ];
  if (result)
    lines.push(
      `処理成功: ${result.articleCount}件 / 重複スキップ: ${report.skippedDuplicateCount}件`,
      `feed取得成功: ${result.successfulFeedCount}/${result.feedCount} / feed取得失敗: ${result.failedFeedCount}件`,
      `記事失敗: ${Math.max(0, result.failedCount - result.failedFeedCount)}件 / 指標更新失敗: ${report.metricsFailedCount}件`,
    );
  for (const issue of report.issues) {
    lines.push(
      `・${stages[issue.stage]}${issue.feed ? ` / ${escapeSlack(issue.feed)}` : ""} / ${reasons[issue.kind]}${issue.httpStatus ? ` / HTTP ${issue.httpStatus}` : ""}`,
    );
  }
  if (report.issues.length === 10) lines.push("エラー詳細は最大10件です。");
  const template = environment.TRIGGER_RUN_URL_TEMPLATE;
  if (template?.includes("{runId}")) {
    try {
      const url = new URL(template.replaceAll("{runId}", encodeURIComponent(context.runId)));
      if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password)
        lines.push(`<${escapeSlack(url.href)}|Trigger.devで実行詳細を確認>`);
    } catch {
      /* An optional dashboard link must not prevent notification. */
    }
  }
  return lines.join("\n");
}

const webhookSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "hooks.slack.com" &&
      url.pathname.startsWith("/services/") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !url.port
    );
  } catch {
    return false;
  }
});

function notificationsEnabled(environment: NodeJS.ProcessEnv): boolean {
  // Collector's boolean transform throws for invalid strings. Invalid optional
  // notification settings must never turn an otherwise successful run into an error.
  try {
    return (
      collectorConfigSchema.shape.debug.parse(environment.SLACK_NOTIFICATIONS_ENABLED) &&
      !collectorConfigSchema.shape.debug.parse(environment.DEBUG) &&
      !collectorConfigSchema.shape.dryRun.parse(environment.COLLECTOR_DRY_RUN)
    );
  } catch {
    return false;
  }
}

export async function notifyCollector(
  input: CollectorNotification,
  dependencies: Dependencies,
): Promise<void> {
  const environment = dependencies.environment ?? process.env;
  if (!notificationsEnabled(environment) || input.result?.dryRun) return;
  if (!environment.SLACK_WEBHOOK_URL) {
    dependencies.logger.warn("Slack notification skipped: webhook is not configured");
    return;
  }
  const webhook = webhookSchema.safeParse(environment.SLACK_WEBHOOK_URL);
  if (!webhook.success) {
    dependencies.logger.warn("Slack notification skipped: invalid webhook configuration");
    return;
  }
  const fetcher = dependencies.fetcher ?? fetch;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const body = JSON.stringify({
    text: buildSlackMessage(input, environment),
    unfurl_links: false,
    unfurl_media: false,
  });
  let httpStatus: number | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetcher(webhook.data, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      httpStatus = response.status;
      await response.body?.cancel();
      if (response.ok) return;
      if (response.status !== 429 && response.status < 500) break;
      const retryAfter = Number(response.headers.get("retry-after") ?? "1");
      // Do not hold the task open for an unbounded server-requested delay.
      if (!Number.isFinite(retryAfter) || retryAfter < 0 || retryAfter > 5) break;
      if (attempt === 0) await sleep(Math.max(1000, retryAfter * 1000));
    } catch {
      if (attempt === 0) await sleep(1000);
    }
  }
  dependencies.logger.warn("Slack notification delivery failed", {
    runId: input.context.runId,
    ...(httpStatus ? { httpStatus } : {}),
  });
}
