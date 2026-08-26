/**
 * Guarded local execution toolset for the OpenRouter adapter.
 *
 * Gives HTTP-only agents real local capability - run commands, read/write
 * files, list directories - confined to a single workspace root:
 *   - every path is resolved and must stay inside the workspace root
 *   - command output is byte-capped; commands are killed (process tree) on timeout
 *   - file writes are size-capped
 *
 * These tools are appended to the Paperclip-API toolset only when
 * enableLocalExec is not explicitly false in the agent's adapterConfig.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import type { Tool } from "./tools.js";

const MAX_OUTPUT_BYTES = 200_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_LIST_ENTRIES = 500;
const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 900;

/** Resolve the workspace root for an agent. Explicit config wins; otherwise
 *  the host-managed per-agent workspace under the Paperclip instance dir. */
export function resolveWorkspaceRoot(
  config: Record<string, unknown>,
  agentId: string,
): string | null {
  const cfgPath = typeof config.workspaceDir === "string" ? config.workspaceDir.trim() : "";
  if (cfgPath) return path.resolve(cfgPath);
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  const instance = process.env.PAPERCLIP_INSTANCE_ID?.trim() || "default";
  return path.join(home, ".paperclip", "instances", instance, "workspaces", agentId);
}

/**
 * Build the Environment block appended to every run's system prompt.
 *
 * Runtime-discoverable facts (shell, workspace root, Windows quoting rules)
 * are always included; operator-configured notes are layered underneath:
 *   1. shared file %USERPROFILE%\.openrouter-adapter\config.json .environmentNotes
 *   2. per-agent adapterConfig.environmentNotes
 */
/** Shared adapter config file used for tiered settings (API key, env notes). */
export function sharedConfigPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return path.join(home, ".openrouter-adapter", "config.json");
}

function collectNotes(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  if (typeof v === "string" && v.trim().length > 0) return [v];
  return [];
}

export function buildEnvironmentBlock(
  config: Record<string, unknown>,
  workspaceRoot: string | null,
): string {
  const lines: string[] = ["## Environment"];
  if (process.platform === "win32") {
    lines.push(
      '- Shell: cmd.exe (not git-bash). POSIX constructs like "export VAR=value" fail; use cmd syntax.',
      '- Quote PATH assignments: set "PATH=%PATH%;C:\\some\\dir" - unquoted assignments break when an existing PATH entry contains parentheses.',
    );
  } else {
    lines.push("- Shell: POSIX sh.");
  }
  if (workspaceRoot) {
    lines.push(`- Workspace root: all file and command tools operate inside ${workspaceRoot}`);
  }
  // Surface operator-managed environment variables so agents know the real paths.
  for (const name of ["COMSPEC", "FLUTTER_ROOT", "SUDOKU_REPO"]) {
    const v = process.env[name]?.trim();
    if (v) lines.push(`- ${name}: ${v}`);
  }

  // Layer configured notes underneath: shared file first, then agent-specific.
  let sharedNotes: string[] = [];
  try {
    sharedNotes = collectNotes(JSON.parse(readFileSync(sharedConfigPath(), "utf8").replace(/^\uFEFF/, "")).environmentNotes);
  } catch {
    // No shared config file - skip.
  }
  for (const note of [...sharedNotes, ...collectNotes(config.environmentNotes)]) {
    lines.push(`- ${note.trim()}`);
  }

  return lines.join("\n");
}

