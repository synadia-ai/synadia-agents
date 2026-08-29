// Every rendered identity carries its trust class (SDK convention, spec
// "SHOULD"): a claim must never read as proof in a log line or a console.

import type { SenderInfo } from "./sender-header.js";

/**
 * - `<account>.<user> (verified)` — signature verified AND the account
 *   attested by a server stamp (operator-attested mode, PR-T2);
 * - `<account>.<user> (verified user, claimed account)` — signature
 *   verified; `account` is the sender's signed word;
 * - `<account>.<user> (claimed)` — unsigned claim;
 * - `(no sender)` — no header / unknown `v`.
 */
export function formatSender(sender: SenderInfo | undefined): string {
  if (sender === undefined) return "(no sender)";
  if (sender.trust === "verified") {
    return sender.accountAttested
      ? `${sender.id} (verified)`
      : `${sender.id} (verified user, claimed account)`;
  }
  return `${sender.claim.account}.${sender.claim.user} (claimed)`;
}
