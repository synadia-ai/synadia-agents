import { readFileSync } from "node:fs";

/** Read the Claude plugin descriptor without leaking raw filesystem errors at startup. */
export function loadPluginVersion(path: string): string {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    throw new Error("invalid .claude-plugin/plugin.json: cannot read file");
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(contents);
  } catch {
    throw new Error("invalid .claude-plugin/plugin.json: expected valid JSON");
  }

  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    throw new Error("invalid .claude-plugin/plugin.json: expected an object");
  }
  const version = (manifest as { version?: unknown }).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(
      "invalid .claude-plugin/plugin.json: expected a non-empty string version",
    );
  }
  return version;
}
