/**
 * Claude Code CLI installer bridge.
 *
 * When the CLI is missing, the provider offers an install action. The plugin
 * runs only official installers — npm's `@anthropic-ai/claude-code` package,
 * or Anthropic's own install script as fallback — and reports the outcome.
 * The installer runs with piped stdio so the host process never sees a
 * hijacked terminal; output is captured for error reporting only.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { buildClaudeCodeChildEnv } from "./auth-env.js";

export type ClaudeCliInstallResult =
  | { ok: true }
  | { ok: false; message: string };

type SpawnInstall = (
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcess;

/** npm global install; slow on first run. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const MAX_BUFFERED_OUTPUT = 16 * 1024;

const ANSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]/g;

/** Official npm distribution of the Claude Code CLI. */
const NPM_INSTALL_ARGS = ["install", "-g", "@anthropic-ai/claude-code"];
/** Official self-contained installer, used when npm itself is unavailable. */
const SCRIPT_INSTALL_COMMAND =
  "curl -fsSL https://claude.ai/install.sh | bash";

let installing = false;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function tail(text: string, max = MAX_BUFFERED_OUTPUT): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

function firstMeaningfulLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

/**
 * Install the official Claude Code CLI into the user environment. npm is
 * tried first (deterministic, Node is a given — the plugin runs in it); the
 * official install script is the fallback for hosts without npm.
 */
export async function installClaudeCli(options?: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  cwd?: string;
  spawnInstall?: SpawnInstall;
  timeoutMs?: number;
}): Promise<ClaudeCliInstallResult> {
  if (installing) {
    return {
      ok: false,
      message: "A Claude Code install is already in progress.",
    };
  }
  installing = true;

  const env = buildClaudeCodeChildEnv(options?.env ?? process.env);
  const spawnInstall = options?.spawnInstall ?? spawn;
  const timeoutMs = options?.timeoutMs ?? INSTALL_TIMEOUT_MS;
  const cwd = options?.cwd ?? process.cwd();

  try {
    const npm = await runInstaller(
      spawnInstall,
      "npm",
      NPM_INSTALL_ARGS,
      { env, cwd, timeoutMs },
    );
    if (npm.ok) return npm;

    // npm missing or failed — try the official script through a shell.
    return await runInstaller(
      spawnInstall,
      "bash",
      ["-lc", SCRIPT_INSTALL_COMMAND],
      { env, cwd, timeoutMs },
    );
  } finally {
    installing = false;
  }
}

function runInstaller(
  spawnInstall: SpawnInstall,
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    timeoutMs: number;
  },
): Promise<ClaudeCliInstallResult> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (result: ClaudeCliInstallResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawnInstall(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish({
        ok: false,
        message:
          error instanceof Error ? error.message : `Failed to run ${command}`,
      });
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      finish({
        ok: false,
        message: `Claude Code install timed out after ${Math.round(
          options.timeoutMs / 1000,
        )}s.`,
      });
    }, options.timeoutMs);

    const onData = (chunk: string | Buffer) => {
      output = tail(output + stripAnsi(String(chunk)));
    };
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (error) => {
      finish({ ok: false, message: error.message });
    });
    child.once("exit", (code) => {
      if (code === 0) {
        finish({ ok: true });
        return;
      }
      finish({
        ok: false,
        message:
          firstMeaningfulLine(output) ||
          `Claude Code install exited with code ${code ?? "unknown"}.`,
      });
    });
  });
}

export function isClaudeCliInstallRunning(): boolean {
  return installing;
}
