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

> [!IMPORTANT]
> This is an **unofficial fork** of [OpenCode](https://github.com/anomalyco/opencode). It is not built by or affiliated with the OpenCode team. This fork adds experimental voice input and output capabilities to the CLI and the JavaScript SDK.

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

### Prerequisites

Voice features require one of the following for audio playback:

- `ffplay` (from FFmpeg) — recommended, supports streaming and speed control
- `afplay` (macOS built-in) — works but buffers the full response before playing
- `aplay` (Linux ALSA) — stdin streaming support

For recording, you need one of:

- `rec` (from SoX)
- `ffmpeg` (uses AVFoundation on macOS, PulseAudio on Linux)

Install both with:

```bash
# macOS
brew install ffmpeg sox

# Linux (Debian/Ubuntu)
sudo apt install ffmpeg sox
```

---

### Installation

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

OpenCode is also available as a desktop application. Download directly from the [releases page](https://github.com/anomalyco/opencode/releases) or [opencode.ai/download](https://opencode.ai/download).

| Platform              | Download                              |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm`, or AppImage           |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OPENCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.opencode/bin` - Default fallback

```bash
# Examples
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

This fork adds **voice-build** and **voice-plan** agents that behave identically but produce speech-optimized output. Switch to these with **Tab** when using TTS.

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode, [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### FAQ

#### How is this different from Claude Code?

It's very similar to Claude Code in terms of capability. Here are the key differences:

- 100% open source
- Not coupled to any provider. Although we recommend the models we provide through [OpenCode Zen](https://opencode.ai/zen), OpenCode can be used with Claude, OpenAI, Google, or even local models. As models evolve, the gaps between them will close and pricing will drop, so being provider-agnostic is important.
- Out-of-the-box LSP support
- A focus on TUI. OpenCode is built by neovim users and the creators of [terminal.shop](https://terminal.shop); we are going to push the limits of what's possible in the terminal.
- A client/server architecture. This, for example, can allow OpenCode to run on your computer while you drive it remotely from a mobile app, meaning that the TUI frontend is just one of the possible clients.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
