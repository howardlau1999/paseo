import type {
  AudioEngine,
  AudioEngineCallbacks,
  AudioPlaybackSource,
} from "@/voice/audio-engine-types";

interface QueuedAudio {
  audio: AudioPlaybackSource;
  resolve: (duration: number) => void;
  reject: (error: Error) => void;
}

interface QueuedPcmPlayback {
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (duration: number) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

interface AudioEngineTraceOptions {
  traceLabel?: string;
  nativeModule?: NativeAudioModule;
}

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

function parsePcmSampleRate(mimeType: string): number | null {
  const match = /rate=(\d+)/i.exec(mimeType);
  if (!match) {
    return null;
  }
  const rate = Number(match[1]);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function resamplePcm16(pcm: Uint8Array, fromRate: number, toRate: number): Uint8Array {
  if (fromRate === toRate) {
    return pcm;
  }

  const inputSamples = Math.floor(pcm.length / 2);
  const outputSamples = Math.floor((inputSamples * toRate) / fromRate);
  const out = new Uint8Array(outputSamples * 2);
  const ratio = fromRate / toRate;

  const readInt16 = (sampleIndex: number): number => {
    const i = sampleIndex * 2;
    if (i + 1 >= pcm.length) {
      return 0;
    }
    const lo = pcm[i];
    const hi = pcm[i + 1];
    let value = (hi << 8) | lo;
    if (value & 0x8000) {
      value = value - 0x10000;
    }
    return value;
  };

  const writeInt16 = (sampleIndex: number, value: number): void => {
    const clamped = Math.max(-32768, Math.min(32767, Math.round(value)));
    const i = sampleIndex * 2;
    out[i] = clamped & 0xff;
    out[i + 1] = (clamped >> 8) & 0xff;
  };

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const frac = srcPos - i0;
    const s0 = readInt16(i0);
    const s1 = readInt16(Math.min(inputSamples - 1, i0 + 1));
    writeInt16(i, s0 + (s1 - s0) * frac);
  }

  return out;
}

function applyPlaybackGain(pcm: Uint8Array, gain: number): Uint8Array {
  if (gain === 1) {
    return pcm;
  }
  const output = new Uint8Array(pcm.length);
  const inputView = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const outputView = new DataView(output.buffer);
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const sample = inputView.getInt16(offset, true);
    const amplified = Math.max(-32768, Math.min(32767, Math.round(sample * gain)));
    outputView.setInt16(offset, amplified, true);
  }
  return output;
}

