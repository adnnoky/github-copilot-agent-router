import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";
import * as https from "https";
import * as http from "http";
import * as os from "os";
import { promisify } from "util";

const execAsync = promisify(cp.exec);

async function exec(command: string, options: cp.ExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
    if (os.platform() === "win32" && !options.shell) {
        options.shell = "powershell.exe";
    }
    const result = await execAsync(command, options);
    return {
        stdout: typeof result.stdout === "string" ? result.stdout : result.stdout.toString(),
        stderr: typeof result.stderr === "string" ? result.stderr : result.stderr.toString()
    };
}
const MAX_READ_CHARS = 100_000;
const MAX_SEARCH_RESULTS = 30;

// ── Readonly Content Provider for Diff Proposals ───────────────────────────

const proposedContentMap = new Map<string, string>();

export const proposedContentProvider = new class implements vscode.TextDocumentContentProvider {
    provideTextDocumentContent(uri: vscode.Uri): string {
        return proposedContentMap.get(uri.path) ?? "";
    }
};

export function registerProposedContentProvider(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider("agent-router-proposed", proposedContentProvider)
    );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getWorkspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
}

function resolveUri(filePath: string): vscode.Uri {
    if (path.isAbsolute(filePath)) {
        return vscode.Uri.file(filePath);
    }
    return vscode.Uri.file(path.join(getWorkspaceRoot(), filePath));
}

function ok(msg: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(msg)]);
}

export async function closeDiffEditor(filePath: string) {
    const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
    const targetLabel = `🔄 ${fileName}: Current ↔ Proposed`;
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.label === targetLabel) {
                await vscode.window.tabGroups.close(tab);
            }
        }
    }
}

// ── 1. Read File ───────────────────────────────────────────────────────────

interface ReadFileInput { path: string; }

