export type WorkState = "pending" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export type JobState =
  | "discovering"
  | "running"
  | "waiting"
  | "succeeded"
  | "partial_failed"
  | "failed"
  | "cancelled";
const transitions: Record<WorkState, readonly WorkState[]> = {
  pending: ["running", "cancelled"],
  running: ["waiting", "succeeded", "failed", "cancelled"],
  waiting: ["pending", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};
export function canTransitionWork(from: WorkState, to: WorkState): boolean {
  return transitions[from].includes(to);
}
export type WorkSnapshot = {
  state: WorkState;
  stateVersion: number;
  leaseEpoch: number;
  leaseOwner: string | null;
  leaseUntil: number | null;
};
export type TransitionClaim = {
  stateVersion: number;
  leaseEpoch: number;
  leaseOwner: string | null;
  now: number;
};

// SQL repositories must enforce this same fence atomically in their UPDATE predicate.
export function transitionWork(
  current: WorkSnapshot,
  next: WorkState,
  claim: TransitionClaim,
): WorkSnapshot {
  if (!Number.isFinite(claim.now)) throw new Error("INVALID_CLOCK");
  if (!canTransitionWork(current.state, next)) throw new Error("INVALID_TRANSITION");
  if (
    current.stateVersion !== claim.stateVersion ||
    current.leaseEpoch !== claim.leaseEpoch ||
    current.leaseOwner !== claim.leaseOwner
  )
    throw new Error("STALE_OWNER");
  if (
    current.state === "running" &&
    (current.leaseOwner === null || current.leaseUntil === null || claim.now >= current.leaseUntil)
  )
    throw new Error("LEASE_EXPIRED");
  if (next === "running") throw new Error("CLAIM_REQUIRED");
  return {
    ...current,
    state: next,
    stateVersion: current.stateVersion + 1,
    leaseOwner: null,
    leaseUntil: null,
  };
}

export function aggregateJobStatus(states: readonly WorkState[], fatal = false): JobState {
  if (fatal) return "failed";
  if (states.some((state) => state === "pending" || state === "running")) return "running";
  if (states.includes("waiting")) return "waiting";
  if (states.length > 0 && states.every((state) => state === "cancelled")) return "cancelled";
  if (states.includes("failed") || states.includes("cancelled"))
    return states.includes("succeeded") ? "partial_failed" : "failed";
  return "succeeded";
}
