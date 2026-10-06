import type { AudioEngine, AudioEngineCallbacks, AudioPlaybackSource } from "./audio-engine-types";

import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { createPlaybackQueue } from "./playback";
import { playFile } from "./file-playback";
import { applyPlaybackGain, parsePcmSampleRate, playPcm16, resamplePcm16 } from "./pcm";

interface NativeAudioModule {
  addExpoTwoWayAudioEventListener<T>(
    event: string,
    listener: (event: T) => void,
  ): { remove(): void };
  initialize(): Promise<boolean>;
  getMicrophonePermissionsAsync(): Promise<{ granted: boolean }>;
  requestMicrophonePermissionsAsync(): Promise<{ granted: boolean }>;
  toggleRecording(enabled: boolean): boolean;
  releaseAudioSession(): void;
  resumePlayback(): void;
  playPCMData(data: Uint8Array): void;
  stopPlayback(): void;
  tearDown(): void;
}

interface AudioEngineOptions {
  traceLabel?: string;
  nativeModule?: NativeAudioModule;
}

interface QueuedPcmPlayback {
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (duration: number) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

export function createAudioEngine(
  callbacks: AudioEngineCallbacks,
  options?: AudioEngineOptions,
): AudioEngine {
  const native: NativeAudioModule =
    options?.nativeModule ?? require("@getpaseo/expo-two-way-audio");

  const refs: {
    initialized: boolean;
    captureActive: boolean;
    muted: boolean;
    destroyed: boolean;
    playbackGain: number;
    queuedPcm: Set<QueuedPcmPlayback>;
    queuedPcmEnqueue: Promise<void>;
    queuedPcmEndMs: number;
    queuedPcmGeneration: number;
  } = {
    initialized: false,
    captureActive: false,
    muted: false,
    destroyed: false,
    playbackGain: 1,
    queuedPcm: new Set(),
    queuedPcmEnqueue: Promise.resolve(),
    queuedPcmEndMs: 0,
    queuedPcmGeneration: 0,
  };

  const microphoneSubscription = native.addExpoTwoWayAudioEventListener(
    "onMicrophoneData",
    (event: { data: Uint8Array }) => {
      if (!refs.captureActive || refs.muted) {
        return;
      }
      const pcm = event.data;
      callbacks.onCaptureData(pcm);
    },
  );
  const volumeSubscription = native.addExpoTwoWayAudioEventListener(
    "onInputVolumeLevelData",
    (event: { data: number }) => {
      if (!refs.captureActive) {
        return;
      }
      const level = refs.muted ? 0 : event.data;
      callbacks.onVolumeLevel(level);
    },
  );
  const interruptionSubscription = native.addExpoTwoWayAudioEventListener(
    "onAudioInterruption",
    (event: { data: string }) => {
      if (event.data !== "blocked") {
        return;
      }
      const wasCaptureActive = refs.captureActive;
      refs.captureActive = false;
      refs.muted = false;
      callbacks.onVolumeLevel(0);
      if (wasCaptureActive) {
        callbacks.onInterruption?.();
      }
    },
  );

  async function ensureInitialized(): Promise<void> {
    if (refs.initialized) {
      return;
    }
    const success = await native.initialize();
    if (!success) {
      throw new Error("expo-two-way-audio: native initialize() returned false");
    }
    refs.initialized = true;
  }

  /**
   * Release the OS audio session as soon as we are neither capturing nor playing.
   * Holding it keeps the user's background music paused — on iOS the non-mixing
   * `.playAndRecord` category survives backgrounding and is re-asserted on every
   * foreground, so an unreleased session means their music never comes back.
   */
  function releaseSessionIfIdle(): void {
    if (!refs.initialized || refs.destroyed) {
      return;
    }
    if (refs.captureActive || playback.isPlaying() || refs.queuedPcm.size > 0) {
      return;
    }
    // The wrapper no-ops on binaries whose native module predates this function.
    native.releaseAudioSession();
  }

  async function ensureMicrophonePermission(): Promise<void> {
    let permission = await native.getMicrophonePermissionsAsync().catch(() => null);
    if (!permission?.granted) {
      permission = await native.requestMicrophonePermissionsAsync().catch(() => null);
    }
    if (!permission?.granted) {
      throw new Error(
        "Microphone permission is required to capture audio. Please enable microphone access in system settings.",
      );
    }
  }

  const pcmOutput = {
    resumePlayback: () => native.resumePlayback(),
    playPCMData: (bytes: Uint8Array) =>
      native.playPCMData(applyPlaybackGain(bytes, refs.playbackGain)),
    stopPlayback: () => native.stopPlayback(),
  };

  let nextFileId = 0;
  async function playAudio(audio: AudioPlaybackSource, signal: AbortSignal): Promise<number> {
    const bytes = new Uint8Array(await audio.arrayBuffer());
    if (signal.aborted) throw new Error("Playback stopped");
    if (audio.type.startsWith("audio/pcm")) {
      await ensureInitialized();
      return playPcm16(bytes, audio.type, signal, pcmOutput);
    }
    // Capture owns its audio session while active. File playback alone must not
    // initialize the microphone or the native two-way engine.
    if (!refs.captureActive) {
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: false,
        interruptionMode: "duckOthers",
        interruptionModeAndroid: "duckOthers",
      });
    }
    if (signal.aborted) throw new Error("Playback stopped");
    // AVPlayer needs a file extension to recognize local encoded audio on iOS.
    const extension =
      {
        "audio/wav": "wav",
        "audio/x-wav": "wav",
        "audio/wave": "wav",
        "audio/mpeg": "mp3",
        "audio/mp3": "mp3",
        "audio/mp4": "m4a",
        "audio/aac": "aac",
        "audio/ogg": "ogg",
        "audio/flac": "flac",
      }[audio.type.split(";")[0].trim()] ?? "audio";
    const file = new File(Paths.cache, `paseo-audio-${Date.now()}-${nextFileId++}.${extension}`);
    try {
      file.write(bytes);
      const player = createAudioPlayer(file.uri, {
        updateInterval: 100,
        keepAudioSessionActive: refs.captureActive,
      });
      return await playFile(player, signal);
    } finally {
      if (file.exists) file.delete();
    }
  }
  const playback = createPlaybackQueue(playAudio, releaseSessionIfIdle);

  function settleQueuedPcm(
    item: QueuedPcmPlayback,
    result: { duration: number } | { error: Error },
  ): void {
    if (item.settled) return;
    item.settled = true;
    if (item.timer) clearTimeout(item.timer);
    refs.queuedPcm.delete(item);
    if ("error" in result) item.reject(result.error);
    else item.resolve(result.duration);
    if (refs.queuedPcm.size === 0) {
      refs.queuedPcmEndMs = 0;
      releaseSessionIfIdle();
    }
  }

  function cancelQueuedPcm(): void {
    if (refs.queuedPcm.size === 0) return;
    native.stopPlayback();
    refs.queuedPcmGeneration += 1;
    refs.queuedPcmEnqueue = Promise.resolve();
    for (const item of refs.queuedPcm) {
      settleQueuedPcm(item, { error: new Error("Playback stopped") });
    }
  }

  /**
   * Hand PCM to the native player as soon as it arrives instead of waiting for the previous
   * block to finish, so AudioTrack and AVAudioPlayerNode play streamed speech without gaps.
   * Each promise still resolves at the block's estimated end so acknowledgements keep their order.
   */
  function playQueuedPcm(audio: AudioPlaybackSource): Promise<number> {
    const generation = refs.queuedPcmGeneration;
    let resolvePlayback!: (duration: number) => void;
    let rejectPlayback!: (error: Error) => void;
    const completion = new Promise<number>((resolve, reject) => {
      resolvePlayback = resolve;
      rejectPlayback = reject;
    });
    const item: QueuedPcmPlayback = {
      timer: null,
      resolve: resolvePlayback,
      reject: rejectPlayback,
      settled: false,
    };
    refs.queuedPcm.add(item);

    const enqueue = refs.queuedPcmEnqueue.then(async () => {
      await ensureInitialized();
      const pcm = new Uint8Array(await audio.arrayBuffer());
      if (item.settled || refs.queuedPcmGeneration !== generation || refs.destroyed) {
        return undefined;
      }

      const pcm16k = resamplePcm16(pcm, parsePcmSampleRate(audio.type || "") ?? 24000, 16000);
      const duration = pcm16k.length / 2 / 16000;
      pcmOutput.resumePlayback();
      pcmOutput.playPCMData(pcm16k);

      const now = Date.now();
      refs.queuedPcmEndMs = Math.max(now, refs.queuedPcmEndMs) + duration * 1000;
      item.timer = setTimeout(
        () => {
          settleQueuedPcm(item, { duration });
        },
        Math.max(0, refs.queuedPcmEndMs - now),
      );
      return undefined;
    });
    refs.queuedPcmEnqueue = enqueue.catch(() => undefined);
    void enqueue.catch((error: unknown) => {
      settleQueuedPcm(item, {
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });
    return completion;
  }

  return {
    async initialize() {
      await ensureInitialized();
    },

    async destroy() {
      if (refs.destroyed) {
        return;
      }
      refs.destroyed = true;
      cancelQueuedPcm();
      playback.destroy();
      if (refs.captureActive) {
        native.toggleRecording(false);
        refs.captureActive = false;
      }
      refs.muted = false;
      callbacks.onVolumeLevel(0);
      if (refs.initialized) {
        native.tearDown();
        refs.initialized = false;
      }
      microphoneSubscription.remove();
      volumeSubscription.remove();
      interruptionSubscription.remove();
    },

    async startCapture() {
      if (refs.captureActive) {
        return;
      }

      try {
        await ensureMicrophonePermission();
        await ensureInitialized();
        const isRecording = native.toggleRecording(true);
        if (!isRecording) {
          throw new Error(
            "Microphone capture could not start because Android audio focus is unavailable.",
          );
        }
        refs.captureActive = true;
      } catch (error) {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        callbacks.onError?.(wrapped);
        throw wrapped;
      }
    },

    async stopCapture() {
      if (refs.captureActive) {
        native.toggleRecording(false);
      }
      refs.captureActive = false;
      refs.muted = false;
      callbacks.onVolumeLevel(0);
      releaseSessionIfIdle();
    },

    toggleMute() {
      refs.muted = !refs.muted;
      if (refs.muted) {
        callbacks.onVolumeLevel(0);
      }
      return refs.muted;
    },

    isMuted() {
      return refs.muted;
    },

    play: playback.play,
    playQueuedPcm,

    setPlaybackGain(gain: number) {
      refs.playbackGain = gain;
    },

    stop() {
      playback.stop();
      cancelQueuedPcm();
    },

    clearQueue() {
      playback.clearQueue();
      cancelQueuedPcm();
    },

    isPlaying() {
      return playback.isPlaying() || refs.queuedPcm.size > 0;
    },
  };
}
