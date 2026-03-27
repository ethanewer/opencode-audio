import { writeFileSync, unlinkSync } from "node:fs"
import { experimental_generateSpeech as generateSpeech, experimental_transcribe as transcribe } from "ai"
import { createOpenAI } from "@ai-sdk/openai"

const openai = createOpenAI()

// --- TTS: gpt-4o-mini-tts ---

const text = "Hello! This is a demo of the OpenAI audio models. Pretty cool, right?"

console.log("[TTS] Generating speech...")
const tts = await generateSpeech({
  model: openai.speech("gpt-4o-mini-tts"),
  text,
  voice: "coral",
  outputFormat: "wav",
})

const path = "demo-output.wav"
writeFileSync(path, tts.audio.uint8Array)
console.log(`[TTS] Wrote ${tts.audio.uint8Array.length} bytes to ${path}`)

// --- STT: gpt-4o-mini-transcribe ---

console.log("\n[STT] Transcribing audio back...")
const stt = await transcribe({
  model: openai.transcription("gpt-4o-mini-transcribe"),
  audio: tts.audio.uint8Array,
})

console.log(`[STT] Transcript: "${stt.text}"`)

unlinkSync(path)
console.log(`\n[cleanup] Removed ${path}`)
