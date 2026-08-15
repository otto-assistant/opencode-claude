import { EFFORT_HEADER, isClaudeEffort, type ClaudeEffort } from "./constants.js";
import { parseAccountModelId } from "./models.js";

export { EFFORT_HEADER };

export type ClaudeModelSelection = {
  modelId: string;
  effort?: ClaudeEffort;
  /**
   * Claude account this turn belongs to, when the operator runs several
   * subscriptions. Absent means "the session's account, else the default".
   */
  account?: string;
};

export function encodeClaudeModelSelection(
  selection: ClaudeModelSelection,
): string {
  return Buffer.from(JSON.stringify(selection), "utf8").toString("base64url");
}

export function decodeClaudeModelSelection(
  value: string | null | undefined,
): ClaudeModelSelection | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as ClaudeModelSelection;
    if (!parsed || typeof parsed.modelId !== "string") return null;
    if (parsed.effort !== undefined && !isClaudeEffort(parsed.effort)) {
      delete parsed.effort;
    }
    if (parsed.account !== undefined && typeof parsed.account !== "string") {
      delete parsed.account;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Selection for a chosen model id. `opus@work` splits into the real model and
 * the account, so the account travels with the model the operator picked —
 * no separate switch to keep in sync.
 */
export function resolveClaudeModelSelection(
  modelId: string,
  variant?: string,
): ClaudeModelSelection {
  const effort = isClaudeEffort(variant) ? variant : undefined;
  const { baseModelId, accountId } = parseAccountModelId(modelId);
  return {
    modelId: baseModelId || modelId,
    ...(effort ? { effort } : {}),
    ...(accountId ? { account: accountId } : {}),
  };
}
