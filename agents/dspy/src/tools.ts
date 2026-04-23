import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type StatusEmitter = (line: string) => void;

export interface AxFunctionTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
  func: (args: Record<string, unknown>) => Promise<string>;
}

export function makeFsTools(root: string, emit: StatusEmitter): AxFunctionTool[] {
  const rootAbs = path.resolve(root);

  const resolveInside = (rel: string): string => {
    const full = path.resolve(rootAbs, rel || ".");
    if (full !== rootAbs && !full.startsWith(rootAbs + path.sep)) {
      throw new Error(`path escapes sandbox: ${rel}`);
    }
    return full;
  };

  return [
    {
      name: "list_files",
      description:
        "List files and directories at a path relative to the sandbox root. Use '.' or empty string for the root.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path within the sandbox. Use '.' for root.",
          },
        },
        required: ["path"],
      },
      func: async (args) => {
        const rel = String(args.path ?? ".");
        emit(`→ list_files(${JSON.stringify(rel)})`);
        const dir = resolveInside(rel);
        const entries = await fs.readdir(dir, { withFileTypes: true });
        if (entries.length === 0) return "(empty)";
        return entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join("\n");
      },
    },
    {
      name: "read_file",
      description: "Read a UTF-8 text file within the sandbox. Returns the full file contents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file." },
        },
        required: ["path"],
      },
      func: async (args) => {
        const rel = String(args.path);
        emit(`→ read_file(${JSON.stringify(rel)})`);
        return await fs.readFile(resolveInside(rel), "utf8");
      },
    },
    {
      name: "bash",
      description:
        "Run a shell command with the sandbox as the working directory. Returns combined stdout+stderr. Times out after 30 seconds. Output is truncated to 8000 characters.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute." },
        },
        required: ["command"],
      },
      func: async (args) => {
        const command = String(args.command ?? "");
        emit(`→ bash(${JSON.stringify(command)})`);
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: rootAbs,
            timeout: 30_000,
            maxBuffer: 1_000_000,
            shell: "/bin/bash",
          });
          const combined = (stdout + (stderr ? `\n[stderr]\n${stderr}` : "")) || "(no output)";
          return combined.length > 8000
            ? `${combined.slice(0, 8000)}\n… [truncated, ${combined.length} chars total]`
            : combined;
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; message?: string; code?: number };
          const out = [
            e.stdout ? `[stdout]\n${e.stdout}` : "",
            e.stderr ? `[stderr]\n${e.stderr}` : "",
            e.message ? `[error] ${e.message}` : "",
            e.code !== undefined ? `[exit ${e.code}]` : "",
          ].filter(Boolean).join("\n");
          return out || "(command failed, no output)";
        }
      },
    },
    {
      name: "write_file",
      description:
        "Write (create or overwrite) a UTF-8 text file within the sandbox. Parent directories are created as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the file." },
          content: { type: "string", description: "UTF-8 file contents." },
        },
        required: ["path", "content"],
      },
      func: async (args) => {
        const rel = String(args.path);
        const content = String(args.content ?? "");
        emit(`→ write_file(${JSON.stringify(rel)}, ${content.length} bytes)`);
        const full = resolveInside(rel);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, content, "utf8");
        return `wrote ${content.length} bytes to ${rel}`;
      },
    },
  ];
}
