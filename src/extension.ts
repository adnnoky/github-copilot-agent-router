import * as vscode from "vscode";
import * as path from "path";
import { scorePromptComplexity } from "./scorer";
import { getRoutingDecision } from "./router";
import { selectModel, selectModelByName, listAvailableModels, STANDARD_MODEL_FAMILIES, MODEL_COSTS } from "./models";
import { runAgentLoop } from "./agent";
import { openDashboard, addSession, updateSessionStatus, getStoredSessions, upsertThread, computeThreadId, getChatSessionSummaries, exportChatSessionToMarkdown, getAllWorkspaceSessions, exportJsonFileToMarkdown, AgentSession, ChatTurn, ChatThread } from "./dashboard";
import {
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  ReplaceStringInFileTool,
  MultiReplaceStringInFileTool,
  ListDirectoryTool,
  RunCommandTool,
  SearchFilesTool,
  GetProblemsTool,
  DeleteFileTool,
  RenameFileTool,
  CopyFileTool,
  CreateDirectoryTool,
  ReadFileLinesTool,
  FindAndReplaceTool,
  GetSymbolsTool,
  OpenFileTool,
  ShowDiffTool,
  GetGitStatusTool,
  GetExtensionSettingsTool,
  ListOpenEditorsTool,
  GetSelectedTextTool,
  InsertSnippetTool,
  RunTestsTool,
  GetTerminalOutputTool,
  FetchUrlTool,
  GetWorkspaceInfoTool,
  GetExtensionListTool,
  ShowNotificationTool,
  OpenTerminalTool,
  ClipboardReadTool,
  ClipboardWriteTool,
  GrepSearchTool,
  SendToTerminalTool,
  KillTerminalTool,
  ListCodeUsagesTool,
  RenameSymbolTool,
  RunVSCodeCommandTool,
  ViewImageTool,
  AskUserTool,
  MemoryTool,
  TodoListTool,
  RunSubAgentTool,
  TerminalLastCommandTool,
  registerTerminalTracking,
  CreateNotebookTool,
  RunNotebookCellTool,
  ReadNotebookCellOutputTool,
  EditNotebookTool,
  GetNotebookSummaryTool,
  registerProposedContentProvider
} from "./tools";

const OUTPUT_CHANNEL_NAME = "Agent Router";
const PARTICIPANT_ID = "agent-router.router";

// ── Config helpers ────────────────────────────────────────────────────────

function getFreeThreshold(): number {
  return vscode.workspace.getConfiguration("agentRouter").get<number>("freeThreshold", 90);
}

function isAgentModeEnabled(): boolean {
  return vscode.workspace.getConfiguration("agentRouter").get<boolean>("agentMode", true);
}

// ── Custom Routing Rules ──────────────────────────────────────────────────

interface RoutingRule {
  pattern: string;
  model?: string;
  tier?: "standard" | "advanced";
}

function getRoutingRules(): RoutingRule[] {
  return vscode.workspace.getConfiguration("agentRouter").get<RoutingRule[]>("routingRules", []);
}

/**
 * Checks custom routing rules against the prompt.
 * Returns the matched model name or tier, or null if no rule matched.
 */
function matchRoutingRule(prompt: string): { model?: string; tier?: "standard" | "advanced" } | null {
  const rules = getRoutingRules();
  for (const rule of rules) {
    try {
      const regex = new RegExp(rule.pattern, "i");
      if (regex.test(prompt)) {
        return { model: rule.model, tier: rule.tier };
      }
    } catch {
      // Skip invalid regex patterns
    }
  }
  return null;
}

// ── Token Estimation ──────────────────────────────────────────────────────

/**
 * Estimates token count from text using a simple heuristic:
 * ~4 characters per token for English text (GPT-style tokenizers).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Chat Thread Capture ───────────────────────────────────────────────────

/**
 * Extracts ChatTurn[] from VS Code chat context history.
 * Captures turns from ALL participants (not just @router).
 */
function extractTurnsFromContext(chatContext: vscode.ChatContext): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const turn of chatContext.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      turns.push({
        role: "user",
        participant: turn.participant ?? undefined,
        command: turn.command ?? undefined,
        content: turn.prompt,
      });
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const textParts = turn.response
        .filter(p => p instanceof vscode.ChatResponseMarkdownPart)
        .map(p => (p as vscode.ChatResponseMarkdownPart).value.value);
      turns.push({
        role: "assistant",
        participant: turn.participant ?? undefined,
        content: textParts.join("\n") || "[non-text response]",
      });
    }
  }
  return turns;
}

/**
 * Snapshots the current chat thread — called after each @router request completes.
 * Includes turns from all participants in the same chat.
 */
function captureThread(
  context: vscode.ExtensionContext,
  chatContext: vscode.ChatContext,
  currentPrompt: string,
  currentResponse: string,
  session: AgentSession
) {
  const turns = extractTurnsFromContext(chatContext);
  // Append the current turn (not yet in history)
  turns.push({ role: "user", participant: "agent-router.router", content: currentPrompt });
  if (currentResponse) {
    turns.push({ role: "assistant", participant: "agent-router.router", content: currentResponse.slice(0, 3000) });
  }

  const threadId = computeThreadId(turns);

  // Derive title from first non-export user prompt
  let title = "Untitled Chat";
  for (const t of turns) {
    if (t.role === "user" && t.content.trim() && t.command !== "export") {
      title = t.content.trim().slice(0, 60);
      break;
    }
  }

  // Collect models used across sessions in this thread
  const existingThreads = getStoredSessions(context).filter(s => s.threadId === threadId);
  const modelsSet = new Set<string>(existingThreads.map(s => s.model));
  modelsSet.add(session.model);

  const thread: ChatThread = {
    id: threadId,
    title,
    turns: turns.map(t => ({ ...t, content: t.content.slice(0, 2000) })), // cap per-turn size
    models: [...modelsSet],
    totalTokens: turns.reduce((sum, t) => sum + estimateTokens(t.content), 0),
    totalCost: existingThreads.reduce((sum, s) => sum + (s.multiplier ?? 1), 0) + (session.multiplier ?? 1),
    requestCount: existingThreads.length + 1,
    firstTimestamp: existingThreads.length > 0 ? Math.min(...existingThreads.map(s => s.timestamp)) : session.timestamp,
    lastTimestamp: session.timestamp,
  };

  upsertThread(context, thread);
  return threadId;
}

// ── Premium Quota Tracker (GitHub Copilot API) ────────────────────────────

interface QuotaSnapshot {
  entitlement: number;
  overage_count: number;
  overage_permitted: boolean;
  percent_remaining: number;
  quota_id: string;
  quota_remaining: number;
  remaining: number;
  unlimited: boolean;
  timestamp_utc: string;
}

interface CopilotApiResponse {
  login: string;
  copilot_plan: string;
  quota_reset_date: string;
  quota_reset_date_utc: string;
  quota_snapshots: {
    chat: QuotaSnapshot;
    completions: QuotaSnapshot;
    premium_interactions: QuotaSnapshot;
  };
}

interface CopilotUsageData {
  used: number;
  entitlement: number;
  remaining: number;
  percentUsed: number;
  resetDate: string;
  unlimited: boolean;
}

