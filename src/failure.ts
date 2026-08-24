/**
 * Classify terminal Claude turn failures so the proxy can answer with a
 * truthful HTTP status instead of a fake-200 stream that carries the error
 * as assistant text (which makes hosts retry and burn quota on doom loops).
 *
 * Mapping:
 * - auth       → 401 (non-retryable: credentials must be fixed by a human)
 * - rate_limit → 429 + Retry-After (the gate store already knows the reset)
 * - overloaded → 529 + short Retry-After (Anthropic transient overload —
 *                retryable, but never recorded as a hard subscription limit)
 * - unknown    → 500
 */
import {
  isClaudeOverloadedText,
  isClaudeRateLimitText,
} from "./rate-limit.js";

export type ClaudeFailureKind = "auth" | "rate_limit" | "overloaded" | "unknown";

const AUTH_FAILURE_PATTERN =
  /invalid_grant|refresh token (not found|invalid|expired)|invalid[_ -]?api[_ -]?key|authentication_error|authentication failed|unauthorized|not logged in|not authenticated|please (run )?\/?login|oauth token (is )?(expired|invalid|revoked)|access token (is )?(expired|invalid|revoked)|credentials (are )?(expired|invalid|revoked)|token (has )?expired|\b401\b/i;

/** Seconds a client should wait before retrying after a 529 overload. */
export const OVERLOADED_RETRY_AFTER_SECONDS = 30;

export function classifyClaudeFailure(text: string): ClaudeFailureKind {
  if (!text) return "unknown";
  // Overload first: "529 overloaded" texts can also contain generic words
  // that pattern-match the rate-limit detector, and treating a transient
  // overload as a hard subscription limit would wrongly gate turns for
  // minutes.
  if (isClaudeOverloadedText(text)) return "overloaded";
  if (isClaudeRateLimitText(text)) return "rate_limit";
  if (AUTH_FAILURE_PATTERN.test(text)) return "auth";
  return "unknown";
}

export function failureStatusFor(kind: ClaudeFailureKind): number {
  switch (kind) {
    case "auth":
      return 401;
    case "rate_limit":
      return 429;
    case "overloaded":
      return 529;
    default:
      return 500;
  }
}

export function failureTypeFor(kind: ClaudeFailureKind): string {
  switch (kind) {
    case "auth":
      return "authentication_error";
    case "rate_limit":
      return "rate_limit_error";
    case "overloaded":
      return "overloaded_error";
    default:
      return "server_error";
  }
}

/** User-facing guidance appended to hard failures. */
export function failureHintFor(kind: ClaudeFailureKind): string {
  switch (kind) {
    case "auth":
      return "Claude Code credentials are invalid or expired. Run `claude auth login`, then restart OpenCode — retrying is pointless until then.";
    case "rate_limit":
      return "Claude subscription limit is active; wait for the reset instead of retrying.";
    case "overloaded":
      return "Anthropic is temporarily overloaded; retry in about half a minute.";
    default:
      return "";
  }
}