export class ReadFileTool implements vscode.LanguageModelTool<ReadFileInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ReadFileInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const uri = resolveUri(options.input.path);
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            let text = new TextDecoder().decode(bytes);
            if (text.length > MAX_READ_CHARS) {
                text = text.slice(0, MAX_READ_CHARS) + `\n[... truncated at ${MAX_READ_CHARS} chars ...]`;
            }
            return ok(text);
        } catch (e) {
            return ok(`ERROR reading "${options.input.path}": ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}


// ── 2. Write File (create or overwrite) ───────────────────────────────────

function detectLanguage(filePath: string): string {
    const ext = filePath.split(".").pop() ?? "";
    const map: Record<string, string> = {
        ts: "typescript", js: "javascript", py: "python", md: "markdown",
        json: "json", html: "html", css: "css", sh: "shellscript",
        yaml: "yaml", yml: "yaml"
    };
    return map[ext] ?? "plaintext";
}

interface WriteFileInput { path: string; content: string; }

export class WriteFileTool implements vscode.LanguageModelTool<WriteFileInput> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<WriteFileInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { path: filePath, content: newContent } = options.input;
        const uri = resolveUri(filePath);

        try {
            const language = detectLanguage(filePath);
            let leftUri: vscode.Uri;
            try {
                await vscode.workspace.fs.stat(uri);
                leftUri = uri;
            } catch {
                const emptyDoc = await vscode.workspace.openTextDocument({ content: "", language });
                leftUri = emptyDoc.uri;
            }
            const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
            const rightUri = vscode.Uri.parse(`agent-router-proposed:${uri.path}`);
            proposedContentMap.set(uri.path, newContent);
            await vscode.commands.executeCommand(
                "vscode.diff", leftUri, rightUri,
                `🔄 ${fileName}: Current ↔ Proposed`, { preview: true }
            );
        } catch { /* silently skip if diff fails */ }

        return {
            invocationMessage: `Writing to \`${filePath}\``,
            confirmationMessages: {
                title: `Apply changes to ${filePath}?`,
                message: new vscode.MarkdownString(`Review the diff, then click **Allow** to write.`)
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<WriteFileInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { path: filePath, content: newContent } = options.input;
        const uri = resolveUri(filePath);
        try {
            const dirPath = path.dirname(uri.fsPath);
            const dirUri = vscode.Uri.file(dirPath);
            await vscode.workspace.fs.createDirectory(dirUri);
            const bytes = new TextEncoder().encode(newContent);
            await vscode.workspace.fs.writeFile(uri, bytes);
            await closeDiffEditor(filePath);
            proposedContentMap.delete(uri.path);
            return ok(`SUCCESS: wrote ${bytes.length} bytes to "${filePath}".`);
        } catch (e) {
            return ok(`ERROR writing "${filePath}": ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

// ── 3. Edit File (targeted line-range replacements) ──────────────────────

interface LineEdit { startLine: number; endLine: number; newText: string; }
interface EditFileInput { path: string; edits: LineEdit[]; }

export class EditFileTool implements vscode.LanguageModelTool<EditFileInput> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<EditFileInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { path: filePath, edits } = options.input;
        const uri = resolveUri(filePath);

        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const lines = new TextDecoder().decode(bytes).split("\n");
            const sorted = [...edits].sort((a, b) => b.startLine - a.startLine);
            const resultLines = [...lines];
            for (const edit of sorted) {
                const sl = Math.max(0, edit.startLine - 1);
                const el = Math.min(resultLines.length - 1, edit.endLine - 1);
                resultLines.splice(sl, el - sl + 1, ...edit.newText.split("\n"));
            }
            const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
            const rightUri = vscode.Uri.parse(`agent-router-proposed:${uri.path}`);
            proposedContentMap.set(uri.path, resultLines.join("\n"));
            await vscode.commands.executeCommand(
                "vscode.diff", uri, rightUri,
                `🔄 ${fileName}: Current ↔ Proposed`, { preview: true }
            );
        } catch { /* silently skip if diff fails */ }

        return {
            invocationMessage: `Editing \`${filePath}\` (${edits.length} edit${edits.length > 1 ? "s" : ""})`,
            confirmationMessages: {
                title: `Apply edits to ${filePath}?`,
                message: new vscode.MarkdownString(`Review the diff, then click **Allow** to apply ${edits.length} edit(s).`)
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<EditFileInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { path: filePath, edits } = options.input;
        const uri = resolveUri(filePath);
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const lines = new TextDecoder().decode(bytes).split("\n");

            const we = new vscode.WorkspaceEdit();
            const sorted = [...edits].sort((a, b) => b.startLine - a.startLine);
            for (const edit of sorted) {
                const sl = Math.max(0, edit.startLine - 1);
                const el = Math.min(lines.length - 1, edit.endLine - 1);
                we.replace(uri, new vscode.Range(
                    new vscode.Position(sl, 0),
                    new vscode.Position(el, lines[el]?.length ?? 0)
                ), edit.newText);
            }
            const success = await vscode.workspace.applyEdit(we);
            if (success) {
                await closeDiffEditor(filePath);
                proposedContentMap.delete(uri.path);
            }
            return ok(success
                ? `SUCCESS: applied ${edits.length} edit(s) to "${filePath}".`
                : `ERROR: applyEdit returned false for "${filePath}".`);
        } catch (e) {
            return ok(`ERROR editing "${filePath}": ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

// ── 3b. Replace String in File (exact string matching) ───────────────────

interface ReplaceStringInput {
    path: string;
    oldString: string;
    newString: string;
}

export class ReplaceStringInFileTool implements vscode.LanguageModelTool<ReplaceStringInput> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ReplaceStringInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { path: filePath, oldString, newString } = options.input;
        const uri = resolveUri(filePath);

        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = new TextDecoder().decode(bytes);
            const idx = text.indexOf(oldString);
            if (idx !== -1) {
                const proposedText = text.slice(0, idx) + newString + text.slice(idx + oldString.length);
                const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
                const rightUri = vscode.Uri.parse(`agent-router-proposed:${uri.path}`);
                proposedContentMap.set(uri.path, proposedText);
                await vscode.commands.executeCommand(
                    "vscode.diff", uri, rightUri,
                    `🔄 ${fileName}: Current ↔ Proposed`, { preview: true }
                );
            }
        } catch { /* silently skip if diff fails */ }

        return {
            invocationMessage: `Replacing string in \`${filePath}\``,
            confirmationMessages: {
                title: `Replace in ${filePath}?`,
                message: new vscode.MarkdownString(`Review the diff, then click **Allow** to replace.`)
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ReplaceStringInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { path: filePath, oldString, newString } = options.input;
        const uri = resolveUri(filePath);
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = new TextDecoder().decode(bytes);

            const idx = text.indexOf(oldString);
            if (idx === -1) {
                return ok(`ERROR: exact string not found in "${filePath}". Make sure you copied the exact text including whitespace and indentation.`);
            }

            const secondIdx = text.indexOf(oldString, idx + 1);
            if (secondIdx !== -1) {
                return ok(`ERROR: the string appears multiple times in "${filePath}". Include more surrounding context to uniquely identify the target location.`);
            }

            const doc = await vscode.workspace.openTextDocument(uri);
            const startPos = doc.positionAt(idx);
            const endPos = doc.positionAt(idx + oldString.length);
            const we = new vscode.WorkspaceEdit();
            we.replace(uri, new vscode.Range(startPos, endPos), newString);
            const success = await vscode.workspace.applyEdit(we);

            if (success) {
                await closeDiffEditor(filePath);
                proposedContentMap.delete(uri.path);
            }

            return ok(success
                ? `SUCCESS: replaced string in "${filePath}".`
                : `ERROR: applyEdit returned false for "${filePath}".`);
        } catch (e) {
            return ok(`ERROR editing "${filePath}": ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

// ── 3c. Multi Replace String in File ─────────────────────────────────────

interface MultiReplaceOperation {
    path: string;
    oldString: string;
    newString: string;
}
interface MultiReplaceStringInput {
    replacements: MultiReplaceOperation[];
}

export class MultiReplaceStringInFileTool implements vscode.LanguageModelTool<MultiReplaceStringInput> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<MultiReplaceStringInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { replacements } = options.input;
        const files = [...new Set(replacements.map(r => r.path))];
        return {
            invocationMessage: `Replacing strings in ${replacements.length} location(s) across ${files.length} file(s)`,
            confirmationMessages: {
                title: `Apply ${replacements.length} replacement(s)?`,
                message: new vscode.MarkdownString(`Replace in: ${files.map(f => `\`${f}\``).join(", ")}`)
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<MultiReplaceStringInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const results: string[] = [];
        let successCount = 0;
        let failCount = 0;

        for (const op of options.input.replacements) {
            const uri = resolveUri(op.path);
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                const text = new TextDecoder().decode(bytes);

                const idx = text.indexOf(op.oldString);
                if (idx === -1) {
                    results.push(`"${op.path}": FAILED — exact string not found`);
                    failCount++;
                    continue;
                }

                const secondIdx = text.indexOf(op.oldString, idx + 1);
                if (secondIdx !== -1) {
                    results.push(`"${op.path}": FAILED — string matches multiple locations`);
                    failCount++;
                    continue;
                }

                const doc = await vscode.workspace.openTextDocument(uri);
                const startPos = doc.positionAt(idx);
                const endPos = doc.positionAt(idx + op.oldString.length);
                const we = new vscode.WorkspaceEdit();
                we.replace(uri, new vscode.Range(startPos, endPos), op.newString);
                const applied = await vscode.workspace.applyEdit(we);

                if (applied) {
                    results.push(`"${op.path}": SUCCESS`);
                    successCount++;
                } else {
                    results.push(`"${op.path}": FAILED — applyEdit returned false`);
                    failCount++;
                }
            } catch (e) {
                results.push(`"${op.path}": ERROR — ${e instanceof Error ? e.message : String(e)}`);
                failCount++;
            }
        }

        return ok(`Multi-replace complete: ${successCount} succeeded, ${failCount} failed.\n${results.join("\n")}`);
    }
}

// ── 4. List Directory ──────────────────────────────────────────────────────

interface ListDirectoryInput { path: string; }

export class ListDirectoryTool implements vscode.LanguageModelTool<ListDirectoryInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ListDirectoryInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const dirPath = options.input.path || ".";
        const uri = resolveUri(dirPath);
        try {
            const entries = await vscode.workspace.fs.readDirectory(uri);
            if (entries.length === 0) { return ok("(empty directory)"); }
            const lines = entries.map(([name, type]) =>
                `[${type === vscode.FileType.Directory ? "dir" : "file"}] ${name}`
            );
            return ok(lines.join("\n"));
        } catch (e) {
            return ok(`ERROR listing "${dirPath}": ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

// ── 5. Run Terminal Command ────────────────────────────────────────────────

interface RunCommandInput { command: string; cwd?: string; timeoutMs?: number; }

export class RunCommandTool implements vscode.LanguageModelTool<RunCommandInput> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<RunCommandInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { command } = options.input;
        return {
            invocationMessage: `Running: \`${command}\``,
            confirmationMessages: {
                title: "Run terminal command?",
                message: new vscode.MarkdownString(`\`\`\`\n${command}\n\`\`\``)
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<RunCommandInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { command, cwd, timeoutMs = 30_000 } = options.input;
        const workingDir = cwd ? resolveUri(cwd).fsPath : getWorkspaceRoot();
        try {
            const { stdout, stderr } = await exec(command, { cwd: workingDir, timeout: timeoutMs });
            const parts: string[] = [];
            if (stdout?.trim()) { parts.push(`STDOUT:\n${stdout.trim()}`); }
            if (stderr?.trim()) { parts.push(`STDERR:\n${stderr.trim()}`); }
            return ok(parts.length > 0 ? parts.join("\n\n") : "(no output)");
        } catch (e: unknown) {
            const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
            const parts = [`Exit code: ${err.code ?? "unknown"}`];
            if (err.stdout?.trim()) { parts.push(`STDOUT:\n${err.stdout.trim()}`); }
            if (err.stderr?.trim()) { parts.push(`STDERR:\n${err.stderr.trim()}`); }
            if (err.message) { parts.push(`ERROR:\n${err.message}`); }
            return ok(parts.join("\n"));
        }
    }
}

// ── 6. Search Files (text search across workspace) ────────────────────────

interface SearchFilesInput { query: string; include?: string; exclude?: string; maxResults?: number; }

export class SearchFilesTool implements vscode.LanguageModelTool<SearchFilesInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SearchFilesInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { query, include = "**/*", exclude, maxResults = MAX_SEARCH_RESULTS } = options.input;
        const root = getWorkspaceRoot();
        try {
            const matches: string[] = [];
            const files = await vscode.workspace.findFiles(include, exclude ?? null, 500);
            const lq = query.toLowerCase();

            for (const fileUri of files) {
                if (token.isCancellationRequested || matches.length >= maxResults) { break; }
                try {
                    const bytes = await vscode.workspace.fs.readFile(fileUri);
                    const relPath = path.relative(root, fileUri.fsPath);
                    const lines = new TextDecoder().decode(bytes).split("\n");
                    for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
                        if (lines[i].toLowerCase().includes(lq)) {
                            matches.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
                        }
                    }
                } catch { /* skip unreadable */ }
            }

            return ok(matches.length > 0 ? matches.join("\n") : `No matches found for "${query}".`);
        } catch (e) {
            return ok(`ERROR searching for "${query}": ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

// ── 7. Get Workspace Diagnostics (Problems panel) ─────────────────────────

interface GetProblemsInput { path?: string; }

export class GetProblemsTool implements vscode.LanguageModelTool<GetProblemsInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetProblemsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const root = getWorkspaceRoot();
        const filterPath = options.input.path;
        const all = vscode.languages.getDiagnostics();
        const filtered = filterPath
            ? all.filter(([uri]) => uri.fsPath.includes(filterPath))
            : all;

        const lines: string[] = [];
        for (const [uri, diags] of filtered) {
            const rel = path.relative(root, uri.fsPath);
            for (const d of diags) {
                const sev = vscode.DiagnosticSeverity[d.severity];
                lines.push(`[${sev}] ${rel}:${d.range.start.line + 1}: ${d.message}`);
            }
        }
        return ok(lines.length > 0 ? lines.join("\n") : "No diagnostics found.");
    }
}

// ── 8. Delete File ─────────────────────────────────────────────────────────

interface DeleteFileInput { path: string; }

export class DeleteFileTool implements vscode.LanguageModelTool<DeleteFileInput> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<DeleteFileInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Deleting \`${options.input.path}\``,
            confirmationMessages: {
                title: `Delete ${options.input.path}?`,
                message: new vscode.MarkdownString(`Delete \`${options.input.path}\` (moved to trash)`)
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<DeleteFileInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const uri = resolveUri(options.input.path);
        try {
            await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
            return ok(`SUCCESS: deleted "${options.input.path}" (moved to trash).`);
        } catch (e) {
            return ok(`ERROR deleting "${options.input.path}": ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

// ── 9. Rename / Move File ──────────────────────────────────────────────────

interface RenameFileInput { oldPath: string; newPath: string; }

export class RenameFileTool implements vscode.LanguageModelTool<RenameFileInput> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<RenameFileInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return { invocationMessage: `Renaming \`${options.input.oldPath}\` → \`${options.input.newPath}\`` };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<RenameFileInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const src = resolveUri(options.input.oldPath);
        const dst = resolveUri(options.input.newPath);
        try {
            await vscode.workspace.fs.rename(src, dst, { overwrite: false });
            return ok(`SUCCESS: renamed "${options.input.oldPath}" → "${options.input.newPath}".`);
        } catch (e) {
            return ok(`ERROR renaming: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

// ── 10. Copy File ──────────────────────────────────────────────────────────

interface CopyFileInput { sourcePath: string; destPath: string; overwrite?: boolean; }

export class CopyFileTool implements vscode.LanguageModelTool<CopyFileInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CopyFileInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const src = resolveUri(options.input.sourcePath);
        const dst = resolveUri(options.input.destPath);
        try {
            await vscode.workspace.fs.copy(src, dst, { overwrite: options.input.overwrite ?? false });
            return ok(`SUCCESS: copied "${options.input.sourcePath}" → "${options.input.destPath}".`);
        } catch (e) {
            return ok(`ERROR copying: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

// ── 11. Create Directory ───────────────────────────────────────────────────

interface CreateDirectoryInput { path: string; }

export class CreateDirectoryTool implements vscode.LanguageModelTool<CreateDirectoryInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CreateDirectoryInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const uri = resolveUri(options.input.path);
        try {
            await vscode.workspace.fs.createDirectory(uri);
            return ok(`SUCCESS: created directory "${options.input.path}".`);
        } catch (e) {
            return ok(`ERROR creating directory "${options.input.path}": ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

// ── 12. Read File Lines ────────────────────────────────────────────────────

interface ReadFileLinesInput { path: string; startLine: number; endLine: number; }

export class ReadFileLinesTool implements vscode.LanguageModelTool<ReadFileLinesInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ReadFileLinesInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { path: filePath, startLine, endLine } = options.input;
        const uri = resolveUri(filePath);
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const lines = new TextDecoder().decode(bytes).split("\n");
            const sl = Math.max(0, startLine - 1);
            const el = Math.min(lines.length - 1, endLine - 1);
            const slice = lines.slice(sl, el + 1)
                .map((l, i) => `${sl + i + 1}: ${l}`)
                .join("\n");
            return ok(`Lines ${startLine}–${endLine} of "${filePath}":\n${slice}`);
        } catch (e) {
            return ok(`ERROR reading "${filePath}": ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

// ── 13. Find and Replace ───────────────────────────────────────────────────

interface FindReplaceChange { file: string; find: string; replace: string; useRegex?: boolean; }
interface FindAndReplaceInput { changes: FindReplaceChange[]; }

export class FindAndReplaceTool implements vscode.LanguageModelTool<FindAndReplaceInput> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<FindAndReplaceInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const { changes } = options.input;
        return {
            invocationMessage: `Finding & replacing across ${changes.length} file(s)`,
            confirmationMessages: {
                title: `Apply find & replace?`,
                message: new vscode.MarkdownString(`${changes.length} replacement(s) across ${[...new Set(changes.map(c => c.file))].length} file(s)`)
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FindAndReplaceInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const we = new vscode.WorkspaceEdit();
        const results: string[] = [];

        for (const change of options.input.changes) {
            const uri = resolveUri(change.file);
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                const text = new TextDecoder().decode(bytes);
                const pattern = change.useRegex
                    ? new RegExp(change.find, "g")
                    : new RegExp(change.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
                const matches = [...text.matchAll(pattern)];
                if (matches.length === 0) {
                    results.push(`"${change.file}": no matches for "${change.find}"`);
                    continue;
                }
                const doc = await vscode.workspace.openTextDocument(uri);
                for (const match of matches.reverse()) {
                    const start = doc.positionAt(match.index!);
                    const end = doc.positionAt(match.index! + match[0].length);
                    we.replace(uri, new vscode.Range(start, end), change.replace);
                }
                results.push(`"${change.file}": replaced ${matches.length} occurrence(s)`);
            } catch (e) {
                results.push(`"${change.file}": ERROR — ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        await vscode.workspace.applyEdit(we);
        return ok(`Find & replace complete:\n${results.join("\n")}`);
    }
}

// ── 14. Get Document Symbols ───────────────────────────────────────────────

interface GetSymbolsInput { path: string; }

export class GetSymbolsTool implements vscode.LanguageModelTool<GetSymbolsInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetSymbolsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const uri = resolveUri(options.input.path);
        try {
            const rawSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                "vscode.executeDocumentSymbolProvider", uri
            );
            if (!rawSymbols || rawSymbols.length === 0) {
                return ok(`No symbols found in "${options.input.path}". The file may not be recognized by a language server.`);
            }
            const flatten = (symbols: vscode.DocumentSymbol[], indent = ""): string[] => {
                const lines: string[] = [];
                for (const s of symbols) {
                    const kind = vscode.SymbolKind[s.kind];
                    lines.push(`${indent}[${kind}] ${s.name} (line ${s.range.start.line + 1})`);
                    if (s.children?.length) { lines.push(...flatten(s.children, indent + "  ")); }
                }
                return lines;
            };
            return ok(`Symbols in "${options.input.path}":\n${flatten(rawSymbols).join("\n")}`);
        } catch (e) {
            return ok(`ERROR getting symbols: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

// ── 15. Open File in Editor ────────────────────────────────────────────────

interface OpenFileInput { path: string; line?: number; }

export class OpenFileTool implements vscode.LanguageModelTool<OpenFileInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<OpenFileInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { path: filePath, line } = options.input;
        const uri = resolveUri(filePath);
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, { preview: false });
            if (line !== undefined && line > 0) {
                const pos = new vscode.Position(Math.max(0, line - 1), 0);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            }
            return ok(`SUCCESS: opened "${filePath}"${line ? ` at line ${line}` : ""}.`);
        } catch (e) {
            return ok(`ERROR opening "${filePath}": ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

// ── 16. Show Diff ──────────────────────────────────────────────────────────

interface ShowDiffInput {
    leftLabel: string; leftContent: string;
    rightLabel: string; rightContent: string;
    language?: string;
}

export class ShowDiffTool implements vscode.LanguageModelTool<ShowDiffInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ShowDiffInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { leftLabel, leftContent, rightLabel, rightContent, language = "plaintext" } = options.input;
        try {
            const leftDoc = await vscode.workspace.openTextDocument({ content: leftContent, language });
            const rightDoc = await vscode.workspace.openTextDocument({ content: rightContent, language });
            await vscode.commands.executeCommand(
                "vscode.diff",
                leftDoc.uri,
                rightDoc.uri,
                `${leftLabel} ↔ ${rightLabel}`,
                { preview: true }
            );
            return ok(`SUCCESS: diff opened — "${leftLabel}" vs "${rightLabel}".`);
        } catch (e) {
            return ok(`ERROR showing diff: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

// ── 17. Get Git Status ────────────────────────────────────────────────────

interface GetGitStatusInput { showDiff?: boolean; }

export class GetGitStatusTool implements vscode.LanguageModelTool<GetGitStatusInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetGitStatusInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const cwd = getWorkspaceRoot();
        try {
            const { stdout: status } = await exec("git status --short", { cwd });
            let out = `Git status:\n${status.trim() || "(clean — no changes)"}\n`;
            if (options.input.showDiff) {
                const { stdout: diff } = await exec("git diff --stat HEAD", { cwd });
                out += `\nDiff stat:\n${diff.trim() || "(no diff)"}\n`;
            }
            return ok(out);
        } catch (e) {
            return ok(`ERROR running git: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

// ── 18. Get Extension Settings ────────────────────────────────────────────

interface GetExtensionSettingsInput { section: string; }

export class GetExtensionSettingsTool implements vscode.LanguageModelTool<GetExtensionSettingsInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetExtensionSettingsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        try {
            const config = vscode.workspace.getConfiguration(options.input.section);
            // Serialize all keys in the section
            const raw = config as unknown as { _keys?: string[] };
            const keys = Object.keys(config).filter(k => typeof (config as Record<string, unknown>)[k] !== "function");
            const entries: Record<string, unknown> = {};
            for (const key of keys) {
                entries[key] = config.get(key);
            }
            return ok(`Settings for "${options.input.section}":\n${JSON.stringify(entries, null, 2)}`);
        } catch (e) {
            return ok(`ERROR reading settings: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

// ── 19. List Open Editors ─────────────────────────────────────────────────

interface ListOpenEditorsInput { }

export class ListOpenEditorsTool implements vscode.LanguageModelTool<ListOpenEditorsInput> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<ListOpenEditorsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const tabs: string[] = [];
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const input = tab.input;
                if (input instanceof vscode.TabInputText) {
                    const active = tab.isActive ? " [ACTIVE]" : "";
                    tabs.push(`${input.uri.fsPath}${active}`);
                } else if (input instanceof vscode.TabInputTextDiff) {
                    tabs.push(`DIFF: ${input.original.fsPath} ↔ ${input.modified.fsPath}`);
                }
            }
        }
        if (tabs.length === 0) { return ok("No open editors."); }
        return ok(`Open editors (${tabs.length}):\n${tabs.join("\n")}`);
    }
}

// ── 20. Get Selected Text ─────────────────────────────────────────────────

interface GetSelectedTextInput { }

export class GetSelectedTextTool implements vscode.LanguageModelTool<GetSelectedTextInput> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<GetSelectedTextInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return ok("No active editor."); }
        const selection = editor.selection;
        if (selection.isEmpty) { return ok("No text selected in the active editor."); }
        const text = editor.document.getText(selection);
        const file = editor.document.uri.fsPath;
        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;
        return ok(`Selected text in "${file}" (lines ${startLine}–${endLine}):\n\`\`\`\n${text}\n\`\`\``);
    }
}

// ── 21. Insert Snippet ────────────────────────────────────────────────────

interface InsertSnippetInput { text: string; }

export class InsertSnippetTool implements vscode.LanguageModelTool<InsertSnippetInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<InsertSnippetInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return ok("ERROR: No active editor to insert into."); }
        try {
            await editor.insertSnippet(new vscode.SnippetString(options.input.text));
            const file = editor.document.uri.fsPath;
            return ok(`SUCCESS: inserted snippet at cursor in "${file}".`);
        } catch (e) {
            return ok(`ERROR inserting snippet: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

// ── 22. Run Tests ─────────────────────────────────────────────────────────

interface RunTestsInput { command?: string; timeoutMs?: number; }

export class RunTestsTool implements vscode.LanguageModelTool<RunTestsInput> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<RunTestsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        const cmd = options.input.command ?? "npm test";
        return {
            invocationMessage: `Running tests: \`${cmd}\``,
            confirmationMessages: {
                title: "Run tests?",
                message: new vscode.MarkdownString(`Run \`${cmd}\``)
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<RunTestsInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const cmd = options.input.command ?? "npm test";
        const timeout = options.input.timeoutMs ?? 60_000;
        const cwd = getWorkspaceRoot();
        try {
            const { stdout, stderr } = await exec(cmd, { cwd, timeout });
            const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
            return ok(`Test output:\n${out}`);
        } catch (e: unknown) {
            const err = e as { stdout?: string; stderr?: string; message?: string };
            const out = [err.stdout?.trim(), err.stderr?.trim(), err.message].filter(Boolean).join("\n");
            return ok(`Tests failed:\n${out}`);
        }
    }
}

// ── 23. Get Terminal Output ───────────────────────────────────────────────

interface GetTerminalOutputInput { command: string; timeoutMs?: number; }

export class GetTerminalOutputTool implements vscode.LanguageModelTool<GetTerminalOutputInput> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<GetTerminalOutputInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Running: \`${options.input.command}\``,
            confirmationMessages: {
                title: "Run command?",
                message: new vscode.MarkdownString(`\`${options.input.command}\``)
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetTerminalOutputInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const cwd = getWorkspaceRoot();
        const timeout = options.input.timeoutMs ?? 30_000;
        try {
            const { stdout, stderr } = await exec(options.input.command, { cwd, timeout });
            const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
            return ok(`Command: \`${options.input.command}\`\nOutput:\n${out || "(no output)"}`);
        } catch (e: unknown) {
            const err = e as { stdout?: string; stderr?: string; message?: string };
            const out = [err.stdout?.trim(), err.stderr?.trim(), err.message].filter(Boolean).join("\n");
            return ok(`Command failed:\n${out}`);
        }
    }
}

// ── 24. Fetch URL ─────────────────────────────────────────────────────────

interface FetchUrlInput { url: string; maxBytes?: number; }

export class FetchUrlTool implements vscode.LanguageModelTool<FetchUrlInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<FetchUrlInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { url, maxBytes = 50_000 } = options.input;
        const lib = url.startsWith("https") ? https : http;
        return new Promise(resolve => {
            const req = lib.get(url, { headers: { "User-Agent": "vscode-agent-router/1.3" } }, res => {
                const chunks: Buffer[] = [];
                let size = 0;
                res.on("data", (chunk: Buffer) => {
                    chunks.push(chunk);
                    size += chunk.length;
                    if (size >= maxBytes) { req.destroy(); }
                });
                res.on("end", () => {
                    const body = Buffer.concat(chunks).toString("utf8").slice(0, maxBytes);
                    const truncated = size >= maxBytes ? "\n\n_[truncated at ${maxBytes} bytes]_" : "";
                    resolve(ok(`${url} (HTTP ${res.statusCode}):\n${body}${truncated}`));
                });
                res.on("error", e => resolve(ok(`ERROR reading response: ${e.message}`)));
            });
            req.on("error", e => resolve(ok(`ERROR fetching "${url}": ${e.message}`)));
            req.setTimeout(10_000, () => { req.destroy(); resolve(ok(`TIMEOUT fetching "${url}"`)); });
            token.onCancellationRequested(() => req.destroy());
        });
    }
}

// ── 25. Get Workspace Info ─────────────────────────────────────────────────

interface GetWorkspaceInfoInput { }

export class GetWorkspaceInfoTool implements vscode.LanguageModelTool<GetWorkspaceInfoInput> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<GetWorkspaceInfoInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const folders = vscode.workspace.workspaceFolders;
        const editor = vscode.window.activeTextEditor;
        const lines: string[] = [];

        lines.push(`Workspace name: ${vscode.workspace.name ?? "(none)"}`);
        lines.push(`Workspace root: ${folders?.[0]?.uri.fsPath ?? "(no folder open)"}`);
        if (folders && folders.length > 1) {
            lines.push(`Additional folders: ${folders.slice(1).map(f => f.uri.fsPath).join(", ")}`);
        }

        if (editor) {
            lines.push(`Active file: ${editor.document.uri.fsPath}`);
            lines.push(`Language ID: ${editor.document.languageId}`);
            lines.push(`Line count: ${editor.document.lineCount}`);
            lines.push(`Cursor: line ${editor.selection.active.line + 1}, col ${editor.selection.active.character + 1}`);
            lines.push(`Unsaved changes: ${editor.document.isDirty}`);
        } else {
            lines.push("Active file: (no editor open)");
        }

        return ok(lines.join("\n"));
    }
}

// ── 26. Get Extension List ─────────────────────────────────────────────────

interface GetExtensionListInput { filter?: string; }

export class GetExtensionListTool implements vscode.LanguageModelTool<GetExtensionListInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetExtensionListInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const filter = options.input.filter?.toLowerCase();
        const exts = vscode.extensions.all
            .filter(e => !e.id.startsWith("vscode."))           // skip built-ins
            .filter(e => !filter || e.id.toLowerCase().includes(filter) ||
                (e.packageJSON?.displayName as string ?? "").toLowerCase().includes(filter))
            .map(e => {
                const name = (e.packageJSON?.displayName as string | undefined) ?? e.id;
                const version = (e.packageJSON?.version as string | undefined) ?? "?";
                const active = e.isActive ? " [active]" : "";
                return `${e.id} v${version} — ${name}${active}`;
            });
        if (exts.length === 0) {
            return ok(filter ? `No extensions matching "${filter}".` : "No non-built-in extensions installed.");
        }
        return ok(`Installed extensions (${exts.length}):\n${exts.join("\n")}`);
    }
}

// ── 27. Show Notification ──────────────────────────────────────────────────

interface ShowNotificationInput {
    message: string;
    level?: "info" | "warning" | "error";
}

export class ShowNotificationTool implements vscode.LanguageModelTool<ShowNotificationInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ShowNotificationInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { message, level = "info" } = options.input;
        if (level === "warning") {
            vscode.window.showWarningMessage(message);
        } else if (level === "error") {
            vscode.window.showErrorMessage(message);
        } else {
            vscode.window.showInformationMessage(message);
        }
        return ok(`Notification shown (${level}): "${message}"`);
    }
}

// ── 28. Open Terminal ──────────────────────────────────────────────────────

interface OpenTerminalInput { name?: string; command?: string; }

export class OpenTerminalTool implements vscode.LanguageModelTool<OpenTerminalInput> {
    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<OpenTerminalInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.PreparedToolInvocation> {
        return {
            invocationMessage: `Opening terminal "${options.input.name ?? 'Agent Terminal'}"`,
            confirmationMessages: {
                title: "Open terminal?",
                message: new vscode.MarkdownString(
                    options.input.command
                        ? `Open terminal and run \`${options.input.command}\``
                        : `Open terminal \`${options.input.name ?? 'Agent Terminal'}\``
                )
            }
        };
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<OpenTerminalInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { name = "Agent Terminal", command } = options.input;
        // Reuse existing terminal with same name if available
        const existing = vscode.window.terminals.find(t => t.name === name);
        const terminal = existing ?? vscode.window.createTerminal({ name, cwd: getWorkspaceRoot() });
        terminal.show(false);   // false = don't steal focus from current editor
        if (command) {
            terminal.sendText(command);
        }
        return ok(`SUCCESS: terminal "${name}" opened${command ? ` and sent: \`${command}\`` : ""}.`);
    }
}

// ── 29. Clipboard Read ─────────────────────────────────────────────────────

interface ClipboardReadInput { }

export class ClipboardReadTool implements vscode.LanguageModelTool<ClipboardReadInput> {
    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<ClipboardReadInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const text = await vscode.env.clipboard.readText();
        if (!text) { return ok("Clipboard is empty."); }
        return ok(`Clipboard contents:\n${text}`);
    }
}

// ── 30. Clipboard Write ────────────────────────────────────────────────────

interface ClipboardWriteInput { text: string; }

export class ClipboardWriteTool implements vscode.LanguageModelTool<ClipboardWriteInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ClipboardWriteInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        await vscode.env.clipboard.writeText(options.input.text);
        const preview = options.input.text.length > 80
            ? options.input.text.slice(0, 80) + "…"
            : options.input.text;
        return ok(`SUCCESS: wrote ${options.input.text.length} chars to clipboard: "${preview}"`);
    }
}

// ── 31. Grep Search ────────────────────────────────────────────────────────

interface GrepSearchInput {
    pattern: string;
    isRegex?: boolean;
    include?: string;
    maxResults?: number;
}

export class GrepSearchTool implements vscode.LanguageModelTool<GrepSearchInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GrepSearchInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { pattern, isRegex, include, maxResults } = options.input;
        // Use ripgrep (rg) or grep via shell for fast text search
        const root = getWorkspaceRoot();
        const rgArgs = [
            isRegex ? "-e" : "-F",
            pattern,
            "--no-heading",
            "--line-number",
            "--color", "never",
            "-i",
            "-m", String(maxResults || MAX_SEARCH_RESULTS),
        ];
        if (include) {
            rgArgs.push("-g", include);
        }
        rgArgs.push(".");

        try {
            const { stdout } = await exec(
                `rg ${rgArgs.map(a => `"${a.replace(/"/g, '\\"')}"`).join(" ")}`,
                { cwd: root, maxBuffer: 1024 * 1024 }
            );
            const lines = stdout.trim().split("\n").filter(l => l.trim());
            if (lines.length === 0) { return ok("No matches found."); }
            const limit = maxResults || MAX_SEARCH_RESULTS;
            const truncated = lines.length > limit ? lines.slice(0, limit) : lines;
            return ok(`Found ${lines.length} match(es):\n${truncated.join("\n")}`);
        } catch (e: any) {
            // rg exits 1 for no matches
            if (e.code === 1) { return ok("No matches found."); }
            // Fallback to grep
            try {
                const grepArgs = isRegex ? `-rniE "${pattern}"` : `-rniF "${pattern}"`;
                const includeArg = include ? `--include="${include}"` : "";
                const { stdout } = await exec(
                    `grep ${grepArgs} ${includeArg} . | head -${maxResults || MAX_SEARCH_RESULTS}`,
                    { cwd: root, maxBuffer: 1024 * 1024 }
                );
                return ok(stdout.trim() || "No matches found.");
            } catch {
                return ok("No matches found.");
            }
        }
    }
}

// ── 32. Send to Terminal ───────────────────────────────────────────────────

interface SendToTerminalInput {
    text: string;
    terminalName?: string;
}

export class SendToTerminalTool implements vscode.LanguageModelTool<SendToTerminalInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SendToTerminalInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { text, terminalName } = options.input;
        let terminal: vscode.Terminal | undefined;

        if (terminalName) {
            terminal = vscode.window.terminals.find(t =>
                t.name.toLowerCase().includes(terminalName.toLowerCase())
            );
        }
        if (!terminal) {
            terminal = vscode.window.activeTerminal;
        }
        if (!terminal) {
            if (vscode.window.terminals.length > 0) {
                terminal = vscode.window.terminals[0];
            } else {
                terminal = vscode.window.createTerminal("Agent Router");
            }
        }

        terminal.show(true);
        terminal.sendText(text);
        return ok(`Sent to terminal "${terminal.name}": ${text.length > 100 ? text.slice(0, 100) + "…" : text}`);
    }
}

// ── 33. Kill Terminal ──────────────────────────────────────────────────────

interface KillTerminalInput {
    terminalName?: string;
}

export class KillTerminalTool implements vscode.LanguageModelTool<KillTerminalInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<KillTerminalInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { terminalName } = options.input;
        let terminal: vscode.Terminal | undefined;

        if (terminalName) {
            terminal = vscode.window.terminals.find(t =>
                t.name.toLowerCase().includes(terminalName.toLowerCase())
            );
        } else {
            terminal = vscode.window.activeTerminal;
        }

        if (!terminal) {
            return ok("No matching terminal found to kill.");
        }

        const name = terminal.name;
        terminal.dispose();
        return ok(`Killed terminal: "${name}"`);
    }
}

// ── 34. List Code Usages ───────────────────────────────────────────────────

interface ListCodeUsagesInput {
    path: string;
    line: number;
    character: number;
}

export class ListCodeUsagesTool implements vscode.LanguageModelTool<ListCodeUsagesInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ListCodeUsagesInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const uri = resolveUri(options.input.path);
        const position = new vscode.Position(
            Math.max(0, options.input.line - 1),
            Math.max(0, options.input.character - 1)
        );

        const locations = await vscode.commands.executeCommand<vscode.Location[]>(
            "vscode.executeReferenceProvider",
            uri,
            position
        );

        if (!locations || locations.length === 0) {
            return ok("No references found.");
        }

        const root = getWorkspaceRoot();
        const results = locations.slice(0, 50).map(loc => {
            const rel = path.relative(root, loc.uri.fsPath);
            return `${rel}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`;
        });

        return ok(`Found ${locations.length} reference(s):\n${results.join("\n")}`);
    }
}

// ── 35. Rename Symbol ──────────────────────────────────────────────────────

interface RenameSymbolInput {
    path: string;
    line: number;
    character: number;
    newName: string;
}

export class RenameSymbolTool implements vscode.LanguageModelTool<RenameSymbolInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<RenameSymbolInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const uri = resolveUri(options.input.path);
        const position = new vscode.Position(
            Math.max(0, options.input.line - 1),
            Math.max(0, options.input.character - 1)
        );

        const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
            "vscode.executeDocumentRenameProvider",
            uri,
            position,
            options.input.newName
        );

        if (!edit) {
            return ok("Rename failed: no rename provider available for this symbol.");
        }

        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            return ok("Rename failed: could not apply workspace edit.");
        }

        const entries = edit.entries();
        let fileCount = 0;
        let changeCount = 0;
        for (const [, edits] of entries) {
            fileCount++;
            changeCount += edits.length;
        }

        return ok(`SUCCESS: Renamed to "${options.input.newName}" — ${changeCount} change(s) across ${fileCount} file(s).`);
    }
}

// ── 36. Run VS Code Command ────────────────────────────────────────────────

interface RunVSCodeCommandInput {
    command: string;
    args?: any[];
}

export class RunVSCodeCommandTool implements vscode.LanguageModelTool<RunVSCodeCommandInput> {
    // Block dangerous commands that could be destructive or leak secrets
    private static readonly BLOCKED_PREFIXES = [
        "workbench.action.quit",
        "workbench.action.closeWindow",
        "workbench.action.reloadWindow",
    ];

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<RunVSCodeCommandInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { command, args } = options.input;

        for (const blocked of RunVSCodeCommandTool.BLOCKED_PREFIXES) {
            if (command.startsWith(blocked)) {
                return ok(`BLOCKED: "${command}" is not allowed for safety.`);
            }
        }

        try {
            const result = await vscode.commands.executeCommand(command, ...(args || []));
            if (result === undefined || result === null) {
                return ok(`Executed: ${command}`);
            }
            const str = typeof result === "string" ? result : JSON.stringify(result, null, 2);
            return ok(`Executed: ${command}\nResult:\n${str.slice(0, MAX_READ_CHARS)}`);
        } catch (e: any) {
            return ok(`Failed to execute "${command}": ${e.message || e}`);
        }
    }
}

// ── 37. View Image ─────────────────────────────────────────────────────────

interface ViewImageInput {
    path: string;
}

export class ViewImageTool implements vscode.LanguageModelTool<ViewImageInput> {
    private static readonly IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"];

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ViewImageInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const uri = resolveUri(options.input.path);
        const ext = path.extname(uri.fsPath).toLowerCase();

        if (!ViewImageTool.IMAGE_EXTENSIONS.includes(ext)) {
            return ok(`Not a supported image format: ${ext}. Supported: ${ViewImageTool.IMAGE_EXTENSIONS.join(", ")}`);
        }

        try {
            const stat = await vscode.workspace.fs.stat(uri);
            const sizeKB = (stat.size / 1024).toFixed(1);

            // Open the image in VS Code's built-in viewer
            await vscode.commands.executeCommand("vscode.open", uri);

            return ok(`Opened image: ${path.basename(uri.fsPath)} (${sizeKB} KB, ${ext}). The image is now displayed in the editor.`);
        } catch (e: any) {
            return ok(`Failed to open image "${options.input.path}": ${e.message || e}`);
        }
    }
}

// ── 38. Ask User ───────────────────────────────────────────────────────────

interface AskUserQuestion {
    question: string;
    options?: string[];
}
interface AskUserInput {
    questions: AskUserQuestion[];
}

export class AskUserTool implements vscode.LanguageModelTool<AskUserInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<AskUserInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const answers: string[] = [];

        for (const q of options.input.questions) {
            let answer: string | undefined;

            if (q.options && q.options.length > 0) {
                // Multiple choice via QuickPick
                answer = await vscode.window.showQuickPick(q.options, {
                    placeHolder: q.question,
                    title: q.question,
                    ignoreFocusOut: true,
                });
            } else {
                // Free text via InputBox
                answer = await vscode.window.showInputBox({
                    prompt: q.question,
                    title: q.question,
                    ignoreFocusOut: true,
                });
            }

            if (answer === undefined) {
                answers.push(`Q: ${q.question}\nA: [user cancelled]`);
            } else {
                answers.push(`Q: ${q.question}\nA: ${answer}`);
            }
        }

        return ok(`User responses:\n${answers.join("\n\n")}`);
    }
}

// ── 39. Memory ─────────────────────────────────────────────────────────────

interface MemoryInput {
    action: "read" | "write" | "list" | "delete";
    scope?: "global" | "workspace";
    key?: string;
    content?: string;
}

export class MemoryTool implements vscode.LanguageModelTool<MemoryInput> {
    constructor(private readonly context: vscode.ExtensionContext) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<MemoryInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { action, scope, key, content } = options.input;
        const storeKey = scope === "workspace" ? "agentRouter.memory.workspace" : "agentRouter.memory.global";
        const store = scope === "workspace" ? this.context.workspaceState : this.context.globalState;

        const memory: Record<string, string> = store.get(storeKey, {});

        switch (action) {
            case "list": {
                const keys = Object.keys(memory);
                if (keys.length === 0) {
                    return ok(`No ${scope || "global"} memory notes found.`);
                }
                const list = keys.map(k => {
                    const preview = memory[k].length > 80 ? memory[k].slice(0, 80) + "…" : memory[k];
                    return `- **${k}**: ${preview}`;
                });
                return ok(`${scope || "global"} memory (${keys.length} notes):\n${list.join("\n")}`);
            }
            case "read": {
                if (!key) { return ok("ERROR: 'key' is required for read."); }
                const val = memory[key];
                if (val === undefined) {
                    return ok(`No memory found for key "${key}".`);
                }
                return ok(`Memory [${key}]:\n${val}`);
            }
            case "write": {
                if (!key) { return ok("ERROR: 'key' is required for write."); }
                if (content === undefined) { return ok("ERROR: 'content' is required for write."); }
                memory[key] = content;
                await store.update(storeKey, memory);
                return ok(`SUCCESS: Saved to ${scope || "global"} memory [${key}] (${content.length} chars).`);
            }
            case "delete": {
                if (!key) { return ok("ERROR: 'key' is required for delete."); }
                if (memory[key] === undefined) {
                    return ok(`Key "${key}" not found in ${scope || "global"} memory.`);
                }
                delete memory[key];
                await store.update(storeKey, memory);
                return ok(`SUCCESS: Deleted [${key}] from ${scope || "global"} memory.`);
            }
            default:
                return ok(`Unknown action: "${action}". Use: read, write, list, delete.`);
        }
    }
}

// ── 40. Todo List ──────────────────────────────────────────────────────────

interface TodoItem {
    id: number;
    title: string;
    status: "not-started" | "in-progress" | "completed";
}
interface TodoListInput {
    action: "get" | "set" | "update" | "clear";
    items?: TodoItem[];
    id?: number;
    status?: "not-started" | "in-progress" | "completed";
}

export class TodoListTool implements vscode.LanguageModelTool<TodoListInput> {
    constructor(private readonly context: vscode.ExtensionContext) { }

    private get store() { return this.context.workspaceState; }
    private static readonly KEY = "agentRouter.todoList";

    private getItems(): TodoItem[] {
        return this.store.get(TodoListTool.KEY, []);
    }
    private async setItems(items: TodoItem[]) {
        await this.store.update(TodoListTool.KEY, items);
    }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<TodoListInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { action, items, id, status } = options.input;

        switch (action) {
            case "get": {
                const current = this.getItems();
                if (current.length === 0) {
                    return ok("Todo list is empty.");
                }
                const icons: Record<string, string> = { "not-started": "⬜", "in-progress": "🔄", "completed": "✅" };
                const lines = current.map(t => `${icons[t.status] || "⬜"} ${t.id}. ${t.title} [${t.status}]`);
                return ok(`Todo list (${current.length} items):\n${lines.join("\n")}`);
            }
            case "set": {
                if (!items || !Array.isArray(items)) {
                    return ok("ERROR: 'items' array is required for 'set'.");
                }
                await this.setItems(items);
                return ok(`SUCCESS: Set ${items.length} todo item(s).`);
            }
            case "update": {
                if (id === undefined || !status) {
                    return ok("ERROR: 'id' and 'status' are required for 'update'.");
                }
                const current = this.getItems();
                const item = current.find(t => t.id === id);
                if (!item) {
                    return ok(`ERROR: No todo with id=${id}.`);
                }
                item.status = status;
                await this.setItems(current);
                return ok(`SUCCESS: Updated todo #${id} "${item.title}" → ${status}`);
            }
            case "clear": {
                await this.setItems([]);
                return ok("SUCCESS: Cleared all todos.");
            }
            default:
                return ok(`Unknown action: "${action}". Use: get, set, update, clear.`);
        }
    }
}

// ── 41. Run Sub-Agent ──────────────────────────────────────────────────────

interface RunSubAgentInput {
    task: string;
    systemPrompt?: string;
}

export class RunSubAgentTool implements vscode.LanguageModelTool<RunSubAgentInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<RunSubAgentInput>,
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { task, systemPrompt } = options.input;

        // Pick the first available model
        const models = await vscode.lm.selectChatModels({ family: "gpt-4o" });
        let model = models[0];
        if (!model) {
            const allModels = await vscode.lm.selectChatModels({});
            model = allModels[0];
        }
        if (!model) {
            return ok("ERROR: No language model available for sub-agent.");
        }

        const system = systemPrompt || "You are a helpful sub-agent. Complete the given task and return the result concisely.";
        const messages = [
            vscode.LanguageModelChatMessage.User(system),
            vscode.LanguageModelChatMessage.User(task),
        ];

        try {
            const response = await model.sendRequest(messages, {}, token);
            let result = "";
            for await (const chunk of response.stream) {
                if (chunk instanceof vscode.LanguageModelTextPart) {
                    result += chunk.value;
                }
            }
            if (!result.trim()) {
                return ok("Sub-agent returned empty response.");
            }
            return ok(`Sub-agent result:\n${result.slice(0, MAX_READ_CHARS)}`);
        } catch (e: any) {
            return ok(`Sub-agent error: ${e.message || e}`);
        }
    }
}

// ── 42. Terminal Last Command ──────────────────────────────────────────────

// Track terminal executions via events
interface TrackedExecution {
    terminal: string;
    commandLine: string;
    exitCode?: number;
    timestamp: number;
}

const terminalHistory: TrackedExecution[] = [];
const MAX_TERMINAL_HISTORY = 50;

export function registerTerminalTracking(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.window.onDidEndTerminalShellExecution(event => {
            const entry: TrackedExecution = {
                terminal: event.terminal.name,
                commandLine: event.shellIntegration.cwd?.fsPath ?? "",
                exitCode: event.exitCode,
                timestamp: Date.now(),
            };
            // Try to get command line from the execution
            if (event.execution.commandLine?.value) {
                entry.commandLine = event.execution.commandLine.value;
            }
            terminalHistory.push(entry);
            if (terminalHistory.length > MAX_TERMINAL_HISTORY) {
                terminalHistory.shift();
            }
        })
    );
}

interface TerminalLastCommandInput {
    terminalName?: string;
    count?: number;
}

export class TerminalLastCommandTool implements vscode.LanguageModelTool<TerminalLastCommandInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<TerminalLastCommandInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { terminalName, count } = options.input;
        const n = Math.min(count || 1, 20);

        let filtered = terminalHistory;
        if (terminalName) {
            filtered = terminalHistory.filter(e =>
                e.terminal.toLowerCase().includes(terminalName.toLowerCase())
            );
        }

        if (filtered.length === 0) {
            return ok("No terminal command history recorded. Shell integration must be enabled and commands must have been executed in this session.");
        }

        const recent = filtered.slice(-n).reverse();
        const lines = recent.map(e => {
            const time = new Date(e.timestamp).toLocaleTimeString();
            const exit = e.exitCode !== undefined ? ` (exit: ${e.exitCode})` : "";
            return `[${time}] [${e.terminal}] ${e.commandLine}${exit}`;
        });

        return ok(`Last ${recent.length} command(s):\n${lines.join("\n")}`);
    }
}

