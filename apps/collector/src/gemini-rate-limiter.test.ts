import { afterEach, describe, expect, it, vi } from "vitest";

import { createGeminiRateLimiter } from "./gemini-rate-limiter.js";

describe("createGeminiRateLimiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not permit a sixth request until the oldest of five requests is 60 seconds old", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T00:00:00.000Z"));
    const limiter = createGeminiRateLimiter({ maxRequestsPerMinute: 5 });

    await Promise.all(Array.from({ length: 5 }, () => limiter.acquire()));
    const sixthRequest = limiter.acquire();
    let sixthStarted = false;
    void sixthRequest.then(() => {
      sixthStarted = true;
    });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(sixthStarted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(sixthRequest).resolves.toBeUndefined();
    expect(sixthStarted).toBe(true);
  });

  it("reports rate-limit waits without exposing request contents", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T00:00:00.000Z"));
    const onWait = vi.fn();
    const limiter = createGeminiRateLimiter({ maxRequestsPerMinute: 1, onWait });

    await limiter.acquire();
    void limiter.acquire();

    expect(onWait).toHaveBeenCalledWith({
      maxRequestsPerMinute: 1,
      waitMilliseconds: 60_000,
    });
  });

  it("shares one moving-window limit among requests that arrive concurrently", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T00:00:00.000Z"));
    const limiter = createGeminiRateLimiter({ maxRequestsPerMinute: 5 });
    const startedAt: number[] = [];

    const requests = Array.from({ length: 10 }, async () => {
      await limiter.acquire();
      startedAt.push(Date.now());
    });
    await vi.runAllTicks();

    expect(startedAt).toHaveLength(5);
    expect(startedAt).toEqual(Array.from({ length: 5 }, () => Date.now()));

    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(requests);

    expect(startedAt).toHaveLength(10);
    expect(startedAt.slice(5)).toEqual(Array.from({ length: 5 }, () => Date.now()));
  });

  it("rechecks the next queued request when a slot becomes available", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T00:00:00.000Z"));
    const limiter = createGeminiRateLimiter({ maxRequestsPerMinute: 2 });

    await Promise.all([limiter.acquire(), limiter.acquire()]);
    const thirdRequest = limiter.acquire();
    const fourthRequest = limiter.acquire();

    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all([thirdRequest, fourthRequest]);

    expect(limiter.requestStartTimes()).toEqual([
      Date.parse("2026-08-18T00:01:00.000Z"),
      Date.parse("2026-08-18T00:01:00.000Z"),
    ]);
  });
});
