# Agent Router - Project Details

## 📋 Project Overview

**Agent Router** is a VS Code extension that intelligently routes GitHub Copilot Chat prompts to the most appropriate model tier based on complexity scoring. It integrates as a native `@router` chat participant and provides full agentic capabilities including file editing, terminal command execution, and workspace search.

| Property | Value |
|---|---|
| **Name** | agent-router-extension |
| **Display Name** | Agent Router |
| **Version** | 1.5.0 |
| **Publisher** | local |
| **License** | MIT |
| **Author** | Adnan Okay |
| **VS Code Minimum Version** | ^1.95.0 |
| **Node Version** | ^20.16.11 |
| **TypeScript Version** | ^5.6.3 |

---

## 🎯 Core Functionality

### Auto-Routing Engine
- Analyzes prompt complexity on a scale of 0–100
- Routes scores ≤ free threshold (default: 70) → free models (gpt-4o, gpt-4o-mini, gpt-4.1)
- Routes scores > threshold → premium models (o3, claude-3.5-sonnet, gemini-2.0)
- Non-blocking keyword heuristics for fast scoring

### Chat Participant
- **ID:** `agent-router.router`
- **Name:** @router
- **Commands:**
  - `@router <prompt>` — Score, route, and answer your prompt
  - `@router /explain <prompt>` — Show routing decision without calling a model
  - `@router /help` or `@router /?` — Show usage guide and available commands

### Agentic Tools (when agent mode is enabled)

#### File Operations
1. **agent-router_readFile** — Read full file contents
2. **agent-router_writeFile** — Create or overwrite files
3. **agent-router_editFile** — Apply targeted line-range edits
4. **agent-router_listDirectory** — List directory contents
5. **agent-router_deleteFile** — Safe trash-based removal
6. **agent-router_renameFile** — Rename or move a file/folder
7. **agent-router_copyFile** — Duplicate a file to a new path
8. **agent-router_createDirectory** — Create directory (and all parents)
9. **agent-router_readFileLines** — Read a specific line range from a file
10. **agent-router_findAndReplace** — Find-and-replace across one or more files
11. **agent-router_openFile** — Open a file in the VS Code editor
12. **agent-router_showDiff** — Open diff editor to compare two text strings

#### Search & Navigation
13. **agent-router_searchFiles** — Text search across workspace
14. **agent-router_getSymbols** — List document symbols via language server

#### Terminal & Diagnostics
15. **agent-router_runCommand** — Execute shell commands with confirmation
16. **agent-router_getProblems** — Get VS Code diagnostics
17. **agent-router_runTests** — Run test suite and capture output
18. **agent-router_getTerminalOutput** — Run command and capture stdout/stderr

#### Editor & Workspace State
19. **agent-router_getWorkspaceInfo** — Workspace name, root path, active file, language, cursor
20. **agent-router_listOpenEditors** — List all open editor tabs
21. **agent-router_getSelectedText** — Read highlighted text in active editor
22. **agent-router_insertSnippet** — Insert text/snippet at cursor position

#### Git
23. **agent-router_getGitStatus** — Run `git status` and optionally `git diff --stat`

#### VS Code Integration
24. **agent-router_getExtensionSettings** — Read VS Code workspace configuration
25. **agent-router_getExtensionList** — List all installed VS Code extensions
26. **agent-router_showNotification** — Display info/warning/error notification popups
27. **agent-router_openTerminal** — Open or reuse a named terminal panel

#### Network & Clipboard
28. **agent-router_fetchUrl** — HTTP GET with response body (capped at 50 KB)
29. **agent-router_clipboardRead** — Read current clipboard contents
30. **agent-router_clipboardWrite** — Write text to the clipboard

---

## 📁 Project Structure