// ── 43. Create Jupyter Notebook ────────────────────────────────────────────

interface CreateNotebookInput {
    path: string;
    cells?: Array<{
        language: string;
        content: string;
    }>;
}

export class CreateNotebookTool implements vscode.LanguageModelTool<CreateNotebookInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<CreateNotebookInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { path: filePath, cells } = options.input;
        const uri = resolveUri(filePath);

        // Build notebook JSON structure
        const nbCells = (cells || [{ language: "python", content: "" }]).map(c => ({
            cell_type: c.language === "markdown" ? "markdown" : "code",
            execution_count: null,
            metadata: {},
            outputs: [],
            source: c.content.split("\n").map((line, i, arr) =>
                i < arr.length - 1 ? line + "\n" : line
            ),
        }));

        const notebook = {
            cells: nbCells,
            metadata: {
                kernelspec: {
                    display_name: "Python 3",
                    language: "python",
                    name: "python3"
                },
                language_info: {
                    name: "python",
                    version: "3.10.0"
                }
            },
            nbformat: 4,
            nbformat_minor: 5
        };

        try {
            const dirUri = vscode.Uri.file(path.dirname(uri.fsPath));
            await vscode.workspace.fs.createDirectory(dirUri);
            const content = JSON.stringify(notebook, null, 1);
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));

            // Open the notebook
            const doc = await vscode.workspace.openNotebookDocument(uri);
            await vscode.window.showNotebookDocument(doc);

            return ok(`SUCCESS: Created notebook "${filePath}" with ${nbCells.length} cell(s).`);
        } catch (e: any) {
            return ok(`ERROR creating notebook: ${e.message || e}`);
        }
    }
}

