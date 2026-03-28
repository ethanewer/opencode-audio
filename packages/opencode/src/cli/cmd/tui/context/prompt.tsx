import { createSimpleContext } from "./helper"
import type { PromptRef } from "../component/prompt"

export type PromptMode = "normal" | "shell" | "voice"

export const { use: usePromptRef, provider: PromptRefProvider } = createSimpleContext({
  name: "PromptRef",
  init: () => {
    let current: PromptRef | undefined
    let mode: PromptMode = "normal"

    return {
      get current() {
        return current
      },
      set(ref: PromptRef | undefined) {
        current = ref
      },
      get mode() {
        return mode
      },
      setMode(v: PromptMode) {
        mode = v
      },
    }
  },
})