function assertInside(root: string, target: string): string {
  const r = path.resolve(root);
  // Resolve relative targets against the workspace root, then verify containment.
  const t = path.resolve(r, target);
  const rel = path.relative(r, t);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the agent workspace: ${target}`);
  }
  return t;
}

function ok(content: unknown): { content: string; isError: boolean } {
  return { content: JSON.stringify(content), isError: false };
}

function fail(message: string): { content: string; isError: boolean } {
  return { content: JSON.stringify({ error: message }), isError: true };
}

interface CommandResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

function killTree(child: import("node:child_process").ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } catch {
      child.kill("SIGKILL");
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

async function runCommand(
  command: string,
  cwd: string,
  timeoutSec: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(command, {
      shell: true,
      cwd,
      windowsHide: true,
      env: process.env,
    });

    const append = (sink: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = chunk.toString();
      const sinkLen = sink === "stdout" ? stdout.length : stderr.length;
      const room = MAX_OUTPUT_BYTES - sinkLen;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const piece = text.length > room ? text.slice(0, room) : text;
      if (text.length > room) truncated = true;
      if (sink === "stdout") stdout += piece;
      else stderr += piece;
    };

    child.stdout?.on("data", (c: Buffer) => append("stdout", c));
    child.stderr?.on("data", (c: Buffer) => append("stderr", c));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutSec * 1000);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        timedOut,
        stdout: stdout + (truncated ? "\n...[output truncated]" : ""),
        stderr: stderr + (truncated ? "\n...[output truncated]" : ""),
        truncated,
      });
    };

    child.on("error", (err) => {
      stderr += `\n[spawn error] ${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

export function buildExecTools(opts: { workspaceRoot: string }): Tool[] {
  const root = path.resolve(opts.workspaceRoot);

  const readTool: Tool = {
    schema: {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read a UTF-8 text file from your workspace. Paths are relative to the workspace root; escaping it is denied.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Workspace-relative file path." } },
          required: ["path"],
        },
      },
    },
    execute: async (args) => {
      try {
        const target = assertInside(root, asString(args.path));
        const stat = await fs.stat(target);
        if (stat.size > MAX_FILE_BYTES) return fail(`File too large (${stat.size} bytes).`);
        const content = await fs.readFile(target, "utf8");
        return ok({ path: target, bytes: stat.size, content });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const writeTool: Tool = {
    schema: {
      type: "function",
      function: {
        name: "write_file",
        description:
          "Create or overwrite a UTF-8 text file inside your workspace. Parent directories are created automatically.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path." },
            content: { type: "string", description: "Full file contents." },
          },
          required: ["path", "content"],
        },
      },
    },
    execute: async (args) => {
      try {
        const target = assertInside(root, asString(args.path));
        const content = typeof args.content === "string" ? args.content : "";
        if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
          return fail(`Content exceeds ${MAX_FILE_BYTES} byte cap.`);
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, "utf8");
        return ok({ path: target, bytes: Buffer.byteLength(content, "utf8"), wrote: true });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const listTool: Tool = {
    schema: {
      type: "function",
      function: {
        name: "list_dir",
        description: "List a directory inside your workspace (files and subdirectories, capped at 500 entries).",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Workspace-relative directory. Omit for root." } },
        },
      },
    },
    execute: async (args) => {
      try {
        const rel = asString(args.path, ".");
        const target = assertInside(root, rel);
        const dirents = await fs.readdir(target, { withFileTypes: true });
        const entries: Array<{ name: string; type: string; size: number | null }> = [];
        for (const d of dirents.slice(0, MAX_LIST_ENTRIES)) {
          let size: number | null = null;
          if (d.isFile()) {
            try {
              size = (await fs.stat(path.join(target, d.name))).size;
            } catch {
              size = null;
            }
          }
          entries.push({ name: d.name, type: d.isDirectory() ? "dir" : d.isSymbolicLink() ? "symlink" : "file", size });
        }
        entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
        return ok({ path: target, count: entries.length, truncated: dirents.length > MAX_LIST_ENTRIES, entries });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const runTool: Tool = {
    schema: {
      type: "function",
      function: {
        name: "run_command",
        description:
          "Execute a shell command inside your workspace directory (cmd.exe on Windows, /bin/sh elsewhere). " +
          "Output is capped and long-running commands are killed at the timeout. Use for builds, tests, git, and project tooling. " +
          "For long-running processes (dev servers, watchers), set background=true to avoid blocking.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "The shell command line to run." },
            timeout_sec: { type: "number", description: `Kill the command after this many seconds (default ${DEFAULT_TIMEOUT_SEC}, max ${MAX_TIMEOUT_SEC}).` },
            background: { type: "boolean", description: "Set true for processes that never exit (dev servers, watchers). Returns immediately with the PID." },
          },
          required: ["command"],
        },
      },
    },
    execute: async (args) => {
      const command = asString(args.command);
      if (!command) return fail("command is required.");

      // Background mode: spawn detached, return immediately with the PID.
      if (args.background === true) {
        try {
          const child = spawn(command, {
            shell: true,
            cwd: root,
            windowsHide: true,
            detached: true,
            stdio: "ignore",
            env: process.env,
          });
          child.unref();
          return ok({
            pid: child.pid,
            background: true,
            command,
            note: `Process started in background (PID ${child.pid}). It keeps running after this call returns. Use 'taskkill /F /PID ${child.pid}' to stop it.`,
          });
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      }

      const requested =
        typeof args.timeout_sec === "number" && args.timeout_sec > 0
          ? Math.min(Math.floor(args.timeout_sec), MAX_TIMEOUT_SEC)
          : DEFAULT_TIMEOUT_SEC;
      try {
        const result = await runCommand(command, root, requested);
        return ok({
          command,
          cwd: root,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [readTool, writeTool, listTool, runTool];
}