// ── 44. Run Notebook Cell ──────────────────────────────────────────────────

interface RunNotebookCellInput {
    path?: string;
    cellIndex: number;
}

export class RunNotebookCellTool implements vscode.LanguageModelTool<RunNotebookCellInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<RunNotebookCellInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { path: filePath, cellIndex } = options.input;

        let notebook: vscode.NotebookDocument | undefined;

        if (filePath) {
            const uri = resolveUri(filePath);
            notebook = vscode.workspace.notebookDocuments.find(
                nb => nb.uri.fsPath === uri.fsPath
            );
            if (!notebook) {
                try {
                    notebook = await vscode.workspace.openNotebookDocument(uri);
                    await vscode.window.showNotebookDocument(notebook);
                } catch (e: any) {
                    return ok(`ERROR: Could not open notebook "${filePath}": ${e.message || e}`);
                }
            }
        } else {
            // Use the active notebook
            const editor = vscode.window.activeNotebookEditor;
            notebook = editor?.notebook;
        }

        if (!notebook) {
            return ok("ERROR: No notebook found. Provide a path or open a notebook first.");
        }

        const idx = cellIndex - 1; // Convert 1-based to 0-based
        if (idx < 0 || idx >= notebook.cellCount) {
            return ok(`ERROR: Cell index ${cellIndex} out of range. Notebook has ${notebook.cellCount} cells (1-${notebook.cellCount}).`);
        }

        const cell = notebook.cellAt(idx);
        if (cell.kind !== vscode.NotebookCellKind.Code) {
            return ok(`ERROR: Cell ${cellIndex} is a markdown cell, not a code cell. Only code cells can be executed.`);
        }

        try {
            // Execute the cell via VS Code's notebook execution command
            await vscode.commands.executeCommand("notebook.cell.execute", {
                ranges: [{ start: idx, end: idx + 1 }],
                document: notebook.uri,
            });

            // Wait briefly for execution to complete
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Read output
            const outputs = cell.outputs;
            if (outputs.length === 0) {
                return ok(`Cell ${cellIndex} executed (no output yet — execution may still be running).`);
            }

            return ok(`Cell ${cellIndex} executed.\n${formatNotebookOutputs(outputs)}`);
        } catch (e: any) {
            return ok(`ERROR executing cell ${cellIndex}: ${e.message || e}`);
        }
    }
}

