import { z } from "zod";

// Allowlisted metadata only: never serialize errors, requests, URLs, prompts or config.
const recordSchema = z.object({
  event: z.enum([
    "stage_started",
    "stage_finished",
    "request_failed",
    "runtime_failed",
    "gate_report_failed",
  ]),
  environment: z.enum(["staging", "production"]).optional(),
  requestId: z.uuid().optional(),
  jobId: z.uuid().optional(),
  workId: z.uuid().optional(),
  generationId: z.uuid().optional(),
  operationKey: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  stage: z
    .enum([
      "discovery",
      "extract",
      "summarize-chunk",
      "merge-summary",
      "persist",
      "job-finalize",
      "prepare",
      "operation-status",
      "manifests",
    ])
    .optional(),
  executorVersion: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
  configVersion: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
  apiAttempt: z.number().int().min(1).max(3).optional(),
  status: z
    .enum(["started", "succeeded", "running", "waiting", "failed", "uncertain", "not_found"])
    .optional(),
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .optional(),
  causeCode: z
    .enum([
      "DATABASE_CONNECTION_FAILED",
      "DATABASE_CAPACITY_EXHAUSTED",
      "DATABASE_STATEMENT_TIMEOUT",
      "DATABASE_CONSTRAINT_FAILED",
      "NETWORK_FAILURE",
      "UNKNOWN_FAILURE",
    ])
    .optional(),
  durationMs: z.number().nonnegative().optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  retryable: z.boolean().optional(),
  replay: z.boolean().optional(),
  nextEligibleAt: z.iso.datetime({ offset: true }).optional(),
  failedCount: z.number().int().nonnegative().optional(),
  cancelledCount: z.number().int().nonnegative().optional(),
});
export type BatchLogRecord = z.input<typeof recordSchema>;
export type BatchObserver = (record: BatchLogRecord) => Promise<void>;
export type SlackConfig = { token: string; channel: string; mentionIds?: string[] };
export function readSlackConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SlackConfig | undefined {
  const token = environment.SLACK_BOT_TOKEN?.trim();
  const channel = environment.SLACK_CHANNEL_ID?.trim();
  if (!token && !channel) return undefined;
  if (
    !token ||
    !channel ||
    !/^xoxb-[A-Za-z0-9-]+$/.test(token) ||
    !/^[CG][A-Z0-9]{5,63}$/.test(channel)
  )
    throw new Error("SLACK_CONFIGURATION_INVALID");
  const mentions = environment.SLACK_MENTION_IDS?.trim();
  if (!mentions) return { token, channel };
  const parsed = z
    .array(z.string().regex(/^[UWS][A-Z0-9]{5,63}$/))
    .safeParse(mentions.split(",").map((id) => id.trim()));
  if (!parsed.success) throw new Error("SLACK_CONFIGURATION_INVALID");
  return { token, channel, mentionIds: [...new Set(parsed.data)] };
}
const infrastructureWaits = new Set([
  "TOKEN_COUNT_UNAVAILABLE",
  "GATE_UNAVAILABLE",
  "GATE_CONSUME_UNKNOWN",
]);
function incident(record: BatchLogRecord): boolean {
  if (record.event === "runtime_failed") return record.errorCode !== "NODE_EXECUTION_DISABLED";
  if (record.event === "gate_report_failed") return true;
  if (record.event === "request_failed")
    return (
      record.httpStatus !== undefined &&
      (record.httpStatus >= 500 || record.errorCode === "REQUEST_DEADLINE_EXCEEDED")
    );
  return (
    (record.stage === "job-finalize" && record.errorCode !== undefined) ||
    record.status === "failed" ||
    record.status === "uncertain" ||
    (record.status === "waiting" && infrastructureWaits.has(record.errorCode ?? "")) ||
    (record.failedCount ?? 0) > 0 ||
    (record.cancelledCount ?? 0) > 0
  );
}
function recovery(record: BatchLogRecord): string {
  if (record.errorCode?.includes("UNKNOWN") || record.status === "uncertain")
    return "生成・送信結果が不明。自動再送しない。operation-statusとPG operation/generation/attemptを照合し、保存済み結果・送信記録を確認する。manual resume入口は未実装。";
  if (record.event === "runtime_failed")
    return "環境変数・deployment設定を確認し、修正後に新しい署名requestで再開する。";
  if (record.stage === "job-finalize")
    return "jobの失敗・cancelled workを確認し、保存済みresultと集計を照合する。状態を一括resetしない。";
  if (record.stage === "discovery")
    return "feed取得・解析と接続状況を確認する。他feedの処理は継続可能。";
  if (record.status === "waiting" || record.event === "gate_report_failed")
    return "Gemini/gateの接続・quotaとPG記録を確認する。nextEligibleAtと制御側の再試行に従う。";
  return "requestIdで実行ログを検索し、operation-statusとPGの保存済みresult・所有権・送信記録を確認する。成功済み結果を再利用し、送信不明は再送しない。";
}
export function createBatchObserver(
  options: {
    slack?: SlackConfig;
    write?: (line: string) => void;
    fetcher?: typeof fetch;
    now?: () => number;
  } = {},
): BatchObserver {
  const write = options.write ?? ((line) => console.log(line));
  const now = options.now ?? Date.now;
  const fetcher = options.fetcher ?? fetch;
  const delivered = new Map<string, number>();
  const pending = new Set<string>();
  let rateLimitedUntil = 0;
  function log(record: Record<string, unknown>, level: string) {
    try {
      write(
        JSON.stringify({
          timestamp: new Date(now()).toISOString(),
          level,
          service: "collector",
          ...record,
        }),
      );
    } catch {
      /* Telemetry cannot change the batch outcome. */
    }
  }
  return async (input) => {
    const parsed = recordSchema.safeParse(input);
    if (!parsed.success) {
      log({ event: "log_record_invalid" }, "warn");
      return;
    }
    const record = parsed.data;
    const alert = incident(record);
    log(
      record,
      alert || record.status === "failed" || record.status === "uncertain"
        ? "error"
        : record.status === "waiting"
          ? "warn"
          : "info",
    );
    if (!alert || !options.slack) return;
    const key = [
      record.environment,
      record.operationKey ?? record.jobId ?? record.event,
      record.stage,
      record.errorCode ?? record.status,
    ].join(":");
    for (const [id, expiry] of delivered) if (expiry <= now()) delivered.delete(id);
    if (pending.has(key) || (delivered.get(key) ?? 0) > now()) return;
    if (now() < rateLimitedUntil || pending.size >= 4) {
      log(
        {
          event: "slack_notification_deferred",
          requestId: record.requestId,
          errorCode: "SLACK_CAPACITY_LIMIT",
        },
        "warn",
      );
      return;
    }
    pending.add(key);
    try {
      const mentions = (options.slack.mentionIds ?? [])
        .map((id) => (id.startsWith("S") ? `<!subteam^${id}>` : `<@${id}>`))
        .join(" ");
      const text = `collector 障害通知\n${JSON.stringify(record)}\n初動: ${recovery(record)}`;
      const escapedText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const response = await fetcher("https://slack.com/api/chat.postMessage", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(3000),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.slack.token}`,
        },
        body: JSON.stringify({
          channel: options.slack.channel,
          text: mentions ? `${mentions}\n${escapedText}` : text,
          mrkdwn: Boolean(mentions),
          parse: "none",
          link_names: false,
          unfurl_links: false,
          unfurl_media: false,
        }),
      });
      if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after"));
        rateLimitedUntil =
          now() + (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 60) * 1000;
      }
      const payload = response.ok ? await response.json() : null;
      if (!response.ok || !z.object({ ok: z.literal(true) }).safeParse(payload).success)
        throw new Error("SLACK_DELIVERY_FAILED");
      if (delivered.size >= 1000) delivered.delete(delivered.keys().next().value!);
      delivered.set(key, now() + 300000);
      log(
        {
          event: "slack_notification_sent",
          requestId: record.requestId,
          operationKey: record.operationKey,
        },
        "info",
      );
    } catch {
      log(
        {
          event: "slack_notification_failed",
          requestId: record.requestId,
          operationKey: record.operationKey,
          errorCode: "SLACK_DELIVERY_FAILED",
        },
        "error",
      );
    } finally {
      pending.delete(key);
    }
  };
}
