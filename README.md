# Agent Router — `@router`

> **Routes GitHub Copilot Chat prompts to standard (1x) or advanced (2x+) models based on complexity — with full agentic file-edit, terminal, and workspace capabilities.**

[![Version](https://img.shields.io/github/v/release/adnnoky/github-copilot-agent-router?label=version)](https://github.com/adnnoky/github-copilot-agent-router/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.95.0-blueviolet)](https://code.visualstudio.com/)

**Author:** [Adnan Okay](https://github.com/adnnoky)

---

## What It Does

Agent Router integrates with **GitHub Copilot Chat** as a native `@router` chat participant. It scores the complexity of your prompt (0–100) and automatically routes it to the most cost-efficient Copilot model — using powerful advanced models only when they're actually needed.

```
@router <your prompt>
      │
      ▼
  Complexity Score (0–100)
  via keyword heuristics
      │
      ├─ Score ≤ threshold → 🟢 Standard (1x)   (gpt-5-mini, gpt-5.6-luna, mai-code-1.1-flash)
      └─ Score >  threshold → 🔴 Advanced (2x+)  (claude-sonnet-5.0, gpt-5.6-terra, gpt-5.3-codex, claude-opus-5.0)
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
- **GitHub Enterprise users:** Set `agentRouter.githubEnterpriseUrl` to your enterprise URL (e.g. `https://company.ghe.com`) in VS Code settings

---

## Usage

Open **Copilot Chat** (`Ctrl+Alt+I` / `⌘⌥I`) and type:

| Command | Description |
|---|---|
| `@router <prompt>` | Score, route and answer your prompt |
| `@router /help` or `@router /?` | Show the full help page |
| `@router /explain <prompt>` | Show routing decision (score, tier, model) — no LLM call |
| `@router /boost <prompt>` | Expand a short prompt into a detailed one using chat history for context |
| `@router /export` | Export the current chat thread to a Markdown file |
| `@router /<model> <prompt>` | Pin a specific model via the autocomplete dropdown, bypassing auto-routing. (e.g., `@router /claude-sonnet-5.0`) |
| `@router --model <name> <prompt>` | Pin a specific model manually, bypassing auto-routing |

### Command Palette Commands

| Command | Description |
|---|---|
| `Agent Router: Show Premium Stats` | Open the Copilot Insights Dashboard |
| `Agent Router: Export Copilot Chat: Current Workspace` | Pick a chat from the current workspace and export to Markdown |
| `Agent Router: Export Copilot Chat: All Workspaces` | Scan all VS Code workspaces on your machine, pick any chat to export |
| `Agent Router: Export Copilot Chat: Backup to .chat-exports` | Bulk export all workspace chats to `.chat-exports/history/` (one file per session) |
| `Agent Router: Export Copilot Chat: Convert JSON/JSONL File...` | Convert any exported `.json` or `.jsonl` chat file to Markdown |
| `Agent Router: Export Chat History to JSON` | Export the active chat session as a portable JSON file (for transfer) |
| `Agent Router: Import Chat History from JSON` | Import a JSON chat file and restore it as a live chat tab |

### Examples

```
@router how do I reverse a string in Python?
→ 🟢 Standard tier (gpt-5-mini) — 1x cost, low complexity

@router design a distributed OAuth2 auth system with Kubernetes and Redis caching
→ 🔴 Advanced tier (claude-sonnet-5.0) — 2x cost, high complexity

@router /claude-sonnet-5.0 refactor my auth module
→ 📌 Pinned model (claude-sonnet-5.0)

@router /claude-sonnet-5.0 /boost implement missing methods
→ 📌 Pinned model (claude-sonnet-5.0), expands prompt with history, then generates answer

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

## Premium Quota & Dashboard 📊

Agent Router makes a best-effort attempt to track your **Premium Request limits** using an internal/undocumented GitHub Copilot endpoint. This is **not** an official, supported public API, so it may change, become unavailable, or be inaccessible for some accounts without notice.

- **Status Bar Indicator**: View your remaining premium request count and dynamic capacity percentage conveniently in the VS Code status bar when quota data is available.
- **Copilot Insights Dashboard**: Click the status bar or run `Agent Router: Show Premium Stats` to open the interactive dashboard with:
  - Usage gauge and quota breakdown
  - Per-model usage distribution with bar charts
  - **Chat Conversations** — all workspace conversations (both `@router` and regular Copilot Chat) in a single view, clickable to see the full conversation thread
  - Individual request log with status, model, tier, score, estimated tokens, and cost multiplier
  - Active session monitoring
  - Workspace Copilot configuration overview (instructions, prompts, agents, skills, hooks)
- **Expected failure modes**: Depending on your account, Copilot plan, authentication state, token scopes, GitHub backend changes, rate limits, or response-format changes, premium-usage data may be missing, partial, stale, or fail to load entirely.
- **Fallback behavior**: If quota data cannot be retrieved, Agent Router will continue to route prompts and provide chat/agent functionality as normal; only the premium-usage indicator/dashboard may be degraded or unavailable.

---

## Chat History & Export 📜

Agent Router reads VS Code's internal Copilot Chat session files (`chatSessions/`) to give you visibility into **all** workspace conversations — not just `@router` sessions. It correctly parses the JSONL patch format including custom titles, appended requests, and streamed responses.

### Viewing Conversations

The **Copilot Insights Dashboard** (`Agent Router: Show Premium Stats`) shows a **Chat Conversations** table listing every conversation in the workspace. Each row shows:
- **Source** badge: `Copilot Chat` (purple) or `@router` (blue)
- Title, models used, turn count, estimated tokens, cost
- Click any row to open the full conversation in a chat-style detail panel

### Exporting to Markdown

| Command | What it does |
|---|---|
| `@router /export` | Export the current chat thread to `.chat-exports/` |
| **Export Copilot Chat: Current Workspace** | Pick any chat from the open project and export to Markdown |
| **Export Copilot Chat: All Workspaces** | Scan every VS Code workspace on your machine — groups chats by project |
| **Export Copilot Chat: Backup to .chat-exports** | Bulk export all workspace chats (one `.md` per session) with progress bar |
| **Export Copilot Chat: Convert JSON/JSONL File...** | Open any exported chat file and convert to readable Markdown |

### Transferring Chats Between Workspaces (JSON)

Move live conversations between VS Code instances (e.g., Windows ↔ WSL, or between machines):

1. **Source workspace** — Run **Export Chat History to JSON**
   - Make sure the chat you want to export is the active chat tab
   - Save the `.json` file to a shared location
2. **Target workspace** — Run **Import Chat History from JSON**
   - Select the `.json` file
   - The chat opens as a **new live tab** in Copilot Chat — fully functional, continue the conversation

This uses VS Code's built-in `workbench.action.chat.export` / `workbench.action.chat.import` commands, so imported chats appear natively in the Chat sidebar — no window reload needed.

---

### Configuration

| Setting | Type | Default | Description |
|---|---|---|---|
| `agentRouter.freeThreshold` | `number` | `90` | Complexity score threshold (0-100). Scores ≤ this go to a standard (1x) model. |
| `agentRouter.agentMode` | `boolean` | `true` | Enable/disable agentic tool access (file editing, terminal, etc). |
| `agentRouter.hybridAgentMode` | `boolean` | `true` | When using an advanced model, automatically switch to a standard (1x) model for intermediate agent tool calls to save token budget. |
| `agentRouter.githubEnterpriseUrl` | `string` | `""` | Base URL for GitHub Enterprise (e.g. `https://company.ghe.com`). Enables authentication via the enterprise provider alongside github.com. |
| `agentRouter.usageRefreshInterval` | `number` | `60` | How often (in seconds) to refresh premium request usage data. |
| `agentRouter.routingRules` | `array` | `[]` | Custom routing rules. Each rule has a `pattern` (regex), and `model` or `tier` to route to. First match wins. |

Open **Settings** (`Ctrl+,`) and search `agentRouter` to adjust.

## 🛠️ Cost Multipliers & Model Tiers

Models are categorized by cost multiplier — how many premium requests each call consumes.

### Standard Models (1x cost)

| Model | Multiplier |
|---|---|
| `gpt-5-mini` | 1x |
| `gpt-5.6-luna` | 1x |
| `mai-code-1.1-flash` | 1x |

### Advanced Models (2x+ cost)

| Model | Multiplier |
|---|---|
| `claude-sonnet-5.0` | 2x |
| `gpt-5.6-terra` | 2x |
| `gpt-5.3-codex` | 3x |
| `claude-opus-5.0` | 3x |

Models not in this table default to 2x. The preferred advanced model is `claude-sonnet-5.0`.

### Custom Routing Rules

Override automatic routing for specific prompts via `agentRouter.routingRules` in settings:

```json
"agentRouter.routingRules": [
  { "pattern": "security|CVE|vulnerability", "tier": "advanced" },
  { "pattern": "translate|simple question", "tier": "standard" },
  { "pattern": "codex", "model": "gpt-5.3-codex" }
]
```

Rules are evaluated in order. First regex match wins. If no rule matches, normal complexity scoring applies.

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

The agent possesses two distinct tools for running terminal commands:

1. **Headless Execution (`runCommand`)**: By default, when you ask the agent to run scripts, build apps, or fix errors, the agent runs the command headlessly in the background. **This is highly recommended** because it forces the agent to *wait* for the command to finish, read the resulting `stdout`/`stderr`, and intelligently fix any errors if it fails. You can view the logs for these headless commands by expanding the tool calls in the Chat panel.
2. **Visible Execution (`openTerminal`)**: You can explicitly ask the agent to "run this in a visible terminal panel" (or specify a tab name like "wsl" or "powershell"). The agent will open a VS Code terminal and paste the command. **Warning:** This is a blind, fire-and-forget action. The agent cannot see the output and cannot wait for it to finish. Use this only for infinite-running dev servers (e.g., `npm run dev`) or when you just want to take over manually.

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
code --install-extension agent-router-extension-1.11.0.vsix
```

---

## License

MIT — see [LICENSE](LICENSE)