export function createAudioEngine(
  callbacks: AudioEngineCallbacks,
  options?: AudioEngineTraceOptions,
): AudioEngine {
  const native: NativeAudioModule =
    options?.nativeModule ?? require("@getpaseo/expo-two-way-audio");

  const refs: {
    initialized: boolean;
    captureActive: boolean;
    muted: boolean;
    queue: QueuedAudio[];
    processingQueue: boolean;
    playbackTimeout: ReturnType<typeof setTimeout> | null;
    activePlayback: {
      resolve: (duration: number) => void;
      reject: (error: Error) => void;
      settled: boolean;
    } | null;
    queuedPcm: Set<QueuedPcmPlayback>;
    queuedPcmEnqueue: Promise<void>;
    queuedPcmEndMs: number;
    playbackGeneration: number;
    playbackGain: number;
    destroyed: boolean;
  } = {
    initialized: false,
    captureActive: false,
    muted: false,
    queue: [],
    processingQueue: false,
    playbackTimeout: null,
    activePlayback: null,
    queuedPcm: new Set(),
    queuedPcmEnqueue: Promise.resolve(),
    queuedPcmEndMs: 0,
    playbackGeneration: 0,
    playbackGain: 1,
    destroyed: false,
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
    if (
      refs.captureActive ||
      refs.activePlayback ||
      refs.queue.length > 0 ||
      refs.queuedPcm.size > 0
    ) {
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

  function clearPlaybackTimeout(): void {
    if (refs.playbackTimeout) {
      clearTimeout(refs.playbackTimeout);
      refs.playbackTimeout = null;
    }
  }

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
    refs.playbackGeneration += 1;
    refs.queuedPcmEnqueue = Promise.resolve();
    for (const item of refs.queuedPcm) {
      settleQueuedPcm(item, { error: new Error("Playback stopped") });
    }
  }

  function playQueuedPcm(audio: AudioPlaybackSource): Promise<number> {
    const generation = refs.playbackGeneration;
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
      if (item.settled || refs.playbackGeneration !== generation || refs.destroyed) {
        return undefined;
      }

      const inputRate = parsePcmSampleRate(audio.type || "") ?? 24000;
      const pcm16k = resamplePcm16(pcm, inputRate, 16000);
      const duration = pcm16k.length / 2 / 16000;
      native.resumePlayback();
      native.playPCMData(applyPlaybackGain(pcm16k, refs.playbackGain));

      // Native AudioTrack and AVAudioPlayerNode queue these buffers continuously.
      // Keep acknowledgements tied to their estimated completion time.
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

  async function playAudio(audio: AudioPlaybackSource): Promise<number> {
    await ensureInitialized();

    return await new Promise<number>((resolve, reject) => {
      refs.activePlayback = { resolve, reject, settled: false };

      audio
        .arrayBuffer()
        .then((arrayBuffer) => {
          const pcm = new Uint8Array(arrayBuffer);
          const inputRate = parsePcmSampleRate(audio.type || "") ?? 24000;

          // Native AudioEngine expects 16kHz PCM16
          const pcm16k = resamplePcm16(pcm, inputRate, 16000);
          const durationSec = pcm16k.length / 2 / 16000;

          native.resumePlayback();
          native.playPCMData(applyPlaybackGain(pcm16k, refs.playbackGain));

          clearPlaybackTimeout();
          refs.playbackTimeout = setTimeout(() => {
            clearPlaybackTimeout();
            const active = refs.activePlayback;
            if (!active || active.settled) {
              return;
            }
            active.settled = true;
            refs.activePlayback = null;
            resolve(durationSec);
          }, durationSec * 1000);
          return undefined;
        })
        .catch((error: unknown) => {
          clearPlaybackTimeout();
          const active = refs.activePlayback;
          if (active && !active.settled) {
            active.settled = true;
            refs.activePlayback = null;
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
    });
  }

  async function processQueue(): Promise<void> {
    if (refs.processingQueue || refs.queue.length === 0) {
      return;
    }

    refs.processingQueue = true;
    while (refs.queue.length > 0) {
      const item = refs.queue.shift()!;
      try {
        const duration = await playAudio(item.audio);
        item.resolve(duration);
      } catch (error) {
        item.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    refs.processingQueue = false;
    releaseSessionIfIdle();
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
      this.stop();
      this.clearQueue();
      if (refs.captureActive) {
        native.toggleRecording(false);
        refs.captureActive = false;
      }
      clearPlaybackTimeout();
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

    async play(audio: AudioPlaybackSource) {
      return await new Promise<number>((resolve, reject) => {
        refs.queue.push({ audio, resolve, reject });
        if (!refs.processingQueue) {
          void processQueue();
        }
      });
    },

    playQueuedPcm,

    setPlaybackGain(gain: number) {
      refs.playbackGain = gain;
    },

    stop() {
      native.stopPlayback();
      cancelQueuedPcm();
      clearPlaybackTimeout();
      const active = refs.activePlayback;
      refs.activePlayback = null;
      if (active && !active.settled) {
        active.settled = true;
        active.reject(new Error("Playback stopped"));
      }
      releaseSessionIfIdle();
    },

    clearQueue() {
      if (refs.queuedPcm.size > 0) {
        native.stopPlayback();
        cancelQueuedPcm();
      }
      while (refs.queue.length > 0) {
        refs.queue.shift()!.reject(new Error("Playback stopped"));
      }
      refs.processingQueue = false;
      releaseSessionIfIdle();
    },

    isPlaying() {
      return refs.activePlayback !== null || refs.queuedPcm.size > 0;
    },
  };
}
