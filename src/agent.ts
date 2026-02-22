import * as vscode from "vscode";

export const AGENT_TOOL_PREFIX = "agent-router_";
export const MAX_TOOL_ROUNDS = 15;

const SYSTEM_PROMPT = `You are an expert software engineering assistant running inside VS Code.
You have access to tools that let you read, write, edit, and delete files, run terminal commands, search the codebase, list directories, and read VS Code diagnostics.

Guidelines:
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

/**
 * All tool calls go through vscode.lm.invokeTool() so that prepareInvocation()
 * confirmation dialogs fire before any destructive operation.
 */
export async function runAgentLoop(
    model: vscode.LanguageModelChat,
    userPrompt: string,
    stream: vscode.ChatResponseStream,
    toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
    token: vscode.CancellationToken,
    output: vscode.OutputChannel
): Promise<void> {
    const agentTools = vscode.lm.tools.filter(t => t.name.startsWith(AGENT_TOOL_PREFIX));

    if (agentTools.length === 0) {
        output.appendLine("[Agent] Warning: no agent-router tools found");
    }

    const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(`${SYSTEM_PROMPT}\n\nUser request: ${userPrompt}`)
    ];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (token.isCancellationRequested) { break; }
        output.appendLine(`[Agent] Round ${round + 1}/${MAX_TOOL_ROUNDS}`);

        let response: vscode.LanguageModelChatResponse;
        try {
            response = await model.sendRequest(messages, { tools: agentTools }, token);
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

        for (const call of toolCalls) {
            if (token.isCancellationRequested) { break; }
            stream.markdown(`\n\n> 🔧 ${summarizeToolCall(call.name, call.input)}\n\n`);
            output.appendLine(`[Tool Run] ${call.name}`);

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