// ── 45. Read Notebook Cell Output ──────────────────────────────────────────

interface ReadNotebookCellOutputInput {
    path?: string;
    cellIndex: number;
}

export class ReadNotebookCellOutputTool implements vscode.LanguageModelTool<ReadNotebookCellOutputInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ReadNotebookCellOutputInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { path: filePath, cellIndex } = options.input;

        let notebook: vscode.NotebookDocument | undefined;

        if (filePath) {
            const uri = resolveUri(filePath);
            notebook = vscode.workspace.notebookDocuments.find(
                nb => nb.uri.fsPath === uri.fsPath
            );
        } else {
            notebook = vscode.window.activeNotebookEditor?.notebook;
        }

        if (!notebook) {
            return ok("ERROR: No notebook found. Provide a path or open a notebook first.");
        }

        const idx = cellIndex - 1;
        if (idx < 0 || idx >= notebook.cellCount) {
            return ok(`ERROR: Cell index ${cellIndex} out of range (1-${notebook.cellCount}).`);
        }

        const cell = notebook.cellAt(idx);
        const outputs = cell.outputs;

        if (outputs.length === 0) {
            return ok(`Cell ${cellIndex} has no output.`);
        }

        return ok(`Cell ${cellIndex} output:\n${formatNotebookOutputs(outputs)}`);
    }
}

