// Unit tests for contextToConnectOpts TLS handling.
//
// NATS CLI contexts store cert/key/ca as file *paths*; the loader must
// read their contents into the standard `tls.cert`/`key`/`ca` options
// (portable across runtimes — Bun's transport never consumed the
// Node-only `certFile`/`keyFile`/`caFile` helper fields) rather than
// passing the paths through. Mirrors the SDK's `loadContextOptions`
// semantics, including `tls_first` alone producing `handshakeFirst`
// with no file reads.
//
// Run with: bun test test/context.test.ts

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextToConnectOpts } from "../extensions/nats-channel.ts";

let baseDir: string;

beforeAll(() => {
	baseDir = mkdtempSync(join(tmpdir(), "pi-nats-ctx-"));
});

afterAll(() => {
	rmSync(baseDir, { recursive: true, force: true });
});

test("loads TLS file contents into standard tls options", () => {
	const certPath = join(baseDir, "client.pem");
	const keyPath = join(baseDir, "client.key");
	const caPath = join(baseDir, "ca.pem");
	writeFileSync(certPath, "client-cert");
	writeFileSync(keyPath, "client-key");
	writeFileSync(caPath, "ca-cert");
	const opts = contextToConnectOpts({
		url: "tls://nats.example.com:4222",
		cert: certPath,
		key: keyPath,
		ca: caPath,
		tls_first: true,
	});
	expect(opts.tls).toEqual({
		cert: "client-cert",
		key: "client-key",
		ca: "ca-cert",
		handshakeFirst: true,
	});
});

test("loads a partial TLS triple (ca only)", () => {
	const caPath = join(baseDir, "ca-only.pem");
	writeFileSync(caPath, "ca-only-cert");
	const opts = contextToConnectOpts({
		url: "tls://nats.example.com:4222",
		ca: caPath,
	});
	expect(opts.tls).toEqual({ ca: "ca-only-cert" });
});

test("sets handshakeFirst alone when only tls_first is set", () => {
	const opts = contextToConnectOpts({
		url: "tls://nats.example.com:4222",
		tls_first: true,
	});
	expect(opts.tls).toEqual({ handshakeFirst: true });
});

test("throws a clear error when a TLS file is missing", () => {
	const certPath = join(baseDir, "missing-client.pem");
	expect(() =>
		contextToConnectOpts({
			url: "tls://nats.example.com:4222",
			cert: certPath,
		}),
	).toThrow(`failed to read TLS cert file ${certPath}`);
});

test("leaves tls undefined when no TLS fields are set", () => {
	const opts = contextToConnectOpts({ url: "nats://localhost:4222" });
	expect(opts.tls).toBeUndefined();
});
