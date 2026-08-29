import { afterEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const { getArticlesByIdsMock, getArticlesPageMock } = vi.hoisted(() => ({
  getArticlesByIdsMock: vi.fn(),
  getArticlesPageMock: vi.fn(),
}));

vi.mock("../../../lib/articles", () => ({
  getArticlesByIds: getArticlesByIdsMock,
  getArticlesPage: getArticlesPageMock,
}));

describe("GET /api/articles", () => {
  afterEach(() => {
    getArticlesPageMock.mockReset();
    getArticlesByIdsMock.mockReset();
    vi.restoreAllMocks();
  });

  it("returns the requested saved articles", async () => {
    const articleIds = [
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ];
    getArticlesByIdsMock.mockResolvedValueOnce([{ id: articleIds[0] }]);

    const response = await GET(
      new Request(`http://localhost/api/articles?ids=${articleIds.join(",")}`),
    );

    await expect(response.json()).resolves.toEqual({ articles: [{ id: articleIds[0] }] });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(getArticlesByIdsMock).toHaveBeenCalledWith(articleIds);
    expect(getArticlesPageMock).not.toHaveBeenCalled();
  });

  it("rejects malformed saved article IDs", async () => {
    const response = await GET(new Request("http://localhost/api/articles?ids=not-a-uuid"));

    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_request",
      },
    });
    expect(response.status).toBe(400);
    expect(getArticlesByIdsMock).not.toHaveBeenCalled();
  });

  it("returns invalid_request for invalid query parameters without calling article loading", async () => {
    const response = await GET(new Request("http://localhost/api/articles?limit=100"));

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "記事一覧のリクエストが不正です",
      },
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(getArticlesPageMock).not.toHaveBeenCalled();
  });

  it("returns invalid_cursor without exposing the internal exception message", async () => {
    getArticlesPageMock.mockRejectedValueOnce(new Error("Invalid article page cursor"));

    const response = await GET(new Request("http://localhost/api/articles?cursor=bad"));

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_cursor",
        message: "ページ指定が不正です",
      },
    });
    expect(response.status).toBe(400);
  });

  it("returns invalid_snapshot without exposing the internal exception message", async () => {
    getArticlesPageMock.mockRejectedValueOnce(new Error("Invalid article page snapshot"));

    const response = await GET(
      new Request("http://localhost/api/articles?snapshotAt=2026-06-16T00:00:00.000Z"),
    );

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_snapshot",
        message: "取得基準日時が不正です",
      },
    });
    expect(response.status).toBe(400);
  });

  it("returns invalid_snapshot for malformed snapshotAt query parameters", async () => {
    const response = await GET(new Request("http://localhost/api/articles?snapshotAt=not-a-date"));

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_snapshot",
        message: "取得基準日時が不正です",
      },
    });
    expect(response.status).toBe(400);
    expect(getArticlesPageMock).not.toHaveBeenCalled();
  });

  it("returns invalid_snapshot for empty snapshotAt query parameters", async () => {
    const response = await GET(new Request("http://localhost/api/articles?snapshotAt="));

    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invalid_snapshot",
      },
    });
    expect(response.status).toBe(400);
    expect(getArticlesPageMock).not.toHaveBeenCalled();
  });

  it("logs internal failures and returns a fixed internal_error response", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    getArticlesPageMock.mockRejectedValueOnce(
      new Error("connection failed postgres://secret@example/db"),
    );

    const response = await GET(new Request("http://localhost/api/articles"));

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "internal_error",
        message: "記事の読み込みに失敗しました",
      },
    });
    expect(response.status).toBe(500);
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to fetch article page",
      expect.objectContaining({ message: "connection failed postgres://secret@example/db" }),
    );
  });
});
