/**
 * Claude CLI detection + Agent SDK probe (from OpenChamber harness).
 */
import { spawnSync } from "node:child_process";
import { buildClaudeCodeChildEnv } from "./auth-env.js";
import { hasClaudeCliOAuthCredentials } from "./credentials.js";
import { findBinaryOnPath } from "./executable-path.js";
import { probeClaudeAgentSdk } from "./query.js";

export type ClaudeDetectStatus =
  | "ready"
  | "needs-login"
  | "missing-cli"
  | "missing-sdk"
  | "error";

export type ClaudeDetectResult = {
  status: ClaudeDetectStatus;
  statusDetail?: string;
  binaryPath?: string | null;
  version?: string | null;
  sdkAvailable: boolean;
  loggedIn: boolean;
};

export function interpretClaudeAuthStatus(payload: unknown): {
  loggedIn: boolean;
  detail: string;
  authMethod?: string;
} {
  if (!payload || typeof payload !== "object") {
    return { loggedIn: false, detail: "invalid-auth-status" };
  }
  const root = payload as Record<string, unknown>;
  const loggedIn = Boolean(root.loggedIn);
  const authMethod =
    typeof root.authMethod === "string" ? root.authMethod : "none";
  const normalized = authMethod.trim().toLowerCase();

  if (!loggedIn) {
    return { loggedIn: false, detail: "auth-status-logged-out", authMethod };
  }

  if (
    normalized === "none" ||
    normalized.includes("api") ||
    normalized.includes("console")
  ) {
    return { loggedIn: false, detail: "api-key-only", authMethod };
  }

  const subscription = ["oauth", "claude", "subscription"].some((hint) =>
    normalized.includes(hint),
  );
  return {
    loggedIn: true,
    detail: subscription ? "auth-status-oauth" : "auth-status-logged-in",
    authMethod,
  };
}

export function probeClaudeAuthStatusCli(options: {
  binaryPath: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  spawnSyncFn?: typeof spawnSync;
}): { loggedIn: boolean; detail: string; authMethod?: string } | null {
  const binaryPath = options.binaryPath.trim();
  if (!binaryPath) return null;
  const spawnSyncFn = options.spawnSyncFn || spawnSync;

  try {
    const result = spawnSyncFn(binaryPath, ["auth", "status", "--json"], {
      encoding: "utf8",
      timeout: 6000,
      env: buildClaudeCodeChildEnv(options.env || process.env) as NodeJS.ProcessEnv,
      windowsHide: true,
    });

    const output = `${result.stdout || ""}`.trim();
    if (!output) return { loggedIn: false, detail: "auth-status-empty" };

    let payload: unknown;
    try {
      payload = JSON.parse(output);
    } catch {
      const start = output.indexOf("{");
      const end = output.lastIndexOf("}");
      if (start < 0 || end <= start) {
        return { loggedIn: false, detail: "auth-status-parse-error" };
      }
      try {
        payload = JSON.parse(output.slice(start, end + 1));
      } catch {
        return { loggedIn: false, detail: "auth-status-parse-error" };
      }
    }

    return interpretClaudeAuthStatus(payload);
  } catch {
    return null;
  }
}

export async function detectClaudeCode(options?: {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir?: string;
  binaryPath?: string | null;
}): Promise<ClaudeDetectResult> {
  const env = options?.env ?? process.env;
  const binaryPath =
    options?.binaryPath !== undefined
      ? options.binaryPath
      : findBinaryOnPath("claude", env);

  if (!binaryPath) {
    return {
      status: "missing-cli",
      statusDetail: "Claude Code CLI (`claude`) not found on PATH",
      binaryPath: null,
      version: null,
      sdkAvailable: false,
      loggedIn: false,
    };
  }

  let version: string | null = null;
  try {
    const result = spawnSync(binaryPath, ["--version"], {
      encoding: "utf8",
      timeout: 4000,
      env: buildClaudeCodeChildEnv(env) as NodeJS.ProcessEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const match = `${result.stdout || ""}`.trim().match(/(\d+\.\d+\.\d+)/);
    version = match?.[1] ?? (`${result.stdout || ""}`.trim() || null);
  } catch {
    version = null;
  }

  const sdk = await probeClaudeAgentSdk();
  if (!sdk.available) {
    return {
      status: "missing-sdk",
      statusDetail: sdk.error || "Claude Agent SDK unavailable",
      binaryPath,
      version,
      sdkAvailable: false,
      loggedIn: false,
    };
  }

  const authStatus = probeClaudeAuthStatusCli({ binaryPath, env });
  const loggedIn =
    Boolean(authStatus?.loggedIn) ||
    hasClaudeCliOAuthCredentials({ homeDir: options?.homeDir, env });

  if (!loggedIn) {
    return {
      status: "needs-login",
      statusDetail:
        "Claude Code is installed but not logged in with a subscription. Run `claude auth login` or use plugin OAuth.",
      binaryPath,
      version,
      sdkAvailable: true,
      loggedIn: false,
    };
  }

  return {
    status: "ready",
    statusDetail: authStatus?.detail || "ready",
    binaryPath,
    version,
    sdkAvailable: true,
    loggedIn: true,
  };
}

export { resolveClaudeCodeExecutable } from "./executable-path.js";
