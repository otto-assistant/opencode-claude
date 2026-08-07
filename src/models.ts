/**
 * Claude Code model catalog (from OpenChamber harness registry).
 */
import { EFFORT_LEVELS, type ClaudeEffort } from "./constants.js";

export type ClaudeModel = {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  resolvedId?: string;
};

const LIMIT_1M = { context: 1_000_000, output: 128_000 } as const;
const LIMIT_200K = { context: 200_000, output: 64_000 } as const;

function model(
  id: string,
  name: string,
  limit: { context: number; output: number },
  resolvedId?: string,
): ClaudeModel {
  return {
    id,
    name,
    reasoning: true,
    contextWindow: limit.context,
    maxTokens: limit.output,
    ...(resolvedId ? { resolvedId } : {}),
  };
}

const ALIAS_MODELS: ClaudeModel[] = [
  model("fable", "Fable 5", LIMIT_1M),
  model("opus", "Opus 5", LIMIT_1M),
  model("sonnet", "Sonnet 5", LIMIT_1M),
  model("haiku", "Haiku 4.5", LIMIT_200K, "claude-haiku-4-5"),
];

const PINNED_MODELS: ClaudeModel[] = [
  model("claude-opus-4-8", "Opus 4.8", LIMIT_1M),
  model("claude-sonnet-4-6", "Sonnet 4.6", LIMIT_1M),
  model("claude-haiku-4-5", "Haiku 4.5", LIMIT_200K),
];

function buildCatalog(): ClaudeModel[] {
  const aliasResolved = new Set(
    ALIAS_MODELS.map((m) => m.resolvedId).filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    ),
  );
  const aliasNames = new Set(ALIAS_MODELS.map((m) => m.name));
  const visiblePins = PINNED_MODELS.filter(
    (m) => !aliasResolved.has(m.id) && !aliasNames.has(m.name),
  );
  return [...ALIAS_MODELS, ...visiblePins];
}

export const CLAUDE_CODE_MODELS: ClaudeModel[] = buildCatalog();

/** Placeholder so OpenCode keeps the provider visible while logged out. */
export const LOGIN_PLACEHOLDER_MODELS: ClaudeModel[] = [
  {
    id: "login",
    name: "Sign in to Claude Code",
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: 8_192,
  },
];

export function isLoginPlaceholderModel(id: string): boolean {
  return id === "login";
}

export function getClaudeModels(): ClaudeModel[] {
  return CLAUDE_CODE_MODELS;
}

export function resolveClaudeModelId(modelId: string): string {
  const match = CLAUDE_CODE_MODELS.find((m) => m.id === modelId);
  if (!match) return modelId;
  return match.resolvedId || match.id;
}

export function buildEffortVariants(
  model: ClaudeModel,
): Record<string, { effort: ClaudeEffort }> {
  if (!model.reasoning || isLoginPlaceholderModel(model.id)) return {};
  return Object.fromEntries(
    EFFORT_LEVELS.map((effort) => [effort, { effort }]),
  );
}
