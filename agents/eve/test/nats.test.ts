import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { resolveNatsOptions } from "../src/nats.js";

const DUMMY_CREDS = `-----BEGIN NATS USER JWT-----\nabc\n------END NATS USER JWT------\n\n-----BEGIN USER NKEY SEED-----\nnot-a-real-seed-fixture\n------END USER NKEY SEED------\n`;

describe("resolveNatsOptions", () => {
  test("test creds fixture does not embed NKEY seed-shaped material", () => {
    expect(DUMMY_CREDS).not.toMatch(/S[A-Z0-9]{57}/);
  });

  test("wires [nats].creds into URL-based connection options", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eve-nats-creds-"));
    const creds = join(dir, "user.creds");
    writeFileSync(creds, DUMMY_CREDS, "utf8");

    const opts = await resolveNatsOptions({ url: "nats://demo.example:4222", creds });

    expect(opts.servers).toEqual(["nats://demo.example:4222"]);
    expect(opts.authenticator).toBeDefined();
  });
});
