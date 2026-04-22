import { describe, expect, it } from "vitest";
import { buildEndpointInfo } from "../../src/discovery/endpoint-info.js";

describe("buildEndpointInfo", () => {
  it("parses max_payload and attachments_ok on the prompt endpoint", () => {
    const info = buildEndpointInfo({
      name: "prompt",
      subject: "agents.ref.alice.echo",
      metadata: { max_payload: "1MB", attachments_ok: "true" },
    });
    expect(info.maxPayloadBytes).toBe(1024 * 1024);
    expect(info.attachmentsOk).toBe(true);
  });

  it("attachments_ok = 'false' becomes false", () => {
    const info = buildEndpointInfo({
      name: "prompt",
      subject: "agents.ref.alice.echo",
      metadata: { max_payload: "512KB", attachments_ok: "false" },
    });
    expect(info.attachmentsOk).toBe(false);
    expect(info.maxPayloadBytes).toBe(512 * 1024);
  });

  it("leaves capability fields undefined when metadata is absent", () => {
    const info = buildEndpointInfo({ name: "prompt", subject: "agents.ref.alice.echo" });
    expect(info.maxPayloadBytes).toBeUndefined();
    expect(info.attachmentsOk).toBeUndefined();
    expect(info.metadata).toEqual({});
  });

  it("drops max_payload when unparseable, but preserves raw string in metadata", () => {
    const info = buildEndpointInfo({
      name: "prompt",
      subject: "agents.ref.alice.echo",
      metadata: { max_payload: "not-a-size" },
    });
    expect(info.maxPayloadBytes).toBeUndefined();
    expect(info.metadata["max_payload"]).toBe("not-a-size");
  });

  it("does NOT parse capability fields on non-prompt endpoints", () => {
    const info = buildEndpointInfo({
      name: "attachments",
      subject: "agents.ref.alice.echo.attachments",
      metadata: { max_payload: "1MB", attachments_ok: "true" },
    });
    expect(info.maxPayloadBytes).toBeUndefined();
    expect(info.attachmentsOk).toBeUndefined();
    // But preserves the metadata verbatim per §12.
    expect(info.metadata["max_payload"]).toBe("1MB");
  });

  it("freezes the returned object and its metadata", () => {
    const info = buildEndpointInfo({
      name: "prompt",
      subject: "agents.ref.alice.echo",
      metadata: { foo: "bar" },
    });
    expect(Object.isFrozen(info)).toBe(true);
    expect(Object.isFrozen(info.metadata)).toBe(true);
  });
});
