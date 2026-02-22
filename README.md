# Agent Router — `@router`

> **Routes GitHub Copilot Chat prompts to free or premium models based on complexity — with full agentic file-edit, terminal, and workspace capabilities.**

[![Version](https://img.shields.io/badge/version-1.6.0-blue)](https://github.com/adnnoky/github-copilot-agent-router/releases)
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
      ├─ Score ≤ threshold → 🟢 Free model      (gpt-4.1, gpt-4o, gpt-5-mini)
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
| `@router --model <name> <prompt>` | Pin a specific model, bypass auto-routing |

### Examples

```
@router how do I reverse a string in Python?
→ 🟢 Free tier (gpt-4o) — low complexity

@router design a distributed OAuth2 auth system with Kubernetes and Redis caching
→ 🔴 Premium tier (claude-3.5-sonnet) — high complexity

@router --model claude-3.5-sonnet refactor my auth module
→ 📌 Pinned model (claude-3.5-sonnet)

@router /explain refactor my authentication module for microservices
→ Shows score breakdown without making any model call

@router /help
→ Shows full help, available models, and tool list
```

---

## Configuration

| Setting | Type | Default | Description |
|---|---|---|---|
| `agentRouter.freeThreshold` | `number` | `70` | Complexity score (0–100). Scores ≤ this go to a free model. |
| `agentRouter.agentMode` | `boolean` | `true` | Enable/disable the full agentic tool-calling loop. |

Open **Settings** (`Ctrl+,`) and search `agentRouter` to adjust.

### Free Model Families

`gpt-4.1`, `gpt-4o`, `gpt-5-mini`

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
code --install-extension agent-router-extension-1.5.0.vsix
```

---

## License

MIT — see [LICENSE](LICENSE)
