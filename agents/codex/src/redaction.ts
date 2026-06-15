export const PRIVATE_VALUE_RE = /(?:\/Users\/[A-Za-z0-9._-]+|S[A-Z0-9]{57}|(?:unix|ws|wss):\/\/[^\s"'`]+|raw-[A-Za-z0-9._-]+|thread-private-[A-Za-z0-9._-]+)/g;

export function redactPrivateText(value: string): string {
  return value.replace(PRIVATE_VALUE_RE, "[REDACTED]");
}

export function publicTextContainsPrivateValue(text: string, values: readonly string[]): boolean {
  return values.some((value) => value.length > 0 && text.includes(value));
}

export function assertNoPrivateValues(label: string, publicValue: unknown, values: readonly string[]): void {
  const text = typeof publicValue === "string" ? publicValue : JSON.stringify(publicValue);
  if (publicTextContainsPrivateValue(text, values)) throw new Error(`${label} leaked a private Codex value`);
}
