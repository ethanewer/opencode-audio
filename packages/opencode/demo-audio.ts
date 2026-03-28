import { speak, play, speakStream, playStream } from "./src/audio/speak"

const text = "Hello! This is a demo of the OpenAI audio models. Pretty cool, right?"

// --- TTS: buffered mode ---

console.log("[TTS buffered] Generating speech...")
const start1 = performance.now()
const audio = await speak(text)
const elapsed1 = (performance.now() - start1).toFixed(0)
console.log(`[TTS buffered] Generated ${audio.length} bytes in ${elapsed1}ms`)

const player1 = play(audio)
await player1.done
console.log("[TTS buffered] Playback complete")

// --- TTS: streaming mode ---

console.log("\n[TTS streaming] Generating speech with streaming playback...")
const start2 = performance.now()
const stream = await speakStream(text)
const elapsed2 = (performance.now() - start2).toFixed(0)
console.log(`[TTS streaming] Got response stream in ${elapsed2}ms, piping to player...`)

const player2 = playStream(stream)
await player2.done
const total2 = (performance.now() - start2).toFixed(0)
console.log(`[TTS streaming] Playback complete in ${total2}ms total`)