```
agent-router/
├── src/
│   ├── extension.ts           # Main extension entry point
│   ├── scorer.ts              # Complexity scoring logic
│   ├── router.ts              # Chat participant & routing logic
│   ├── tools/                 # Tool implementations
│   ├── utils/                 # Utility helpers
│   └── types.ts               # TypeScript type definitions
├── out/                       # Compiled JavaScript output
├── .github/
│   ├── agents/                # Agent definitions
│   └── workflows/             # CI/CD workflows
├── .vscode/                   # VS Code configuration
├── package.json               # Dependency & script definitions
├── tsconfig.json              # TypeScript configuration
├── LICENSE                    # MIT license
├── README.md                  # User documentation
├── quickstart.md              # Quick start guide
├── CHANGELOG.md               # Full version history
├── adnan.md                   # Author information
└── agent-router-extension-*.vsix  # Published packages

```

---

## ⚙️ Complexity Scoring Algorithm

The scorer assigns points based on:

### Base Scoring
- **Base score:** 10 (all prompts)

### Bonus Points
| Factor | Points | Trigger |
|---|---|---|
| **Length bonus** | +25 | Long prompts |
| **Multi-step structure** | +8 | 4+ lines |
| **Dense technical syntax** | +7 | Code-heavy content |

### Keyword Signals
| Category | Points | Examples |
|---|---|---|
| Architecture / Microservices | +20 | distributed, kubernetes, load balancing |
| Security / Auth / Encryption | +20 | OAuth2, JWT, cryptography, TLS |
| Machine Learning / Neural Networks | +18 | neural networks, transformers, NLP |
| Performance / Optimization | +15 | caching, indexing, profiling |
| Refactoring / Migration | +12 | legacy, deprecation, upgrade |
| Deep Debugging / Root-cause | +10 | memory leak, deadlock, race condition |

---

## 🔧 Configuration

All settings are under the `agentRouter` namespace in VS Code settings:

### Settings

| Setting | Type | Default | Description |
|---|---|---|---|
| `agentRouter.freeThreshold` | number | 70 | Complexity threshold (0–100) |
| `agentRouter.agentMode` | boolean | true | Enable/disable full agentic loop |

---

## 🚀 Development Workflow

### Setup
```bash
npm install          # Install dependencies
npm run compile      # Compile TypeScript
npm run watch        # Watch mode for development
```

### Debugging
1. Press `F5` in VS Code to launch **Extension Development Host**
2. Test the `@router` participant in Copilot Chat (Ctrl+Alt+I / ⌘⌥I)
3. Set breakpoints in src/ files; they'll apply to the host

### Building & Publishing
```bash
npm run vscode:prepublish     # Preparation for publishing
# Package with: vsce package
# Publish with: vsce publish
```

---

## 📦 Dependencies

### Runtime
- **@types/vscode:** ^1.95.0 — VS Code extension API types
- **@types/node:** ^20.16.11 — Node.js types
- **typescript:** ^5.6.3 — TypeScript compiler

### VS Code API Proposals
- **chatParticipantAdditions** — Enhanced chat participant capabilities

---

## 💬 Chat Participant API

### Activation
- **Event:** `onStartupFinished`
- **Sticky:** true (chat participant persists across sessions)

### Message Handling
The router:
1. Receives user prompt
2. Sanitizes & analyzes complexity
3. Scores against heuristics
4. Selects appropriate model tier
5. Invokes Copilot with selection
6. Streams response back to chat

### Command: `/explain`
Shows scoring breakdown without calling a model:
- Complexity score
- Matched keywords
- Assigned tier (free/premium)
- Selected model

---

## 🛠️ Tool Integration

All tools expose a standardized **inputSchema** for AI model invocation:

### File Operations (Workspace)
- **Read:** Full text content via `agent-router_readFile`; line-range via `agent-router_readFileLines`
- **Write:** Create/overwrite files via `agent-router_writeFile`
- **Edit:** Line-range targeting with `agent-router_editFile`; find-and-replace via `agent-router_findAndReplace`
- **Delete:** Safe trash-based removal via `agent-router_deleteFile`
- **Rename/Copy/Move:** Via `agent-router_renameFile` and `agent-router_copyFile`
- **Directories:** Create with `agent-router_createDirectory`; list with `agent-router_listDirectory`

