import { EFFORT_HEADER, isClaudeEffort, type ClaudeEffort } from "./constants.js";

export { EFFORT_HEADER };

export type ClaudeModelSelection = {
  modelId: string;
  effort?: ClaudeEffort;
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
    return parsed;
  } catch {
    return null;
  }
}

export function resolveClaudeModelSelection(
  modelId: string,
  variant?: string,
): ClaudeModelSelection {
  const effort = isClaudeEffort(variant) ? variant : undefined;
  return { modelId, ...(effort ? { effort } : {}) };
}
