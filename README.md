# Agent Router — `@router`

> **Routes GitHub Copilot Chat prompts to free or premium models based on complexity — with full agentic file-edit, terminal, and workspace capabilities.**

[![Version](https://img.shields.io/badge/version-1.9.3-blue)](https://github.com/adnnoky/github-copilot-agent-router/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.95.0-blueviolet)](https://code.visualstudio.com/)

**Author:** [Adnan Okay](https://github.com/adnnoky)

---

## What It Does

Agent Router integrates with **GitHub Copilot Chat** as a native `@router` chat participant. It scores the complexity of your prompt (0–100) and automatically routes it to the most appropriate Copilot model — so you use powerful premium models only when they're actually needed.

```
@router <your prompt>
      │
      ▼
  Complexity Score (0–100)
  via keyword heuristics
      │
      ├─ Score ≤ threshold → 🟢 Free model      (gpt-5-mini, gpt-4o, gpt-4.1)
      └─ Score >  threshold → 🔴 Premium model  (claude-sonnet-4.6, gemini-3-pro, gpt-5.3-codex…)
      │
      ▼
  Full agentic loop with 30 tools (file edits, terminal, search, git…)
  Response streamed back into Copilot Chat
```

---

## Installation

### Option A — From `.vsix` File (Manual)

1. Download the latest `.vsix` from [Releases](https://github.com/adnnoky/github-copilot-agent-router/releases)
2. Open VS Code → **Extensions** sidebar (`Ctrl+Shift+X`)
3. Click the `···` menu (top-right) → **Install from VSIX…**
4. Select the downloaded file and reload VS Code

### Option B — VS Code Marketplace

Search for **"Agent Router"** in the Extensions panel, or:

```
ext install local.agent-router-extension
```

### Prerequisites

- VS Code `^1.95.0`
- [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) extension installed & active
- Active GitHub Copilot subscription (for premium model access)

---

## Usage

Open **Copilot Chat** (`Ctrl+Alt+I` / `⌘⌥I`) and type:

| Command | Description |
|---|---|
| `@router <prompt>` | Score, route and answer your prompt |
| `@router /help` or `@router /?` | Show the full help page |
| `@router /explain <prompt>` | Show routing decision (score, tier, model) — no LLM call |
| `@router /boost <prompt>` | Expand a short prompt into a detailed one using chat history for context |
| `@router /<model> <prompt>` | Pin a specific model via the autocomplete dropdown, bypassing auto-routing. (e.g., `@router /gpt-4o`) |
| `@router --model <name> <prompt>` | Pin a specific model manually, bypassing auto-routing |

### Examples

```
@router how do I reverse a string in Python?
→ 🟢 Free tier (gpt-4o) — low complexity

@router design a distributed OAuth2 auth system with Kubernetes and Redis caching
→ 🔴 Premium tier (claude-3.5-sonnet) — high complexity

@router /claude-sonnet-4.6 refactor my auth module
→ 📌 Pinned model (claude-sonnet-4.6)

@router /claude-sonnet-4.6 /boost implement missing methods
→ 📌 Pinned model (claude-sonnet-4.6), expands prompt with history, then generates answer

@router /explain refactor my authentication module for microservices
→ Shows score breakdown without making any model call

@router /help
→ Shows full help, available models, and tool list
```

---

## Chat Memory

Starting with v1.8.0, **all** model requests — routing, agentic tool loops, simple responses, and `/boost` prompt expansion — automatically include the preceding turns of your current Copilot Chat session as context. This lets the model reference earlier questions and answers in the same conversation without you repeating yourself.

**Context-length note:** Each prior turn adds tokens to the request. Very long conversations may approach a model's context window limit. If you notice slower responses or truncated answers, start a new chat session to reset the history.

**Privacy note:** Conversation history is passed to the selected Copilot model (the same model that already handles your prompt). No history is stored or sent anywhere outside of the active Copilot session.

---

### Configuration

| Setting | Type | Default | Description |
|---|---|---|---|
| `agentRouter.freeThreshold` | `number` | `90` | Complexity score threshold (0-100). Scores ≤ this go to a free model. |
| `agentRouter.agentMode` | `boolean` | `true` | Enable/disable agentic tool access (file editing, terminal, etc). |
| `agentRouter.hybridAgentMode` | `boolean` | `true` | When using a premium model, automatically switch to a free model for intermediate agent tool calls to save premium request quota. |
| `agentRouter.allowGitCommands` | `boolean` | `false` | (Beta) Allow the agent to automatically commit and push changes. |

Open **Settings** (`Ctrl+,`) and search `agentRouter` to adjust.

## 🛠️ How it matches models

### Free Model Families

`gpt-4o`, `gpt-5-mini`, `gpt-4.1`

### Premium Model Families

All other available Copilot models (e.g. `claude-sonnet-4.6`, `gemini-3-pro`, `gpt-5.3-codex`) are treated as **premium**.

---

## Complexity Scoring

Prompts are scored 0–100 using fast non-blocking keyword heuristics:

| Factor | Points | Trigger |
|---|---|---|
| Base score | +10 | All prompts |
| Length bonus | +25 | Long prompts |
| Multi-step structure | +8 | 4+ lines |
| Dense technical syntax | +7 | Code-heavy content |
| Architecture / Distributed | +20 | kubernetes, microservices, load balancing… |
| Security / Auth / Encryption | +20 | OAuth2, JWT, TLS, cryptography… |
| ML / Neural Networks | +18 | transformers, NLP, embeddings… |
| Performance / Optimization | +15 | caching, indexing, profiling… |
| Refactoring / Migration | +12 | legacy, upgrade, deprecation… |
| Deep Debugging / Root-cause | +10 | memory leak, deadlock, race condition… |

---

## Agentic Tools (30 tools)

When `agentRouter.agentMode` is `true`, `@router` can call these tools during the response:

| Category | Tools |
|---|---|
| **File** | `readFile`, `writeFile`, `editFile`, `deleteFile`, `renameFile`, `copyFile`, `createDirectory`, `readFileLines`, `findAndReplace` |
| **Search** | `searchFiles`, `listDirectory` |
| **Code** | `getSymbols`, `getProblems`, `showDiff` |
| **Editor** | `openFile`, `getSelectedText`, `insertSnippet`, `listOpenEditors` |
| **Terminal** | `runCommand`, `runTests`, `getTerminalOutput`, `openTerminal` |
| **Git** | `getGitStatus` |
| **VS Code** | `getWorkspaceInfo`, `getExtensionSettings`, `getExtensionList`, `showNotification` |
| **Clipboard** | `clipboardRead`, `clipboardWrite` |
| **Network** | `fetchUrl` |

### Terminal Execution: Headless vs Visible
The agent interacts with your terminal in two different ways depending on how you phrase your prompt:

1. **Headless Execution (Default):** If you ask the agent to *"run my tests and fix the failure"*, it will execute the command headlessly in the background. The agent uses this when it needs to read the text output (like error stack traces) to analyze and fix your code. You won't see this in your normal terminal tabs, but the command output is visible in the Chat panel dropdowns.
2. **Visible Terminal Execution:** If you just want the agent to start a long-running process (like starting a server) in a visible VS Code terminal panel so you can see the logs, you can tell it to use the `openTerminal` tool. 
   - **Targeting specific terminals:** If you already have terminals open named **"wsl"** or **"powershell"**, you can explicitly tell the agent: *"Open my **'wsl'** terminal and run `npm start`"*. The agent will find the existing tab by name and type the command directly into it.

---

## Development

```bash
git clone https://github.com/adnnoky/github-copilot-agent-router.git
cd github-copilot-agent-router
npm install
npm run compile   # one-time build
npm run watch     # watch mode
# Press F5 to launch Extension Development Host
```

```bash
# Package for distribution
npx vsce package
# Install locally
code --install-extension agent-router-extension-1.9.3.vsix
```

---

## License

MIT — see [LICENSE](LICENSE)
