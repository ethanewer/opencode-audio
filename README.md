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

### Use the CLI

The TUI ships with a set of default **systems** and **agents** so you can start working immediately. A system groups a model, reasoning level, and optional voice configuration into a single preset. Two agents are available: **build** (full-access development) and **plan** (read-only analysis).

| Key       | Action                                 |
| --------- | -------------------------------------- |
| Tab       | Cycle agents within the current system |
| Shift+Tab | Cycle between systems                  |

The status bar shows the active agent, system label, reasoning level, and providers.

---

#### Voice in the TUI

To enable voice mode, set `experimental.voice.enabled` to `true` in your config (`~/.config/opencode/opencode.json` or `.opencode/opencode.json`):

```json
{
  "experimental": {
    "voice": {
      "enabled": true
    }
  }
}
```

When voice is enabled, the prompt starts in voice mode. Press **Space** to start recording and **Space** again to stop. Your audio is transcribed (or sent natively) and submitted as a prompt.

| Key    | Action                              |
| ------ | ----------------------------------- |
| Space  | Toggle recording                    |
| s      | Stop speaking (when TTS is playing) |
| !      | Enter shell mode                    |
| /      | Enter command mode                  |
| Escape | Exit voice mode                     |

You can also enter voice mode by running `/voice` in the prompt. Voice mode works for answering permission and question prompts too — speak your answer and it will be classified against the available options.

---

#### Voice modes

How voice behaves depends on the active system's configuration:

- **Transcribed input, text output** — Your speech is transcribed via OpenAI's STT API. The agent responds with text. Works with any model that has a `transcription` field.
- **Transcribed input, spoken output** — Same as above, plus the agent's text is converted to speech via OpenAI's TTS API. Activates when the system has a `tts` config. Responses are streamed sentence-by-sentence for low latency.
- **Native audio input** — Some models accept audio directly. Your recording is sent as a WAV attachment instead of being transcribed. Auto-detected from the model's capabilities.
- **Fully native audio** — Models like GPT Audio handle both audio input and output natively. No STT or TTS involved. Auto-detected when the model supports audio in both directions.

---

### Voice SDK

The JavaScript SDK includes a voice module for building custom voice interfaces on top of OpenCode. Import it from `@opencode-ai/sdk/v2/voice`.

#### Built-in systems

The voice SDK ships with built-in systems that work out of the box — just pass a system name as a string. All you need are your API keys set as environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`).

```ts
import { createOpencode } from "@opencode-ai/sdk/v2"
import { createVoiceSession } from "@opencode-ai/sdk/v2/voice"

const { client, server } = await createOpencode()