### Search & Navigation
- **List:** Directory contents via `agent-router_listDirectory`
- **Search:** Text patterns via `agent-router_searchFiles`
- **Symbols:** Document symbol lookup via `agent-router_getSymbols`
- **Open/Diff:** Open files via `agent-router_openFile`; side-by-side diff via `agent-router_showDiff`

### Terminal & Diagnostics
- **Execute:** Shell commands via `agent-router_runCommand`
- **Diagnostics:** VS Code problems via `agent-router_getProblems`
- **Tests:** Run test suite via `agent-router_runTests`
- **Capture:** Capture terminal output via `agent-router_getTerminalOutput`

### Editor & Workspace
- **Workspace Info:** Name, root path, language, cursor via `agent-router_getWorkspaceInfo`
- **Editors:** List open tabs via `agent-router_listOpenEditors`
- **Selection:** Get highlighted text via `agent-router_getSelectedText`
- **Snippet:** Insert at cursor via `agent-router_insertSnippet`

### Git
- **Status:** `git status` / `git diff --stat` via `agent-router_getGitStatus`

### VS Code Integration
- **Settings:** Read config via `agent-router_getExtensionSettings`
- **Extensions:** List installed extensions via `agent-router_getExtensionList`
- **Notifications:** Popup messages via `agent-router_showNotification`
- **Terminal:** Open/reuse terminal panel via `agent-router_openTerminal`

### Network & Clipboard
- **HTTP:** GET requests via `agent-router_fetchUrl`
- **Clipboard:** Read/write via `agent-router_clipboardRead` / `agent-router_clipboardWrite`

---

## 📊 Categories & Tags

| Aspect | Value |
|---|---|
| **Extension Categories** | AI, Chat |
| **Tool Tags** | workspace, file, read, write, execute, terminal, search, vscode, diagnostics, git, clipboard, network |

---

## 📈 Version History

| Version | Release Status | Highlights |
|---|---|---|
| 1.5.0 | Current | Icon, /help & /? commands, README/docs rewrite, package.json metadata |
| 1.4.0 | Stable | 6 new tools: workspace info, extension list, notifications, terminal, clipboard |
| 1.3.0 | Stable | 8 new tools: git status, settings, open editors, selection, snippet, tests, terminal, fetch |
| 1.2.0 | Stable | 5 new tools: readFileLines, findAndReplace, getSymbols, openFile, showDiff |
| 1.1.1 | Stable | Stability fix for runCommand timeout; corrected model-override banner |
| 1.1.0 | Stable | 4 new tools: deleteFile, renameFile, copyFile, createDirectory |
| 1.0.0 | Stable | Initial stable release with 7 core tools, auto-routing, /explain command |
| 0.1.0 – 0.9.0 | Archive | Early iterations |

---

## 📚 Documentation Files

| File | Purpose |
|---|---|
| `README.md` | User guide, configuration, usage examples, all 30 tools |
| `quickstart.md` | Quick start instructions with .vsix install steps |
| `adnan.md` | Author/contributor information |
| `CHANGELOG.md` | Full version history from 0.1.0 to 1.5.0 |
| `project-details.md` | This file — comprehensive project documentation |

---

## 🎯 Key Design Decisions

1. **Keyword Heuristics** — Fast, non-blocking complexity scoring without LLM calls
2. **Layered Architecture** — Separation of scorer, router, and tool layers
3. **Full Agentic Support** — Default agent mode enables tool-calling for complex workflows
4. **Configurable Threshold** — Users can adjust free/premium split to match their needs
5. **Sticky Chat Participant** — @router remains available across chat sessions

---

## 🔐 Requirements

- **OS:** Windows, macOS, Linux
- **VS Code:** ^1.95.0 minimum
- **GitHub Copilot Extension:** v1.0+
- **Active Copilot Subscription:** For premium model access

---

## 📝 Notes

- The project uses **VS Code's ChatParticipantAdditions API**, which may still be in proposal status
- Full agentic mode requires proper tool registration and model support
- Complexity scoring is fully customizable through keyword lists in scorer.ts
- All terminal commands run in the workspace root by default