// ── 46. Edit Notebook File ─────────────────────────────────────────────────

interface NotebookCellEdit {
    action: "insert" | "replace" | "delete";
    cellIndex: number;
    language?: string;
    content?: string;
}
interface EditNotebookInput {
    path?: string;
    edits: NotebookCellEdit[];
}

export class EditNotebookTool implements vscode.LanguageModelTool<EditNotebookInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<EditNotebookInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { path: filePath, edits } = options.input;

        let notebook: vscode.NotebookDocument | undefined;

        if (filePath) {
            const uri = resolveUri(filePath);
            notebook = vscode.workspace.notebookDocuments.find(
                nb => nb.uri.fsPath === uri.fsPath
            );
            if (!notebook) {
                try {
                    notebook = await vscode.workspace.openNotebookDocument(uri);
                    await vscode.window.showNotebookDocument(notebook);
                } catch (e: any) {
                    return ok(`ERROR: Could not open notebook "${filePath}": ${e.message || e}`);
                }
            }
        } else {
            notebook = vscode.window.activeNotebookEditor?.notebook;
        }

        if (!notebook) {
            return ok("ERROR: No notebook found. Provide a path or open a notebook first.");
        }

        const we = new vscode.WorkspaceEdit();
        const results: string[] = [];

        // Process edits in reverse order so indices stay consistent
        const sorted = [...edits].sort((a, b) => b.cellIndex - a.cellIndex);

        for (const edit of sorted) {
            const idx = edit.cellIndex - 1; // 1-based to 0-based

            switch (edit.action) {
                case "insert": {
                    const lang = edit.language || "python";
                    const kind = lang === "markdown"
                        ? vscode.NotebookCellKind.Markup
                        : vscode.NotebookCellKind.Code;
                    const cellData = new vscode.NotebookCellData(kind, edit.content || "", lang);
                    const nbEdit = vscode.NotebookEdit.insertCells(idx, [cellData]);
                    we.set(notebook.uri, [nbEdit]);
                    results.push(`Inserted ${lang} cell at position ${edit.cellIndex}`);
                    break;
                }
                case "replace": {
                    if (idx < 0 || idx >= notebook.cellCount) {
                        results.push(`Cell ${edit.cellIndex} out of range — skipped`);
                        break;
                    }
                    const existingCell = notebook.cellAt(idx);
                    const lang = edit.language || (existingCell.kind === vscode.NotebookCellKind.Markup ? "markdown" : "python");
                    const kind = lang === "markdown"
                        ? vscode.NotebookCellKind.Markup
                        : vscode.NotebookCellKind.Code;
                    const cellData = new vscode.NotebookCellData(kind, edit.content || "", lang);
                    const nbEdit = vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(idx, idx + 1), [cellData]);
                    we.set(notebook.uri, [nbEdit]);
                    results.push(`Replaced cell ${edit.cellIndex} with ${lang} cell`);
                    break;
                }
                case "delete": {
                    if (idx < 0 || idx >= notebook.cellCount) {
                        results.push(`Cell ${edit.cellIndex} out of range — skipped`);
                        break;
                    }
                    const nbEdit = vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(idx, idx + 1));
                    we.set(notebook.uri, [nbEdit]);
                    results.push(`Deleted cell ${edit.cellIndex}`);
                    break;
                }
                default:
                    results.push(`Unknown action "${edit.action}" for cell ${edit.cellIndex}`);
            }
        }

        const applied = await vscode.workspace.applyEdit(we);
        return ok(applied
            ? `SUCCESS: Applied ${edits.length} notebook edit(s):\n${results.join("\n")}`
            : `ERROR: Failed to apply notebook edits.`);
    }
}

