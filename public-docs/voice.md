---
title: Voice
description: Paseo voice architecture, local-first model execution, and provider configuration.
nav: Voice
order: 41
category: Configuration
---

# Voice

Paseo has first-class voice support for dictation and voice mode conversations with your coding environment.

## Philosophy

Voice is local-first. You can run speech fully on-device, or choose OpenAI for speech features. For voice reasoning/orchestration, Paseo reuses agent providers already installed and authenticated on your machine.

This keeps credentials and execution in your environment and avoids introducing a separate cloud-only voice stack.

## Architecture

- Speech I/O: STT and TTS providers per feature (`local` or `openai`)
- Local speech runtime: ONNX models executed on CPU by default
- Voice LLM orchestration: hidden agent session using your configured provider (`claude`, `codex`, or `opencode`)
- Tooling path: MCP stdio bridge for voice tools and agent control

## Local Speech

Local speech defaults to model IDs `parakeet-tdt-0.6b-v2-int8` (STT) and `kokoro-en-v0_19` (TTS, speaker 0 / voice 00). For Chinese speech output, select `kokoro-multi-lang-v1_0` (Chinese speaker 48 by default). The multilingual model also includes English voices; set `speakerId` to choose one.

Missing models are downloaded at daemon startup into `$PASEO_HOME/models/local-speech`. Downloads happen only for missing files.

### Local STT models and language support

| Model ID                    | Languages                                                                                                                                                                                                                                                                    |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parakeet-tdt-0.6b-v2-int8` | English only (default). Includes punctuation and capitalization.                                                                                                                                                                                                             |
| `parakeet-tdt-0.6b-v3-int8` | 25 European languages, auto-detected: Bulgarian, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Greek, Hungarian, Italian, Latvian, Lithuanian, Maltese, Polish, Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Ukrainian. |

For the listed European languages, switch the local STT model to `parakeet-tdt-0.6b-v3-int8`. It detects the spoken language automatically. For Chinese recognition, use a compatible speech-to-text endpoint such as a local whisper.cpp server, as shown below. The `language` field does not steer the local Parakeet models; it applies to the `openai` STT provider.

```json
{
  "version": 1,
  "features": {
    "dictation": {
      "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v2-int8", "language": "en" }
    },
    "voiceMode": {
      "llm": { "provider": "claude", "model": "haiku" },
      "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v2-int8", "language": "en" },
      "tts": { "provider": "local", "model": "kokoro-en-v0_19", "speakerId": 0 }
    }
  },
  "providers": {
    "local": {
      "modelsDir": "~/.paseo/models/local-speech"
    }
  }
}
```

For multilingual local dictation, set the model to v3 — it auto-detects the language, so no `language` field is needed:

```json
{
  "version": 1,
  "features": {
    "dictation": {
      "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v3-int8" }
    }
  }
}
```

The `language` field applies only to the OpenAI STT provider: set `features.dictation.stt.language` for dictation and `features.voiceMode.stt.language` for voice mode. If voice language is omitted, Paseo uses the dictation language before falling back to `en`. It has no effect on the local Parakeet models.

### Chinese speech with whisper.cpp

If you have whisper.cpp and a multilingual Whisper model, run its server on loopback with an OpenAI-compatible transcription path:

```bash
whisper-server --host 127.0.0.1 --port 18081 \
  --inference-path /v1/audio/transcriptions \
  -m /absolute/path/to/ggml-large-v3-turbo-q5_0.bin -l auto
