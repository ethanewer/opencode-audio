<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">The open source AI coding agent — with voice.</p>

This is an **unofficial fork** of [OpenCode](https://github.com/anomalyco/opencode). It is not built by or affiliated with the OpenCode team. This fork adds experimental voice input and output capabilities to the CLI and the JavaScript SDK.

---

### Install

This fork must be built from source. You need [Bun](https://bun.sh) 1.3 or later.

```bash
git clone https://github.com/ethanewer/opencode-audio.git
cd opencode-audio
bun install
```

---

#### Run in development

```bash
bun dev
```

This starts OpenCode against the `packages/opencode` directory. To target a different project:

```bash
bun dev /path/to/project
```

---

#### Build a standalone binary

```bash
./packages/opencode/script/build.ts --single
```

The compiled binary is written to `./packages/opencode/dist/opencode-<platform>/bin/opencode`. Replace `<platform>` with your system (e.g. `darwin-arm64`, `linux-x64`).

You can copy this binary anywhere on your `PATH` and run it like a normal CLI tool.

---

#### Audio tools

Voice features require tools for recording and playback. For playback, you need one of:

- `ffplay` (from FFmpeg) — recommended, supports streaming and speed control
- `afplay` (macOS built-in) — buffers the full response before playing
- `aplay` (Linux ALSA) — stdin streaming support

For recording, you need one of:

- `rec` (from SoX)
- `ffmpeg` (uses AVFoundation on macOS, PulseAudio on Linux)

```bash
# macOS
brew install ffmpeg sox

# Linux (Debian/Ubuntu)
sudo apt install ffmpeg sox
```

---

### Voice

This fork adds voice capabilities to OpenCode. You can talk to the agent, and optionally have it talk back. There are three ways to use voice depending on your model and configuration.

---

#### Transcribed input, text output

Use your microphone to speak prompts that get transcribed to text via OpenAI's STT API. The agent responds with text as usual. This works with any model.

Enable voice input in your config and use a model like Claude or any other text-only model. Your speech is transcribed with `gpt-4o-mini-transcribe` before being sent to the model.

```jsonc
{
  "experimental": {
    "voice": {
      "enabled": true,
    },
  },
}
```

---

#### Transcribed input, spoken output

Same as above, but the agent's text responses are also converted to speech via OpenAI's TTS API. Responses are streamed sentence-by-sentence for low latency. The agent uses a special voice-optimized system prompt that keeps output concise and conversational.

```jsonc
{
  "experimental": {
    "voice": {
      "enabled": true,
      "tts": {
        "enabled": true,
      },
    },
  },
}
```

To get spoken responses, switch to the `voice-build` or `voice-plan` agent using **Tab**. These behave identically to the standard `build` and `plan` agents but produce output optimized for speech — short sentences, no markdown, no code fences. TTS output only activates when a voice agent is selected.

---

#### Native audio input

Some models accept audio directly without transcription. When you select a model with native audio input support (like Gemini), your recording is sent as a WAV file attachment instead of being transcribed first. This is auto-detected from the model's capabilities — no extra configuration needed.

Native audio input also works with TTS output enabled. You get audio in, audio out, but the output is still synthesized from the model's text response.

---

#### Fully native audio

For models that support both audio input and audio output natively (like GPT-4o audio), the agent produces speech directly — no STT or TTS involved. The model receives your audio and responds with audio. This is auto-detected when the model advertises audio in both input and output modalities.

With native audio output, the voice system prompt is skipped since the model handles speech formatting itself.

---

### Configure voice

All voice settings live under `experimental.voice` in your `opencode.json` or `opencode.jsonc`.

```jsonc
{
  "experimental": {
    "voice": {
      "enabled": true,
      "model": "gpt-4o-mini-transcribe",
      "tts": {
        "enabled": true,
        "model": "gpt-4o-mini-tts",
        "voice": "coral",
        "speed": 1,
        "status": true,
      },
    },
  },
}
```

| Key                 | Default                  | Description                                     |
| ------------------- | ------------------------ | ----------------------------------------------- |
| `voice.enabled`     | `false`                  | Enable voice input mode                         |
| `voice.model`       | `gpt-4o-mini-transcribe` | OpenAI transcription model for STT              |
| `voice.tts.enabled` | `false`                  | Enable text-to-speech output                    |
| `voice.tts.model`   | `gpt-4o-mini-tts`        | OpenAI TTS model                                |
| `voice.tts.voice`   | `coral`                  | Voice ID for TTS                                |
| `voice.tts.speed`   | `1`                      | Playback speed multiplier (0.5–4)               |
| `voice.tts.status`  | `true`                   | Speak tool status updates while the agent works |

Voice features require an `OPENAI_API_KEY` environment variable for STT and TTS. Native audio input/output uses whatever provider the selected model belongs to.

---

### Use voice in the TUI

When voice is enabled, the prompt starts in voice mode. Press **Space** to start recording and **Space** again to stop. Your audio is transcribed (or sent natively) and submitted as a prompt.

| Key    | Action                              |
| ------ | ----------------------------------- |
| Space  | Toggle recording                    |
| s      | Stop speaking (when TTS is playing) |
| !      | Enter shell mode                    |
| /      | Enter command mode                  |
| Escape | Exit voice mode                     |

You can also enter voice mode by running `/voice` in the prompt. When `voice.enabled` is `true` in your config, the prompt starts in voice mode automatically.

Voice mode also works for answering permission and question prompts. When the agent asks for permission or poses a question, you can speak your answer and it will be classified against the available options.

---

### Voice SDK

The JavaScript SDK includes a voice module for building custom voice interfaces on top of OpenCode. Import it from `@opencode-ai/sdk/v2/voice`.

```ts
import { createOpencode } from "@opencode-ai/sdk/v2"
import { createVoiceSession } from "@opencode-ai/sdk/v2/voice"

const { client, server } = await createOpencode()

const session = await createVoiceSession(client, {
  permission: "dangerous",
  tts: { voice: "coral" },
})

// Push recorded audio (WAV Uint8Array) to the input queue
session.input.push(audioData)

// Read synthesized speech from the output queue
for await (const chunk of session.output) {
  // PCM audio data — 24kHz 16-bit signed LE mono
  playAudio(chunk)
}

session.close()
await session.done
```

---

#### Session options

`createVoiceSession` accepts the following options:

| Option              | Default       | Description                                                                                     |
| ------------------- | ------------- | ----------------------------------------------------------------------------------------------- |
| `sessionID`         | —             | Reuse an existing session instead of creating one                                               |
| `agent`             | `voice-build` | Agent name                                                                                      |
| `model`             | —             | Model override as `{ providerID, modelID }`                                                     |
| `permission`        | `safe`        | `"safe"` (auto-reject), `"dangerous"` (allow-all), or a custom ruleset                          |
| `tts`               | —             | TTS options: `model`, `voice`, `speed`, `apiKey`, `baseUrl`                                     |
| `stt`               | —             | STT options: `model`, `apiKey`, `baseUrl`, `format` (for raw PCM input)                         |
| `nativeAudioInput`  | auto          | Send audio directly to the model instead of transcribing. Auto-detected from model capabilities |
| `nativeAudioOutput` | auto          | Receive audio directly from the model instead of TTS. Auto-detected from model capabilities     |
| `minSentenceLength` | `40`          | Minimum characters before a sentence is sent to TTS                                             |
| `toolStatus`        | `false`       | Speak tool execution status on the output queue                                                 |
| `system`            | —             | Custom system prompt appended to agent defaults                                                 |
| `tools`             | —             | Tool enable/disable map                                                                         |

---

#### Standalone utilities

The voice module also exports standalone STT, TTS, and audio utility functions.

```ts
import { stt, tts, pcmToWav, splitSentences, sanitize } from "@opencode-ai/sdk/v2/voice"

// Speech-to-text
const text = await stt(wavBuffer, { model: "gpt-4o-mini-transcribe" })

// Text-to-speech (returns a ReadableStream of PCM chunks)
const stream = await tts("Hello world", { voice: "coral" })

// Wrap raw PCM in a WAV header
const wav = pcmToWav(pcmBuffer, { sampleRate: 24000, channels: 1, bitDepth: 16 })

// Split text into speakable sentences
const { complete, remaining } = splitSentences(text, false)

// Strip markdown for TTS
const clean = sanitize(markdownText)
```

---

### Agents

OpenCode includes built-in agents you can switch between with the **Tab** key.

- **build** — default, full-access agent for development work
- **plan** — read-only agent for analysis and code exploration
- **voice-build** — same as build but output is optimized for speech
- **voice-plan** — same as plan but output is optimized for speech

The voice agents produce short, conversational responses with no markdown or code fences. Switch to these when using TTS.

A **general** subagent is also included for complex searches and multistep tasks. It is used internally and can be invoked with `@general` in messages.

---

### Original OpenCode documentation

For general OpenCode configuration and usage, see the [upstream OpenCode docs](https://opencode.ai/docs). Note that some features documented there (like the desktop app and package manager installation) apply to the official release and not to this fork.
