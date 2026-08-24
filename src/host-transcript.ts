/**
 * Host-transcript ownership and divergence detection.
 *
 * On resumed turns the proxy normally ignores the host's prior messages —
 * history comes from the Claude-side session transcript that `resume` points
 * at. Host plugins that rewrite conversation history through
 * `experimental.chat.messages.transform` (e.g. @tarquinen/opencode-dcp) would
 * silently have no effect after the first turn.
 *
 * This module fingerprints the non-system messages of each request so the
 * proxy can detect when the incoming array is no longer an extension of what
 * it saw last turn (messages dropped, replaced, or edited). On divergence the
 * proxy abandons the Claude session and rebuilds from the host array, so the
 * transformed history is what actually reaches Claude.
 *
 * System messages are excluded on purpose: the proxy deliberately drops them
 * (the Claude Code preset supplies the agent system prompt), and hosts vary
 * them between turns.
 */
import { createHash } from "node:crypto";
import {
  contentHasAttachments,
  extractTextContent,
  type ConversationHistoryMessage,
} from "./prompt.js";

export type HostTranscriptDigest = {
  /** Non-system message count of the fingerprinted array. */
  count: number;
  /** Cumulative chain hash over all non-system messages. */
  hash: string;
};

export type HostTranscriptFingerprint = HostTranscriptDigest & {
  /** chain[i] = cumulative hash after non-system message i. */
  chain: string[];
};

export type HostTranscriptDivergence =
  | { diverged: false }
  | {
      diverged: true;
      /** "shrunk": messages were dropped; "rewritten": content replaced. */
      reason: "shrunk" | "rewritten";
      sentCount: number;
      incomingCount: number;
    };

function isTruthyFlag(raw: string | undefined): boolean {
  const value = (raw || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "always" || value === "on";
}

function isFalsyFlag(raw: string | undefined): boolean {
  const value = (raw || "").trim().toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "warn";
}

/**
 * Opt-in "host owns the transcript" mode: never resume a Claude session —
 * rebuild the conversation from the (possibly transformed) host array every
 * turn. Guarantees transform plugins always take effect, at the cost of
 * Claude-side context features (prompt caching across turns, auto-compact
 * continuity) and a bigger prompt per turn.
 */
export function hostOwnsTranscript(): boolean {
  return isTruthyFlag(process.env.OPENCODE_CLAUDE_HOST_TRANSCRIPT);
}

/**
 * Default-on: a detected divergence rebuilds from the host array instead of
 * resuming. `OPENCODE_CLAUDE_DIVERGENCE_REBUILD=0` downgrades to warn-only
 * (the divergence is logged but the Claude transcript still wins).
 */
export function divergenceRebuildEnabled(): boolean {
  return !isFalsyFlag(process.env.OPENCODE_CLAUDE_DIVERGENCE_REBUILD);
}

/**
 * Per-message signature. Text content is normalized through
 * extractTextContent + trim so string vs part-array shapes of the same text
 * do not register as a rewrite.
 */
function messageSignature(msg: ConversationHistoryMessage): string {
  const role = typeof msg.role === "string" ? msg.role : "";
  const text = extractTextContent(msg.content).trim();
  const attachments = contentHasAttachments(msg.content) ? "+attachments" : "";
  const toolCalls = (msg.tool_calls ?? [])
    .map((call) => `${call?.id ?? ""}:${call?.function?.name ?? ""}`)
    .join(",");
  const toolCallId =
    typeof msg.tool_call_id === "string" ? msg.tool_call_id : "";
  return [role, text, attachments, toolCalls, toolCallId].join("\u0000");
}

/**
 * Cumulative chain hash over the non-system messages. chain[i] depends on
 * messages 0..i, so "stored digest is a prefix of the incoming array" is a
 * single comparison against chain[stored.count - 1].
 */
export function fingerprintHostMessages(
  messages: ConversationHistoryMessage[],
): HostTranscriptFingerprint {
  const chain: string[] = [];
  let acc = "";
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || msg.role === "system") continue;
    acc = createHash("sha1")
      .update(acc)
      .update("\u0001")
      .update(messageSignature(msg))
      .digest("hex");
    chain.push(acc);
  }
  return { count: chain.length, hash: acc, chain };
}

/**
 * Compare what the host sent last turn against the incoming array. No stored
 * digest (first turn, migrated store) never counts as divergence.
 */
export function detectHostTranscriptDivergence(
  stored: HostTranscriptDigest | undefined,
  incoming: HostTranscriptFingerprint,
): HostTranscriptDivergence {
  if (!stored || stored.count <= 0) return { diverged: false };
  if (incoming.count < stored.count) {
    return {
      diverged: true,
      reason: "shrunk",
      sentCount: stored.count,
      incomingCount: incoming.count,
    };
  }
  if (incoming.chain[stored.count - 1] !== stored.hash) {
    return {
      diverged: true,
      reason: "rewritten",
      sentCount: stored.count,
      incomingCount: incoming.count,
    };
  }
  return { diverged: false };
}
