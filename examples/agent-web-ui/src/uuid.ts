// Polyfill for `crypto.randomUUID()` in non-secure HTTP contexts.
//
// Browsers expose `crypto.randomUUID()` only in secure contexts — HTTPS or
// `localhost`. When this UI is served over plain HTTP to a non-localhost
// host (e.g. `http://tux64.lan:5173/`), the native call throws. The
// `crypto.getRandomValues()` API IS available in all contexts, so we
// generate an RFC 4122 v4 UUID by hand when the native call is missing.

export function randomUUID(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  // RFC 4122 §4.4: set version bits to 0100 on byte 6, variant to 10 on byte 8.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
