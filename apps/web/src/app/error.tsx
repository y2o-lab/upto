"use client";

import { useEffect } from "react";

import { logError } from "../lib/logging";

export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    logError("Failed to render the article feed", error);
  }, [error]);

  return (
    <main className="min-h-screen px-4">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center">
        <p className="text-sm font-medium text-[var(--accent)]">Upto</p>
        <h1 className="mt-3 text-3xl leading-tight font-semibold">記事を読み込めませんでした</h1>
        <p className="mt-5 max-w-xl leading-7 text-[var(--muted)]">
          時間をおいて再読み込みしてください。問題が続く場合は運用ログを確認してください。
        </p>
        <button
          className="mt-7 w-fit rounded-md bg-[var(--foreground)] px-4 py-2.5 text-sm font-medium text-white"
          onClick={retry}
          type="button"
        >
          再読み込み
        </button>
      </div>
    </main>
  );
}
