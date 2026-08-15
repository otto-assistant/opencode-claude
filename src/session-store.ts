/**
 * Sticky foreign Claude session IDs for Agent SDK resume
 * (OpenChamber harness session-bindings pattern, scoped to this proxy).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type ClaudeSessionBinding = {
  conversationKey: string;
  foreignSessionId: string;
  modelId?: string;
  cwd?: string;
  /** Claude account this conversation is bound to (multi-account setups). */
  accountId?: string;
  /** Label of that account at bind time — for read-only displays. */
  accountLabel?: string;
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
  // An account-only stub (bound, but no Claude session yet) carries an empty
  // id. Returning it would hand `resume: ""` to the Agent SDK.
  return entry?.foreignSessionId || undefined;
}

/** Full binding for a conversation — account included. */
export function getSessionBinding(
  conversationKey: string,
): ClaudeSessionBinding | null {
  return readStore()[conversationKey] ?? null;
}

/** Repoint every session bound to an old account id (see renameAccount). */
export function renameBoundAccount(oldId: string, newId: string, newLabel: string): void {
  const store = readStore();
  let touched = false;
  for (const [key, binding] of Object.entries(store)) {
    if (binding.accountId !== oldId) continue;
    store[key] = { ...binding, accountId: newId, accountLabel: newLabel };
    touched = true;
  }
  if (touched) writeStore(store);
}

/** Every stored binding, newest first. Backs the read-only `/v1/sessions` view. */
export function listSessionBindings(): ClaudeSessionBinding[] {
  return Object.values(readStore()).sort(
    (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );
}

/**
 * Account a conversation is already running on, if any. The proxy uses this to
 * keep a session on its account across turns even when the request carries no
 * account of its own.
 */
export function getBoundAccountId(
  conversationKey: string,
): string | undefined {
  return readStore()[conversationKey]?.accountId;
}

/**
 * Record which account owns a conversation, before any Claude session exists.
 * Called on the first turn so the binding is visible even if that turn dies.
 */
export function bindConversationAccount(
  conversationKey: string,
  accountId: string,
  accountLabel: string,
): void {
  const store = readStore();
  const existing = store[conversationKey];
  if (existing?.accountId === accountId) return;
  store[conversationKey] = {
    ...(existing ?? { conversationKey, foreignSessionId: "" }),
    conversationKey,
    // Switching account invalidates the resume target: the transcript lives in
    // the other account's Claude home and resuming it there would either fail
    // or, worse, silently continue someone else's conversation.
    foreignSessionId:
      existing && existing.accountId && existing.accountId !== accountId
        ? ""
        : (existing?.foreignSessionId ?? ""),
    accountId,
    accountLabel,
    updatedAt: Date.now(),
  };
  writeStore(store);
}

export function setForeignSessionId(
  conversationKey: string,
  foreignSessionId: string,
  meta?: {
    modelId?: string;
    cwd?: string;
    accountId?: string;
    accountLabel?: string;
  },
): void {
  const store = readStore();
  const existing = store[conversationKey];
  store[conversationKey] = {
    conversationKey,
    foreignSessionId,
    modelId: meta?.modelId,
    cwd: meta?.cwd,
    accountId: meta?.accountId ?? existing?.accountId,
    accountLabel: meta?.accountLabel ?? existing?.accountLabel,
    updatedAt: Date.now(),
  };
  writeStore(store);
}

/**
 * Drop the resume target. The account binding survives: a dead transcript says
 * nothing about which subscription the conversation belongs to, and losing it
 * would silently move the session to the default account on the next turn.
 */
export function clearForeignSessionId(conversationKey: string): void {
  const store = readStore();
  const existing = store[conversationKey];
  if (!existing) return;
  if (!existing.accountId) {
    delete store[conversationKey];
  } else {
    store[conversationKey] = {
      ...existing,
      foreignSessionId: "",
      updatedAt: Date.now(),
    };
  }
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
  claudeConfigDir?: string,
): string | null {
  const id = foreignSessionId.trim();
  if (!id) return null;
  // The account's Claude home wins: each account keeps its own transcripts, and
  // probing the proxy's ambient dir would declare every non-default account's
  // session dead and re-inject history on every single turn.
  const configDir =
    claudeConfigDir?.trim() ||
    process.env.CLAUDE_CONFIG_DIR ||
    join(homedir(), ".claude");
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