```

Then configure Paseo to send dictation and voice recognition to that server and use the multilingual Kokoro model for voice output:

```json
{
  "version": 1,
  "features": {
    "dictation": { "stt": { "provider": "openai", "model": "whisper-1", "language": "auto" } },
    "voiceMode": {
      "stt": { "provider": "openai", "model": "whisper-1", "language": "auto" },
      "tts": { "provider": "local", "model": "kokoro-multi-lang-v1_0", "speakerId": 48 }
    }
  },
  "providers": {
    "openai": {
      "stt": { "apiKey": "local-whisper", "baseUrl": "http://127.0.0.1:18081/v1" }
    }
  }
}
```

The placeholder API key satisfies Paseo's endpoint configuration; the local whisper.cpp server does not use it. `language: "auto"` tells whisper.cpp to detect Chinese or English. Leave the server running while using voice features. Paseo downloads the multilingual Kokoro model on startup if it is missing.

## OpenAI Voice Option

You can switch dictation, voice STT, and voice TTS to OpenAI by setting provider fields to `openai` and providing OpenAI credentials.

```json
{
  "version": 1,
  "features": {
    "dictation": { "stt": { "provider": "openai" } },
    "voiceMode": {
      "stt": { "provider": "openai" },
      "tts": { "provider": "openai" }
    }
  },
  "providers": {
    "openai": {
      "stt": {
        "apiKey": "...",
        "baseUrl": "https://api.openai.com/v1"
      },
      "tts": {
        "apiKey": "...",
        "baseUrl": "https://api.openai.com/v1"
      }
    }
  }
}
```

`providers.openai.stt` covers dictation and voice mode speech-to-text, and `providers.openai.tts` covers voice mode text-to-speech. Because they resolve independently, you can point STT and TTS at different endpoints. Each falls back to `providers.openai.apiKey`/`baseUrl`, then `OPENAI_API_KEY`/`OPENAI_BASE_URL`, when unset. These settings configure only Paseo OpenAI speech traffic, without changing Codex or other OpenAI-backed tools.

Paseo uses these paths under the configured OpenAI base URL:

- dictation STT: `/v1/audio/transcriptions`
- voice mode STT: `/v1/audio/transcriptions`
- voice mode TTS: `/v1/audio/speech`

### Local Qwen3-TTS with vLLM-Omni

Qwen3-TTS can serve an OpenAI-compatible speech endpoint with streaming PCM.
Start vLLM-Omni with a CustomVoice model and a served model name such as
`qwen3-tts`, then configure Paseo's voice TTS endpoint independently of STT:

```json
{
  "version": 1,
  "features": {
    "voiceMode": {
      "tts": { "provider": "openai", "model": "qwen3-tts", "voice": "vivian" }
    }
  },
  "providers": {
    "openai": {
      "tts": {
        "apiKey": "local-qwen",
        "baseUrl": "http://127.0.0.1:18082/v1",
        "language": "Chinese",
        "instructions": "用稍快的语速、轻松活泼的语气说，保持吐字清晰。",
        "stream": true
      }
    }
  }
}
```

The placeholder key is accepted by the local server. With `stream: true`,
Paseo requests raw 24 kHz PCM and forwards completed PCM blocks to voice
playback as they arrive. Keep `127.0.0.1` in `NO_PROXY` for the Paseo daemon.
`providers.openai.tts.instructions` optionally passes a style instruction to
models that support it, such as Qwen3-TTS CustomVoice. It can guide delivery
without changing the selected voice. Check your endpoint's support before
using it with other TTS models.
The vLLM-Omni [Qwen3-TTS recipe](https://github.com/vllm-project/vllm-omni/blob/main/recipes/Qwen/Qwen3-TTS.md)
documents the server and supported voices. Use a model and voice name served by
your own vLLM instance.

## Environment Variables

- `PASEO_VOICE_LLM_PROVIDER`, voice agent provider override
- `PASEO_DICTATION_STT_PROVIDER`, `PASEO_VOICE_STT_PROVIDER`, `PASEO_VOICE_TTS_PROVIDER`, speech provider selection (`local` or `openai`)
- `OPENAI_STT_API_KEY`, `OPENAI_STT_BASE_URL`, OpenAI speech-to-text endpoint (dictation + voice mode STT)
- `OPENAI_TTS_API_KEY`, `OPENAI_TTS_BASE_URL`, OpenAI text-to-speech endpoint (voice mode TTS)
- `PASEO_LOCAL_MODELS_DIR`, local model storage directory
- `PASEO_DICTATION_LOCAL_STT_MODEL`, local dictation STT model ID
- `PASEO_VOICE_LOCAL_STT_MODEL`, `PASEO_VOICE_LOCAL_TTS_MODEL`, local voice STT/TTS model IDs
- `PASEO_DICTATION_LANGUAGE`, dictation STT language (OpenAI STT only; ignored by local Parakeet)
- `PASEO_VOICE_LANGUAGE`, voice mode STT language; falls back to `PASEO_DICTATION_LANGUAGE` when unset (OpenAI STT only; ignored by local Parakeet)
- `PASEO_VOICE_LOCAL_TTS_SPEAKER_ID`, `PASEO_VOICE_LOCAL_TTS_SPEED`, optional local voice TTS tuning

## Operational Notes

Voice mode can launch and control agents. Treat voice prompts with the same care as direct agent instructions, especially when specifying working directories or destructive operations.
