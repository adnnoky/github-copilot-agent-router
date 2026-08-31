import * as vscode from "vscode";
import { selectModel } from "./models";
import * as path from "path";

export const AGENT_TOOL_PREFIX = "agent-router_";
export const MAX_TOOL_ROUNDS = 15;

const SYSTEM_PROMPT = `You are an expert software engineering assistant running inside VS Code.
You have access to tools that let you read, write, edit, and delete files, run terminal commands, search the codebase, list directories, and read VS Code diagnostics.

Guidelines:
- You DO have authorization to run terminal commands via the provided tools. Do not state that you lack access.
- Use tools proactively to gather context before making changes.
- When editing files, always read them first to understand current content and line numbers.
- After writing or editing files, confirm success by reading them back or checking diagnostics.
- For multi-file changes, process one file at a time.
- To delete a file, use the deleteFile tool.
- When done, give a concise summary of what was changed and why.`;

function summarizeToolCall(name: string, input: unknown): string {
    const shortName = name.replace(AGENT_TOOL_PREFIX, "");
    if (typeof input !== "object" || !input) { return `\`${shortName}\``; }
    const obj = input as Record<string, unknown>;
    if (obj.path) { return `\`${shortName}\` → \`${obj.path}\``; }
    if (obj.command) { return `\`${shortName}\` → \`${String(obj.command).slice(0, 60)}\``; }
    if (obj.query) { return `\`${shortName}\` → "${String(obj.query).slice(0, 60)}"`; }
    return `\`${shortName}\``;
}

/** Describe a tool call as a progress message (shown as a spinner). */
function toolProgressMessage(name: string, input: unknown): string {
    const shortName = name.replace(AGENT_TOOL_PREFIX, "");
    const obj = (typeof input === "object" && input) ? input as Record<string, unknown> : {};

    switch (shortName) {
        case "readFile":
        case "readFileLines":
            return `Reading ${basename(obj)}`;
        case "writeFile":
            return `Writing ${basename(obj)}`;
        case "editFile":
        case "replaceStringInFile":
        case "multiReplaceStringInFile":
            return `Editing ${basename(obj)}`;
        case "deleteFile":
            return `Deleting ${basename(obj)}`;
        case "renameFile":
            return `Renaming ${basename(obj)}`;
        case "copyFile":
            return `Copying ${basename(obj)}`;
        case "createDirectory":
            return `Creating directory`;
        case "searchFiles":
            return `Searching files${obj.query ? `: ${String(obj.query).slice(0, 40)}` : ""}`;
        case "grepSearch":
            return `Searching${obj.pattern ? `: ${String(obj.pattern).slice(0, 40)}` : ""}`;
        case "listDirectory":
            return `Listing ${basename(obj)}`;
        case "runCommand":
            return `Running command${obj.command ? `: ${String(obj.command).slice(0, 50)}` : ""}`;
        case "getProblems":
            return `Checking for errors`;
        case "getSymbols":
            return `Getting symbols in ${basename(obj)}`;
        case "getGitStatus":
            return `Checking git status`;
        case "openFile":
            return `Opening ${basename(obj)}`;
        case "runTests":
            return `Running tests`;
        case "fetchUrl":
            return `Fetching URL`;
        case "findAndReplace":
            return `Find & replace`;
        case "listCodeUsages":
            return `Finding references`;
        case "renameSymbol":
            return `Renaming symbol`;
        case "runVSCodeCommand":
            return `Running VS Code command`;
        case "runNotebookCell":
            return `Executing notebook cell`;
        case "askUser":
            return `Asking question`;
        case "runSubAgent":
            return `Delegating to sub-agent`;
        default:
            return shortName;
    }
}

function basename(obj: Record<string, unknown>): string {
    const p = String(obj.path || obj.file || "");
    if (!p) { return ""; }
    const name = p.split(/[\\/]/).pop() || p;
    return name;
}

