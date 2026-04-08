## Bugs

- `Unknown parameter: 'modalities'` shows up in the TUI
- When `/eval` returns its result to the build agent, the build agent does not keep working (note every time)
  - This could be a more general but with subagents, but I am not sure of this
  - Eval can stop without calling the end eval tool, causing the agent to hang.

## Features

- shift + space to stop recording in voice mode, but not submit the message. this should workslike when the user starts typing, but without the user needing to append chars to the current message
- Optional compressed view for shell tool.
  - 1 line per shell command only (display for read tool, but with a different color)
  - Click to show output (indented and faded below tool call line)
- Reduce the number of times I need to give permissions for read/write/edit:
  - The agent tries to read from "/" when it doesn't need to.
    - We could add notes to prompts to only read outside <cli_entrypoint_path> if actually needed.
    - Add a nudge when the agent tries to do an action that requires user permission.
      - Give a model the message used to deny actions, but add rerun the tool call to ask the user for explicit permission.
  - Make a new tmp dir for every session, and allow the model to read and write to it as needed (if the agent has read/write permission).
    - The path should be given to the agent in the system prompt.
    - The path should have the same permission as the dir where the cli was started in.
