import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveNatsBundle } from "../src/nats.js";

const DUMMY_CREDS = `-----BEGIN NATS USER JWT-----\nabc\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\nnot-a-real-seed-fixture\n------END USER NKEY SEED------\n`;

describe("resolveNatsBundle", () => {
  test("test creds fixture does not embed NKEY seed-shaped material", () => {
    expect(DUMMY_CREDS).not.toMatch(/S[A-Z0-9]{57}/);
  });

  test("wires [nats].creds into URL-based connection options", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flue-nats-creds-"));
    const creds = join(dir, "user.creds");
    writeFileSync(creds, DUMMY_CREDS, "utf8");

    const bundle = await resolveNatsBundle({ url: "nats://demo.example:4222", creds });

    expect(bundle.connectionOptions.servers).toEqual(["nats://demo.example:4222"]);
    expect(bundle.connectionOptions.authenticator).toBeDefined();
    expect(bundle.signer).toBeUndefined();
    bundle.wipe();
    expect(bundle.connectionOptions.authenticator).toBeUndefined();
  });
});
