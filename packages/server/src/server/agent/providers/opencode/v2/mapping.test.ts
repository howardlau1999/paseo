import type { AgentInfo, ModelInfo, SessionInfo } from "@opencode/client";
import { expect, test } from "vitest";
import {
  contextWindowUsedTokensFromV2,
  modelContextWindowLookup,
  modelsFromV2,
  modesFromV2,
  usageFromV2,
} from "./mapping.js";

test("normalizes v2 model capabilities, variants, and visible primary modes", () => {
  const model: ModelInfo = {
    id: "model",
    modelID: "native-model",
    providerID: "provider",
    name: "Model",
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [{ id: "high" }],
    time: { released: 1 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 200000, output: 10000 },
  };
  expect(modelsFromV2([model, { ...model, id: "disabled", enabled: false }])).toEqual([
    {
      provider: "opencode",
      id: "provider/model",
      label: "Model",
      contextWindowMaxTokens: 200000,
      metadata: {
        providerId: "provider",
        modelId: "model",
        supportsAttachments: true,
        supportsToolCall: true,
        contextWindowMaxTokens: 200000,
      },
      thinkingOptions: [{ id: "high", label: "high" }],
    },
  ]);
  const agent: AgentInfo = {
    id: "build",
    name: "Build",
    mode: "primary",
    hidden: false,
    request: { settings: {}, headers: {}, body: {} },
    permissions: [],
  };
  expect(
    modesFromV2([
      agent,
      { ...agent, id: "hidden", hidden: true },
      { ...agent, id: "child", mode: "subagent" },
    ]),
  ).toEqual([{ id: "build", label: "Build", description: undefined }]);
});

const session: SessionInfo = {
  id: "session",
  projectID: "project",
  location: { directory: "/tmp/project" },
  agent: "build",
  model: { providerID: "provider", id: "model" },
  tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 50 } },
  cost: 0.25,
  time: { created: 1, updated: 2 },
};

test("carries context window fields into usage and omits them when unresolved", () => {
  expect(
    usageFromV2(session, { contextWindowMaxTokens: 200_000, contextWindowUsedTokens: 1_175 }),
  ).toEqual({
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 1000,
    totalCostUsd: 0.25,
    contextWindowMaxTokens: 200_000,
    contextWindowUsedTokens: 1_175,
  });
  expect(usageFromV2(session)).toEqual({
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 1000,
    totalCostUsd: 0.25,
  });
});

test("indexes model context limits by provider/model", () => {
  const model = (id: string, providerID: string, context: number): ModelInfo => ({
    id,
    modelID: id,
    providerID,
    name: id,
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 1 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context, output: 1000 },
  });
  const lookup = modelContextWindowLookup([
    model("model", "provider", 200_000),
    model("other", "provider", 400_000),
    { ...model("zero", "provider", 0) },
  ]);
  expect([...lookup]).toEqual([
    ["provider/model", 200_000],
    ["provider/other", 400_000],
  ]);
});

test("reads context occupancy from the latest assistant token totals", () => {
  const assistant = (id: string, tokens?: SessionInfo["tokens"]) => ({
    id,
    type: "assistant" as const,
    agent: "build",
    model: { providerID: "provider", id: "model" },
    time: { created: 1 },
    content: [],
    ...(tokens ? { tokens } : {}),
  });
  const user = {
    id: "user",
    type: "user" as const,
    text: "hi",
    time: { created: 0 },
  };
  // The last assistant message wins; the session cumulative total is not used.
  expect(
    contextWindowUsedTokensFromV2([
      user,
      assistant("first", { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }),
      assistant("latest", {
        input: 200,
        output: 10,
        reasoning: 5,
        cache: { read: 1000, write: 30 },
      }),
    ]),
  ).toBe(1245);
  // A message without tokens is skipped rather than resetting to zero.
  expect(contextWindowUsedTokensFromV2([assistant("tokenless"), assistant("empty")])).toBe(
    undefined,
  );
  expect(contextWindowUsedTokensFromV2([user])).toBe(undefined);
  expect(contextWindowUsedTokensFromV2([])).toBe(undefined);
});
