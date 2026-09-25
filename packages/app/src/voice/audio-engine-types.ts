export interface AudioEngineCallbacks {
  onCaptureData(pcm: Uint8Array): void;
  onVolumeLevel(level: number): void;
  onInterruption?(): void;
  onError?(error: Error): void;
}

export interface AudioPlaybackSource {
  arrayBuffer(): Promise<ArrayBuffer>;
  size: number;
  type: string;
}

export interface AudioEngine {
  initialize(): Promise<void>;
  destroy(): Promise<void>;

  startCapture(): Promise<void>;
  stopCapture(): Promise<void>;
  toggleMute(): boolean;
  isMuted(): boolean;

  play(audio: AudioPlaybackSource): Promise<number>;
  /** Queue PCM in the native player now; resolve after its estimated playback ends. */
  playQueuedPcm?(audio: AudioPlaybackSource): Promise<number>;
  setPlaybackGain(gain: number): void;
  stop(): void;
  clearQueue(): void;
  isPlaying(): boolean;
}
