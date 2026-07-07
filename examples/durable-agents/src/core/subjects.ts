// core/subjects.ts — NATS subjects shared by the durable brain and the front-door.
// A single source of truth so the approval side-channel can't drift between publisher and subscriber.

/** Subject a parked approval is announced on, so a front-door (or the crash demo) can answer it. */
export const approvalSubject = (runId: string): string => `de-agent.approval.${runId}`;
