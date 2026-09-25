import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

const { openAiConstructorOptionsMock, transcriptionsCreateMock } = vi.hoisted(() => ({
  openAiConstructorOptionsMock: vi.fn(),
  transcriptionsCreateMock: vi.fn(),
}));

vi.mock("openai", () => ({
  OpenAI: vi.fn(function OpenAI(options: unknown) {
    openAiConstructorOptionsMock(options);
    return {
      audio: {
        transcriptions: {
          create: transcriptionsCreateMock,
        },
      },
    };
  }),
}));

import { OpenAISTT } from "./stt.js";

function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

describe("OpenAISTT", () => {
  afterEach(() => {
    openAiConstructorOptionsMock.mockReset();
    transcriptionsCreateMock.mockReset();
  });

  test("passes configured baseUrl to the OpenAI client", () => {
    const provider = new OpenAISTT(
      { apiKey: "sk-test", baseUrl: "https://speech.example.com/v1" },
      pino({ level: "silent" }),
    );

    expect(provider.id).toBe("openai");
    expect(openAiConstructorOptionsMock).toHaveBeenCalledWith({
      apiKey: "sk-test",
      baseURL: "https://speech.example.com/v1",
    });
  });

  test("passes transcription prompt to OpenAI REST STT", async () => {
    transcriptionsCreateMock.mockImplementation(
      async (request: { file: NodeJS.ReadableStream }) => {
        await new Promise<void>((resolve, reject) => {
          request.file.once("error", reject);
          request.file.once("end", resolve);
          request.file.resume();
        });
        return { text: "hello" };
      },
    );

    const provider = new OpenAISTT(
      { apiKey: "sk-test", model: "gpt-4o-transcribe" },
      pino({ level: "silent" }),
    );
    const session = provider.createSession({
      logger: pino({ level: "silent" }),
      language: "en",
      prompt: "Only transcribe the speaker.",
    });

    const transcript = new Promise<string>((resolve, reject) => {
      session.on("transcript", (event) => {
        if (event.isFinal) {
          resolve(event.transcript);
        }
      });
      session.on("error", (error) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });

    await session.connect();
    session.appendPcm16(Buffer.from([0, 0, 0, 0]));
    session.commit();

    await expect(transcript).resolves.toBe("hello");
    expect(transcriptionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "en",
        model: "gpt-4o-transcribe",
        prompt: "Only transcribe the speaker.",
        response_format: "json",
      }),
    );
  });

  test("commits consecutive utterances with separate audio buffers", async () => {
    transcriptionsCreateMock.mockImplementation(
      async (request: { file: NodeJS.ReadableStream }) => {
        const wav = await readStream(request.file);
        return { text: `${wav[44]}/${wav.length - 44}` };
      },
    );

    const provider = new OpenAISTT({ apiKey: "sk-test" }, pino({ level: "silent" }));
    const session = provider.createSession({ logger: pino({ level: "silent" }), language: "zh" });
    const transcripts: string[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      session.on("transcript", (event) => {
        if (event.isFinal) {
          transcripts.push(event.transcript);
          if (transcripts.length === 2) resolve();
        }
      });
      session.on("error", reject);
    });

    await session.connect();
    session.appendPcm16(Buffer.from([1, 0]));
    session.commit();
    session.appendPcm16(Buffer.from([2, 0]));
    session.commit();
    await completed;

    expect(transcripts.sort()).toEqual(["1/2", "2/2"]);
  });

  test("omits auto language so the ASR server can detect it", async () => {
    transcriptionsCreateMock.mockImplementation(
      async (request: { file: NodeJS.ReadableStream }) => {
        await readStream(request.file);
        return { text: "你好" };
      },
    );
    const provider = new OpenAISTT(
      { apiKey: "local", model: "qwen3-asr" },
      pino({ level: "silent" }),
    );
    const session = provider.createSession({ logger: pino({ level: "silent" }), language: "auto" });
    const transcript = new Promise<string>((resolve, reject) => {
      session.on("transcript", (event) => resolve(event.transcript));
      session.on("error", reject);
    });

    await session.connect();
    session.appendPcm16(Buffer.from([0, 0]));
    session.commit();

    await expect(transcript).resolves.toBe("你好");
    expect(transcriptionsCreateMock.mock.calls[0]?.[0]).not.toHaveProperty("language");
  });
});