const COPILOT_CACHE_KEY = "agentRouter.copilotUsageCache";
const COPILOT_CACHE_VERSION = "1.0";

interface CopilotCacheData {
  version: string;
  timestamp: number;
  data: CopilotApiResponse;
}

let premiumLimitStatusBarItem: vscode.StatusBarItem;
let usageRefreshInterval: ReturnType<typeof setInterval> | undefined;

function getRefreshIntervalMs(): number {
  return vscode.workspace.getConfiguration("agentRouter").get<number>("usageRefreshInterval", 60) * 1000;
}

function getGitHubEnterpriseUrl(): string {
  return vscode.workspace.getConfiguration("agentRouter").get<string>("githubEnterpriseUrl", "").replace(/\/+$/, "");
}

/**
 * Resolves the GitHub auth session by trying both providers.
 * If an enterprise URL is configured, tries "github-enterprise" first, then falls back to "github".
 * Returns the session and the API base URL to use.
 */
async function resolveGitHubSession(silent: boolean): Promise<{ session: vscode.AuthenticationSession; apiBaseUrl: string } | null> {
  const enterpriseUrl = getGitHubEnterpriseUrl();
  const sessionOptions = silent ? { silent: true } : { createIfNone: true };

  // If enterprise URL is configured, try enterprise provider first
  if (enterpriseUrl) {
    try {
      const session = await vscode.authentication.getSession(
        "github-enterprise",
        ["user:email"],
        sessionOptions
      );
      if (session) {
        return { session, apiBaseUrl: `${enterpriseUrl}/api/v3` };
      }
    } catch {
      // Enterprise auth failed, fall through to github.com
    }
  }

  // Try standard github.com provider
  try {
    const session = await vscode.authentication.getSession(
      "github",
      ["user:email"],
      sessionOptions
    );
    if (session) {
      return { session, apiBaseUrl: "https://api.github.com" };
    }
  } catch {
    // github.com auth failed
  }

  return null;
}

function getCopilotCache(context: vscode.ExtensionContext): CopilotCacheData | null {
  const cache = context.globalState.get<CopilotCacheData>(COPILOT_CACHE_KEY);
  if (!cache || cache.version !== COPILOT_CACHE_VERSION) { return null; }
  return cache;
}

function setCopilotCache(context: vscode.ExtensionContext, data: CopilotApiResponse): void {
  context.globalState.update(COPILOT_CACHE_KEY, {
    version: COPILOT_CACHE_VERSION,
    timestamp: Date.now(),
    data,
  });
}

function isCopilotCacheValid(cache: CopilotCacheData | null): boolean {
  if (!cache) { return false; }
  return Date.now() - cache.timestamp < getRefreshIntervalMs();
}

function extractUsageData(data: CopilotApiResponse): CopilotUsageData | null {
  const premium = data.quota_snapshots?.premium_interactions;
  if (!premium) { return null; }
  if (premium.unlimited) {
    return { used: 0, entitlement: 0, remaining: 0, percentUsed: 0, resetDate: data.quota_reset_date ?? "", unlimited: true };
  }
  if (premium.entitlement === 0) { return null; }

  let used: number;
  let percentUsed: number;
  if (premium.percent_remaining !== undefined && !Number.isNaN(premium.percent_remaining)) {
    percentUsed = Math.round((100 - premium.percent_remaining) * 10) / 10;
    used = Math.round((percentUsed / 100) * premium.entitlement);
  } else {
    used = premium.entitlement - premium.quota_remaining;
    percentUsed = Math.round((used / premium.entitlement) * 1000) / 10;
  }

  return {
    used,
    entitlement: premium.entitlement,
    remaining: premium.quota_remaining,
    percentUsed,
    resetDate: data.quota_reset_date ?? "",
    unlimited: false,
  };
}

async function fetchCopilotUsageFromApi(silent = false): Promise<CopilotApiResponse | null> {
  try {
    const resolved = await resolveGitHubSession(silent);
    if (!resolved) { return null; }

    const response = await fetch(`${resolved.apiBaseUrl}/copilot_internal/user`, {
      headers: {
        Authorization: `Bearer ${resolved.session.accessToken}`,
        "User-Agent": "VSCode-AgentRouter-Extension",
      },
    });

    if (!response.ok) { return null; }
    return await response.json() as CopilotApiResponse;
  } catch {
    return null;
  }
}

async function fetchCopilotUsage(context: vscode.ExtensionContext, silent = false): Promise<CopilotUsageData | null> {
  const cache = getCopilotCache(context);
  if (cache && isCopilotCacheValid(cache)) {
    return extractUsageData(cache.data);
  }

  const apiData = await fetchCopilotUsageFromApi(silent);
  if (apiData) {
    setCopilotCache(context, apiData);
    return extractUsageData(apiData);
  }

  // Fallback to expired cache
  if (cache) { return extractUsageData(cache.data); }
  return null;
}

