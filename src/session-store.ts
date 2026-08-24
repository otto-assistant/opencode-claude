/**
 * Sticky foreign Claude session IDs for Agent SDK resume
 * (OpenChamber harness session-bindings pattern, scoped to this proxy).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HostTranscriptDigest } from "./host-transcript.js";

export type ClaudeSessionBinding = {
  conversationKey: string;
  /** Absent while only a host-transcript digest has been recorded. */
  foreignSessionId?: string;
  modelId?: string;
  cwd?: string;
  /** Fingerprint of the host messages array sent last turn. */
  hostDigest?: HostTranscriptDigest;
  updatedAt: number;
};

function storePath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode-claude", "sessions.json");
}

function readStore(): Record<string, ClaudeSessionBinding> {
  const path = storePath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      ClaudeSessionBinding
    >;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, ClaudeSessionBinding>): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", "utf8");
}

export function getForeignSessionId(
  conversationKey: string,
): string | undefined {
  const entry = readStore()[conversationKey];
  return entry?.foreignSessionId;
}

export function setForeignSessionId(
  conversationKey: string,
  foreignSessionId: string,
  meta?: { modelId?: string; cwd?: string },
): void {
  const store = readStore();
  // Merge so the host-transcript digest recorded at turn start survives the
  // session_id events that arrive later in the same turn.
  store[conversationKey] = {
    ...store[conversationKey],
    conversationKey,
    foreignSessionId,
    modelId: meta?.modelId,
    cwd: meta?.cwd,
    updatedAt: Date.now(),
  };
  writeStore(store);
}

export function clearForeignSessionId(conversationKey: string): void {
  const store = readStore();
  if (!(conversationKey in store)) return;
  delete store[conversationKey];
  writeStore(store);
}

export function getHostTranscriptDigest(
  conversationKey: string,
): HostTranscriptDigest | undefined {
  const digest = readStore()[conversationKey]?.hostDigest;
  return digest &&
    Number.isInteger(digest.count) &&
    digest.count >= 0 &&
    typeof digest.hash === "string"
    ? digest
    : undefined;
}

export function setHostTranscriptDigest(
  conversationKey: string,
  digest: HostTranscriptDigest,
): void {
  const store = readStore();
  store[conversationKey] = {
    ...store[conversationKey],
    conversationKey,
    hostDigest: digest,
    updatedAt: Date.now(),
  };
  writeStore(store);
}

/**
 * Stable key from OpenAI messages so follow-ups resume the same Claude session.
 * Hashes the first user message only — including the message count made the key
 * change on every turn, which defeated resume entirely when the session header
 * is absent.
 */
export function conversationKeyFromMessages(
  messages: Array<{ role?: string; content?: unknown }>,
): string {
  const firstUser = messages.find((m) => m.role === "user");
  const seed =
    typeof firstUser?.content === "string"
      ? firstUser.content.slice(0, 200)
      : JSON.stringify(firstUser?.content ?? "").slice(0, 200);
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `conv_${hash.toString(16)}`;
}

/**
 * Locate the Claude Code transcript for a foreign session id. The Agent SDK
 * resumes via the claude CLI, which looks the session up under
 * ~/.claude/projects/<cwd-slug>/ — a missing file means resume silently starts
 * (or errors into) a context-free session, so callers must fall back to
 * history injection instead.
 */
export function findClaudeSessionFile(
  foreignSessionId: string,
): string | null {
  const id = foreignSessionId.trim();
  if (!id) return null;
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const projectsDir = join(configDir, "projects");
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    const candidate = join(projectsDir, dir, `${id}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
