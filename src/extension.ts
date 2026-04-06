import * as vscode from "vscode";
import { scorePromptComplexity } from "./scorer";
import { getRoutingDecision } from "./router";
import { selectModel, selectModelByName, listAvailableModels, FREE_MODEL_FAMILIES } from "./models";
import { runAgentLoop } from "./agent";
import { openDashboard, addSession, updateSessionStatus, AgentSession } from "./dashboard";
import {
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
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
    const session = await vscode.authentication.getSession(
      "github",
      ["user:email"],
      silent ? { silent: true } : { createIfNone: true }
    );
    if (!session) { return null; }

    const response = await fetch("https://api.github.com/copilot_internal/user", {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
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
  tier: "free" | "premium",
  modelFamily: string,
  reasons: string[],
  agentMode: boolean
): string {
  const tierEmoji = tier === "free" ? "🟢" : "🔴";
  const tierLabel = tier === "free" ? "Free" : "Premium";
  const agentBadge = agentMode ? " _(agent mode — tools enabled)_" : "";
  return [
    `${tierEmoji} **Routed to ${tierLabel} tier** — model family: \`${modelFamily}\`${agentBadge}`,
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
| \`@router /<model> <prompt>\` | Select a model directly from the autocomplete dropdown to pin it. (e.g. \`@router /gpt-4o\`) |

## 🎮 Flags

| Flag | Description |
|---|---|
| \`--model <name>\` | Pin a specific model, bypassing auto-routing |

**Examples:**
\`\`\`
@router scaffold a REST API in src/api/
@router /claude-sonnet-4.6 refactor my auth module
@router /explain design a distributed cache system
@router /boost write a python fast api
@router /help
\`\`\`

## ⚙️ Routing

Prompts are scored 0–100. Score ≤ **${threshold}** → 🟢 Free tier. Score > **${threshold}** → 🔴 Premium tier.

Change the threshold: **Settings** → \`agentRouter.freeThreshold\`

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

> **Free model families:** ${FREE_MODEL_FAMILIES.join(", ")}
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
  const tierEmoji = decision.tier === "free" ? "🟢" : "🔴";

  output.appendLine(`[Explain] score=${complexity.score}, threshold=${threshold}, tier=${decision.tier}`);

  stream.markdown(`## 🔀 Routing Analysis\n\n`);
  stream.markdown(`**Prompt:** _${prompt}_\n\n---\n\n`);
  stream.markdown(`### Score Breakdown\n\n| Metric | Value |\n|---|---|\n| Score | **${complexity.score}/100** |\n| Threshold | ${threshold} |\n| Signals | ${complexity.reasons.join(", ")} |\n\n`);
  stream.markdown(`### Decision\n\n${tierEmoji} **${decision.tier === "free" ? "Free" : "Premium"} tier** — score ${decision.score} ${decision.tier === "free" ? "≤" : ">"} threshold ${threshold}\n\n`);
  stream.markdown(`### Available Models\n\n${allModels.length > 0 ? allModels.map(m => `- \`${m}\``).join("\n") : "_No Copilot models detected_"}\n\n`);
  stream.markdown(`### Free Model Families\n\n${FREE_MODEL_FAMILIES.join(", ")}\n\n`);
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

  const selection = await selectModel("free");
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

  const KNOWN_MODELS: string[] = ["gpt-4o", "gpt-4.1", "gpt-5-mini", "claude-sonnet-4.6", "gemini-3-pro", "claude-haiku-4.5", "gpt-5.3-codex"];
  let rawPrompt = request.prompt.trim();

  // Parse model override (either from a primary slash command, a secondary one in the text, or a --model flag)
  let modelOverride = null;

  if (request.command && KNOWN_MODELS.includes(request.command)) {
    modelOverride = { modelName: request.command, cleanPrompt: rawPrompt };
  } else {
    // Check if the prompt starts with a known model slash command (e.g. user typed `/boost /gpt-4o`)
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
    stream.markdown("⚠️ Please enter a prompt. Example: `@router scaffold a new Express API in src/api/`\n\nTip: Use `--model gpt-4o` to pin a specific model.");
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
  const agentMode = isAgentModeEnabled();

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
    stream.markdown(`📌 **Pinned model:** \`${selection.model.family}\` (\`${selection.model.id}\`) _(agent mode — tools enabled)_`);
    stream.markdown("\n\n---\n\n");
  } else {
    selection = await selectModel(decision.tier);
    if (!selection) {
      stream.markdown("❌ **No Copilot language models available.** Make sure GitHub Copilot is installed and you are signed in.");
      return;
    }
    output.appendLine(`[Model] family=${selection.family}, tier=${selection.tier}, id=${selection.model.id}`);
    stream.markdown(buildRoutingSummary(
      complexity.score, threshold, selection.tier, selection.family, complexity.reasons, agentMode
    ));
    stream.markdown("\n\n---\n\n");
  }

  // 4. Agentic loop (if enabled) or simple single request

  // Record agent session
  const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const session: AgentSession = {
    id: sessionId,
    prompt: prompt.slice(0, 200),
    model: selection.model.family,
    tier: selection.tier,
    score: complexity.score,
    agentMode,
    boosted: isBoostRequested,
    timestamp: Date.now(),
    status: "running",
  };
  addSession(context, session);

  try {
  if (agentMode) {
    const isComplex = decision.tier === "premium";
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
      }
    } catch (e) {
      stream.markdown(`\n\n⚠️ _Stream interrupted: ${e instanceof Error ? e.message : String(e)}_`);
    }
  }

  updateSessionStatus(context, sessionId, "completed");
  } catch (e) {
    updateSessionStatus(context, sessionId, "error");
    throw e;
  }

  // Refresh the status bar after a premium request so it reflects API-side usage
  if (selection.tier === "premium") {
    updatePremiumStatusBar(context, true);
  }
}

// ── Activation ────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  output.appendLine("Agent Router v1.9.0 activated. @router participant + 30 tools ready.");

  registerProposedContentProvider(context);

  // Register all language model tools
  context.subscriptions.push(
    vscode.lm.registerTool("agent-router_readFile", new ReadFileTool()),
    vscode.lm.registerTool("agent-router_writeFile", new WriteFileTool()),
    vscode.lm.registerTool("agent-router_editFile", new EditFileTool()),
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
