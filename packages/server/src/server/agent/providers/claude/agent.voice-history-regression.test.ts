import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";
import { streamSession } from "../test-utils/session-stream-adapter.js";
import { wrapSpokenInput } from "../../../voice-config.js";
import type { AgentPersistenceHandle, AgentStreamEvent } from "../../agent-sdk-types.js";

const queryFactory = vi.fn();
let lastQuery: ReturnType<typeof buildSdkQueryMock> | null = null;

const LIVE_REPLY_MARKER = "LIVE_ONLY_REPLY_MARKER";
const HISTORY_USER_MARKER = "HISTORY_ONLY_USER_MARKER";
const HISTORY_ASSISTANT_MARKER = "HISTORY_ONLY_ASSISTANT_MARKER";
const HISTORY_SIDECHAIN_MARKER = "HISTORY_ONLY_SIDECHAIN_MARKER";

function buildSdkQueryMock(
  events: unknown[] = [
    {
      type: "system",
      subtype: "init",
      session_id: "history-session",
      permissionMode: "default",
      model: "opus",
    },
    {
      type: "assistant",
      message: {
        content: LIVE_REPLY_MARKER,
      },
    },
    {
      type: "result",
      subtype: "success",
      usage: {
        input_tokens: 1,
        cache_read_input_tokens: 0,
        output_tokens: 1,
      },
      total_cost_usd: 0,
    },
  ],
) {
  let index = 0;
  return {
    next: vi.fn(async () => {
      if (index >= events.length) {
        return { done: true, value: undefined };
      }
      const value = events[index];
      index += 1;
      return { done: false, value };
    }),
    interrupt: vi.fn(async () => undefined),
    return: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function collectTimelineText(events: AgentStreamEvent[]): string {
  const chunks: string[] = [];
  for (const event of events) {
    if (event.type !== "timeline") {
      continue;
    }
    if (event.item.type === "user_message") {
      chunks.push(event.item.text);
    }
    if (event.item.type === "assistant_message") {
      chunks.push(event.item.text);
    }
  }
  return chunks.join("\n");
}

describe("ClaudeAgentSession history replay regression", () => {
  let tempRoot: string;
  let cwd: string;
  let configDir: string;
  let previousClaudeConfigDir: string | undefined;

  beforeEach(() => {
    queryFactory.mockImplementation(() => {
      const mock = buildSdkQueryMock();
      lastQuery = mock;
      return mock;
    });

    tempRoot = mkdtempSync(path.join(os.tmpdir(), "claude-history-regression-"));
    cwd = path.join(tempRoot, "Michael Depies", "repo");
    configDir = path.join(tempRoot, "claude-config");
    mkdirSync(cwd, { recursive: true });

    const historyDir = claudeProjectDirSync(cwd, { configDir });
    mkdirSync(historyDir, { recursive: true });
    const historyPath = path.join(historyDir, "history-session.jsonl");
    writeFileSync(
      historyPath,
      [
        JSON.stringify({
          type: "user",
          uuid: "history-user-uuid",
          sessionId: "history-session",
          cwd,
          message: {
            role: "user",
            content: HISTORY_USER_MARKER,
          },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "history-session",
          cwd,
          message: {
            role: "assistant",
            content: HISTORY_ASSISTANT_MARKER,
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "history-task-call-message",
          sessionId: "history-session",
          cwd,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "history-task-call",
                name: "Agent",
                input: {
                  name: "history_researcher",
                  subagent_type: "Explore",
                  description: "Inspect persisted history",
                },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "assistant",
          isSidechain: true,
          agentId: "history-child",
          uuid: "history-child-message",
          timestamp: "2026-07-12T10:00:01.000Z",
          sessionId: "history-session",
          cwd,
          message: {
            id: "history-child-message",
            role: "assistant",
            content: [{ type: "text", text: HISTORY_SIDECHAIN_MARKER }],
          },
        }),
        JSON.stringify({
          type: "user",
          sessionId: "history-session",
          cwd,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "history-task-call",
                content: "done\nagentId: history-child",
              },
            ],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    queryFactory.mockReset();
    lastQuery = null;
    if (previousClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("does not replay persisted history during the first live stream turn", async () => {
    const logger = createTestLogger();
    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const handle: AgentPersistenceHandle = {
      provider: "claude",
      sessionId: "history-session",
      nativeHandle: "history-session",
      metadata: {
        provider: "claude",
        cwd,
      },
    };

    const session = await client.resumeSession(handle, { cwd });
    const events: AgentStreamEvent[] = [];

    try {
      for await (const event of streamSession(session, "Say hello")) {
        events.push(event);
        if (
          event.type === "turn_completed" ||
          event.type === "turn_failed" ||
          event.type === "turn_canceled"
        ) {
          break;
        }
      }
    } finally {
      await session.close();
    }

    const timelineText = collectTimelineText(events);
    expect(timelineText).toContain(LIVE_REPLY_MARKER);
    expect(timelineText).not.toContain(HISTORY_USER_MARKER);
    expect(timelineText).not.toContain(HISTORY_ASSISTANT_MARKER);
  });

  test("shows only spoken text for a live Claude voice reply", async () => {
    queryFactory.mockImplementation(() =>
      buildSdkQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "history-session",
          permissionMode: "default",
          model: "opus",
        },
        {
          type: "assistant",
          uuid: "voice-answer",
          message: {
            content: [
              { type: "text", text: "Extra introduction." },
              {
                type: "tool_use",
                id: "voice-call",
                name: "mcp__paseo__speak",
                input: { text: "The spoken reply." },
              },
            ],
          },
        },
        {
          type: "assistant",
          uuid: "voice-extra-final",
          message: { content: [{ type: "text", text: "Extra final summary." }] },
        },
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
          total_cost_usd: 0,
        },
      ]),
    );
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.resumeSession(
      {
        provider: "claude",
        sessionId: "history-session",
        nativeHandle: "history-session",
        metadata: { provider: "claude", cwd },
      },
      { cwd },
    );
    const events: AgentStreamEvent[] = [];
    try {
      for await (const event of streamSession(session, wrapSpokenInput("Say hello"))) {
        events.push(event);
        if (event.type === "turn_completed" || event.type === "turn_failed") break;
      }
    } finally {
      await session.close();
    }

    expect(
      events.filter(
        (event) => event.type === "timeline" && event.item.type === "assistant_message",
      ),
    ).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        item: expect.objectContaining({
          type: "tool_call",
          name: "speak",
          detail: { type: "unknown", input: "The spoken reply.", output: null },
        }),
      }),
    );
  });

  test("replays Claude voice history without extra assistant text", async () => {
    const historyPath = path.join(
      claudeProjectDirSync(cwd, { configDir }),
      "history-session.jsonl",
    );
    writeFileSync(
      historyPath,
      [
        {
          type: "user",
          uuid: "voice-user",
          message: { role: "user", content: wrapSpokenInput("Say hello") },
        },
        {
          type: "assistant",
          uuid: "voice-answer",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Extra introduction." },
              {
                type: "tool_use",
                id: "voice-call",
                name: "mcp__paseo__speak",
                input: { text: "The spoken reply." },
              },
            ],
          },
        },
        {
          type: "assistant",
          uuid: "voice-extra-final",
          message: { role: "assistant", content: "Extra final summary." },
        },
        {
          type: "user",
          uuid: "typed-user",
          message: { role: "user", content: "Typed prompt" },
        },
        {
          type: "assistant",
          uuid: "typed-answer",
          message: { role: "assistant", content: "Normal written reply." },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
      "utf8",
    );
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.resumeSession(
      {
        provider: "claude",
        sessionId: "history-session",
        nativeHandle: "history-session",
        metadata: { provider: "claude", cwd },
      },
      { cwd },
    );
    const events: AgentStreamEvent[] = [];
    try {
      for await (const event of session.streamHistory()) events.push(event);
    } finally {
      await session.close();
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        item: expect.objectContaining({ type: "tool_call", name: "speak" }),
      }),
    );
    expect(collectTimelineText(events)).toContain("Normal written reply.");
    expect(collectTimelineText(events)).not.toContain("Extra introduction.");
    expect(collectTimelineText(events)).not.toContain("Extra final summary.");
  });

  test("still exposes persisted history through streamHistory", async () => {
    const logger = createTestLogger();
    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const handle: AgentPersistenceHandle = {
      provider: "claude",
      sessionId: "history-session",
      nativeHandle: "history-session",
      metadata: {
        provider: "claude",
        cwd,
      },
    };

    const session = await client.resumeSession(handle, { cwd });
    const historyEvents: AgentStreamEvent[] = [];

    try {
      for await (const event of session.streamHistory()) {
        historyEvents.push(event);
      }
    } finally {
      await session.close();
    }

    const timelineText = collectTimelineText(historyEvents);
    expect(timelineText).toContain(HISTORY_USER_MARKER);
    expect(timelineText).toContain(HISTORY_ASSISTANT_MARKER);
  });

  test("replays persisted sidechains as provider subagent timelines", async () => {
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.resumeSession(
      {
        provider: "claude",
        sessionId: "history-session",
        nativeHandle: "history-session",
        metadata: { provider: "claude", cwd },
      },
      { cwd },
    );
    const historyEvents: AgentStreamEvent[] = [];

    try {
      for await (const event of session.streamHistory()) historyEvents.push(event);
    } finally {
      await session.close();
    }

    expect(historyEvents).toContainEqual({
      type: "provider_subagent",
      provider: "claude",
      event: {
        type: "timeline",
        id: "history-task-call",
        item: {
          type: "assistant_message",
          text: HISTORY_SIDECHAIN_MARKER,
          messageId: "history-child-message",
        },
        timestamp: "2026-07-12T10:00:01.000Z",
      },
    });
    expect(historyEvents).toContainEqual({
      type: "provider_subagent",
      provider: "claude",
      event: expect.objectContaining({
        type: "upsert",
        id: "history-task-call",
        title: "history_researcher",
        status: "running",
      }),
    });
    expect(historyEvents).toContainEqual({
      type: "provider_subagent",
      provider: "claude",
      event: expect.objectContaining({
        type: "upsert",
        id: "history-task-call",
        status: "completed",
      }),
    });
  });

  test("listCommands includes rewind command", async () => {
    const logger = createTestLogger();
    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const handle: AgentPersistenceHandle = {
      provider: "claude",
      sessionId: "history-session",
      nativeHandle: "history-session",
      metadata: {
        provider: "claude",
        cwd,
      },
    };

    const session = await client.resumeSession(handle, { cwd });
    try {
      const commands = await session.listCommands?.();
      expect(commands?.some((command) => command.name === "rewind")).toBe(true);
    } finally {
      await session.close();
    }
  });

  test("slash /rewind uses latest user message id from persisted history", async () => {
    const logger = createTestLogger();
    const client = new ClaudeAgentClient({
      logger,
      queryFactory,
      resolveBinary: async () => "/test/claude/bin",
    });
    const handle: AgentPersistenceHandle = {
      provider: "claude",
      sessionId: "history-session",
      nativeHandle: "history-session",
      metadata: {
        provider: "claude",
        cwd,
      },
    };

    const session = await client.resumeSession(handle, { cwd });
    const events: AgentStreamEvent[] = [];

    try {
      for await (const event of streamSession(session, "/rewind")) {
        events.push(event);
        if (
          event.type === "turn_completed" ||
          event.type === "turn_failed" ||
          event.type === "turn_canceled"
        ) {
          break;
        }
      }
    } finally {
      await session.close();
    }

    expect(events.some((event) => event.type === "turn_started")).toBe(true);
    expect(events.some((event) => event.type === "turn_completed")).toBe(true);
    expect(lastQuery).toBeTruthy();
    expect(lastQuery?.rewindFiles).toHaveBeenCalledTimes(1);
    expect(lastQuery?.rewindFiles).toHaveBeenCalledWith("history-user-uuid", {
      dryRun: false,
    });
  });
});
