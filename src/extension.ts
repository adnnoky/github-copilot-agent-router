import * as vscode from "vscode";
import { scorePromptComplexity } from "./scorer";
import { getRoutingDecision } from "./router";
import { selectModel, selectModelByName, listAvailableModels, FREE_MODEL_FAMILIES } from "./models";
import { runAgentLoop } from "./agent";
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
  ClipboardWriteTool
} from "./tools";

const OUTPUT_CHANNEL_NAME = "Agent Router";
const PARTICIPANT_ID = "agent-router.router";

// ── Config helpers ────────────────────────────────────────────────────────

function getFreeThreshold(): number {
  return vscode.workspace.getConfiguration("agentRouter").get<number>("freeThreshold", 70);
}

function isAgentModeEnabled(): boolean {
  return vscode.workspace.getConfiguration("agentRouter").get<boolean>("agentMode", true);
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
| \`@router /help\` or \`@router /?\` | Show this help page |
| \`@router /explain <prompt>\` | Show routing score breakdown without sending to model |

## 🎮 Flags

| Flag | Description |
|---|---|
| \`--model <name>\` | Pin a specific model, bypassing auto-routing |

**Examples:**
\`\`\`
@router scaffold a REST API in src/api/
@router --model claude-3.5-sonnet refactor my auth module
@router /explain design a distributed cache system
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

// ── Main chat participant handler ─────────────────────────────────────────

async function routerHandler(
  request: vscode.ChatRequest,
  _context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  output: vscode.OutputChannel
): Promise<void> {
  if (request.command === "explain") {
    await handleExplainCommand(request, stream, output);
    return;
  }

  // /help and /? are registered slash commands → request.command will be "help" or "?"
  if (request.command === "help" || request.command === "?") {
    await handleHelpCommand(stream);
    return;
  }

  const rawPrompt = request.prompt.trim();

  // Fallback: bare "help" / "?" typed without a slash (belt-and-suspenders)
  if (/^(help|\?)$/i.test(rawPrompt)) {
    await handleHelpCommand(stream);
    return;
  }

  const attachedContext = await resolveReferences(request.references);

  // Parse optional --model flag
  const modelOverride = parseModelFlag(rawPrompt);
  const prompt = modelOverride ? modelOverride.cleanPrompt : rawPrompt;


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
  if (agentMode) {
    await runAgentLoop(
      selection.model,
      fullPrompt,
      stream,
      request.toolInvocationToken,
      token,
      output
    );
  } else {
    // Simple single-shot request without tools
    let response: vscode.LanguageModelChatResponse;
    try {
      response = await selection.model.sendRequest(
        [vscode.LanguageModelChatMessage.User(fullPrompt)],
        {},
        token
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      output.appendLine(`[Error] ${msg}`);
      stream.markdown(`❌ **Failed:** ${msg}`);
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
}

// ── Activation ────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  output.appendLine("Agent Router v1.5.0 activated. @router participant + 30 tools ready.");

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
      routerHandler(request, chatContext, stream, token, output)
  );

  participant.iconPath = new vscode.ThemeIcon("radio-tower");
  context.subscriptions.push(participant, output);
}

export function deactivate() {
  return;
}
