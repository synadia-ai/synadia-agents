// vitest globalSetup — starts a single `nats-server` process for the entire
// integration-test run and exposes its URL via `inject("natsUrl")`. When the
// binary isn't installed, `natsUrl` is published as `null` so individual
// test suites can mark themselves skipped with a friendly message.

import type { TestProject } from "vitest/node";
import { NatsServerNotAvailableError, NatsServerProcess } from "./nats-server.js";

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const server = new NatsServerProcess();
  try {
    await server.start();
  } catch (err) {
    if (err instanceof NatsServerNotAvailableError) {
      console.warn(
        "⚠ nats-server not found on PATH — integration tests will be skipped.\n" +
          "   Install with e.g.  brew install nats-server  or download from\n" +
          "   https://github.com/nats-io/nats-server/releases",
      );
      project.provide("natsUrl", null);
      // No teardown when nats-server wasn't started.
      return () => Promise.resolve();
    }
    throw err;
  }
  project.provide("natsUrl", server.url);
  return async () => {
    await server.stop();
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    natsUrl: string | null;
  }
}
