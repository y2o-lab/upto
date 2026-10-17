import { expect, test, type Page } from "@playwright/test";

const firstArticleId = "00000000-0000-4000-8000-000000000002";
const secondArticleId = "00000000-0000-4000-8000-000000000001";

async function readArticleIds(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open("upto_user_state");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction("read_articles", "readonly");
          const records = transaction.objectStore("read_articles").getAllKeys();
          records.onsuccess = () => {
            db.close();
            resolve(records.result.map(String));
          };
          records.onerror = () => {
            db.close();
            reject(records.error);
          };
        };
      }),
  );
}

async function openFeed(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("article-feed")).toHaveAttribute("data-ready", "true");
}

async function openFeedWithPausedClock(page: Page) {
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await page.goto("/");
  // Advance animation frames so hydration and progress restoration can finish.
  await expect
    .poll(
      async () => {
        await page.clock.runFor(50);
        return page.evaluate(() =>
          document.querySelector('[data-testid="article-feed"]')?.getAttribute("data-ready"),
        );
      },
      { intervals: [10] },
    )
    .toBe("true");
}

test("marks an article read only after the one-second dwell threshold", async ({ page }) => {
  await openFeedWithPausedClock(page);
  await page.clock.runFor(800);
  expect(await readArticleIds(page)).not.toContain(firstArticleId);
  await page.clock.runFor(250);
  await expect.poll(() => readArticleIds(page)).toContain(firstArticleId);
});

test("cancels the previous article's dwell timer and starts a fresh timer after navigation", async ({
  page,
}) => {
  await openFeedWithPausedClock(page);
  await page.clock.runFor(400);
  await page.keyboard.press("ArrowDown");
  await page.clock.runFor(500);
  await expect(page.locator("article[data-index='1'] h2")).toBeInViewport();
  expect(await readArticleIds(page)).not.toContain(firstArticleId);
  expect(await readArticleIds(page)).not.toContain(secondArticleId);
  await page.clock.runFor(600);
  await expect.poll(() => readArticleIds(page)).toContain(secondArticleId);
  expect(await readArticleIds(page)).not.toContain(firstArticleId);
});

test("supports Space and ArrowUp and keeps backward navigation at the first card", async ({
  page,
}) => {
  await openFeed(page);
  const feed = page.getByTestId("article-feed");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Shift+Space");
  await expect.poll(() => feed.evaluate((element) => element.scrollTop)).toBe(0);
  await page.keyboard.press("Space");
  await expect(page.locator("article[data-index='1'] h2")).toBeInViewport();
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("article[data-index='0'] h2")).toBeInViewport();
  await expect.poll(() => feed.evaluate((element) => element.scrollTop)).toBe(0);
});

test("keeps forward navigation at the terminal card and returns to the first card", async ({
  page,
}) => {
  await openFeed(page);
  await page.locator("article[data-index='8']").scrollIntoViewIfNeeded();
  await expect(page.getByRole("heading", { name: "fixture pagination article 12" })).toBeAttached();
  await page.getByTestId("feed-complete").scrollIntoViewIfNeeded();
  const feed = page.getByTestId("article-feed");
  await expect(page.getByText("完了", { exact: true })).toBeVisible();
  const terminalTop = await feed.evaluate((element) => element.scrollTop);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await expect(page.getByTestId("feed-complete")).toBeInViewport();
  await expect.poll(() => feed.evaluate((element) => element.scrollTop)).toBe(terminalTop);
  await page.getByRole("button", { name: "先頭へ戻る" }).click();
  await expect(page.locator("article[data-index='0'] h2")).toBeInViewport();
  await expect.poll(() => feed.evaluate((element) => element.scrollTop)).toBe(0);
});

