import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createAudioEngine } from "./audio-engine.native";

const native = vi.hoisted(() => ({
  addExpoTwoWayAudioEventListener: vi.fn(() => ({ remove: vi.fn() })),
  initialize: vi.fn(async () => true),
  getMicrophonePermissionsAsync: vi.fn(async () => ({ granted: true })),
  requestMicrophonePermissionsAsync: vi.fn(async () => ({ granted: true })),
  toggleRecording: vi.fn(() => true),
  resumePlayback: vi.fn(),
  playPCMData: vi.fn(),
  stopPlayback: vi.fn(),
  releaseAudioSession: vi.fn(),
  tearDown: vi.fn(),
}));

function pcmSource(bytes: number) {
  return {
    size: bytes,
    type: "audio/pcm;rate=24000;bits=16",
    async arrayBuffer() {
      return new Uint8Array(bytes).buffer;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

it("queues the next PCM block in native playback before the first completes", async () => {
  const engine = createAudioEngine(
    { onCaptureData: vi.fn(), onVolumeLevel: vi.fn() },
    { nativeModule: native },
  );
  const first = engine.playQueuedPcm!(pcmSource(38_400));
  const second = engine.playQueuedPcm!(pcmSource(38_400));
  const settled: string[] = [];
  void first.then(() => settled.push("first"));
  void second.then(() => settled.push("second"));

  await vi.waitFor(() => expect(native.playPCMData).toHaveBeenCalledTimes(2));
  expect(settled).toEqual([]);

  await vi.advanceTimersByTimeAsync(800);
  expect(settled).toEqual(["first"]);
  await vi.advanceTimersByTimeAsync(800);
  expect(settled).toEqual(["first", "second"]);
  await engine.destroy();
});

it("cancels queued native playback acknowledgements on stop", async () => {
  const engine = createAudioEngine(
    { onCaptureData: vi.fn(), onVolumeLevel: vi.fn() },
    { nativeModule: native },
  );
  const first = engine.playQueuedPcm!(pcmSource(38_400));
  const second = engine.playQueuedPcm!(pcmSource(38_400));
  const firstResult = first.catch((error: Error) => error.message);
  const secondResult = second.catch((error: Error) => error.message);

  await vi.waitFor(() => expect(native.playPCMData).toHaveBeenCalledTimes(2));
  engine.stop();

  expect(await firstResult).toBe("Playback stopped");
  expect(await secondResult).toBe("Playback stopped");
  await vi.advanceTimersByTimeAsync(2_000);
  await engine.destroy();
});