function buildProgressBar(percent: number, length: number): string {
  const filled = Math.max(0, Math.min(length, Math.round((percent / 100) * length)));
  const empty = length - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

async function updatePremiumStatusBar(context: vscode.ExtensionContext, silent = false) {
  if (!premiumLimitStatusBarItem) {
    premiumLimitStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    premiumLimitStatusBarItem.command = "agentRouter.showPremiumStats";
  }

  const usage = await fetchCopilotUsage(context, silent);

  if (!usage) {
    premiumLimitStatusBarItem.text = "$(copilot) Premium: —";
    premiumLimitStatusBarItem.tooltip = new vscode.MarkdownString(
      `$(warning) **Unable to fetch usage data**\n\nMake sure you are signed in to GitHub.\n\n_Click to retry._`,
      true
    );
    premiumLimitStatusBarItem.tooltip.isTrusted = true;
    premiumLimitStatusBarItem.backgroundColor = undefined;
  } else if (usage.unlimited) {
    premiumLimitStatusBarItem.text = "$(copilot) Premium: ∞";
    premiumLimitStatusBarItem.tooltip = new vscode.MarkdownString(
      `$(rocket) **Unlimited Premium Plan**\n\n| | |\n|---|---|\n| Plan | Unlimited |\n| Overage | N/A |`,
      true
    );
    premiumLimitStatusBarItem.tooltip.isTrusted = true;
    premiumLimitStatusBarItem.backgroundColor = undefined;
  } else {
    const bar = buildProgressBar(usage.percentUsed, 8);
    const percentRemaining = Math.round((100 - usage.percentUsed) * 10) / 10;
    premiumLimitStatusBarItem.text = `$(copilot) ${bar} ${usage.remaining} (${percentRemaining}%)`;

    const tooltipBar = buildProgressBar(usage.percentUsed, 20);
    const resetFormatted = usage.resetDate || "Unknown";
    const statusIcon = usage.remaining === 0 ? "$(error)" : usage.remaining <= 5 ? "$(warning)" : "$(check)";

    const md = new vscode.MarkdownString(
      `$(github-copilot) **Copilot Premium Requests**\n\n` +
      `\`${tooltipBar}\` **${usage.percentUsed}%** used\n\n` +
      `---\n\n` +
      `| | |\n|---|---|\n` +
      `| ${statusIcon} Remaining | **${usage.remaining}** requests |\n` +
      `| $(graph) Used | **${usage.used}** / ${usage.entitlement} |\n` +
      `| $(calendar) Resets | ${resetFormatted} |\n\n` +
      `_Click for details_`,
      true
    );
    md.isTrusted = true;
    premiumLimitStatusBarItem.tooltip = md;

    if (usage.remaining === 0) {
      premiumLimitStatusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    } else if (usage.remaining <= 5) {
      premiumLimitStatusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else {
      premiumLimitStatusBarItem.backgroundColor = undefined;
    }
  }

  premiumLimitStatusBarItem.show();
}

function startUsageRefreshInterval(context: vscode.ExtensionContext) {
  if (usageRefreshInterval !== undefined) { clearInterval(usageRefreshInterval); }
  usageRefreshInterval = setInterval(() => updatePremiumStatusBar(context, true), getRefreshIntervalMs());
}

// ── Resolve chat references (attached files, selections, etc.) ────────────

async function resolveReferences(references: readonly vscode.ChatPromptReference[]): Promise<string> {
  if (!references || references.length === 0) { return ""; }

  const parts: string[] = [];
  for (const ref of references) {
    try {
      // File reference (attached via paperclip or #file)
      if (ref.value instanceof vscode.Uri) {
        const bytes = await vscode.workspace.fs.readFile(ref.value);
        let text = new TextDecoder().decode(bytes);
        if (text.length > 80_000) {
          text = text.slice(0, 80_000) + "\n[... truncated ...]";
        }
        parts.push(`--- Attached file: ${ref.value.fsPath} ---\n${text}\n--- End of ${ref.value.fsPath} ---`);
      }
      // Location reference (file + line range selection)
      else if (ref.value instanceof vscode.Location) {
        const bytes = await vscode.workspace.fs.readFile(ref.value.uri);
        const allLines = new TextDecoder().decode(bytes).split("\n");
        const startLine = ref.value.range.start.line;
        const endLine = ref.value.range.end.line;
        const selected = allLines.slice(startLine, endLine + 1).join("\n");
        parts.push(`--- Selection from ${ref.value.uri.fsPath} (lines ${startLine + 1}-${endLine + 1}) ---\n${selected}\n--- End selection ---`);
      }
      // String or other value
      else if (typeof ref.value === "string") {
        parts.push(`--- Reference: ${ref.id} ---\n${ref.value}\n--- End reference ---`);
      }
    } catch {
      parts.push(`[Could not read reference: ${ref.id}]`);
    }
  }
  return parts.join("\n\n");
}

// ── Routing summary ───────────────────────────────────────────────────────

function buildRoutingSummary(
  score: number,
  threshold: number,
  tier: "standard" | "advanced",
  modelFamily: string,
  reasons: string[],
  agentMode: boolean,
  multiplier: number
): string {
  const tierEmoji = tier === "standard" ? "🟢" : "🔴";
  const tierLabel = tier === "standard" ? "Standard (1x)" : `Advanced (${multiplier}x)`;
  const agentBadge = agentMode ? " _(agent mode — tools enabled)_" : "";
  return [
    `${tierEmoji} **Routed to ${tierLabel}** — model: \`${modelFamily}\`${agentBadge}`,
    `📊 Complexity score: **${score}/100** (threshold: ${threshold})`,
    `🔍 Signals: ${reasons.join(", ")}`,
  ].join("\n\n");
}

// ── --model flag parser ───────────────────────────────────────────────────

/**
 * Parses an optional `--model <name>` flag from the prompt.
 * Returns the model name and the prompt with the flag stripped, or null if not present.
 */
function parseModelFlag(rawPrompt: string): { modelName: string; cleanPrompt: string } | null {
  const match = rawPrompt.match(/--model\s+(\S+)/);
  if (!match) { return null; }
  const modelName = match[1];
  const cleanPrompt = rawPrompt.replace(match[0], "").replace(/\s+/g, " ").trim();
  return { modelName, cleanPrompt };
}

// ── help command ──────────────────────────────────────────────────────────

async function handleHelpCommand(
  stream: vscode.ChatResponseStream
): Promise<void> {
  const models = await listAvailableModels();
  const threshold = getFreeThreshold();
  const modelList = models.length > 0
    ? models.map(m => `- \`${m}\``).join("\n")
    : "_No Copilot models detected. Make sure GitHub Copilot is installed and you are signed in._";

  stream.markdown(`# 🧠 Copilot Model Router — Help

Routes your prompts to the right Copilot model based on complexity, with full agentic file-edit and terminal capabilities.

---

## 🚀 Basic Usage

\`\`\`
@router <your prompt>
\`\`\`

## 🛠️ Commands

| Command | Description |
|---|---|
| \`@router /help\` | Show this help page |
| \`@router /explain <prompt>\` | Show routing score breakdown without sending to model |
| \`@router /boost <prompt>\` | Expand a short prompt into a highly detailed one before sending (makes an extra model call with your prompt and chat history to generate the boosted prompt, then sends it for the final answer) |
| \`@router /export\` | Export the current chat session (prompts + responses) to a Markdown file in the workspace |
| \`@router /<model> <prompt>\` | Select a model directly from the autocomplete dropdown to pin it. (e.g. \`@router /gpt-5-mini\`) |

## 🎮 Flags

| Flag | Description |
|---|---|
| \`--model <name>\` | Pin a specific model, bypassing auto-routing |

**Examples:**
\`\`\`
@router scaffold a REST API in src/api/
@router /claude-sonnet-5.0 refactor my auth module
@router /explain design a distributed cache system
@router /boost write a python fast api
@router /help
\`\`\`

## ⚙️ Routing

Prompts are scored 0–100. Score ≤ **${threshold}** → 🟢 Standard (1x). Score > **${threshold}** → 🔴 Advanced (2x+).

All models consume from the same token budget, but at different multiplier rates. Standard models (1x) are cost-efficient for simple tasks; Advanced models (2x+) are reserved for complex requests.

Change the threshold: **Settings** → \`agentRouter.freeThreshold\`

## 🎯 Custom Routing Rules

Define regex patterns to always route matching prompts to a specific model or tier:

\`\`\`json
"agentRouter.routingRules": [
  { "pattern": "terraform|infrastructure", "model": "claude-sonnet-5.0" },
  { "pattern": "quick fix|typo|rename", "tier": "standard" }
]
\`\`\`

Rules are evaluated in order; first match wins.

## 🔧 Agent Tools

| Tool | Description |
|---|---|
| \`readFile\` | Read any workspace file |
| \`writeFile\` | Create or overwrite a file (shows diff + approval) |
| \`editFile\` | Targeted line-range edits (shows diff + approval) |
| \`deleteFile\` | Delete a file (moved to trash, requires confirmation) |
| \`listDirectory\` | List files in a directory |
| \`runCommand\` | Run a shell command (requires confirmation) |
| \`searchFiles\` | Search file contents across the workspace |
| \`getProblems\` | Read VS Code diagnostics / Problems panel |

> Toggle agent mode: **Settings** → \`agentRouter.agentMode\`

## 🤖 Available Models

${modelList}

---

> **Standard models (1x):** ${STANDARD_MODEL_FAMILIES.join(", ")}
`);
}


// ── /explain command ──────────────────────────────────────────────────────

async function handleExplainCommand(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  output: vscode.OutputChannel
): Promise<void> {
  const prompt = request.prompt.trim();
  if (!prompt) {
    stream.markdown("⚠️ Provide a prompt after `/explain`.\n\nExample: `@router /explain design a distributed auth system`");
    return;
  }

  const threshold = getFreeThreshold();
  const complexity = scorePromptComplexity(prompt);
  const decision = getRoutingDecision({ score: complexity.score, freeThreshold: threshold });
  const allModels = await listAvailableModels();
  const tierEmoji = decision.tier === "standard" ? "🟢" : "🔴";

  output.appendLine(`[Explain] score=${complexity.score}, threshold=${threshold}, tier=${decision.tier}`);

  const costTable = Object.entries(MODEL_COSTS).map(([m, c]) => `| \`${m}\` | ${c}x |`).join("\n");

  stream.markdown(`## 🔀 Routing Analysis\n\n`);
  stream.markdown(`**Prompt:** _${prompt}_\n\n---\n\n`);
  stream.markdown(`### Score Breakdown\n\n| Metric | Value |\n|---|---|\n| Score | **${complexity.score}/100** |\n| Threshold | ${threshold} |\n| Signals | ${complexity.reasons.join(", ")} |\n\n`);
  stream.markdown(`### Decision\n\n${tierEmoji} **${decision.tier === "standard" ? "Standard (1x)" : "Advanced (2x+)"}** — score ${decision.score} ${decision.tier === "standard" ? "≤" : ">"} threshold ${threshold}\n\n`);
  stream.markdown(`### Available Models\n\n${allModels.length > 0 ? allModels.map(m => `- \`${m}\``).join("\n") : "_No Copilot models detected_"}\n\n`);
  stream.markdown(`### Model Cost Multipliers\n\n| Model | Cost |\n|---|---|\n${costTable}\n\n`);
  stream.markdown(`> _Run \`@router <prompt>\` (without \`/explain\`) to get a real response._`);
}

// ── /boost command ────────────────────────────────────────────────────────

async function handleBoostCommand(
  request: vscode.ChatRequest,
  historyMessages: vscode.LanguageModelChatMessage[],
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<string | undefined> {
  const prompt = request.prompt.trim();
  if (!prompt) {
    stream.markdown("⚠️ Provide a prompt to boost.\n\nExample: `@router /boost write a python fast api for user auth`");
    return undefined;
  }

  stream.progress("Boosting prompt...");

  const selection = await selectModel("standard");
  if (!selection) {
    throw new Error("No model available to boost prompt.");
  }

  const systemMessage = "You are an expert prompt engineer. Your task is to take a short, simple user prompt and expand it into a highly detailed, comprehensive prompt suitable for an expert AI programming assistant. If the user prompt references previous conversation (like 'give me the same for X' or 'what about Y'), you MUST incorporate that context into the new detailed prompt so it stands alone. Ensure the resulting prompt is specific, actionable, and covers potential edge cases or architectural considerations. Output ONLY the expanded prompt, without any conversational filler or code formatting wrappers.";

  const messages = [
    vscode.LanguageModelChatMessage.User(systemMessage),
    ...historyMessages,
    vscode.LanguageModelChatMessage.User(`Original prompt to boost: ${prompt}`)
  ];

  const response = await selection.model.sendRequest(messages, {}, token);
  const parts: string[] = [];
  for await (const chunk of response.text) {
    if (token.isCancellationRequested) { break; }
    parts.push(chunk);
  }

  const enhancedPrompt = parts.join("").trim();
  stream.markdown(`_🚀 **Boosted Prompt:**_\n> ${enhancedPrompt.replace(/\n/g, "\n> ")}\n\n---\n\n`);
  return enhancedPrompt;
}

// ── /export command ───────────────────────────────────────────────────────

async function handleExportCommand(
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  output: vscode.OutputChannel,
  context: vscode.ExtensionContext
): Promise<void> {
  const lines: string[] = [];

  // Derive chat name from the first user prompt in history
  let chatTitle = "Untitled Chat";
  for (const turn of chatContext.history) {
    if (turn instanceof vscode.ChatRequestTurn && turn.prompt.trim() && turn.command !== "export") {
      chatTitle = turn.prompt.trim().slice(0, 60).replace(/[^a-zA-Z0-9\s\-]/g, "").trim();
      break;
    }
  }

  lines.push(`# ${chatTitle}\n`);
  lines.push(`> Exported: ${new Date().toLocaleString()} | By: Agent Router\n\n---\n`);

  // ─── Current Chat Thread (all participants) ───
  let turnIndex = 0;
  for (const turn of chatContext.history) {
    turnIndex++;
    if (turn instanceof vscode.ChatRequestTurn) {
      const participant = turn.participant ? `@${turn.participant}` : "";
      const cmd = turn.command ? ` /${turn.command}` : "";
      lines.push(`\n### 🧑 User ${participant ? `→ ${participant}` : ""}${cmd}\n`);
      lines.push(turn.prompt);
      lines.push("");
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const participant = turn.participant ?? "copilot";
      lines.push(`\n### 🤖 ${participant}\n`);
      const textParts = turn.response
        .filter(p => p instanceof vscode.ChatResponseMarkdownPart)
        .map(p => (p as vscode.ChatResponseMarkdownPart).value.value);
      if (textParts.length > 0) {
        lines.push(textParts.join("\n"));
      } else {
        lines.push("_[non-text response]_");
      }
      lines.push("");
    }
  }

  if (turnIndex === 0) {
    stream.markdown("⚠️ No chat history to export. Have a conversation first (with any participant — `@workspace`, `@router`, default Copilot, etc.), then call `@router /export` in the **same chat thread**.");
    return;
  }

  // ─── Session stats footer ───
  const allSessions = getStoredSessions(context);
  lines.push(`\n---\n\n<details>\n<summary>📊 Session History (${allSessions.length} tracked @router requests)</summary>\n`);
  lines.push(`| # | Time | Model | Tier | Cost | Score | Tokens | Status | Prompt |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|`);

  for (let i = 0; i < Math.min(allSessions.length, 50); i++) {
    const s = allSessions[i];
    const date = new Date(s.timestamp).toLocaleString();
    const prompt = s.prompt.replace(/\|/g, "\\|").replace(/\n/g, " ");
    const truncated = prompt.length > 80 ? prompt.slice(0, 80) + "…" : prompt;
    lines.push(`| ${i + 1} | ${date} | ${s.model} | ${s.tier} | ${s.multiplier ?? 1}x | ${s.score} | ~${s.estimatedTokens ?? 0} | ${s.status} | ${truncated} |`);
  }
  lines.push(`\n</details>\n`);

  // Write file — use chat title as filename
  const content = lines.join("\n");
  const safeTitle = chatTitle.replace(/\s+/g, "-").toLowerCase().slice(0, 40);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const fileName = `${safeTitle}--${timestamp}.md`;

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) {
    stream.markdown("⚠️ No workspace folder open. Cannot save export file.");
    return;
  }

  const exportUri = vscode.Uri.joinPath(workspaceFolders[0].uri, ".chat-exports", fileName);
  await vscode.workspace.fs.writeFile(exportUri, new TextEncoder().encode(content));

  stream.markdown(`✅ **Exported "${chatTitle}"** — ${turnIndex} turns → \`${vscode.workspace.asRelativePath(exportUri)}\`\n\n> 💡 _Tip: To capture messages from \`@workspace\`, \`@github\`, or default Copilot, call \`@router /export\` in the same chat thread where those messages are._`);
  output.appendLine(`[Export] "${chatTitle}" — ${turnIndex} turns → ${exportUri.fsPath}`);
}

// ── Main chat participant handler ─────────────────────────────────────────

async function routerHandler(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  output: vscode.OutputChannel,
  context: vscode.ExtensionContext
): Promise<void> {
  if (request.command === "explain") {
    await handleExplainCommand(request, stream, output);
    return;
  }

  // /help is a registered slash command → request.command will be "help"
  if (request.command === "help") {
    await handleHelpCommand(stream);
    return;
  }

  // /export — save chat history to a markdown file
  if (request.command === "export") {
    await handleExportCommand(chatContext, stream, output, context);
    return;
  }

  const KNOWN_MODELS: string[] = ["gpt-5-mini", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.3-codex", "claude-sonnet-5.0", "claude-opus-5.0", "mai-code-1.1-flash"];
  let rawPrompt = request.prompt.trim();

  // Parse model override (either from a primary slash command, a secondary one in the text, or a --model flag)
  let modelOverride = null;

  if (request.command && KNOWN_MODELS.includes(request.command)) {
    modelOverride = { modelName: request.command, cleanPrompt: rawPrompt };
  } else {
    // Check if the prompt starts with a known model slash command (e.g. user typed `/boost /gpt-5-mini`)
    const firstWordMatch = rawPrompt.match(/^\/([^ ]+)(?:\s+|$)/);
    if (firstWordMatch && KNOWN_MODELS.includes(firstWordMatch[1])) {
      modelOverride = {
        modelName: firstWordMatch[1],
        cleanPrompt: rawPrompt.substring(firstWordMatch[0].length).trim()
      };
    } else {
      modelOverride = parseModelFlag(rawPrompt);
    }
  }

  if (modelOverride) {
    rawPrompt = modelOverride.cleanPrompt;
  }

  // Convert chat history
  const historyMessages: vscode.LanguageModelChatMessage[] = [];
  for (const turn of chatContext.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      historyMessages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const textParts = turn.response
        .filter(p => p instanceof vscode.ChatResponseMarkdownPart)
        .map(p => (p as vscode.ChatResponseMarkdownPart).value.value);

      if (textParts.length > 0) {
        let fullText = textParts.join("\n");

        // Strip out the custom Agent Router header from history so the LLM doesn't try to hallucinate/repeat it
        if ((fullText.includes("Pinned model:") || fullText.includes("Routed to")) && fullText.includes("---")) {
          // The header is followed by \n\n---\n\n. We want to remove everything up to and including the ---
          const match = fullText.match(/^[\s\S]*?(?:-{3,})[\s\n]*/);
          if (match && (match[0].includes("Pinned model:") || match[0].includes("Routed to"))) {
            fullText = fullText.substring(match[0].length).trim();
          }
        }

        // Catch any remaining hallucinations from prior turns that escaped the first pass
        fullText = fullText.replace(/^.*?(?:Pinned model:|Routed to (?:free|premium) tier).*?$/gim, "").trim();

        if (fullText) {
          historyMessages.push(vscode.LanguageModelChatMessage.Assistant(fullText));
        }
      }
    }
  }

  // Check if boost is requested (either as primary command or as a secondary command in the text)
  let isBoostRequested = request.command === "boost";

  if (!isBoostRequested) {
    const boostMatch = rawPrompt.match(/^\/boost(?:\s+|$)/);
    if (boostMatch) {
      isBoostRequested = true;
      rawPrompt = rawPrompt.substring(boostMatch[0].length).trim();
    }
  }

  if (isBoostRequested) {
    // Re-create a mock request so handleBoostCommand gets the prompt without the --model flag or slash commands
    const reqWithoutModel = { ...request, prompt: rawPrompt };
    try {
      const boosted = await handleBoostCommand(reqWithoutModel, historyMessages, stream, token);
      if (!boosted) return;
      rawPrompt = boosted;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      output.appendLine(`[Boost Error] ${msg}`);
      stream.markdown(`⚠️ _Failed to boost prompt: ${msg}_ \n\n`);
    }
  }

  // Fallback: bare "help" / "?" typed without a slash (belt-and-suspenders)
  if (/^(help|\?)$/i.test(rawPrompt)) {
    await handleHelpCommand(stream);
    return;
  }

  const attachedContext = await resolveReferences(request.references);

  const prompt = rawPrompt;


  if (!prompt && !attachedContext) {
    stream.markdown("⚠️ Please enter a prompt. Example: `@router scaffold a new Express API in src/api/`\n\nTip: Use `--model gpt-5-mini` to pin a specific model.");
    return;
  }

  // Build the full prompt including any attached file content
  const fullPrompt = attachedContext
    ? `${prompt}\n\n${attachedContext}`
    : prompt;

  // 1. Score & route (score based on the text prompt, not file content)
  const threshold = getFreeThreshold();
  const complexity = scorePromptComplexity(prompt || "read file");
  const decision = getRoutingDecision({ score: complexity.score, freeThreshold: threshold });
  const agentModeSetting = isAgentModeEnabled();
  // Auto-skip agent loop for simple Q&A (low complexity, no file attachments)
  const agentMode = agentModeSetting && (complexity.score >= 30 || !!attachedContext);

  // 1.5 Check custom routing rules (before model override so explicit --model still wins)
  if (!modelOverride) {
    const ruleMatch = matchRoutingRule(prompt || "");
    if (ruleMatch) {
      if (ruleMatch.model) {
        modelOverride = { modelName: ruleMatch.model, cleanPrompt: rawPrompt };
        output.appendLine(`[Rule] Custom rule matched → model=${ruleMatch.model}`);
      } else if (ruleMatch.tier) {
        decision.tier = ruleMatch.tier;
        output.appendLine(`[Rule] Custom rule matched → tier=${ruleMatch.tier}`);
      }
    }
  }

  output.appendLine(`[Route] score=${complexity.score}, threshold=${threshold}, tier=${decision.tier}, agent=${agentMode}, modelOverride=${modelOverride?.modelName ?? "none"}`);

  // 2. Select model — use override if provided, otherwise auto-route
  let selection;
  if (modelOverride) {
    selection = await selectModelByName(modelOverride.modelName);
    if (!selection) {
      const available = await listAvailableModels();
      stream.markdown(`❌ **Model not found:** \`${modelOverride.modelName}\`\n\nAvailable models:\n${available.map(m => `- \`${m}\``).join("\n")}`);
      return;
    }
    output.appendLine(`[Model] pinned=${modelOverride.modelName}, resolved=${selection.model.id}`);
    stream.markdown(`📌 **Pinned model:** \`${selection.model.family}\` (\`${selection.model.id}\`) — ${selection.multiplier}x cost _(agent mode — tools enabled)_`);
    stream.markdown("\n\n---\n\n");
  } else {
    selection = await selectModel(decision.tier);
    if (!selection) {
      stream.markdown("❌ **No Copilot language models available.** Make sure GitHub Copilot is installed and you are signed in.");
      return;
    }
    output.appendLine(`[Model] family=${selection.family}, tier=${selection.tier}, id=${selection.model.id}`);
    stream.markdown(buildRoutingSummary(
      complexity.score, threshold, selection.tier, selection.family, complexity.reasons, agentMode, selection.multiplier
    ));
    stream.markdown("\n\n---\n\n");
  }

  // 4. Agentic loop (if enabled) or simple single request

  // Record agent session
  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const estimatedTokens = estimateTokens(fullPrompt);
  const preliminaryTurns = extractTurnsFromContext(chatContext);
  preliminaryTurns.push({ role: "user", participant: "agent-router.router", content: prompt });
  const threadId = computeThreadId(preliminaryTurns);
  const session: AgentSession = {
    id: sessionId,
    prompt: prompt.slice(0, 500),
    model: selection.model.family,
    tier: selection.tier,
    score: complexity.score,
    agentMode,
    boosted: isBoostRequested,
    timestamp: Date.now(),
    status: "running",
    estimatedTokens,
    multiplier: selection.multiplier,
    threadId,
  };
  addSession(context, session);

  try {
  let responseText = "";

  if (agentMode) {
    const isComplex = decision.tier === "advanced";
    await runAgentLoop(
      selection.model,
      fullPrompt,
      historyMessages,
      stream,
      request.toolInvocationToken,
      token,
      output,
      isComplex
    );
    responseText = "[Agent mode — multi-turn tool loop]";
  } else {
    // Simple single-shot request without tools
    let response: vscode.LanguageModelChatResponse;
    try {
      response = await selection.model.sendRequest(
        [
          ...historyMessages,
          vscode.LanguageModelChatMessage.User(fullPrompt)
        ],
        {},
        token
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      output.appendLine(`[Error] ${msg}`);
      stream.markdown(`❌ **Failed:** ${msg}`);
      updateSessionStatus(context, sessionId, "error");
      return;
    }

    try {
      for await (const chunk of response.text) {
        if (token.isCancellationRequested) { break; }
        stream.markdown(chunk);
        responseText += chunk;
      }
    } catch (e) {
      stream.markdown(`\n\n⚠️ _Stream interrupted: ${e instanceof Error ? e.message : String(e)}_`);
    }
  }

  updateSessionStatus(context, sessionId, "completed", responseText);
  // Capture/update the chat thread with full conversation
  captureThread(context, chatContext, prompt, responseText, session);
  } catch (e) {
    updateSessionStatus(context, sessionId, "error");
    throw e;
  }

  // Refresh the status bar after an advanced request so it reflects API-side usage
  if (selection.tier === "advanced") {
    updatePremiumStatusBar(context, true);
  }
}

// ── Activation ────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  output.appendLine("Agent Router v1.9.0 activated. @router participant + 30 tools ready.");

  registerProposedContentProvider(context);
  registerTerminalTracking(context);

  // Register all language model tools
  context.subscriptions.push(
    vscode.lm.registerTool("agent-router_readFile", new ReadFileTool()),
    vscode.lm.registerTool("agent-router_writeFile", new WriteFileTool()),
    vscode.lm.registerTool("agent-router_editFile", new EditFileTool()),
    vscode.lm.registerTool("agent-router_replaceStringInFile", new ReplaceStringInFileTool()),
    vscode.lm.registerTool("agent-router_multiReplaceStringInFile", new MultiReplaceStringInFileTool()),
    vscode.lm.registerTool("agent-router_listDirectory", new ListDirectoryTool()),
    vscode.lm.registerTool("agent-router_runCommand", new RunCommandTool()),
    vscode.lm.registerTool("agent-router_searchFiles", new SearchFilesTool()),
    vscode.lm.registerTool("agent-router_getProblems", new GetProblemsTool()),
    vscode.lm.registerTool("agent-router_deleteFile", new DeleteFileTool()),
    vscode.lm.registerTool("agent-router_renameFile", new RenameFileTool()),
    vscode.lm.registerTool("agent-router_copyFile", new CopyFileTool()),
    vscode.lm.registerTool("agent-router_createDirectory", new CreateDirectoryTool()),
    vscode.lm.registerTool("agent-router_readFileLines", new ReadFileLinesTool()),
    vscode.lm.registerTool("agent-router_findAndReplace", new FindAndReplaceTool()),
    vscode.lm.registerTool("agent-router_getSymbols", new GetSymbolsTool()),
    vscode.lm.registerTool("agent-router_openFile", new OpenFileTool()),
    vscode.lm.registerTool("agent-router_showDiff", new ShowDiffTool()),
    vscode.lm.registerTool("agent-router_getGitStatus", new GetGitStatusTool()),
    vscode.lm.registerTool("agent-router_getExtensionSettings", new GetExtensionSettingsTool()),
    vscode.lm.registerTool("agent-router_listOpenEditors", new ListOpenEditorsTool()),
    vscode.lm.registerTool("agent-router_getSelectedText", new GetSelectedTextTool()),
    vscode.lm.registerTool("agent-router_insertSnippet", new InsertSnippetTool()),
    vscode.lm.registerTool("agent-router_runTests", new RunTestsTool()),
    vscode.lm.registerTool("agent-router_getTerminalOutput", new GetTerminalOutputTool()),
    vscode.lm.registerTool("agent-router_fetchUrl", new FetchUrlTool()),
    vscode.lm.registerTool("agent-router_getWorkspaceInfo", new GetWorkspaceInfoTool()),
    vscode.lm.registerTool("agent-router_getExtensionList", new GetExtensionListTool()),
    vscode.lm.registerTool("agent-router_showNotification", new ShowNotificationTool()),
    vscode.lm.registerTool("agent-router_openTerminal", new OpenTerminalTool()),
    vscode.lm.registerTool("agent-router_clipboardRead", new ClipboardReadTool()),
    vscode.lm.registerTool("agent-router_clipboardWrite", new ClipboardWriteTool()),
    vscode.lm.registerTool("agent-router_grepSearch", new GrepSearchTool()),
    vscode.lm.registerTool("agent-router_sendToTerminal", new SendToTerminalTool()),
    vscode.lm.registerTool("agent-router_killTerminal", new KillTerminalTool()),
    vscode.lm.registerTool("agent-router_listCodeUsages", new ListCodeUsagesTool()),
    vscode.lm.registerTool("agent-router_renameSymbol", new RenameSymbolTool()),
    vscode.lm.registerTool("agent-router_runVSCodeCommand", new RunVSCodeCommandTool()),
    vscode.lm.registerTool("agent-router_viewImage", new ViewImageTool()),
    vscode.lm.registerTool("agent-router_askUser", new AskUserTool()),
    vscode.lm.registerTool("agent-router_memory", new MemoryTool(context)),
    vscode.lm.registerTool("agent-router_todoList", new TodoListTool(context)),
    vscode.lm.registerTool("agent-router_runSubAgent", new RunSubAgentTool()),
    vscode.lm.registerTool("agent-router_terminalLastCommand", new TerminalLastCommandTool()),
    vscode.lm.registerTool("agent-router_createNotebook", new CreateNotebookTool()),
    vscode.lm.registerTool("agent-router_runNotebookCell", new RunNotebookCellTool()),
    vscode.lm.registerTool("agent-router_readNotebookCellOutput", new ReadNotebookCellOutputTool()),
    vscode.lm.registerTool("agent-router_editNotebook", new EditNotebookTool()),
    vscode.lm.registerTool("agent-router_getNotebookSummary", new GetNotebookSummaryTool()),
  );

  // Register chat participant
  const participant = vscode.chat.createChatParticipant(
    PARTICIPANT_ID,
    (request, chatContext, stream, token) =>
      routerHandler(request, chatContext, stream, token, output, context)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentRouter.showPremiumStats", async () => {
      openDashboard(
        context,
        () => fetchCopilotUsage(context, false),
        () => fetchCopilotUsageFromApi(false)
      );
    })
  );

  // ── Export Chat: Current Workspace ──
  context.subscriptions.push(
    vscode.commands.registerCommand("agentRouter.exportChatHistory", async () => {
      const sessionSummaries = getChatSessionSummaries(context);
      if (sessionSummaries.length === 0) {
        vscode.window.showWarningMessage("No Copilot Chat sessions found for this workspace.");
        return;
      }

      const items = sessionSummaries.map(s => {
        const date = s.creationDate ? new Date(s.creationDate).toLocaleString() : "Unknown date";
        return {
          label: s.title.length > 60 ? s.title.slice(0, 60) + "…" : s.title,
          description: `${s.requestCount} requests`,
          detail: `Created: ${date}`,
          summary: s,
        };
      });

      const allOption = {
        label: "$(file-zip) Export All Conversations",
        description: `${sessionSummaries.length} conversations`,
        detail: "Export every chat session to a single file",
        summary: null as any,
      };

      const picked = await vscode.window.showQuickPick([allOption, ...items], {
        placeHolder: "Select a chat conversation to export",
        title: "Export Copilot Chat: Current Workspace",
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!picked) { return; }

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showWarningMessage("No workspace folder open.");
        return;
      }

      const exportDir = vscode.Uri.joinPath(workspaceFolders[0].uri, ".chat-exports");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);

      if (picked === allOption) {
        const sections: string[] = [
          `# All Copilot Chat Conversations\n`,
          `> Exported: ${new Date().toLocaleString()} | Conversations: ${sessionSummaries.length}\n\n---\n`,
        ];
        for (const s of sessionSummaries) {
          const md = exportChatSessionToMarkdown(s.filePath);
          if (md) { sections.push(`\n${"-".repeat(80)}\n`); sections.push(md); }
        }
        const fileName = `all-conversations--${timestamp}.md`;
        const exportUri = vscode.Uri.joinPath(exportDir, fileName);
        await vscode.workspace.fs.writeFile(exportUri, new TextEncoder().encode(sections.join("\n")));
        const doc = await vscode.workspace.openTextDocument(exportUri);
        await vscode.window.showTextDocument(doc, { preview: false });
        vscode.window.showInformationMessage(`Exported ${sessionSummaries.length} conversations → ${vscode.workspace.asRelativePath(exportUri)}`);
      } else {
        const md = exportChatSessionToMarkdown(picked.summary.filePath);
        if (!md) { vscode.window.showWarningMessage("Failed to parse chat session file."); return; }
        const safeTitle = picked.summary.title.replace(/[^a-zA-Z0-9\s\-]/g, "").replace(/\s+/g, "-").toLowerCase().slice(0, 40);
        const fileName = `${safeTitle}--${timestamp}.md`;
        const exportUri = vscode.Uri.joinPath(exportDir, fileName);
        await vscode.workspace.fs.writeFile(exportUri, new TextEncoder().encode(md));
        const doc = await vscode.workspace.openTextDocument(exportUri);
        await vscode.window.showTextDocument(doc, { preview: false });
        vscode.window.showInformationMessage(`Exported "${picked.summary.title}" → ${vscode.workspace.asRelativePath(exportUri)}`);
      }
    })
  );

  // ── Export Chat: All Workspaces ──
  context.subscriptions.push(
    vscode.commands.registerCommand("agentRouter.exportAllWorkspaces", async () => {
      const allSessions = getAllWorkspaceSessions();
      if (allSessions.length === 0) {
        vscode.window.showWarningMessage("No Copilot Chat sessions found across any workspace.");
        return;
      }

      // Group by workspace
      const byWorkspace = new Map<string, typeof allSessions>();
      for (const s of allSessions) {
        const key = s.workspaceName || "Unknown";
        if (!byWorkspace.has(key)) { byWorkspace.set(key, []); }
        byWorkspace.get(key)!.push(s);
      }

      const items: (vscode.QuickPickItem & { summary?: typeof allSessions[0] })[] = [];
      items.push({
        label: "$(file-zip) Export All",
        description: `${allSessions.length} sessions across ${byWorkspace.size} workspaces`,
        detail: "Export every session from all workspaces to a single file",
      });

      for (const [wsName, sessions] of byWorkspace) {
        items.push({ label: "", description: "", detail: "", kind: vscode.QuickPickItemKind.Separator } as any);
        for (const s of sessions) {
          const date = s.creationDate ? new Date(s.creationDate).toLocaleString() : "Unknown";
          items.push({
            label: s.title.length > 60 ? s.title.slice(0, 60) + "…" : s.title,
            description: `${s.requestCount} requests | ${wsName}`,
            detail: `Created: ${date}`,
            summary: s,
          });
        }
      }

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `Found ${allSessions.length} sessions across ${byWorkspace.size} workspaces`,
        title: "Export Copilot Chat: All Workspaces",
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!picked) { return; }

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showWarningMessage("No workspace folder open.");
        return;
      }

      const exportDir = vscode.Uri.joinPath(workspaceFolders[0].uri, ".chat-exports");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);

      if (!("summary" in picked) || !picked.summary) {
        // Export all
        const sections: string[] = [
          `# All Copilot Chat Sessions (All Workspaces)\n`,
          `> Exported: ${new Date().toLocaleString()} | ${allSessions.length} sessions across ${byWorkspace.size} workspaces\n\n---\n`,
        ];
        for (const [wsName, sessions] of byWorkspace) {
          sections.push(`\n## Workspace: ${wsName}\n`);
          for (const s of sessions) {
            const md = exportChatSessionToMarkdown(s.filePath);
            if (md) { sections.push(`\n${"-".repeat(60)}\n`); sections.push(md); }
          }
        }
        const fileName = `all-workspaces--${timestamp}.md`;
        const exportUri = vscode.Uri.joinPath(exportDir, fileName);
        await vscode.workspace.fs.writeFile(exportUri, new TextEncoder().encode(sections.join("\n")));
        const doc = await vscode.workspace.openTextDocument(exportUri);
        await vscode.window.showTextDocument(doc, { preview: false });
        vscode.window.showInformationMessage(`Exported ${allSessions.length} sessions from ${byWorkspace.size} workspaces → ${vscode.workspace.asRelativePath(exportUri)}`);
      } else {
        const md = exportChatSessionToMarkdown(picked.summary.filePath);
        if (!md) { vscode.window.showWarningMessage("Failed to parse chat session."); return; }
        const safeTitle = picked.summary.title.replace(/[^a-zA-Z0-9\s\-]/g, "").replace(/\s+/g, "-").toLowerCase().slice(0, 40);
        const fileName = `${safeTitle}--${timestamp}.md`;
        const exportUri = vscode.Uri.joinPath(exportDir, fileName);
        await vscode.workspace.fs.writeFile(exportUri, new TextEncoder().encode(md));
        const doc = await vscode.workspace.openTextDocument(exportUri);
        await vscode.window.showTextDocument(doc, { preview: false });
        vscode.window.showInformationMessage(`Exported "${picked.summary.title}" → ${vscode.workspace.asRelativePath(exportUri)}`);
      }
    })
  );

  // ── Export Chat: Bulk Backup to .chat-exports ──
  context.subscriptions.push(
    vscode.commands.registerCommand("agentRouter.bulkExport", async () => {
      const sessionSummaries = getChatSessionSummaries(context);
      if (sessionSummaries.length === 0) {
        vscode.window.showWarningMessage("No Copilot Chat sessions found for this workspace.");
        return;
      }

      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showWarningMessage("No workspace folder open.");
        return;
      }

      const exportDir = vscode.Uri.joinPath(workspaceFolders[0].uri, ".chat-exports", "history");
      let exported = 0;

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Exporting chat sessions...",
        cancellable: false,
      }, async (progress) => {
        for (let i = 0; i < sessionSummaries.length; i++) {
          const s = sessionSummaries[i];
          progress.report({ message: `${i + 1}/${sessionSummaries.length}: ${s.title.slice(0, 40)}`, increment: 100 / sessionSummaries.length });

          const md = exportChatSessionToMarkdown(s.filePath);
          if (!md) { continue; }

          const date = s.creationDate ? new Date(s.creationDate).toISOString().split("T")[0] : "unknown";
          const safeTitle = s.title.replace(/[^a-zA-Z0-9\s\-]/g, "").replace(/\s+/g, "-").toLowerCase().slice(0, 40);
          const fileName = `${date}--${safeTitle}--${s.sessionId.slice(0, 8)}.md`;
          const fileUri = vscode.Uri.joinPath(exportDir, fileName);

          await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(md));
          exported++;
        }
      });

      output.appendLine(`[BulkExport] Exported ${exported} sessions to .chat-exports/history/`);
      const action = await vscode.window.showInformationMessage(
        `Bulk export complete: ${exported} chat sessions saved to .chat-exports/history/`,
        "Open Folder"
      );
      if (action === "Open Folder") {
        vscode.commands.executeCommand("revealInExplorer", exportDir);
      }
    })
  );

  // ── Convert JSON/JSONL File to Markdown ──
  context.subscriptions.push(
    vscode.commands.registerCommand("agentRouter.convertChatFile", async () => {
      const files = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: "Convert",
        title: "Select a Copilot Chat JSON or JSONL file",
        filters: { "Chat Files": ["json", "jsonl"], "All Files": ["*"] },
      });
      if (!files || files.length === 0) { return; }

      const filePath = files[0].fsPath;
      const md = exportJsonFileToMarkdown(filePath);

      if (!md) {
        vscode.window.showWarningMessage("Could not parse the selected file. Make sure it's a Copilot Chat JSON or JSONL file.");
        return;
      }

      // Open as untitled markdown document
      const doc = await vscode.workspace.openTextDocument({ content: md, language: "markdown" });
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.window.showInformationMessage(`Converted "${path.basename(filePath)}" to Markdown. Save with Ctrl+S.`);
    })
  );

  // ── Export current chat session as portable JSON (for transfer) ──
  context.subscriptions.push(
    vscode.commands.registerCommand("agentRouter.copyTranscriptOut", async () => {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders) {
        vscode.window.showWarningMessage("No workspace folder open.");
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
      const defaultUri = vscode.Uri.joinPath(workspaceFolders[0].uri, `.chat-exports`, `chat-export-${timestamp}.json`);

      const outputUri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { "JSON Files": ["json"] },
        title: "Export Chat History to JSON",
      });
      if (!outputUri) { return; }

      try {
        // Ensure parent directory exists
        const parentUri = vscode.Uri.joinPath(outputUri, "..");
        try { await vscode.workspace.fs.createDirectory(parentUri); } catch { /* may already exist */ }

        // Use VS Code's built-in chat export command
        await vscode.commands.executeCommand("workbench.action.chat.export", outputUri);

        // Verify the file was created
        try {
          await vscode.workspace.fs.stat(outputUri);
          const relativePath = vscode.workspace.asRelativePath(outputUri);
          output.appendLine(`[ExportChat] Exported to: ${outputUri.fsPath}`);
          vscode.window.showInformationMessage(
            `Chat exported to: ${relativePath}. Import it in another workspace with "Agent Router: Import Chat History from JSON".`
          );
        } catch {
          vscode.window.showWarningMessage("Export command completed but no file was created. Make sure you have an active chat session open.");
        }
      } catch (e) {
        output.appendLine(`[ExportChat] Failed: ${e}`);
        vscode.window.showErrorMessage(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })
  );

  // ── Import chat session JSON into current workspace ──
  context.subscriptions.push(
    vscode.commands.registerCommand("agentRouter.importTranscript", async () => {
      const files = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: "Import",
        title: "Import Chat History from JSON",
        filters: { "JSON Files": ["json"], "All Files": ["*"] },
      });
      if (!files || files.length === 0) { return; }

      const inputUri = files[0];
      output.appendLine(`[ImportChat] Importing: ${inputUri.fsPath}`);

      try {
        // Verify the file exists and is readable
        await vscode.workspace.fs.stat(inputUri);

        // Use VS Code's built-in chat import command — opens in a new chat tab
        await vscode.commands.executeCommand("workbench.action.chat.import", { inputPath: inputUri });

        const relativePath = vscode.workspace.asRelativePath(inputUri);
        output.appendLine(`[ImportChat] Import complete: ${relativePath}`);
        vscode.window.showInformationMessage(`Chat session restored from: ${relativePath}`);
      } catch (e) {
        output.appendLine(`[ImportChat] Failed: ${e}`);
        vscode.window.showErrorMessage(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })
  );

  updatePremiumStatusBar(context, true);
  startUsageRefreshInterval(context);

  participant.iconPath = new vscode.ThemeIcon("radio-tower");
  context.subscriptions.push(
    participant,
    output,
    { dispose: () => { if (usageRefreshInterval !== undefined) { clearInterval(usageRefreshInterval); } } }
  );
  if (premiumLimitStatusBarItem) {
    context.subscriptions.push(premiumLimitStatusBarItem);
  }
}

export function deactivate() {
  return;
}
