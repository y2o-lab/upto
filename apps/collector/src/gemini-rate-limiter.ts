const WINDOW_MS = 60_000;

export type GeminiRateLimiter = {
  acquire(): Promise<void>;
  requestStartTimes(): number[];
};

export type GeminiRateLimiterOptions = {
  maxRequestsPerMinute: number;
  now?: () => number;
  onWait?:
    | ((details: { maxRequestsPerMinute: number; waitMilliseconds: number }) => void)
    | undefined;
  sleep?: (milliseconds: number) => Promise<void>;
};

export function createGeminiRateLimiter(options: GeminiRateLimiterOptions): GeminiRateLimiter {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const requestStartTimes: number[] = [];
  const queue: (() => void)[] = [];
  let waitingForNextSlot = false;

  const processQueue = (): void => {
    removeExpiredStartTimes(requestStartTimes, now());

    while (queue.length > 0 && requestStartTimes.length < options.maxRequestsPerMinute) {
      const nextRequest = queue.shift();
      if (!nextRequest) {
        return;
      }
      requestStartTimes.push(now());
      nextRequest();
      removeExpiredStartTimes(requestStartTimes, now());
    }

    if (queue.length === 0 || waitingForNextSlot) {
      return;
    }

    const oldestStart = requestStartTimes[0];
    if (oldestStart === undefined) {
      return;
    }

    const waitMilliseconds = Math.max(0, oldestStart + WINDOW_MS - now());
    waitingForNextSlot = true;
    options.onWait?.({
      maxRequestsPerMinute: options.maxRequestsPerMinute,
      waitMilliseconds,
    });
    void sleep(waitMilliseconds).then(() => {
      waitingForNextSlot = false;
      processQueue();
    });
  };

  return {
    acquire() {
      return new Promise<void>((resolve) => {
        queue.push(resolve);
        processQueue();
      });
    },
    requestStartTimes() {
      removeExpiredStartTimes(requestStartTimes, now());
      return [...requestStartTimes];
    },
  };
}

function removeExpiredStartTimes(requestStartTimes: number[], currentTime: number): void {
  while (requestStartTimes[0] !== undefined && currentTime - requestStartTimes[0] >= WINDOW_MS) {
    requestStartTimes.shift();
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
