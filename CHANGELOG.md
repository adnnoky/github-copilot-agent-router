# Changelog

All notable changes to **Agent Router** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [1.5.0] — 2026-02-22

### Added
- Custom extension icon (`images/icon.png`) — neural-network routing graph
- `/help` and `/?` registered as official VS Code slash commands (reliably routed via `request.command`)
- Belt-and-suspenders fallback regex for bare `help` / `?` typed without a slash
- Help table updated to show `/help` and `/?` as canonical commands

---

## [1.4.0] — 2026-02-21

### Added
- **`getWorkspaceInfo`** — returns workspace name, root path, active file, language ID, cursor position
- **`getExtensionList`** — lists all installed non-built-in VS Code extensions with version & active status
- **`showNotification`** — displays info / warning / error notification popups in VS Code
- **`openTerminal`** — opens (or reuses) a named terminal panel, optionally sends a command
- **`clipboardRead`** — reads current clipboard contents as text
- **`clipboardWrite`** — writes text to the clipboard
- Total registered tools: **30**

---

## [1.3.0] — 2026-02-21

### Added
- **`getGitStatus`** — runs `git status` and optionally `git diff --stat`
- **`getExtensionSettings`** — reads VS Code workspace configuration for any settings section
- **`listOpenEditors`** — lists all open editor tabs and which is active
- **`getSelectedText`** — reads the highlighted text in the active editor
- **`insertSnippet`** — inserts text / VS Code snippet at the current cursor position
- **`runTests`** — runs the test suite and captures output (default: `npm test`)
- **`getTerminalOutput`** — runs a shell command and captures stdout/stderr
- **`fetchUrl`** — performs an HTTP GET and returns response body (capped at 50 KB)

---

## [1.2.0] — 2026-02-20

### Added
- **`readFileLines`** — reads a specific line range from a file (avoids full-file truncation)
- **`findAndReplace`** — find-and-replace across one or more files; supports plain text and regex
- **`getSymbols`** — lists document symbols (functions, classes, vars) using the language server
- **`openFile`** — opens a file in the VS Code editor, optionally scrolling to a line
- **`showDiff`** — opens VS Code's diff editor to compare two text strings side by side

---

## [1.1.1] — 2026-02-19

### Fixed
- Stability fix for `runCommand` timeout handling
- Corrected model-override banner formatting

---

## [1.1.0] — 2026-02-19

### Added
- **`deleteFile`** — safely moves files to system trash (recoverable)
- **`renameFile`** — rename or move a file/folder (requires confirmation)
- **`copyFile`** — duplicate a file to a new path
- **`createDirectory`** — create a directory (and all missing parents)

---

## [1.0.0] — 2026-02-18

### Added
- Initial stable release
- Auto model-routing by complexity score (0–100)
- Free tier: `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`; Premium tier: all other Copilot models
- `--model <name>` flag to pin a specific model, bypassing auto-routing
- Attached file / selection context resolution (paperclip `#file` references)
- Core agentic tools: `readFile`, `writeFile`, `editFile`, `listDirectory`, `runCommand`, `searchFiles`, `getProblems`
- `/explain` slash command — shows scoring breakdown without calling a model
- `agentRouter.agentMode` setting (default: `true`)
- `agentRouter.freeThreshold` setting (default: `70`)
- Activation event: `onStartupFinished`

---

## [0.9.0] — 2026-02-10

### Added
- Streaming response support for multi-chunk model replies
- Cancellation token support to stop mid-stream

---

## [0.8.0] — 2026-02-08

### Added
- `searchFiles` tool — text search across workspace with glob include/exclude filters

---

## [0.7.0] — 2026-02-06

### Added
- `getProblems` tool — surfaces VS Code diagnostics (errors, warnings) from the Problems panel

---

## [0.6.0] — 2026-02-04

### Added
- `runCommand` tool — execute arbitrary shell commands from the model with confirmation guard

---

## [0.5.0] — 2026-02-02

### Added
- `editFile` tool — targeted line-range replacements via VS Code WorkspaceEdit (undo-safe)

---

## [0.4.0] — 2026-01-30

### Added
- `writeFile` tool — create new files or overwrite existing ones
- `listDirectory` tool — list files and subdirectories in a workspace path

---

## [0.3.0] — 2026-01-27

### Added
- `readFile` tool — read full text contents of any workspace file
- agentic tool loop via `runAgentLoop` (multi-turn tool-calling)

---

## [0.2.0] — 2026-01-24

### Added
- Routing decision (`free` / `premium`) based on complexity score and configurable threshold
- Initial complexity scorer with keyword heuristics and length/structure bonuses

---

## [0.1.0] — 2026-01-20

### Added
- Initial project scaffolding
- `@router` chat participant registered with VS Code Chat API
- `isSticky: true` — participant persists across chat sessions