test("opens the original article in a new tab and immediately records it as read", async ({
  page,
  context,
}) => {
  await openFeedWithPausedClock(page);
  const original = page
    .locator("article[data-index='0']")
    .getByRole("link", { name: "元記事を読む" });
  const href = await original.getAttribute("href");
  expect(href).toBe("https://qiita.com/example/items/collector");
  await expect(original).toHaveAttribute("target", "_blank");
  await expect(original).toHaveAttribute("rel", /noreferrer/);
  // Keep this test local and deterministic instead of loading an external publisher.
  await context.route(href!, (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Original article</h1>" }),
  );
  const popupPromise = page.waitForEvent("popup");
  await original.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(href!);
  await expect(popup.getByRole("heading", { name: "Original article" })).toBeVisible();
  await expect.poll(() => readArticleIds(page)).toContain(firstArticleId);
  await expect(page).toHaveURL("/");
  await popup.close();
});

test("shows an empty saved list on direct access and returns to the news feed", async ({
  page,
}) => {
  await page.goto("/bookmarks");
  await expect(page.getByTestId("bookmarks-empty")).toBeVisible();
  await expect(page.getByRole("heading", { name: "保存した記事はありません" })).toBeVisible();
  await page.getByRole("link", { name: "新着記事" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByTestId("article-feed")).toHaveAttribute("data-ready", "true");
});

test("loads multiple saved articles newest first after direct access and reload", async ({
  page,
}) => {
  await openFeedWithPausedClock(page);
  const firstTitle = await page.locator("article[data-index='0'] h2").textContent();
  const secondTitle = await page.locator("article[data-index='1'] h2").textContent();
  await page.getByTestId("save-article-0").click();
  await expect(page.getByTestId("save-article-0")).toHaveAttribute("data-saved", "true");
  await page.clock.runFor(100);
  await page.keyboard.press("ArrowDown");
  await page.clock.runFor(500);
  await page.getByTestId("save-article-1").click();
  await expect(page.getByTestId("save-article-1")).toHaveAttribute("data-saved", "true");
  await page.clock.resume();
  await page.goto("/bookmarks");
  await expect(page.getByTestId("article-feed")).toHaveAttribute("data-ready", "true");
  await expect(page.locator('article[data-testid^="article-card-"] h2')).toHaveText([
    secondTitle!,
    firstTitle!,
  ]);
  await page.reload();
  await expect(page.locator('article[data-testid^="article-card-"] h2')).toHaveText([
    secondTitle!,
    firstTitle!,
  ]);
  await page.getByTestId("save-article-0").click();
  await expect(page.locator('article[data-testid^="article-card-"] h2')).toHaveText([firstTitle!]);
});

test("shows saved article loading, failure, and successful retry", async ({ page }) => {
  await openFeed(page);
  const savedTitle = await page.locator("article[data-index='0'] h2").textContent();
  await page.getByTestId("save-article-0").click();
  await expect(page.getByTestId("save-article-0")).toHaveAttribute("data-saved", "true");
  let requests = 0;
  let failRequest!: () => void;
  const failureGate = new Promise<void>((resolve) => {
    failRequest = resolve;
  });
  await page.route("**/api/articles?ids=*", async (route) => {
    requests += 1;
    if (requests === 1) {
      await failureGate;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "internal_error" } }),
      });
    } else {
      await route.fallback();
    }
  });
  try {
    await page.goto("/bookmarks");
    await expect(
      page.getByRole("heading", { name: "保存した記事を読み込んでいます" }),
    ).toBeVisible();
    failRequest();
    await expect(
      page.getByRole("heading", { name: "保存した記事を読み込めませんでした" }),
    ).toBeVisible();
    await expect(page.getByTestId("bookmarks-empty")).toHaveCount(0);
    await page.getByRole("button", { name: "再試行" }).click();
    await expect(page.getByTestId("article-feed")).toHaveAttribute("data-ready", "true");
    await expect(page.locator("article[data-index='0'] h2")).toHaveText(savedTitle!);
    expect(requests).toBe(2);
  } finally {
    failRequest();
  }
});

test("swipes forward and backward with native touch input and snaps to card boundaries", async ({
  page,
  context,
  isMobile,
}) => {
  test.skip(!isMobile, "Touch gestures are covered by the mobile Chromium project.");
  await openFeed(page);
  const feed = page.getByTestId("article-feed");
  const box = await feed.boundingBox();
  expect(box).not.toBeNull();
  const { x, y, width, height } = box!;
  const session = await context.newCDPSession(page);
  async function swipe(forward: boolean) {
    const start = y + height * (forward ? 0.85 : 0.15);
    const distance = height * (forward ? -0.65 : 0.65);
    const point = (position: number) => [{ x: x + width / 2, y: position }];
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: point(start),
    });
    for (let step = 1; step <= 16; step += 1) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: point(start + (distance * step) / 16),
      });
      await page.waitForTimeout(16);
    }
    // Hold before release to avoid a fling passing several cards.
    await page.waitForTimeout(150);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
  try {
    await swipe(true);
    await expect(page.locator("article[data-index='1'] h2")).toBeInViewport();
    await expect
      .poll(() => feed.evaluate((element) => Math.abs(element.scrollTop - element.clientHeight)))
      .toBeLessThanOrEqual(1);
    await swipe(false);
    await expect(page.locator("article[data-index='0'] h2")).toBeInViewport();
    await expect.poll(() => feed.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);
  } finally {
    await session.detach();
  }
});
