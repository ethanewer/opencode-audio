import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useKeybind } from "@tui/context/keybind"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { createMemo, createSignal, onMount } from "solid-js"

function DialogWorktreeName(props: { onCreated: (id: string) => void }) {
  const sdk = useSDK()
  const toast = useToast()
  const [name, setName] = createSignal("")
  const [creating, setCreating] = createSignal(false)
  const sync = useSync()

  const options = createMemo(() => {
    if (creating()) return [{ title: "Creating worktree...", value: "__creating__" as const }]
    const n = name().trim()
    return [
      {
        title: n ? `Create "${n}"` : "Create with random name",
        value: "__confirm__" as const,
        description: n ? `branch opencode/${n}` : "press enter",
      },
    ]
  })

  async function create() {
    if (creating()) return
    const input = name().trim()
    setCreating(true)
    const result = await sdk.client.experimental.workspace
      .create({ type: "worktree", branch: null, name: input || null })
      .catch(() => undefined)
    if (!result?.data) {
      const msg = (result?.error as any)?.message ?? "Failed to create worktree"
      toast.show({ message: msg, variant: "error" })
      setCreating(false)
      return
    }
    await sync.workspace.sync()
    props.onCreated(result.data.id)
  }

  return (
    <DialogSelect
      title="New Worktree"
      placeholder="Name (enter for random)"
      skipFilter={false}
      options={options()}
      onFilter={(q) => setName(q)}
      onSelect={(option) => {
        if (option.value === "__creating__") return
        void create()
      }}
    />
  )
}

export function DialogWorktree() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const keybind = useKeybind()
  const [deleting, setDeleting] = createSignal<string>()

  onMount(() => {
    void sync.workspace.sync()
  })

  function last(id: string) {
    const match = sync.data.session
      .filter((s) => s.workspaceID === id && !s.parentID)
      .sort((a, b) => b.time.updated - a.time.updated)[0]
    return match?.title
  }

  const options = createMemo(() => [
    ...sync.data.workspaceList
      .filter((w) => w.type === "worktree")
      .map((w) => {
        const title = last(w.id)
        const name = w.name ?? w.id
        return {
          title: deleting() === w.id ? `Delete ${name}? Press ${keybind.print("session_delete")} again` : name,
          value: w.id,
          description: title ?? "no sessions",
        }
      }),
    { title: "+ New worktree", value: "__new__" as const, description: "Create a new git worktree" },
  ])

  function select(id: string) {
    sdk.setWorkspace(id)
    route.navigate({ type: "home", workspaceID: id })
    dialog.clear()
  }

  return (
    <DialogSelect
      title="Worktree"
      skipFilter={true}
      options={options()}
      onMove={() => setDeleting(undefined)}
      onSelect={(option) => {
        setDeleting(undefined)
        if (option.value === "__new__") {
          dialog.replace(() => (
            <DialogWorktreeName
              onCreated={(id) => select(id)}
            />
          ))
          return
        }
        select(option.value)
      }}
      keybind={[
        {
          keybind: keybind.all.session_delete?.[0],
          title: "delete",
          onTrigger: async (option) => {
            if (option.value === "__new__") return
            if (deleting() !== option.value) {
              setDeleting(option.value)
              return
            }
            const result = await sdk.client.experimental.workspace
              .remove({ id: option.value })
              .catch(() => undefined)
            setDeleting(undefined)
            if (result?.error) {
              toast.show({ message: "Failed to delete worktree", variant: "error" })
              return
            }
            if (sdk.workspaceID === option.value) {
              sdk.setWorkspace(undefined)
              route.navigate({ type: "home" })
            }
            await sync.workspace.sync()
          },
        },
      ]}
    />
  )
}