/** Determine if a tool call modifies files (for tracking changed files). */
function isWriteTool(name: string): boolean {
    const shortName = name.replace(AGENT_TOOL_PREFIX, "");
    return ["writeFile", "editFile", "replaceStringInFile", "multiReplaceStringInFile",
        "deleteFile", "renameFile", "copyFile", "findAndReplace", "renameSymbol",
        "editNotebook", "createNotebook"].includes(shortName);
}

/** Extract file path(s) from a tool call input. */
function extractPaths(name: string, input: unknown): string[] {
    if (typeof input !== "object" || !input) { return []; }
    const obj = input as Record<string, unknown>;
    const paths: string[] = [];
    if (obj.path && typeof obj.path === "string") { paths.push(obj.path); }
    if (obj.file && typeof obj.file === "string") { paths.push(obj.file); }
    // multiReplaceStringInFile / findAndReplace
    if (Array.isArray(obj.replacements)) {
        for (const r of obj.replacements) {
            if (r && typeof r === "object" && typeof r.path === "string") { paths.push(r.path); }
        }
    }
    if (Array.isArray(obj.changes)) {
        for (const c of obj.changes) {
            if (c && typeof c === "object" && typeof c.file === "string") { paths.push(c.file); }
        }
    }
    return [...new Set(paths)];
}

function resolveToolUri(p: string): vscode.Uri {
    if (path.isAbsolute(p) || /^[a-zA-Z]:/.test(p)) { return vscode.Uri.file(p); }
    return vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "", p));
}

async function readFileLines(p: string): Promise<string[] | null> {
    try {
        const bytes = await vscode.workspace.fs.readFile(resolveToolUri(p));
        return new TextDecoder().decode(bytes).split("\n");
    } catch { return null; }
}

function computeDiffStats(before: string[] | null, after: string[] | null): { added: number; removed: number } {
    if (!after) { return { added: 0, removed: 0 }; }
    if (!before) { return { added: after.length, removed: 0 }; }
    // Simple line-level diff: count lines present in after but not before (added) and vice versa (removed)
    const beforeSet = new Map<string, number>();
    for (const line of before) { beforeSet.set(line, (beforeSet.get(line) ?? 0) + 1); }
    const afterSet = new Map<string, number>();
    for (const line of after) { afterSet.set(line, (afterSet.get(line) ?? 0) + 1); }

    let added = 0;
    let removed = 0;
    for (const [line, count] of afterSet) {
        const diff = count - (beforeSet.get(line) ?? 0);
        if (diff > 0) { added += diff; }
    }
    for (const [line, count] of beforeSet) {
        const diff = count - (afterSet.get(line) ?? 0);
        if (diff > 0) { removed += diff; }
    }
    return { added, removed };
}

/**
 * All tool calls go through vscode.lm.invokeTool() so that prepareInvocation()
 * confirmation dialogs fire before any destructive operation.
 */
