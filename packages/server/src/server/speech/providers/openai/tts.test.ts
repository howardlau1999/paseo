import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

const { openAiConstructorOptionsMock, speechCreateMock } = vi.hoisted(() => ({
  openAiConstructorOptionsMock: vi.fn(),
  speechCreateMock: vi.fn(),
}));

vi.mock("openai", () => ({
  OpenAI: vi.fn(function OpenAI(options: unknown) {
    openAiConstructorOptionsMock(options);
    return {
      audio: {
        speech: {
          create: speechCreateMock,
        },
      },
    };
  }),
}));

import { OpenAITTS } from "./tts.js";

describe("OpenAITTS", () => {
  afterEach(() => {
    openAiConstructorOptionsMock.mockReset();
    speechCreateMock.mockReset();
  });

  test("passes configured baseUrl to the OpenAI client", () => {
    const provider = new OpenAITTS(
      { apiKey: "sk-test", baseUrl: "https://speech.example.com/v1" },
      pino({ level: "silent" }),
    );

    expect(provider.getConfig().baseUrl).toBe("https://speech.example.com/v1");
    expect(openAiConstructorOptionsMock).toHaveBeenCalledWith({
      apiKey: "sk-test",
      baseURL: "https://speech.example.com/v1",
    });
  });

  test("passes Qwen streaming fields and returns a cancellable Node stream", async () => {
    const pcm = Buffer.from([1, 0, 2, 0]);
    speechCreateMock.mockResolvedValue(
      new Response(pcm, { headers: { "Content-Type": "application/octet-stream" } }),
    );
    const provider = new OpenAITTS(
      {
        apiKey: "local-qwen",
        baseUrl: "http://127.0.0.1:18082/v1",
        model: "qwen3-tts",
        voice: "vivian",
        language: "Chinese",
        instructions: "说话稍快一些，语气轻松活泼。",
        stream: true,
        responseFormat: "pcm",
      },
      pino({ level: "silent" }),
    );

    const result = await provider.synthesizeSpeech("你好");
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) {
      chunks.push(Buffer.from(chunk));
    }

    expect(speechCreateMock).toHaveBeenCalledWith({
      model: "qwen3-tts",
      voice: "vivian",
      input: "你好",
      language: "Chinese",
      instructions: "说话稍快一些，语气轻松活泼。",
      stream: true,
      stream_format: "audio",
      response_format: "pcm",
    });
    expect(result.streaming).toBe(true);
    expect(provider.prefersWholeUtterance).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(pcm);
    expect(typeof result.stream.destroy).toBe("function");
  });
});