// ── 47. Get Notebook Summary ───────────────────────────────────────────────

interface GetNotebookSummaryInput {
    path?: string;
}

export class GetNotebookSummaryTool implements vscode.LanguageModelTool<GetNotebookSummaryInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetNotebookSummaryInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const { path: filePath } = options.input;

        let notebook: vscode.NotebookDocument | undefined;

        if (filePath) {
            const uri = resolveUri(filePath);
            notebook = vscode.workspace.notebookDocuments.find(
                nb => nb.uri.fsPath === uri.fsPath
            );
            if (!notebook) {
                try {
                    notebook = await vscode.workspace.openNotebookDocument(uri);
                } catch (e: any) {
                    return ok(`ERROR: Could not open notebook "${filePath}": ${e.message || e}`);
                }
            }
        } else {
            notebook = vscode.window.activeNotebookEditor?.notebook;
        }

        if (!notebook) {
            return ok("ERROR: No notebook found. Provide a path or open a notebook first.");
        }

        const lines: string[] = [
            `Notebook: ${path.basename(notebook.uri.fsPath)}`,
            `Path: ${notebook.uri.fsPath}`,
            `Cells: ${notebook.cellCount}`,
            `Type: ${notebook.notebookType}`,
            "",
            "| # | Type | Language | Lines | Has Output |",
            "|---|------|----------|-------|------------|",
        ];

        for (let i = 0; i < notebook.cellCount; i++) {
            const cell = notebook.cellAt(i);
            const kind = cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown";
            const lang = cell.document.languageId;
            const lineCount = cell.document.lineCount;
            const hasOutput = cell.outputs.length > 0 ? "✅" : "—";
            lines.push(`| ${i + 1} | ${kind} | ${lang} | ${lineCount} | ${hasOutput} |`);
        }

        return ok(lines.join("\n"));
    }
}

