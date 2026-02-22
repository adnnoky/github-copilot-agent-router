import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";
import * as https from "https";
import * as http from "http";
import { promisify } from "util";

const exec = promisify(cp.exec);
const MAX_READ_CHARS = 100_000;
const MAX_SEARCH_RESULTS = 30;

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
            const proposedDoc = await vscode.workspace.openTextDocument({ content: newContent, language });

            let leftUri: vscode.Uri;
            try {
                await vscode.workspace.fs.stat(uri);
                leftUri = uri;
            } catch {
                const emptyDoc = await vscode.workspace.openTextDocument({ content: "", language });
                leftUri = emptyDoc.uri;
            }

            const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
            await vscode.commands.executeCommand(
                "vscode.diff",
                leftUri,
                proposedDoc.uri,
                `🔄 ${fileName}: Current ↔ Proposed`,
                { preview: true }
            );
        } catch { /* silently skip if diff fails */ }

        return {
            invocationMessage: `Writing to \`${filePath}\``,
            confirmationMessages: {
                title: `Apply changes to ${filePath}?`,
                message: new vscode.MarkdownString(
                    `🔄 **Review the diff in the editor**, then click **Allow** to write the file.`
                )
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
            await vscode.window.showTextDocument(uri, { preserveFocus: true, preview: false });
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
            const existingText = new TextDecoder().decode(bytes);
            const lines = existingText.split("\n");

            // Compute proposed result in memory
            const sorted = [...edits].sort((a, b) => b.startLine - a.startLine);
            const resultLines = [...lines];
            for (const edit of sorted) {
                const sl = Math.max(0, edit.startLine - 1);
                const el = Math.min(resultLines.length - 1, edit.endLine - 1);
                resultLines.splice(sl, el - sl + 1, ...edit.newText.split("\n"));
            }
            const proposedText = resultLines.join("\n");

            const language = detectLanguage(filePath);
            const proposedDoc = await vscode.workspace.openTextDocument({ content: proposedText, language });
            const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
            await vscode.commands.executeCommand(
                "vscode.diff",
                uri,
                proposedDoc.uri,
                `🔄 ${fileName}: Current ↔ Proposed`,
                { preview: true }
            );
        } catch { /* silently skip if diff fails */ }

        return {
            invocationMessage: `Editing \`${filePath}\` (${edits.length} edit${edits.length > 1 ? "s" : ""})`,
            confirmationMessages: {
                title: `Apply edits to ${filePath}?`,
                message: new vscode.MarkdownString(
                    `🔄 **Review the diff in the editor**, then click **Allow** to apply ${edits.length} edit(s).`
                )
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
                await vscode.window.showTextDocument(uri, { preserveFocus: true, preview: false });
            }
            return ok(success
                ? `SUCCESS: applied ${edits.length} edit(s) to "${filePath}".`
                : `ERROR: applyEdit returned false for "${filePath}".`);
        } catch (e) {
            return ok(`ERROR editing "${filePath}": ${e instanceof Error ? e.message : String(e)}`);
        }
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
        const { command, cwd } = options.input;
        return {
            invocationMessage: `Running: \`${command}\``,
            confirmationMessages: {
                title: "Run terminal command?",
                message: new vscode.MarkdownString(
                    `The agent wants to execute:\n\n` +
                    `\`\`\`\n${command}\n\`\`\`\n\n` +
                    (cwd ? `**Working directory:** \`${cwd}\`\n\n` : "") +
                    `⚠️ Terminal commands can modify your system.`
                )
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
                message: new vscode.MarkdownString(
                    `The agent wants to **delete** the file:\n\n` +
                    `\`${options.input.path}\`\n\n` +
                    `The file will be moved to the system trash.`
                )
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
        return {
            invocationMessage: `Renaming \`${options.input.oldPath}\` → \`${options.input.newPath}\``,
            confirmationMessages: {
                title: `Rename file?`,
                message: new vscode.MarkdownString(
                    `Rename **\`${options.input.oldPath}\`** to **\`${options.input.newPath}\`**?`
                )
            }
        };
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
        const summary = changes.map(c => `- \`${c.file}\`: \`${c.find}\` → \`${c.replace}\``).join("\n");
        return {
            invocationMessage: `Finding & replacing across ${changes.length} file(s)`,
            confirmationMessages: {
                title: `Apply find & replace?`,
                message: new vscode.MarkdownString(`${summary}`)
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
                title: `Run tests?`,
                message: new vscode.MarkdownString(`Run \`${cmd}\` in the workspace root?`)
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
                title: `Run command and capture output?`,
                message: new vscode.MarkdownString(
                    `Run \`${options.input.command}\` and return its stdout/stderr?`
                )
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
