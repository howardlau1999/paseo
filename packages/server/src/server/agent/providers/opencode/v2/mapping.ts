import type {
  AgentInfo,
  ModelInfo,
  ModelRef,
  SessionInfo,
  SessionMessageInfo,
} from "@opencode/client";
import type { AgentMode, AgentModelDefinition, AgentUsage } from "../../../agent-sdk-types.js";

export function modelRef(id: string, variant?: string | null): ModelRef {
  const slash = id.indexOf("/");
  if (slash < 1 || slash === id.length - 1)
    throw new Error("OpenCode model must be provider/model");
  return {
    providerID: id.slice(0, slash),
    id: id.slice(slash + 1),
    ...(variant ? { variant } : {}),
  };
}

export function modelsFromV2(models: ModelInfo[]): AgentModelDefinition[] {
  return models
    .filter((model) => model.enabled)
    .map((model) => ({
      provider: "opencode",
      id: `${model.providerID}/${model.id}`,
      label: model.name,
      contextWindowMaxTokens: model.limit.context,
      metadata: {
        providerId: model.providerID,
        modelId: model.id,
        supportsAttachments: model.capabilities.input.includes("image"),
        supportsToolCall: model.capabilities.tools,
        contextWindowMaxTokens: model.limit.context,
      },
      thinkingOptions: model.variants.map((variant) => ({ id: variant.id, label: variant.id })),
    }));
}

export function modesFromV2(agents: AgentInfo[]): AgentMode[] {
  return agents
    .filter((agent) => !agent.hidden && agent.mode !== "subagent")
    .map((agent) => ({ id: agent.id, label: agent.name, description: agent.description }));
}

export function usageFromV2(
  session: SessionInfo,
  context: { contextWindowMaxTokens?: number; contextWindowUsedTokens?: number } = {},
): AgentUsage {
  return {
    inputTokens: session.tokens.input,
    outputTokens: session.tokens.output,
    cachedInputTokens: session.tokens.cache.read,
    totalCostUsd: session.cost,
    // Context window fields are optional: the daemon merges usage into the agent state, so an
    // explicit `undefined` would erase context data resolved by an earlier turn.
    ...(context.contextWindowMaxTokens !== undefined
      ? { contextWindowMaxTokens: context.contextWindowMaxTokens }
      : {}),
    ...(context.contextWindowUsedTokens !== undefined
      ? { contextWindowUsedTokens: context.contextWindowUsedTokens }
      : {}),
  };
}

/** Selected model context limits keyed by `providerID/modelID`, mirroring `modelRef`. */
export function modelContextWindowLookup(models: ModelInfo[]): Map<string, number> {
  const lookup = new Map<string, number>();
  for (const model of models) {
    const context = model.limit?.context;
    if (typeof context === "number" && Number.isFinite(context) && context > 0)
      lookup.set(`${model.providerID}/${model.id}`, context);
  }
  return lookup;
}

/**
 * Current context occupancy: the token total of the most recent assistant message, not the
 * session cumulative `session.tokens`. Session totals grow across turns and would read as a
 * nearly full window even after a compaction.
 */
export function contextWindowUsedTokensFromV2(history: SessionMessageInfo[]): number | undefined {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message?.type !== "assistant" || !message.tokens) continue;
    const tokens = message.tokens;
    const total =
      tokens.input +
      tokens.output +
      tokens.reasoning +
      (tokens.cache?.read ?? 0) +
      (tokens.cache?.write ?? 0);
    if (Number.isFinite(total) && total > 0) return total;
  }
  return undefined;
}