export async function runAgentLoop(
    model: vscode.LanguageModelChat,
    userPrompt: string,
    history: vscode.LanguageModelChatMessage[],
    stream: vscode.ChatResponseStream,
    toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
    token: vscode.CancellationToken,
    output: vscode.OutputChannel,
    isComplex?: boolean
): Promise<void> {
    const agentTools = vscode.lm.tools.filter(t => t.name.startsWith(AGENT_TOOL_PREFIX));

    if (agentTools.length === 0) {
        output.appendLine("[Agent] Warning: no agent-router tools found");
    }

    const planInstruction = isComplex
        ? "This is a complex request. Before taking any actions or calling any tools, you MUST first output a step-by-step to-do list plan of how you will solve this. Do not skip this planning step.\n\n"
        : "";

    const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(SYSTEM_PROMPT),
        ...history,
        vscode.LanguageModelChatMessage.User(`${planInstruction}User request: ${userPrompt}`)
    ];

    const hybridMode = vscode.workspace.getConfiguration("agentRouter").get<boolean>("hybridAgentMode", true);
    let fallbackModel: vscode.LanguageModelChat | undefined;

    if (hybridMode) {
        const standardSelection = await selectModel("standard");
        // Only use fallback if we successfully got a standard model AND the original model wasn't already the standard model.
        if (standardSelection && standardSelection.model.id !== model.id) {
            fallbackModel = standardSelection.model;
        }
    }

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (token.isCancellationRequested) { break; }
        output.appendLine(`[Agent] Round ${round + 1}/${MAX_TOOL_ROUNDS}`);

        // Use the advanced model for round 0 (planning), then switch to the fallback standard model for tool execution.
        const currentModel = (round > 0 && fallbackModel) ? fallbackModel : model;

        let response: vscode.LanguageModelChatResponse;
        try {
            response = await currentModel.sendRequest(messages, { tools: agentTools }, token);
        } catch (e) {
            stream.markdown(`\n\n❌ **Model error:** ${e instanceof Error ? e.message : String(e)}`);
            break;
        }

        const toolCalls: vscode.LanguageModelToolCallPart[] = [];
        const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];

        for await (const chunk of response.stream) {
            if (token.isCancellationRequested) { break; }
            if (chunk instanceof vscode.LanguageModelTextPart) {
                stream.markdown(chunk.value);
                assistantParts.push(chunk);
            } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push(chunk);
                assistantParts.push(chunk);
                output.appendLine(`[Tool Call] ${chunk.name}(${JSON.stringify(chunk.input).slice(0, 120)})`);
            }
        }

        if (toolCalls.length === 0) {
            output.appendLine(`[Agent] Finished after ${round + 1} round(s).`);
            break;
        }

        messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

        const toolResults: vscode.LanguageModelToolResultPart[] = [];
        const changedFiles = new Set<string>();

        for (const call of toolCalls) {
            if (token.isCancellationRequested) { break; }

            // Show live progress spinner instead of raw tool name
            stream.progress(toolProgressMessage(call.name, call.input));
            output.appendLine(`[Tool Run] ${call.name}`);

            const isWrite = isWriteTool(call.name);
            const filePaths = isWrite ? extractPaths(call.name, call.input) : [];

            // Snapshot file contents before write tools execute
            const snapshots = new Map<string, string[] | null>();
            if (isWrite) {
                for (const p of filePaths) {
                    snapshots.set(p, await readFileLines(p));
                }
            }

            let resultContent: Array<vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart>;
            try {
                // ALL tools go through invokeTool so prepareInvocation confirmations fire
                const result = await vscode.lm.invokeTool(
                    call.name,
                    { input: call.input, toolInvocationToken },
                    token
                );
                resultContent = result.content as Array<vscode.LanguageModelTextPart | vscode.LanguageModelPromptTsxPart>;
                output.appendLine(`[Tool Result] ${resultContent.map(p => p instanceof vscode.LanguageModelTextPart ? p.value.slice(0, 120) : "(non-text)").join(" | ")}`);

                // Show diff stats and file references for write tools
                if (isWrite) {
                    const resultText = resultContent.map(p => p instanceof vscode.LanguageModelTextPart ? p.value : "").join("");
                    const succeeded = resultText.includes("SUCCESS");

                    for (const p of filePaths) {
                        if (!changedFiles.has(p)) {
                            changedFiles.add(p);
                            const after = await readFileLines(p);
                            const { added, removed } = computeDiffStats(snapshots.get(p) ?? null, after);
                            const name = p.split(/[\\/]/).pop() || p;
                            const verb = call.name.includes("delete") ? "Deleted" : (snapshots.get(p) ? "Edited" : "Created");
                            const stats = (added || removed) ? ` +${added} -${removed}` : "";
                            stream.markdown(`\n\n\`${verb} ${name}${stats}\`\n`);
                            try {
                                const uri = resolveToolUri(p);
                                stream.reference(uri);
                            } catch { /* ignore */ }
                        }
                    }
                }
            } catch (e) {
                const msg = `Tool "${call.name}" error: ${e instanceof Error ? e.message : String(e)}`;
                resultContent = [new vscode.LanguageModelTextPart(msg)];
                output.appendLine(`[Tool Error] ${msg}`);
            }

            toolResults.push(new vscode.LanguageModelToolResultPart(call.callId, resultContent));
        }

        messages.push(vscode.LanguageModelChatMessage.User(toolResults));
    }
}