const session = await createVoiceSession(client, {
  system: "claude-opus-medium-voice",
  permission: "dangerous",
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

Available built-in systems:

| Name                       | Model                 | Variant | STT    | TTS                          |
| -------------------------- | --------------------- | ------- | ------ | ---------------------------- |
| `claude-opus-medium-voice` | Claude Opus 4.6       | medium  | yes    | gpt-4o-mini-tts, echo, 1.25x |
| `claude-opus-high-voice`   | Claude Opus 4.6       | high    | yes    | gpt-4o-mini-tts, echo, 1.25x |
| `claude-opus-max-voice`    | Claude Opus 4.6       | max     | yes    | gpt-4o-mini-tts, echo, 1.25x |
| `gpt-medium-voice`         | GPT 5.4               | medium  | yes    | gpt-4o-mini-tts, echo, 1.25x |
| `gpt-high-voice`           | GPT 5.4               | high    | yes    | gpt-4o-mini-tts, echo, 1.25x |
| `gpt-xhigh-voice`          | GPT 5.4               | xhigh   | yes    | gpt-4o-mini-tts, echo, 1.25x |
| `gpt-audio-voice`          | GPT Audio             | —       | native | native                       |
| `gemini-flash-voice`       | Gemini 3.1 Flash Lite | —       | yes    | gpt-4o-mini-tts, echo, 1.25x |
| `gemini-pro-voice`         | Gemini 3.1 Pro        | —       | yes    | gpt-4o-mini-tts, echo, 1.25x |

You can also access the built-in systems directly via the `voiceSystems` export:

```ts
import { voiceSystems } from "@opencode-ai/sdk/v2/voice"

console.log(Object.keys(voiceSystems))
// => ["claude-opus-medium-voice", "claude-opus-high-voice", ...]
```

---

#### Custom systems

Pass a `VoiceSystem` object instead of a string for full control:

```ts
const session = await createVoiceSession(client, {
  system: {
    model: "anthropic/claude-opus-4-6",
    variant: "medium",
    transcription: "gpt-4o-mini-transcribe",
    tts: { model: "gpt-4o-mini-tts", voice: "coral", speed: 1.5 },
  },
  permission: "dangerous",
})
```

---

#### Session options

`createVoiceSession` requires a `system` field and accepts the following options:

| Option              | Default | Description                                                                                     |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `system`            | —       | **Required.** Built-in system name or custom `VoiceSystem` object                               |
| `sessionID`         | —       | Reuse an existing session instead of creating one                                               |
| `permission`        | `safe`  | `"safe"` (auto-reject), `"dangerous"` (allow-all), or a custom ruleset                          |
| `prompt`            | —       | Custom system prompt appended to agent defaults                                                 |
| `tools`             | —       | Tool enable/disable map                                                                         |
| `nativeAudioInput`  | auto    | Send audio directly to the model instead of transcribing. Auto-detected from model capabilities |
| `nativeAudioOutput` | auto    | Receive audio directly from the model instead of TTS. Auto-detected from model capabilities     |
| `minSentenceLength` | `40`    | Minimum characters before a sentence is sent to TTS                                             |
| `toolStatus`        | `false` | Speak tool execution status on the output queue                                                 |
| `format`            | —       | Output format                                                                                   |
| `noReply`           | `false` | Don't generate a reply                                                                          |

The custom `system` object has these fields:

| Field           | Default       | Description                                    |
| --------------- | ------------- | ---------------------------------------------- |
| `model`         | —             | **Required.** Model in `provider/model` format |
| `variant`       | —             | Reasoning effort level                         |
| `transcription` | —             | STT model name                                 |
| `tts`           | —             | TTS config (`model`, `voice`, `speed`)         |
| `agent`         | `voice-build` | Agent name                                     |
| `apiKey`        | —             | OpenAI API key for STT/TTS                     |
| `baseUrl`       | —             | OpenAI base URL for STT/TTS                    |

The original SDK (`@opencode-ai/sdk/v2`) is completely unchanged.

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

### Configuration

Out of the box, the TUI ships with default systems so you can start immediately. To customize which models, reasoning levels, and voice settings are available, define your own systems.

#### Systems

A system groups a model, reasoning level, and voice configuration into a single switchable preset.

| Field           | Required | Description                                         |
| --------------- | -------- | --------------------------------------------------- |
| `model`         | yes      | LLM model in `provider/model` format                |
| `label`         | no       | Display name shown in the status bar                |
| `variant`       | no       | Reasoning effort (`medium`, `high`, `max`, `xhigh`) |
| `transcription` | no       | STT model name for voice input                      |
| `tts`           | no       | TTS config object (`model`, `voice`, `speed`)       |
| `agents`        | no       | Agent list, defaults to `["build", "plan"]`         |

---

#### Custom systems

Define systems in `~/.config/opencode/opencode.json` (or `.opencode/opencode.json`) under the `system` field. When you define custom systems, they replace the defaults entirely.

```json
{
  "system": {
    "claude-voice": {
      "label": "Claude Opus 4.6",
      "model": "anthropic/claude-opus-4-6",
      "variant": "medium",
      "transcription": "gpt-4o-mini-transcribe",
      "tts": {
        "model": "gpt-4o-mini-tts",
        "voice": "echo",
        "speed": 1.25
      },
      "agents": ["build", "plan"]
    },
    "claude-high": {
      "label": "Claude Opus 4.6",
      "model": "anthropic/claude-opus-4-6",
      "variant": "high",
      "transcription": "gpt-4o-mini-transcribe",
      "agents": ["build", "plan"]
    },
    "gpt-audio": {
      "label": "GPT Audio",
      "model": "openai/gpt-audio",
      "agents": ["build", "plan"]
    }
  },
  "experimental": {
    "voice": {
      "enabled": true
    }
  }
}
```

Voice-optimized agent variants (`voice-build` and `voice-plan`) are used automatically when a system has TTS configured. A **general** subagent for complex searches can be invoked with `@general` in messages.

---

#### Keybinds

| Key         | Action                                 |
| ----------- | -------------------------------------- |
| Tab         | Cycle agents within the current system |
| Shift+Tab   | Cycle between systems                  |
| `<leader>m` | Open system selection dialog           |
| `/systems`  | List all available systems             |

---

#### Default systems

New installs with no custom `system` config get these presets:

| Key                        | Model                 | Variant | Voice        |
| -------------------------- | --------------------- | ------- | ------------ |
| `claude-opus-medium-voice` | Claude Opus 4.6       | medium  | STT + TTS    |
| `claude-opus-high`         | Claude Opus 4.6       | high    | STT          |
| `claude-opus-max`          | Claude Opus 4.6       | max     | STT          |
| `gpt-medium`               | GPT 5.4               | medium  | STT          |
| `gpt-high`                 | GPT 5.4               | high    | STT          |
| `gpt-xhigh`                | GPT 5.4               | xhigh   | STT          |
| `gpt-audio`                | GPT Audio             | —       | Native audio |
| `gemini-flash`             | Gemini 3.1 Flash Lite | —       | —            |
| `gemini-pro`               | Gemini 3.1 Pro        | —       | —            |

---

### Original OpenCode documentation

For general OpenCode configuration and usage, see the [upstream OpenCode docs](https://opencode.ai/docs). Note that some features documented there (like the desktop app and package manager installation) apply to the official release and not to this fork.
