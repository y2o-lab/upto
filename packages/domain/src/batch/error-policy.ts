export type FailureClass = "terminal" | "transient" | "quota" | "uncertain";
export type Failure =
  | { kind: "http"; status: number }
  | {
      kind: "network" | "timeout" | "quota" | "generation_unknown" | "validation" | "configuration";
    };
export function classifyFailure(failure: Failure): FailureClass {
  switch (failure.kind) {
    case "http":
      return failure.status === 429 || (failure.status >= 500 && failure.status <= 599)
        ? "transient"
        : "terminal";
    case "network":
    case "timeout":
      return "transient";
    case "quota":
      return "quota";
    case "generation_unknown":
      return "uncertain";
    case "validation":
    case "configuration":
      return "terminal";
  }
}
export type RetryDecision =
  | { action: "retry"; nextEligibleAt: number }
  | { action: "lookup" | "reuse" | "wait" | "stop" | "uncertain" };
export function retryDecision(input: {
  failure: FailureClass;
  retries: number;
  now: number;
  deadlineAt: number;
  operationStatus:
    | "unknown"
    | "not_found"
    | "running"
    | "waiting"
    | "succeeded"
    | "failed"
    | "uncertain";
  jitter: number;
}): RetryDecision {
  if (
    !Number.isFinite(input.now) ||
    !Number.isFinite(input.deadlineAt) ||
    !Number.isInteger(input.retries) ||
    input.retries < 0 ||
    !Number.isFinite(input.jitter) ||
    input.jitter < 0 ||
    input.jitter > 1
  ) {
    throw new Error("INVALID_RETRY_INPUT");
  }
  if (input.operationStatus === "succeeded") return { action: "reuse" };
  if (input.failure === "uncertain" || input.operationStatus === "uncertain")
    return { action: "uncertain" };
  if (input.now >= input.deadlineAt || input.failure === "terminal") return { action: "stop" };
  if (
    input.failure === "quota" ||
    input.operationStatus === "running" ||
    input.operationStatus === "waiting"
  )
    return { action: "wait" };
  if (input.operationStatus === "unknown") return { action: "lookup" };
  if (input.operationStatus === "failed" || input.retries >= 2) return { action: "stop" };
  const nextEligibleAt =
    input.now + (input.retries === 0 ? 5000 : 30000) + Math.floor(input.jitter * 1000);
  return nextEligibleAt >= input.deadlineAt
    ? { action: "stop" }
    : { action: "retry", nextEligibleAt };
}
