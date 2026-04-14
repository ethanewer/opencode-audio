import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, createSignal, onCleanup, onMount } from "solid-js"

export type EventSource = {
  on: (handler: (event: Event) => void) => () => void
  setWorkspace?: (workspaceID?: string) => Promise<{ directory?: string }> | void
}

export type ClassifyFn = (input: {
  providerID: string
  modelID: string
  transcript: string
  options: string[]
  question?: string
}) => Promise<{ option: string | null; context: string | null; confidence: number }>

export type ClassifyMultiFn = (input: {
  providerID: string
  modelID: string
  transcript: string
  options: string[]
  question?: string
}) => Promise<{ options: string[]; context: string | null; confidence: number }>

export type TranscribeFn = (input: { audio: Uint8Array; model?: string }) => Promise<string>

export type SpeakFn = (input: { text: string; model?: string; voice?: string }) => Promise<string>

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
    classify?: ClassifyFn
    classifyMulti?: ClassifyMultiFn
    transcribe?: TranscribeFn
    speak?: SpeakFn
  }) => {
    const abort = new AbortController()
    const [wsId, setWsId] = createSignal<string | undefined>()
    let dir = props.directory
    let sse: AbortController | undefined

    function createSDK() {
      return createOpencodeClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory: dir,
        fetch: props.fetch,
        headers: props.headers,
        experimental_workspaceID: wsId(),
      })
    }

    let sdk = createSDK()

    const emitter = createGlobalEmitter<{
      [key in Event["type"]]: Extract<Event, { type: key }>
    }>()

    let queue: Event[] = []
    let timer: Timer | undefined
    let last = 0

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          emitter.emit(event.type, event)
        }
      })
    }

    const handleEvent = (event: Event) => {
      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    function startSSE() {
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break
          const events = await sdk.event.subscribe({}, { signal: ctrl.signal })

          for await (const event of events.stream) {
            if (ctrl.signal.aborted) break
            handleEvent(event)
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
        }
      })().catch(() => {})
    }

    onMount(() => {
      if (props.events) {
        const unsub = props.events.on(handleEvent)
        onCleanup(unsub)
      } else {
        startSSE()
      }
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      if (timer) clearTimeout(timer)
    })

    return {
      get client() {
        return sdk
      },
      get workspaceID() {
        return wsId()
      },
      classify: props.classify,
      classifyMulti: props.classifyMulti,
      transcribe: props.transcribe,
      speak: props.speak,
      get directory() {
        return dir
      },
      event: emitter,
      fetch: props.fetch ?? fetch,
      setWorkspace(next?: string) {
        if (wsId() === next) return
        setWsId(next)
        sdk = createSDK()
        const p = props.events?.setWorkspace?.(next)
        if (p)
          p.then((result) => {
            if (result?.directory && result.directory !== dir) {
              dir = result.directory
              sdk = createSDK()
            }
          }).catch(() => {})
        if (!props.events) startSSE()
      },
      url: props.url,
    }
  },
})
