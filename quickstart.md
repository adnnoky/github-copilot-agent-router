# Agent Router — Quick Start

**Author:** [Adnan Okay](https://github.com/adnnoky)  
**Version:** 1.9.0  
**Repo:** https://github.com/adnnoky/github-copilot-agent-router

---

## 1. Install

### From `.vsix` (Manual)

1. Download the latest `.vsix` from [Releases](https://github.com/adnnoky/github-copilot-agent-router/releases)
2. Open VS Code → Extensions sidebar → `···` menu → **Install from VSIX…**
3. Select the file and reload

### From Source

```bash
git clone https://github.com/adnnoky/github-copilot-agent-router.git
cd github-copilot-agent-router
npm install && npm run compile
# Press F5 — Extension Development Host opens
```

---

## 2. Use It

Open **Copilot Chat** (`Ctrl+Alt+I` / `⌘⌥I`):

| Command | Description |
|---|---|
| `@router <prompt>` | Score, route, and answer your prompt |
| `@router /help` or `@router /?` | Show the full help page |
| `@router /explain <prompt>` | Dry-run: show routing decision without calling a model |
| `@router /boost <prompt>` | Expand a short prompt into a detailed one (supports chat history memory) |
| `@router --model <name> <prompt>` | Pin a specific Copilot model, bypass routing |

### Quick Examples

```
@router how do I reverse a string in Python?
→ 🟢 Free tier (gpt-4o) — low complexity

@router design a distributed OAuth2 system with Kubernetes and Redis
→ 🔴 Premium tier (claude-3.5-sonnet) — high complexity

@router --model gpt-4o explain async/await to me
→ 📌 Pinned to gpt-4o

@router /explain refactor auth module for microservices
→ Shows score breakdown, no model call made

@router /help
→ Opens full help page in chat
```

---

## 3. Configure

| Setting | Default | What it does |
|---|---|---|
| `agentRouter.freeThreshold` | `90` | Scores ≤ this → free model; higher → premium |
| `agentRouter.agentMode` | `true` | Enable 30-tool agentic loop (file edits, terminal…) |

Go to **Settings** (`Ctrl+,`) and search `agentRouter`.

**Free model families:** `gpt-5-mini`, `gpt-4o`, `gpt-4.1`

**Premium models** (examples): `claude-sonnet-4.6`, `gemini-3-pro`, `gpt-5.3-codex` — any model family not in the free list.


---

## 4. Requirements

- VS Code `^1.95.0`
- GitHub Copilot extension installed and signed in
- Active GitHub Copilot subscription