// ── Notebook output formatter ──────────────────────────────────────────────

function formatNotebookOutputs(outputs: readonly vscode.NotebookCellOutput[]): string {
    const parts: string[] = [];
    for (const output of outputs) {
        for (const item of output.items) {
            const mime = item.mime;
            if (mime === "text/plain" || mime === "application/vnd.code.notebook.stdout") {
                parts.push(new TextDecoder().decode(item.data));
            } else if (mime === "application/vnd.code.notebook.stderr") {
                parts.push(`[stderr] ${new TextDecoder().decode(item.data)}`);
            } else if (mime === "application/vnd.code.notebook.error") {
                try {
                    const err = JSON.parse(new TextDecoder().decode(item.data));
                    parts.push(`[error] ${err.ename}: ${err.evalue}`);
                    if (err.traceback) { parts.push(err.traceback.join("\n")); }
                } catch {
                    parts.push(`[error] ${new TextDecoder().decode(item.data)}`);
                }
            } else if (mime === "text/html" || mime === "text/markdown") {
                parts.push(new TextDecoder().decode(item.data));
            } else if (mime.startsWith("image/")) {
                parts.push(`[${mime} image — ${item.data.length} bytes]`);
            } else {
                parts.push(`[${mime} — ${item.data.length} bytes]`);
            }
        }
    }
    return parts.join("\n").slice(0, MAX_READ_CHARS);
}
