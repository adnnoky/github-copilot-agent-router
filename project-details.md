# Agent Router - Project Details

## 📋 Project Overview

**Agent Router** is a VS Code extension that intelligently routes GitHub Copilot Chat prompts to the most appropriate model tier based on complexity scoring. It integrates as a native `@router` chat participant and provides full agentic capabilities including file editing, terminal command execution, and workspace search.

| Property | Value |
|---|---|
| **Name** | agent-router-extension |
| **Display Name** | Agent Router |
| **Version** | 1.1.1 |
| **Publisher** | local |
| **License** | See licence.md |
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

### Agentic Tools (when agent mode is enabled)
1. **agent-router_readFile** — Read file contents
2. **agent-router_writeFile** — Create or overwrite files
3. **agent-router_editFile** — Apply targeted line-range edits
4. **agent-router_listDirectory** — List directory contents
5. **agent-router_runCommand** — Execute terminal commands
6. **agent-router_searchFiles** — Search files across workspace
7. **agent-router_getProblems** — Get VS Code diagnostics
8. **agent-router_deleteFile** — Delete files safely

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
├── LICENSE                    # Project license
├── README.md                  # User documentation
├── quickstart.md              # Quick start guide
├── author.md                  # Author information
├── licence.md                 # Licensing details
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
- **Read:** Full text content via `agent-router_readFile`
- **Write:** Create/overwrite files via `agent-router_writeFile`
- **Edit:** Line-range targeting with `agent-router_editFile`
- **Delete:** Safe trash-based removal via `agent-router_deleteFile`

### Search & Navigation
- **List:** Directory contents via `agent-router_listDirectory`
- **Search:** Text patterns via `agent-router_searchFiles`

### Terminal & Diagnostics
- **Execute:** Shell commands via `agent-router_runCommand`
- **Diagnostics:** VS Code problems via `agent-router_getProblems`

---

## 📊 Categories & Tags

| Aspect | Value |
|---|---|
| **Extension Categories** | AI, Chat |
| **Tool Tags** | workspace, file, read, write, execute, terminal, search, vscode, diagnostics |

---

## 📈 Version History

| Version | Release Status |
|---|---|
| 1.1.1 | Current |
| 1.0.0 | Stable |
| 0.9.0 - 0.1.0 | Archive |

---

## 📚 Documentation Files

| File | Purpose |
|---|---|
| `README.md` | User guide, configuration, usage examples |
| `quickstart.md` | Quick start instructions |
| `author.md` | Author/contributor information |
| `licence.md` | License details |
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
