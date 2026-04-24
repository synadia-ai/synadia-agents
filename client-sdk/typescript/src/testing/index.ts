// Public exports for the `@synadia-ai/agents/testing` subpath.
//
// These helpers let third-party implementations test against a
// spec-compliant counterparty without rolling their own.

export {
  ReferenceAgent,
  type ReferenceAgentOptions,
  type ReferenceAgentPromptHandler,
} from "./reference-agent.js";
