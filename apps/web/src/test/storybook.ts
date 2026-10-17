import { expect, waitFor, within } from "storybook/test";

export async function readyFeed(canvasElement: HTMLElement): Promise<ReturnType<typeof within>> {
  const canvas = within(canvasElement);
  const feed = await canvas.findByTestId("article-feed");
  await waitFor(() => expect(feed).toHaveAttribute("data-ready", "true"));
  return canvas;
}

export async function expectActiveCard(canvasElement: HTMLElement, index: number) {
  const canvas = within(canvasElement);
  const feed = canvas.getByTestId("article-feed");
  const card = canvas.getByTestId(`article-card-${index}`);
  await waitFor(() => {
    const viewport = feed.getBoundingClientRect();
    const bounds = card.getBoundingClientRect();
    expect(Math.abs(bounds.top - viewport.top)).toBeLessThanOrEqual(2);
  });
}

export async function expectInsideCard(card: HTMLElement, elements: HTMLElement[]) {
  await waitFor(() => {
    const bounds = card.getBoundingClientRect();
    for (const element of elements) {
      expect(element).toBeVisible();
      const content = element.getBoundingClientRect();
      expect(content.top).toBeGreaterThanOrEqual(bounds.top - 1);
      expect(content.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
      expect(content.left).toBeGreaterThanOrEqual(bounds.left - 1);
      expect(content.right).toBeLessThanOrEqual(bounds.right + 1);
    }
  });
}
