import { NextResponse } from "next/server";
import { z } from "zod";

import { getArticlesByIds, getArticlesPage } from "../../../lib/articles";
import { logError } from "../../../lib/logging";

type ArticleApiErrorCode =
  | "internal_error"
  | "invalid_cursor"
  | "invalid_request"
  | "invalid_snapshot";

const errorMessages = {
  internal_error: "記事の読み込みに失敗しました",
  invalid_cursor: "ページ指定が不正です",
  invalid_request: "記事一覧のリクエストが不正です",
  invalid_snapshot: "取得基準日時が不正です",
} satisfies Record<ArticleApiErrorCode, string>;

const searchParamsSchema = z.object({
  cursor: z.string().min(1).nullable(),
  limit: z.coerce.number().int().min(1).max(30).default(10),
  snapshotAt: z.string().nullable(),
});

const snapshotAtSchema = z.string().datetime();
const savedArticleIdsSchema = z.array(z.string().uuid()).min(1).max(100);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const savedArticleIds = url.searchParams.get("ids");

  if (savedArticleIds !== null) {
    const parsedArticleIds = savedArticleIdsSchema.safeParse(savedArticleIds.split(","));
    if (!parsedArticleIds.success) {
      return articleApiError("invalid_request", 400);
    }

    try {
      const articles = await getArticlesByIds(parsedArticleIds.data);
      return NextResponse.json({ articles }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      logError("Failed to fetch saved articles", error);
      return articleApiError("internal_error", 500);
    }
  }

  const parsedParams = searchParamsSchema.safeParse({
    cursor: url.searchParams.get("cursor"),
    limit: url.searchParams.get("limit") ?? undefined,
    snapshotAt: url.searchParams.get("snapshotAt"),
  });

  if (!parsedParams.success) {
    return articleApiError("invalid_request", 400);
  }

  if (
    parsedParams.data.snapshotAt !== null &&
    !snapshotAtSchema.safeParse(parsedParams.data.snapshotAt).success
  ) {
    return articleApiError("invalid_snapshot", 400);
  }

  try {
    const page = await getArticlesPage(parsedParams.data);
    return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch articles";

    if (message === "Invalid article page cursor") {
      return articleApiError("invalid_cursor", 400);
    }

    if (message === "Invalid article page snapshot") {
      return articleApiError("invalid_snapshot", 400);
    }

    logError("Failed to fetch article page", error);
    return articleApiError("internal_error", 500);
  }
}

function articleApiError(code: ArticleApiErrorCode, status: 400 | 500) {
  return NextResponse.json(
    {
      error: {
        code,
        message: errorMessages[code],
      },
    },
    { headers: { "Cache-Control": "no-store" }, status },
  );
}
