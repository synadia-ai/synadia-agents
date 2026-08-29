import { describe, expect, it } from "vitest";
import { parseAgentId } from "../../../src/identity/agent-id.js";
import { formatSender } from "../../../src/identity/format.js";
import type {
  AgentSenderHeader,
  ClaimedSender,
  VerifiedSender,
} from "../../../src/identity/sender-header.js";

const A = "AABYLMBR6Q2CDXTLGRQCFA2GP76BGCDF7NZF2OVHH4RQ7L3Y3TZWJDRL";
const U = "UAWW24XPLGOX3R3JF4OZEZZ6RUXMB55DSWJCEFFSUDFBCKJD4MSCMQYI";
const header: AgentSenderHeader = { v: 1, account: A, user: U };

describe("formatSender", () => {
  it("renders the three trust forms and the absent case", () => {
    const base: Omit<VerifiedSender, "accountAttested"> = {
      trust: "verified",
      id: parseAgentId(`${A}.${U}`),
      header,
      resolve: () => Promise.resolve(undefined),
    };
    expect(formatSender({ ...base, accountAttested: true })).toBe(`${A}.${U} (verified)`);
    expect(formatSender({ ...base, accountAttested: false })).toBe(
      `${A}.${U} (verified user, claimed account)`,
    );
    const claimed: ClaimedSender = { trust: "claimed", claim: { account: A, user: U }, header };
    expect(formatSender(claimed)).toBe(`${A}.${U} (claimed)`);
    expect(formatSender(undefined)).toBe("(no sender)");
  });
});
