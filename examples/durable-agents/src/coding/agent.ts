// coding/agent.ts — the "durable Claude Code" persona: sandboxed filesystem tools + an
// approval-gated run_bash + a system prompt + a deterministic offline script. Shares the same
// engine-neutral core as the SRE agent — this file is just a different tool-set + prompt.
//
// Safety: every path is resolved inside the sandbox and traversal is rejected; run_bash executes
// with the sandbox as cwd and a timeout. (For a real deployment you'd also allow-list commands.)
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Tool } from "../core/effects";
import type { ChatMessage, Decision, StubScript } from "../core/llm";

const pexec = promisify(execFile);

export const codingSystem =
  "You are a careful coding agent working ONLY inside a sandboxed directory. Explore with " +
  "list_dir / read_file / grep, make changes with write_file, and run commands with run_bash " +
  "(which requires human approval). Keep changes minimal and finish with a short summary of what you did.";

/** Resolve `p` inside the sandbox, rejecting any path that escapes it. */
function safe(sandbox: string, p: string): string {
  const root = path.resolve(sandbox);
  const resolved = path.resolve(root, p);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes sandbox: ${p}`);
  }
  return resolved;
}

export function codingTools(
  sandbox: string,
  onCall?: (name: string, args: Record<string, unknown>, key: string) => void,
): Tool[] {
  const hit = (n: string, a: Record<string, unknown>, k: string) => onCall?.(n, a, k);
  return [
    {
      spec: { name: "list_dir", description: "list files in a sandbox directory", parameters: { type: "object", properties: { path: { type: "string" } } } },
      run: async (args, key) => {
        hit("list_dir", args, key);
        const entries = await fs.readdir(safe(sandbox, String(args.path ?? ".")), { withFileTypes: true });
        return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n") || "(empty)";
      },
    },
    {
      spec: { name: "read_file", description: "read a file in the sandbox", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
      run: async (args, key) => {
        hit("read_file", args, key);
        return await fs.readFile(safe(sandbox, String(args.path)), "utf8");
      },
    },
    {
      spec: { name: "grep", description: "recursively search the sandbox for a pattern", parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
      run: async (args, key) => {
        hit("grep", args, key);
        try {
          const { stdout } = await pexec("grep", ["-rn", String(args.pattern), "."], { cwd: sandbox });
          return stdout.slice(0, 4000) || "(no matches)";
        } catch {
          return "(no matches)";
        }
      },
    },
    {
      spec: { name: "write_file", description: "create or overwrite a file in the sandbox", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
      run: async (args, key) => {
        hit("write_file", args, key);
        const f = safe(sandbox, String(args.path));
        await fs.mkdir(path.dirname(f), { recursive: true });
        await fs.writeFile(f, String(args.content));
        return `wrote ${String(args.path)} (${String(args.content).length} bytes)`;
      },
    },
    {
      spec: { name: "run_bash", description: "run a bash command in the sandbox (disruptive)", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
      dangerous: true, // parks on human approval before running
      run: async (args, key) => {
        hit("run_bash", args, key);
        try {
          const { stdout, stderr } = await pexec("bash", ["-c", String(args.cmd)], { cwd: sandbox, timeout: 15_000 });
          return (stdout + stderr).slice(0, 4000) || "(no output)";
        } catch (e) {
          return `error: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
    },
  ];
}

/** Deterministic offline playbook: write a file → read it back → measure it with bash (approval). */
export const codingStub: StubScript = {
  label: "coding-stub",
  decide(messages: ChatMessage[]): Decision {
    const seen = messages.filter((m) => m.role === "tool").length;
    if (seen === 0)
      return { content: "I'll create a greeting file.", toolCalls: [{ id: "c0", name: "write_file", args: { path: "greeting.txt", content: "hello from the durable coding agent\n" } }] };
    if (seen === 1)
      return { content: "Reading it back to confirm.", toolCalls: [{ id: "c1", name: "read_file", args: { path: "greeting.txt" } }] };
    if (seen === 2)
      return { content: "Measuring it with bash (needs approval).", toolCalls: [{ id: "c2", name: "run_bash", args: { cmd: "wc -c greeting.txt" } }] };
    return { content: "Done: wrote greeting.txt, read it back, and measured it with wc.", toolCalls: [] };
  },
};
