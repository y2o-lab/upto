import { expect, test, type Locator, type Page } from "@playwright/test";

// Pause dwell timers as well as time-dependent labels while allowing hydration frames explicitly.
const now = new Date("2026-10-17T03:00:00.000Z");

test.beforeEach(async ({ page, baseURL }) => {
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).origin === baseURL) {
      return route.continue();
    }
    return route.abort();
  });
});

async function waitVisible(page: Page, locator: Locator) {
  await expect
    .poll(async () => {
      await page.clock.runFor(50);
      return locator.isVisible();
    })
    .toBe(true);
}

async function readyFeed(page: Page) {
  await waitVisible(page, page.locator('[data-testid="article-feed"][data-ready="true"]'));
}

async function snapshot(page: Page, name: string) {
  await page.clock.runFor(100);
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    test.info().project.use.colorScheme ?? "light",
  );
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot(name);
}

async function saveFirstArticle(page: Page) {
  await page.goto("/");
  await readyFeed(page);
  await page.getByTestId("save-article-0").click();
  await expect(page.getByTestId("save-article-0")).toHaveAttribute("data-saved", "true");
}

test("news feed", async ({ page }) => {
  await page.goto("/");
  await readyFeed(page);
  await expect(page.locator("article[data-index='0'] h2")).toHaveText(
    "ニュース収集バッチを安全に設計する",
  );
  await snapshot(page, "feed.png");
});

test("saved article list", async ({ page }) => {
  await saveFirstArticle(page);
  await page.goto("/bookmarks");
  await readyFeed(page);
  await expect(page.getByTestId("save-article-0")).toHaveAttribute("data-saved", "true");
  await expect(page.getByTestId("article-card-1")).toHaveCount(0);
  await snapshot(page, "bookmarks.png");
});

test("empty saved article list", async ({ page }) => {
  await page.goto("/bookmarks");
  await waitVisible(page, page.getByTestId("bookmarks-empty"));
  await snapshot(page, "bookmarks-empty.png");
});

test("saved article loading and error", async ({ page }) => {
  await saveFirstArticle(page);
  let releaseRequest!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  let requestStarted = false;
  await page.route("**/api/articles?ids=*", async (route) => {
    requestStarted = true;
    await gate;
    await route.fulfill({ status: 500, json: { error: { code: "internal_error" } } });
  });
  try {
    await page.goto("/bookmarks");
    // Hydration can need another frame before it starts the saved-article request.
    await expect
      .poll(async () => {
        await page.clock.runFor(50);
        return requestStarted;
      })
      .toBe(true);
    await waitVisible(page, page.getByRole("heading", { name: "保存した記事を読み込んでいます" }));
    await snapshot(page, "bookmarks-loading.png");
    releaseRequest();
    await waitVisible(
      page,
      page.getByRole("heading", { name: "保存した記事を読み込めませんでした" }),
    );
    await snapshot(page, "bookmarks-error.png");
  } finally {
    releaseRequest();
    if (!page.isClosed()) {
      await page.unrouteAll({ behavior: "wait" });
    }
  }
});

test("end of feed", async ({ page }) => {
  await page.goto("/");
  await readyFeed(page);
  await page.locator("article[data-index='8']").scrollIntoViewIfNeeded();
  await waitVisible(page, page.getByTestId("feed-complete"));
  await page.getByTestId("feed-complete").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("feed-complete")).toBeInViewport();
  await snapshot(page, "feed-complete.png");
});
