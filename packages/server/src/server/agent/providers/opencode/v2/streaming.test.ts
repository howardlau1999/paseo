import { V2Timeline } from "./timeline.js";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SessionMessageAssistant } from "@opencode/client";
import { describe, expect, test } from "vitest";
import { OpenCodeV2AgentClient } from "./agent.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { wrapSpokenInput } from "../../../../voice-config.js";
import type { AgentStreamEvent } from "../../../agent-sdk-types.js";

function collectAssistantText(session: {
  subscribe: (cb: (e: AgentStreamEvent) => void) => () => void;
}) {
  const chunks: string[] = [];
  session.subscribe((event) => {
    if (event.type === "timeline" && event.item.type === "assistant_message")
      chunks.push(event.item.text);
  });
  return chunks;
}

function assistant(content: SessionMessageAssistant["content"]): SessionMessageAssistant {
  return {
    id: "answer",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "model" },
    time: { created: 2 },
    content,
  };
}

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X1r0AAAAASUVORK5CYII=";

describe("OpenCode v2 token streaming", () => {
  test("emits text and reasoning deltas as they arrive", async () => {
    const harness = new V2Harness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const text = collectAssistantText(session);
    const reasoning: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "reasoning")
        reasoning.push(event.item.text);
    });
    try {
      harness.push({
        id: "rs",
        created: 2,
        type: "session.reasoning.started",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0 },
      });
      harness.push({
        id: "r1",
        created: 3,
        type: "session.reasoning.delta",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0, delta: "think" },
      });
      harness.push({
        id: "ts",
        created: 2,
        type: "session.text.started",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0 },
      });
      harness.push({
        id: "t1",
        created: 4,
        type: "session.text.delta",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0, delta: "Hel" },
      });
      harness.push({
        id: "t2",
        created: 5,
        type: "session.text.delta",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0, delta: "lo" },
      });
      await expect.poll(() => text).toEqual(["Hel", "lo"]);
      expect(reasoning).toEqual(["think"]);
    } finally {
      await session.close();
    }
  });

  test("deduplicates snapshots before and after deltas using per-type ordinals", () => {
    const timeline = new V2Timeline();
    const text = { assistantMessageID: "answer", type: "text", ordinal: 0 } as const;
    const reasoning = { ...text, type: "reasoning" } as const;
    timeline.startPart(text);
    timeline.startPart(reasoning);
    expect(timeline.delta({ ...text, delta: "Hel" })).toMatchObject({ item: { text: "Hel" } });
    expect(timeline.delta({ ...reasoning, delta: "think" })).toMatchObject({
      item: { text: "think" },
    });
    const snapshot = assistant([
      {
        type: "reasoning",
        text: "think",
        state: { reasoningField: "reasoning_content" },
        time: { created: 2, completed: 2 },
      },
      { type: "text", text: "Hello" },
    ]);
    expect(timeline.messages([snapshot])).toMatchObject([{ item: { text: "lo" } }]);
    expect(timeline.delta({ ...text, delta: "lo" })).toBeNull();
    expect(timeline.messages([snapshot])).toEqual([]);
    expect(timeline.delta({ ...text, delta: "!" })).toMatchObject({ item: { text: "!" } });
    expect(timeline.messages([snapshot])).toEqual([]);
  });

  test("recovers missed fragments from snapshots after reconnect", () => {
    const timeline = new V2Timeline();
    const part = { assistantMessageID: "answer", type: "text", ordinal: 0 } as const;
    timeline.startPart(part);
    expect(timeline.delta({ ...part, delta: "Hel" })).toMatchObject({ item: { text: "Hel" } });
    timeline.resetStreams();
    expect(timeline.delta({ ...part, delta: "!" })).toBeNull();
    expect(timeline.messages([assistant([{ type: "text", text: "Hello!" }])])).toMatchObject([
      { item: { text: "lo!" } },
    ]);
    expect(timeline.messages([assistant([{ type: "text", text: "Hello!" }])])).toEqual([]);
  });

  test("shows OpenCode speech text while the speak tool is still running", () => {
    const timeline = new V2Timeline();
    const running = assistant([
      {
        type: "tool",
        id: "voice-call",
        name: "paseo_speak",
        time: { created: 2 },
        state: {
          status: "running",
          input: { text: "I can speak and show this text." },
          metadata: {},
        },
      },
    ]);
    expect(timeline.messages([running])).toMatchObject([
      {
        item: {
          type: "tool_call",
          callId: "voice-call",
          name: "speak",
          status: "running",
          detail: { type: "unknown", input: "I can speak and show this text." },
        },
      },
    ]);
    expect(timeline.messages([running])).toEqual([]);
    const completed = assistant([
      {
        ...running.content[0],
        state: {
          status: "completed",
          input: { text: "I can speak and show this text." },
          content: [{ type: "text", text: "ok" }],
        },
      },
    ]);
    expect(timeline.messages([completed])).toMatchObject([
      { item: { callId: "voice-call", name: "speak", status: "completed" } },
    ]);
  });

  test("keeps OpenCode voice replies identical to the spoken text", () => {
    const timeline = new V2Timeline();
    const spoken = {
      id: "voice-user",
      type: "user",
      text: wrapSpokenInput("Write a poem"),
      time: { created: 1 },
    } satisfies SessionMessageInfo;
    const voiceAnswer = assistant([
      { type: "text", text: "Extra introduction." },
      {
        type: "tool",
        id: "voice-call",
        name: "paseo_speak",
        time: { created: 2 },
        state: {
          status: "completed",
          input: { text: "The spoken poem." },
          content: [{ type: "text", text: "ok" }],
        },
      },
    ]);
    const extraFinal = {
      ...assistant([{ type: "text", text: "Extra final summary." }]),
      id: "voice-final",
      time: { created: 3 },
    } satisfies SessionMessageAssistant;

    timeline.expectUserPrompt(spoken.text);
    timeline.startPart({ assistantMessageID: "streamed", type: "text", ordinal: 0 });
    expect(
      timeline.delta({
        assistantMessageID: "streamed",
        type: "text",
        ordinal: 0,
        delta: "Extra streamed text.",
      }),
    ).toBeNull();

    const voiceEvents = timeline.messages([spoken, voiceAnswer, extraFinal]);
    expect(voiceEvents.map((event) => event.type === "timeline" && event.item.type)).toEqual([
      "user_message",
      "tool_call",
    ]);
    expect(voiceEvents[1]).toMatchObject({
      item: { name: "speak", detail: { input: "The spoken poem." } },
    });

    const typed = {
      id: "typed-user",
      type: "user",
      text: "Normal text prompt",
      time: { created: 4 },
    } satisfies SessionMessageInfo;
    const typedAnswer = {
      ...assistant([{ type: "text", text: "Normal written reply." }]),
      id: "typed-answer",
      time: { created: 5 },
    } satisfies SessionMessageAssistant;
    const allMessages = [spoken, voiceAnswer, extraFinal, typed, typedAnswer];
    expect(timeline.messages(allMessages)).toMatchObject([
      { item: { type: "user_message", text: "Normal text prompt" } },
      { item: { type: "assistant_message", text: "Normal written reply." } },
    ]);
    expect(
      new V2Timeline(false)
        .messages(allMessages)
        .filter((event) => event.type === "timeline" && event.item.type === "assistant_message")
        .map((event) => event.item),
    ).toEqual([
      { type: "assistant_message", text: "Normal written reply.", messageId: "typed-answer" },
    ]);
  });

  test("shows image tool results in a spoken turn without leaking base64 or duplicating snapshots", () => {
    const timeline = new V2Timeline();
    const spoken = {
      id: "voice-user",
      type: "user",
      text: wrapSpokenInput("Show me the screenshot"),
      time: { created: 1 },
    } satisfies SessionMessageInfo;
    const result = assistant([
      { type: "text", text: "Extra text that is not spoken." },
      {
        type: "tool",
        id: "screenshot-call",
        name: "screenshot",
        time: { created: 2, completed: 3 },
        state: {
          status: "completed",
          input: {},
          content: [
            { type: "text", text: "Screenshot captured" },
            {
              type: "file",
              uri: `data:image/png;base64,${ONE_BY_ONE_PNG_BASE64}`,
              mime: "image/png",
              name: "Screenshot",
            },
          ],
        },
      },
    ]);
    const events = timeline.messages([spoken, result]);
    const image = events.find(
      (event) => event.type === "timeline" && event.item.type === "assistant_message",
    );
    expect(image).toMatchObject({
      item: { text: expect.stringMatching(/^!\[Screenshot\]\(file:\/\//) },
    });
    expect(JSON.stringify(events)).not.toContain(ONE_BY_ONE_PNG_BASE64);
    expect(JSON.stringify(events)).toContain("[image]");
    expect(timeline.messages([spoken, result])).toEqual([]);
    const tool = result.content[1];
    if (!tool || tool.type !== "tool") throw new Error("Expected screenshot tool");
    expect(
      timeline
        .messages([
          spoken,
          assistant([
            result.content[0],
            {
              ...tool,
              state: { ...tool.state, metadata: { updated: true } },
            },
          ]),
        ])
        .filter((event) => event.type === "timeline" && event.item.type === "assistant_message"),
    ).toEqual([]);
    if (!image || image.type !== "timeline" || image.item.type !== "assistant_message")
      throw new Error("Image message was not emitted");
    const source = image.item.text.match(/^!\[[^\]]*\]\((.*)\)$/)?.[1];
    if (!source) throw new Error("Image source was not emitted");
    const imagePath = fileURLToPath(source);
    try {
      expect(existsSync(imagePath)).toBe(true);
    } finally {
      rmSync(imagePath, { force: true });
    }
  });

  test("replays OpenCode image files as images and keeps other files as tool output", () => {
    const result = assistant([
      {
        type: "tool",
        id: "file-call",
        name: "read",
        time: { created: 2, completed: 3 },
        state: {
          status: "completed",
          input: {},
          content: [
            { type: "file", uri: "file:///tmp/screenshot.png", mime: "image/png" },
            { type: "file", uri: "file:///tmp/notes.txt", mime: "text/plain" },
          ],
        },
      },
    ]);
    const events = new V2Timeline(false).messages([result]);
    expect(events).toMatchObject([
      { item: { type: "tool_call", detail: { output: expect.stringContaining("notes.txt") } } },
      { item: { type: "assistant_message", text: "![Image](file:///tmp/screenshot.png)" } },
    ]);
    expect(JSON.stringify(events)).not.toContain(
      "file:///tmp/screenshot.png\nfile:///tmp/notes.txt",
    );
  });

  test("withholds streamed prose during a structured-output turn", async () => {
    const harness = new V2Harness();
    let settle!: () => void;
    harness.wait = () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const text = collectAssistantText(session);
    const reasoning: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "reasoning")
        reasoning.push(event.item.text);
    });
    const failures: AgentStreamEvent[] = [];
    session.subscribe((event) => {
      if (event.type === "turn_failed") failures.push(event);
    });
    try {
      await session.startTurn("answer", {
        outputSchema: { type: "object", properties: { answer: { type: "integer" } } },
      });
      await expect.poll(() => harness.prompts).toEqual(["answer"]);
      harness.push({
        id: "ts",
        created: 2,
        type: "session.text.started",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0 },
      });
      harness.push({
        id: "t1",
        created: 3,
        type: "session.text.delta",
        data: {
          sessionID: "session",
          assistantMessageID: "answer",
          ordinal: 0,
          delta: "ignore me",
        },
      });
      // A following reasoning delta is still delivered, so its arrival proves
      // the text delta was seen and suppressed rather than merely not yet read.
      harness.push({
        id: "rs",
        created: 2,
        type: "session.reasoning.started",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0 },
      });
      harness.push({
        id: "r1",
        created: 4,
        type: "session.reasoning.delta",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0, delta: "thought" },
      });
      await expect.poll(() => reasoning).toEqual(["thought"]);
      expect(text).toEqual([]);
      // A late delta after the structured turn failed must remain suppressed.
      settle();
      await expect.poll(() => failures.length).toBe(1);
      harness.push({
        id: "late",
        created: 5,
        type: "session.text.delta",
        data: {
          sessionID: "session",
          assistantMessageID: "answer",
          ordinal: 0,
          delta: "still hidden",
        },
      });
      harness.push({
        id: "r2",
        created: 6,
        type: "session.reasoning.delta",
        data: { sessionID: "session", assistantMessageID: "answer", ordinal: 0, delta: "done" },
      });
      await expect.poll(() => reasoning).toEqual(["thought", "done"]);
      expect(text).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
