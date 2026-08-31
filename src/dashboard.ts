import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

// ── Types ─────────────────────────────────────────────────────────────────

interface CopilotUsageData {
  used: number;
  entitlement: number;
  remaining: number;
  percentUsed: number;
  resetDate: string;
  unlimited: boolean;
}

interface ModelInfo {
  id: string;
  family: string;
  vendor: string;
  version: string;
  maxInputTokens: number;
}

export interface AgentSession {
  id: string;
  prompt: string;
  model: string;
  tier: "standard" | "advanced";
  score: number;
  agentMode: boolean;
  boosted: boolean;
  timestamp: number;
  status: "running" | "completed" | "error";
  estimatedTokens?: number;
  multiplier?: number;
  response?: string;
  threadId?: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  participant?: string;
  command?: string;
  content: string;
}

export interface ChatThread {
  id: string;
  title: string;
  turns: ChatTurn[];
  models: string[];
  totalTokens: number;
  totalCost: number;
  requestCount: number;
  firstTimestamp: number;
  lastTimestamp: number;
}

export interface WorkspaceCopilotConfig {
  instructions: string[];
  prompts: string[];
  agents: string[];
  skills: string[];
  hooks: string[];
}

interface DashboardPayload {
  usage: CopilotUsageData | null;
  models: ModelInfo[];
  plan: string;
  login: string;
  timestamp: string;
  sessions: AgentSession[];
  activeSessions: AgentSession[];
  config: WorkspaceCopilotConfig;
  rawApi: any;
  threads: ChatThread[];
}

// ── Session Storage ───────────────────────────────────────────────────────

const SESSION_KEY = "agentRouter.sessions";
const MAX_SESSIONS = 100;

export function getStoredSessions(context: vscode.ExtensionContext): AgentSession[] {
  return context.globalState.get<AgentSession[]>(SESSION_KEY, []);
}

export function addSession(context: vscode.ExtensionContext, session: AgentSession) {
  const sessions = getStoredSessions(context);
  sessions.unshift(session);
  if (sessions.length > MAX_SESSIONS) { sessions.length = MAX_SESSIONS; }
  context.globalState.update(SESSION_KEY, sessions);
}

export function updateSessionStatus(context: vscode.ExtensionContext, sessionId: string, status: "completed" | "error", response?: string) {
  const sessions = getStoredSessions(context);
  const s = sessions.find(s => s.id === sessionId);
  if (s) {
    s.status = status;
    if (response) {
      s.response = response.slice(0, 5000); // Cap at 5KB to keep storage reasonable
    }
    context.globalState.update(SESSION_KEY, sessions);
  }
}

// ── Thread Storage ────────────────────────────────────────────────────────

const THREAD_KEY = "agentRouter.threads";
const MAX_THREADS = 50;

export function getStoredThreads(context: vscode.ExtensionContext): ChatThread[] {
  return context.globalState.get<ChatThread[]>(THREAD_KEY, []);
}

export function upsertThread(context: vscode.ExtensionContext, thread: ChatThread) {
  const threads = getStoredThreads(context);
  const existingIdx = threads.findIndex(t => t.id === thread.id);
  if (existingIdx >= 0) {
    // Update existing thread with latest turns and stats
    threads[existingIdx] = thread;
  } else {
    threads.unshift(thread);
    if (threads.length > MAX_THREADS) { threads.length = MAX_THREADS; }
  }
  context.globalState.update(THREAD_KEY, threads);
}

/**
 * Generate a stable thread ID from chat context.
 * Uses the first user prompt as the key — same first prompt = same thread.
 */
export function computeThreadId(turns: ChatTurn[]): string {
  const firstUserTurn = turns.find(t => t.role === "user");
  if (!firstUserTurn) { return `thread-${Date.now()}`; }
  // Simple hash from first prompt content
  let hash = 0;
  const str = firstUserTurn.content.slice(0, 200);
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return `thread-${Math.abs(hash).toString(36)}`;
}

// ── VS Code Chat Transcript Reader ───────────────────────────────────────

interface TranscriptEvent {
  type: string;
  data: any;
  id: string;
  timestamp: string;
  parentId: string | null;
}

/**
 * Discovers the Copilot Chat transcript directory from extension context.
 * Transcripts live in: workspaceStorage/<id>/GitHub.copilot-chat/transcripts/
 * For remote workspaces, falls back to the Windows client-side path.
 */
export function getTranscriptDir(context: vscode.ExtensionContext): string | null {
  // Try the client-side root first (works for both local and remote)
  const root = getWorkspaceStorageRoot(context);
  if (root) {
    const transcriptDir = path.join(root, "GitHub.copilot-chat", "transcripts");
    if (fs.existsSync(transcriptDir)) { return transcriptDir; }
  }
  // Fallback: try the direct storageUri parent (original behavior)
  const storageUri = context.storageUri;
  if (!storageUri) { return null; }
  const fallbackDir = path.join(path.dirname(storageUri.fsPath), "GitHub.copilot-chat", "transcripts");
  if (fs.existsSync(fallbackDir)) { return fallbackDir; }
  return null;
}

/**
 * Like getTranscriptDir but creates the directory structure if it doesn't exist.
 */
export function getOrCreateTranscriptDir(context: vscode.ExtensionContext): string | null {
  const root = getWorkspaceStorageRoot(context);
  if (!root) { return null; }
  const transcriptDir = path.join(root, "GitHub.copilot-chat", "transcripts");
  if (!fs.existsSync(transcriptDir)) {
    fs.mkdirSync(transcriptDir, { recursive: true });
  }
  return transcriptDir;
}

// ── Native Chat Session Helpers ───────────────────────────────────────────

/**
 * Gets the workspace storage root where chatSessions/ and state.vscdb live.
 *
 * IMPORTANT: In remote workspaces (WSL, SSH, Codespaces), context.storageUri
 * points to the remote server storage, but Chat UI data (chatSessions/,
 * state.vscdb) lives on the Windows CLIENT side. We detect this by checking
 * if the storageUri is on a remote filesystem and falling back to the
 * Windows-side path using the same workspace storage ID.
 */
function getWorkspaceStorageRoot(context: vscode.ExtensionContext): string | null {
  const storageUri = context.storageUri;
  if (!storageUri) { return null; }

  const storagePath = storageUri.fsPath;

  // Check if this looks like a remote workspace (vscode-server path)
  // e.g. /home/user/.vscode-server/data/User/workspaceStorage/<id>/ext
  if (storagePath.includes(".vscode-server")) {
    // Extract workspace storage ID from the path
    const match = storagePath.match(/workspaceStorage[/\\]([a-f0-9]+)/);
    if (match) {
      const wsId = match[1];
      // Try common Windows client paths via WSL mount
      const candidates = [
        path.join("/mnt/c/Users", process.env.USER || "", "AppData/Roaming/Code/User/workspaceStorage", wsId),
      ];
      // Also try to find the actual Windows username from the mount
      try {
        const usersDir = fs.readdirSync("/mnt/c/Users").filter(d =>
          !["Public", "Default", "Default User", "All Users"].includes(d) && !d.startsWith(".")
        );
        for (const user of usersDir) {
          const candidate = path.join("/mnt/c/Users", user, "AppData/Roaming/Code/User/workspaceStorage", wsId);
          if (!candidates.includes(candidate)) { candidates.push(candidate); }
        }
      } catch { /* ignore */ }

      for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, "chatSessions")) || fs.existsSync(path.join(candidate, "state.vscdb"))) {
          return candidate;
        }
      }
    }
  }

  // Local workspace — storageUri parent is the workspace storage root
  const root = path.dirname(storagePath);
  return root;
}

/**
 * Returns the chatSessions/ directory path. This is where VS Code's
 * Chat sidebar stores actual session data (different from transcripts/).
 */
export function getChatSessionsDir(context: vscode.ExtensionContext): string | null {
  const root = getWorkspaceStorageRoot(context);
  if (!root) { return null; }
  const dir = path.join(root, "chatSessions");
  if (!fs.existsSync(dir)) { return null; }
  return dir;
}

/**
 * Like getChatSessionsDir but creates the directory if needed.
 */
export function getOrCreateChatSessionsDir(context: vscode.ExtensionContext): string | null {
  const root = getWorkspaceStorageRoot(context);
  if (!root) { return null; }
  const dir = path.join(root, "chatSessions");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Returns the path to the workspace's state.vscdb SQLite database.
 */
export function getStateDbPath(context: vscode.ExtensionContext): string | null {
  const root = getWorkspaceStorageRoot(context);
  if (!root) { return null; }
  const dbPath = path.join(root, "state.vscdb");
  if (!fs.existsSync(dbPath)) { return null; }
  return dbPath;
}

export interface ChatSessionSummary {
  sessionId: string;
  filePath: string;
  title: string;
  creationDate: number;
  requestCount: number;
  workspaceName?: string;
  workspaceId?: string;
}

/**
 * Parse a single chatSession JSONL file to extract summary metadata.
 * Reads enough lines to find customTitle, request count, and first user message.
 */
function parseChatSessionSummary(filePath: string): ChatSessionSummary | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter(l => l.trim());
    if (lines.length === 0) { return null; }

    let sessionId = path.basename(filePath, ".jsonl");
    let creationDate = 0;
    let customTitle = "";
    let firstUserMsg = "";
    let requestCount = 0;

    for (const line of lines) {
      let data: any;
      try { data = JSON.parse(line); } catch { continue; }

      const kind = data.kind;
      const k: any[] = data.k || [];
      const v = data.v;

      if (kind === 0 && v) {
        if (v.sessionId) { sessionId = v.sessionId; }
        if (v.creationDate) { creationDate = v.creationDate; }
        if (v.customTitle) { customTitle = v.customTitle; }
        if (Array.isArray(v.requests)) {
          requestCount += v.requests.length;
          if (!firstUserMsg && v.requests.length > 0) {
            firstUserMsg = (v.requests[0].message?.text || "").trim().slice(0, 80);
          }
        }
      } else if (kind === 1 && k.length === 1 && k[0] === "customTitle" && typeof v === "string") {
        customTitle = v;
      } else if (kind === 2 && k.length === 1 && k[0] === "requests" && Array.isArray(v)) {
        requestCount += v.length;
        if (!firstUserMsg && v.length > 0) {
          firstUserMsg = (v[0].message?.text || "").trim().slice(0, 80);
        }
      }
    }

    const title = customTitle || firstUserMsg || "Untitled Chat";
    if (requestCount === 0) { return null; }

    return { sessionId, filePath, title, creationDate, requestCount };
  } catch {
    return null;
  }
}

/**
 * Reads chatSessions/ directory and returns summaries of each session.
 * This reads the actual VS Code Chat session files (not transcripts).
 */
export function getChatSessionSummaries(context: vscode.ExtensionContext): ChatSessionSummary[] {
  const dir = getChatSessionsDir(context);
  if (!dir) { return []; }
  return getChatSessionSummariesFromDir(dir);
}

/**
 * Reads chatSessions from a specific directory path.
 */
function getChatSessionSummariesFromDir(dir: string): ChatSessionSummary[] {
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl") || f.endsWith(".json"));
    const summaries: ChatSessionSummary[] = [];

    for (const file of files) {
      const summary = parseChatSessionSummary(path.join(dir, file));
      if (summary) { summaries.push(summary); }
    }

    return summaries.sort((a, b) => b.creationDate - a.creationDate);
  } catch {
    return [];
  }
}

/**
 * Resolves the VS Code User data directory (platform-specific).
 */
function getVSCodeUserDir(): string {
  switch (process.platform) {
    case "win32":
      return path.join(process.env.APPDATA || "", "Code", "User");
    case "darwin":
      return path.join(process.env.HOME || "", "Library", "Application Support", "Code", "User");
    default: {
      // Linux — also handle WSL where we may need to read from Windows side
      const linuxPath = path.join(process.env.HOME || "", ".config", "Code", "User");
      if (fs.existsSync(linuxPath)) { return linuxPath; }
      // WSL fallback: try Windows path via /mnt/c
      try {
        const usersDir = fs.readdirSync("/mnt/c/Users").filter(d =>
          !["Public", "Default", "Default User", "All Users"].includes(d) && !d.startsWith(".")
        );
        for (const user of usersDir) {
          const winPath = path.join("/mnt/c/Users", user, "AppData/Roaming/Code/User");
          if (fs.existsSync(winPath)) { return winPath; }
        }
      } catch { /* not WSL */ }
      return linuxPath;
    }
  }
}

/**
 * Scans ALL VS Code workspaceStorage directories and returns chat session
 * summaries grouped by workspace. This discovers chats across all projects.
 */
export function getAllWorkspaceSessions(): ChatSessionSummary[] {
  const userDir = getVSCodeUserDir();
  const storageDir = path.join(userDir, "workspaceStorage");
  if (!fs.existsSync(storageDir)) { return []; }

  const allSummaries: ChatSessionSummary[] = [];

  try {
    const entries = fs.readdirSync(storageDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) { continue; }
      const wsId = entry.name;
      const chatDir = path.join(storageDir, wsId, "chatSessions");
      if (!fs.existsSync(chatDir)) { continue; }

      // Read workspace name from workspace.json
      let workspaceName = "Unknown Workspace";
      try {
        const wsJsonPath = path.join(storageDir, wsId, "workspace.json");
        if (fs.existsSync(wsJsonPath)) {
          const wsJson = JSON.parse(fs.readFileSync(wsJsonPath, "utf-8"));
          if (wsJson.folder) {
            workspaceName = decodeURIComponent(path.basename(wsJson.folder));
          } else if (wsJson.workspace) {
            workspaceName = decodeURIComponent(path.basename(wsJson.workspace));
          }
        }
      } catch { /* ignore */ }

      const sessions = getChatSessionSummariesFromDir(chatDir);
      for (const s of sessions) {
        s.workspaceName = workspaceName;
        s.workspaceId = wsId;
      }
      allSummaries.push(...sessions);
    }
  } catch { /* ignore */ }

  return allSummaries.sort((a, b) => b.creationDate - a.creationDate);
}

/**
 * Parse a standalone JSON file (VS Code's export format) to Markdown.
 * The JSON has: { sessionId, creationDate, requests: [{ message: { text }, response: [{ value }] }] }
 */
export function exportJsonFileToMarkdown(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const content = raw.trim();

    // Try JSON first (exported chat format)
    if (content.startsWith("{") || content.startsWith("[")) {
      try {
        const json = JSON.parse(content);
        return convertJsonSessionToMarkdown(json);
      } catch { /* fall through to JSONL */ }
    }

    // Try JSONL (chatSessions native format)
    return exportChatSessionToMarkdown(filePath);
  } catch {
    return null;
  }
}

/**
 * Convert a parsed JSON chat session object to Markdown.
 */
function convertJsonSessionToMarkdown(json: any): string | null {
  const requests = json.requests || [];
  if (requests.length === 0) { return null; }

  const mdLines: string[] = [];
  let firstUserMsg = "";

  for (const req of requests) {
    if (req.message?.text) {
      if (!firstUserMsg) { firstUserMsg = req.message.text.trim().slice(0, 60); }
      mdLines.push(`\n### 🧑 User\n`);
      mdLines.push(req.message.text);
      mdLines.push("");
    }

    if (req.response && Array.isArray(req.response)) {
      let responseText = "";
      for (const item of req.response) {
        if (item.value && typeof item.value === "string") {
          responseText += item.value;
        }
      }
      if (responseText) {
        mdLines.push(`\n### 🤖 Copilot\n`);
        mdLines.push(responseText);
        mdLines.push("");
      }
    }
  }

  if (mdLines.length === 0) { return null; }

  const title = json.customTitle || firstUserMsg || "Chat Session";
  const date = json.creationDate ? new Date(json.creationDate).toLocaleString() : "Unknown";
  const header = [
    `# ${title}\n`,
    `> Exported: ${new Date().toLocaleString()} | Source: Converted JSON File`,
    `> Session: ${date} | Turns: ${requests.length}`,
    "",
    "---",
    "",
  ];

  return header.join("\n") + mdLines.join("\n");
}

/**
 * Parse a single JSONL transcript file into a ChatThread.
 * Extracts user.message and assistant.message events.
 */
function parseTranscriptFile(filePath: string): ChatThread | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(l => l.trim());
    if (lines.length === 0) { return null; }

    let sessionId = path.basename(filePath, ".jsonl");
    let startTime = "";
    const turns: ChatTurn[] = [];

    for (const line of lines) {
      let evt: TranscriptEvent;
      try { evt = JSON.parse(line); } catch { continue; }

      if (evt.type === "session.start") {
        sessionId = evt.data?.sessionId ?? sessionId;
        startTime = evt.timestamp ?? "";
      } else if (evt.type === "user.message") {
        const content = evt.data?.content ?? "";
        if (content) {
          turns.push({ role: "user", content });
        }
      } else if (evt.type === "assistant.message") {
        const content = evt.data?.content ?? "";
        if (content) {
          turns.push({ role: "assistant", content: content.slice(0, 3000) });
        }
      }
    }

    if (turns.length === 0) { return null; }

    // Derive title from first user prompt
    const firstUser = turns.find(t => t.role === "user");
    const title = firstUser ? firstUser.content.trim().slice(0, 60) : "Chat Session";

    const firstTs = startTime ? new Date(startTime).getTime() : Date.now();
    const lastLine = lines[lines.length - 1];
    let lastTs = firstTs;
    try {
      const lastEvt = JSON.parse(lastLine);
      if (lastEvt.timestamp) { lastTs = new Date(lastEvt.timestamp).getTime(); }
    } catch { /* ignore */ }

    const userCount = turns.filter(t => t.role === "user").length;

    return {
      id: `transcript-${sessionId}`,
      title,
      turns: turns.map(t => ({ ...t, content: t.content.slice(0, 2000) })),
      models: [], // Transcript doesn't record which model was used
      totalTokens: turns.reduce((sum, t) => sum + Math.ceil(t.content.length / 4), 0),
      totalCost: userCount, // 1x per user turn (no multiplier info available)
      requestCount: userCount,
      firstTimestamp: firstTs,
      lastTimestamp: lastTs,
    };
  } catch {
    return null;
  }
}

/**
 * Reads all Copilot Chat transcripts from VS Code's workspace storage.
 * Returns ChatThread[] for all workspace conversations.
 */
export function loadAllTranscripts(context: vscode.ExtensionContext): ChatThread[] {
  const dir = getTranscriptDir(context);
  if (!dir) { return []; }

  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
    const threads: ChatThread[] = [];
    for (const file of files) {
      const thread = parseTranscriptFile(path.join(dir, file));
      if (thread) { threads.push(thread); }
    }
    return threads.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  } catch {
    return [];
  }
}

// ── Transcript Export ─────────────────────────────────────────────────────

export interface TranscriptSummary {
  sessionId: string;
  filePath: string;
  title: string;
  startTime: string;
  userMessages: number;
  assistantMessages: number;
}

/**
 * Returns a quick summary of each transcript file (for the pick list).
 */
export function getTranscriptSummaries(context: vscode.ExtensionContext): TranscriptSummary[] {
  const dir = getTranscriptDir(context);
  if (!dir) { return []; }

  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
    const summaries: TranscriptSummary[] = [];

    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const lines = raw.trim().split("\n").filter(l => l.trim());
        let sessionId = path.basename(file, ".jsonl");
        let startTime = "";
        let firstUserMsg = "";
        let userMessages = 0;
        let assistantMessages = 0;

        for (const line of lines) {
          let evt: TranscriptEvent;
          try { evt = JSON.parse(line); } catch { continue; }

          if (evt.type === "session.start") {
            sessionId = evt.data?.sessionId ?? sessionId;
            startTime = evt.timestamp ?? "";
          } else if (evt.type === "user.message") {
            userMessages++;
            if (!firstUserMsg) {
              firstUserMsg = (evt.data?.content ?? "").trim().slice(0, 80);
            }
          } else if (evt.type === "assistant.message") {
            assistantMessages++;
          }
        }

        if (userMessages === 0 && assistantMessages === 0) { continue; }

        summaries.push({
          sessionId,
          filePath,
          title: firstUserMsg || "Chat Session",
          startTime,
          userMessages,
          assistantMessages,
        });
      } catch { continue; }
    }

    return summaries.sort((a, b) => (b.startTime || "").localeCompare(a.startTime || ""));
  } catch {
    return [];
  }
}

/**
 * Reads a single transcript file and returns full Markdown export content.
 * Unlike parseTranscriptFile, this does NOT truncate content.
 */
export function exportTranscriptToMarkdown(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const jsonLines = raw.trim().split("\n").filter(l => l.trim());
    if (jsonLines.length === 0) { return null; }

    let startTime = "";
    let firstUserMsg = "";
    const mdLines: string[] = [];
    let turnIndex = 0;

    for (const line of jsonLines) {
      let evt: TranscriptEvent;
      try { evt = JSON.parse(line); } catch { continue; }

      if (evt.type === "session.start") {
        startTime = evt.timestamp ?? "";
      } else if (evt.type === "user.message") {
        const content = evt.data?.content ?? "";
        if (!firstUserMsg && content.trim()) {
          firstUserMsg = content.trim().slice(0, 60);
        }
        turnIndex++;
        const ts = evt.timestamp ? new Date(evt.timestamp).toLocaleString() : "";
        mdLines.push(`\n### 🧑 User${ts ? ` _(${ts})_` : ""}\n`);
        mdLines.push(content);
        mdLines.push("");
      } else if (evt.type === "assistant.message") {
        turnIndex++;
        const ts = evt.timestamp ? new Date(evt.timestamp).toLocaleString() : "";
        mdLines.push(`\n### 🤖 Copilot${ts ? ` _(${ts})_` : ""}\n`);
        mdLines.push(evt.data?.content ?? "_[empty response]_");
        mdLines.push("");
      }
    }

    if (turnIndex === 0) { return null; }

    const title = firstUserMsg || "Chat Session";
    const header = [
      `# ${title}\n`,
      `> Exported: ${new Date().toLocaleString()} | Source: VS Code Copilot Chat Transcript`,
      `> Session started: ${startTime ? new Date(startTime).toLocaleString() : "Unknown"} | Turns: ${turnIndex}`,
      "",
      "---",
      "",
    ];

    return header.join("\n") + mdLines.join("\n");
  } catch {
    return null;
  }
}

/**
 * Parse a chatSessions JSONL file (VS Code's native format) and export as Markdown.
 * Handles kind=0 (initial state), kind=1 (patches like customTitle),
 * kind=2 (appended requests and streamed responses).
 */
export function exportChatSessionToMarkdown(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter(l => l.trim());
    if (lines.length === 0) { return null; }

    let sessionId = path.basename(filePath, ".jsonl");
    let creationDate = "";
    let customTitle = "";

    // Collect requests: index → { prompt, responses[] }
    const requestsDict: Record<number, { prompt: string; responses: any[] }> = {};

    for (const line of lines) {
      let data: any;
      try { data = JSON.parse(line); } catch { continue; }

      const kind = data.kind;
      const k: any[] = data.k || [];
      const v = data.v;

      if (kind === 0 && v) {
        // Initial state
        if (v.sessionId) { sessionId = v.sessionId; }
        if (v.creationDate) {
          creationDate = new Date(v.creationDate).toLocaleString();
        }
        if (v.customTitle) { customTitle = v.customTitle; }
        if (Array.isArray(v.requests)) {
          v.requests.forEach((req: any, idx: number) => {
            const prompt = req.message?.text || "";
            requestsDict[idx] = { prompt, responses: req.response || [] };
          });
        }
      } else if (kind === 1 && k.length === 1 && k[0] === "customTitle" && typeof v === "string") {
        // Custom title patch
        customTitle = v;
      } else if (kind === 2 && k.length === 1 && k[0] === "requests" && Array.isArray(v)) {
        // Appended requests
        v.forEach((req: any) => {
          const idx = Object.keys(requestsDict).length;
          const prompt = req.message?.text || "";
          requestsDict[idx] = { prompt, responses: req.response || [] };
        });
      } else if (kind === 2 && k.length >= 3 && k[0] === "requests" && k[2] === "response") {
        // Streamed AI response chunks
        const idx = k[1];
        if (requestsDict[idx] && Array.isArray(v)) {
          requestsDict[idx].responses.push(...v);
        }
      }
    }

    // Build messages from requestsDict
    const sortedKeys = Object.keys(requestsDict).map(Number).sort((a, b) => a - b);
    if (sortedKeys.length === 0) { return null; }

    const mdLines: string[] = [];
    let firstUserMsg = "";

    for (const idx of sortedKeys) {
      const req = requestsDict[idx];

      // User message
      if (req.prompt) {
        if (!firstUserMsg) { firstUserMsg = req.prompt.trim().slice(0, 60); }
        mdLines.push(`\n### 🧑 User\n`);
        mdLines.push(req.prompt);
        mdLines.push("");
      }

      // Assistant response
      let responseText = "";
      for (const resp of req.responses) {
        if (!resp || typeof resp !== "object") { continue; }
        if (resp.value && typeof resp.value === "string") {
          responseText += resp.value;
        } else if (resp.kind === "toolInvocationSerialized") {
          const toolName = resp.toolId || "Tool";
          const msg = resp.pastTenseMessage?.value || resp.invocationMessage?.value || "Used tool";
          responseText += `\n\n> **[${toolName}]** ${msg}\n`;
          const toolData = resp.toolSpecificData || {};
          if (toolData.kind === "terminal") {
            const cmd = toolData.commandLine?.original || "";
            const out = toolData.terminalCommandOutput?.text || "";
            if (cmd) { responseText += `> \`\`\`bash\n> ${cmd}\n> \`\`\`\n`; }
            if (out.trim()) {
              responseText += `\n**Terminal Output:**\n\`\`\`bash\n${out.replace(/\r\n/g, "\n").trim()}\n\`\`\`\n\n`;
            }
          }
        }
      }

      if (responseText) {
        mdLines.push(`\n### 🤖 Copilot\n`);
        mdLines.push(responseText);
        mdLines.push("");
      }
    }

    if (mdLines.length === 0) { return null; }

    const title = customTitle || firstUserMsg || "Chat Session";
    const turnCount = sortedKeys.length;
    const header = [
      `# ${title}\n`,
      `> Exported: ${new Date().toLocaleString()} | Source: VS Code Copilot Chat Session`,
      `> Session: ${creationDate || "Unknown date"} | Turns: ${turnCount}`,
      "",
      "---",
      "",
    ];

    return header.join("\n") + mdLines.join("\n");
  } catch {
    return null;
  }
}

// ── Workspace Config Scanner ──────────────────────────────────────────────

export async function scanWorkspaceCopilotConfig(): Promise<WorkspaceCopilotConfig> {
  const config: WorkspaceCopilotConfig = {
    instructions: [],
    prompts: [],
    agents: [],
    skills: [],
    hooks: [],
  };

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) { return config; }

  try {
    // Instructions: .github/copilot-instructions.md
    const instructionFiles = await vscode.workspace.findFiles(".github/copilot-instructions.md", "**/node_modules/**", 5);
    config.instructions = instructionFiles.map(f => vscode.workspace.asRelativePath(f));

    // Also check for .github/instructions/*.instructions.md
    const instructionsDirFiles = await vscode.workspace.findFiles(".github/instructions/**/*.instructions.md", "**/node_modules/**", 20);
    config.instructions.push(...instructionsDirFiles.map(f => vscode.workspace.asRelativePath(f)));

    // Prompts: .github/prompts/*.prompt.md
    const promptFiles = await vscode.workspace.findFiles(".github/prompts/**/*.prompt.md", "**/node_modules/**", 50);
    config.prompts = promptFiles.map(f => vscode.workspace.asRelativePath(f));

    // Agents: .github/agents/*.md or custom chat participants
    const agentFiles = await vscode.workspace.findFiles(".github/agents/**/*.md", "**/node_modules/**", 20);
    config.agents = agentFiles.map(f => vscode.workspace.asRelativePath(f));

    // Skills: MCP tools / .github/skills/
    const skillFiles = await vscode.workspace.findFiles(".github/skills/**/*", "**/node_modules/**", 20);
    config.skills = skillFiles.map(f => vscode.workspace.asRelativePath(f));

    // Hooks: .github/hooks/
    const hookFiles = await vscode.workspace.findFiles(".github/hooks/**/*", "**/node_modules/**", 20);
    config.hooks = hookFiles.map(f => vscode.workspace.asRelativePath(f));
  } catch {
    // Silently fail — workspace scan is best-effort
  }

  return config;
}

// ── Dashboard Panel ───────────────────────────────────────────────────────

let currentPanel: vscode.WebviewPanel | undefined;

export function openDashboard(
  context: vscode.ExtensionContext,
  fetchUsageFn: () => Promise<CopilotUsageData | null>,
  fetchRawApiFn: () => Promise<any>
) {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.One);
    refreshDashboard(context, fetchUsageFn, fetchRawApiFn);
    return;
  }

  currentPanel = vscode.window.createWebviewPanel(
    "copilotInsightsDashboard",
    "Copilot Insights Dashboard",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  currentPanel.iconPath = new vscode.ThemeIcon("github-copilot");

  currentPanel.onDidDispose(() => { currentPanel = undefined; }, null, context.subscriptions);

  currentPanel.webview.onDidReceiveMessage(
    async (message) => {
      if (message.command === "refresh") {
        await refreshDashboard(context, fetchUsageFn, fetchRawApiFn);
      } else if (message.command === "openSession") {
        const sessions = getStoredSessions(context);
        const session = sessions.find(s => s.id === message.sessionId);
        if (session) {
          openSessionDetailPanel(context, session);
        }
      } else if (message.command === "openThread") {
        // Search in both router threads and transcript threads
        const routerThreads = getStoredThreads(context);
        let thread = routerThreads.find(t => t.id === message.threadId);
        if (!thread) {
          const transcriptThreads = loadAllTranscripts(context);
          thread = transcriptThreads.find(t => t.id === message.threadId);
        }
        if (thread) {
          openThreadDetailPanel(context, thread);
        }
      }
    },
    undefined,
    context.subscriptions
  );

  refreshDashboard(context, fetchUsageFn, fetchRawApiFn);
}

async function refreshDashboard(
  context: vscode.ExtensionContext,
  fetchUsageFn: () => Promise<CopilotUsageData | null>,
  fetchRawApiFn: () => Promise<any>
) {
  if (!currentPanel) { return; }

  const [usage, rawApi, wsConfig] = await Promise.all([
    fetchUsageFn(),
    fetchRawApiFn(),
    scanWorkspaceCopilotConfig(),
  ]);

  const allModels = await vscode.lm.selectChatModels({ vendor: "copilot" });
  const models: ModelInfo[] = allModels.map(m => ({
    id: m.id, family: m.family, vendor: m.vendor, version: m.version, maxInputTokens: m.maxInputTokens,
  }));

  const allSessions = getStoredSessions(context);
  const activeSessions = allSessions.filter(s => s.status === "running");
  const routerThreads = getStoredThreads(context);
  const transcriptThreads = loadAllTranscripts(context);

  // Merge: router-captured threads take priority (have richer metadata).
  // Transcript threads fill in conversations that never used @router.
  const threadMap = new Map<string, ChatThread>();
  for (const t of transcriptThreads) { threadMap.set(t.id, t); }
  for (const t of routerThreads) { threadMap.set(t.id, t); } // router overrides transcript if same id
  const threads = [...threadMap.values()].sort((a, b) => b.lastTimestamp - a.lastTimestamp);

  const payload: DashboardPayload = {
    usage, models, rawApi,
    plan: rawApi?.copilot_plan ?? "Unknown",
    login: rawApi?.login ?? "Unknown",
    timestamp: new Date().toLocaleString(),
    sessions: allSessions,
    activeSessions,
    config: wsConfig,
    threads,
  };

  currentPanel.webview.html = getHtml(payload);
}

// ── Session Detail Panel ──────────────────────────────────────────────────

function openSessionDetailPanel(context: vscode.ExtensionContext, session: AgentSession) {
  const panel = vscode.window.createWebviewPanel(
    "sessionDetail",
    `Session: ${session.prompt.slice(0, 40)}…`,
    vscode.ViewColumn.Two,
    { enableScripts: false }
  );

  panel.iconPath = new vscode.ThemeIcon("history");

  const date = new Date(session.timestamp).toLocaleString();
  const duration = session.status === "running"
    ? `${Math.round((Date.now() - session.timestamp) / 1000)}s (still running)`
    : "Completed";
  const statusColor = session.status === "completed" ? "#4ade80" : session.status === "error" ? "#ef4444" : "#58a6ff";
  const statusLabel = session.status === "completed" ? "✓ Completed" : session.status === "error" ? "✕ Error" : "● Running";
  const tierLabel = session.tier === "advanced" ? "🔴 Advanced" : "🟢 Standard";
  const responseTokens = session.response ? Math.ceil(session.response.length / 4) : 0;
  const totalTokens = (session.estimatedTokens ?? 0) + responseTokens;

  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Session Detail</title>
<style>
  :root { --bg:#0d1117; --surface:#161b22; --border:#30363d; --text:#e6edf3; --muted:#8b949e; --accent:#58a6ff; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--text); padding:32px; line-height:1.6; }
  h1 { font-size:20px; margin-bottom:24px; border-bottom:1px solid var(--border); padding-bottom:12px; }
  .detail-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:24px; }
  .detail-card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:16px; }
  .detail-label { font-size:11px; text-transform:uppercase; letter-spacing:.8px; color:var(--muted); margin-bottom:4px; }
  .detail-value { font-size:16px; font-weight:600; }
  .prompt-box { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:20px; margin-top:16px; white-space:pre-wrap; font-family:monospace; font-size:13px; color:var(--muted); max-height:400px; overflow-y:auto; }
  .badge { display:inline-block; padding:3px 10px; border-radius:10px; font-size:12px; font-weight:600; }
  .wide { grid-column:1/-1; }
</style>
</head>
<body>
<h1>📋 Session Detail</h1>
<div class="detail-grid">
  <div class="detail-card">
    <div class="detail-label">Status</div>
    <div class="detail-value" style="color:${statusColor}">${statusLabel}</div>
  </div>
  <div class="detail-card">
    <div class="detail-label">Timestamp</div>
    <div class="detail-value">${date}</div>
  </div>
  <div class="detail-card">
    <div class="detail-label">Model</div>
    <div class="detail-value" style="color:var(--accent)">${esc(session.model)}</div>
  </div>
  <div class="detail-card">
    <div class="detail-label">Tier</div>
    <div class="detail-value">${tierLabel}</div>
  </div>
  <div class="detail-card">
    <div class="detail-label">Complexity Score</div>
    <div class="detail-value">${session.score} / 100</div>
  </div>
  <div class="detail-card">
    <div class="detail-label">Cost Multiplier</div>
    <div class="detail-value">${session.multiplier ?? 1}x</div>
  </div>
  <div class="detail-card">
    <div class="detail-label">Est. Input Tokens</div>
    <div class="detail-value">${session.estimatedTokens?.toLocaleString() ?? "—"}</div>
  </div>
  <div class="detail-card">
    <div class="detail-label">Est. Output Tokens</div>
    <div class="detail-value">${responseTokens > 0 ? responseTokens.toLocaleString() : "—"}</div>
  </div>
  <div class="detail-card">
    <div class="detail-label">Est. Total Tokens</div>
    <div class="detail-value">${totalTokens > 0 ? totalTokens.toLocaleString() : "—"}</div>
  </div>
  <div class="detail-card">
    <div class="detail-label">Duration</div>
    <div class="detail-value">${duration}</div>
  </div>
  <div class="detail-card">
    <div class="detail-label">Agent Mode</div>
    <div class="detail-value">${session.agentMode ? "✅ Enabled" : "❌ Disabled"}</div>
  </div>
  <div class="detail-card">
    <div class="detail-label">Boosted</div>
    <div class="detail-value">${session.boosted ? "🚀 Yes" : "— No"}</div>
  </div>
  <div class="detail-card wide">
    <div class="detail-label">Session ID</div>
    <div class="detail-value" style="font-size:12px;font-family:monospace;color:var(--muted)">${esc(session.id)}</div>
  </div>
</div>
<h2 style="font-size:16px;margin-bottom:8px">💬 Prompt</h2>
<div class="prompt-box">${esc(session.prompt)}</div>
${session.response ? `
<h2 style="font-size:16px;margin-top:24px;margin-bottom:8px">🤖 Response</h2>
<div class="prompt-box" style="color:#e6edf3;border-color:#30363d">${esc(session.response)}</div>
` : `
<h2 style="font-size:16px;margin-top:24px;margin-bottom:8px">🤖 Response</h2>
<div class="prompt-box" style="color:#6e7681;font-style:italic">No response captured. Responses are stored for sessions created after this update.</div>
`}
</body>
</html>`;
}

// ── Thread Detail Panel ───────────────────────────────────────────────────

function openThreadDetailPanel(context: vscode.ExtensionContext, thread: ChatThread) {
  const panel = vscode.window.createWebviewPanel(
    "threadDetail",
    `Chat: ${thread.title.slice(0, 40)}…`,
    vscode.ViewColumn.Two,
    { enableScripts: false }
  );

  panel.iconPath = new vscode.ThemeIcon("comment-discussion");

  const startDate = new Date(thread.firstTimestamp).toLocaleString();
  const endDate = new Date(thread.lastTimestamp).toLocaleString();
  const userTurns = thread.turns.filter(t => t.role === "user").length;
  const assistantTurns = thread.turns.filter(t => t.role === "assistant").length;

  // Render conversation turns as a chat UI
  const turnHtml = thread.turns.map(t => {
    const isUser = t.role === "user";
    const bgColor = isUser ? "rgba(88,166,255,0.08)" : "rgba(74,222,128,0.06)";
    const borderColor = isUser ? "rgba(88,166,255,0.25)" : "rgba(74,222,128,0.2)";
    const icon = isUser ? "👤" : "🤖";
    const label = isUser ? "You" : (t.participant ?? "Copilot");
    const cmdTag = t.command ? ` <span style="font-size:11px;color:#8b949e;background:rgba(255,255,255,0.05);padding:1px 6px;border-radius:4px">/${esc(t.command)}</span>` : "";
    const content = esc(t.content).replace(/\n/g, "<br>");
    return `<div style="background:${bgColor};border:1px solid ${borderColor};border-radius:12px;padding:16px;margin-bottom:12px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
        <span style="font-size:16px">${icon}</span>
        <span style="font-weight:700;font-size:13px;color:${isUser ? "#58a6ff" : "#4ade80"}">${esc(label)}</span>
        ${cmdTag}
      </div>
      <div style="font-size:13px;line-height:1.7;color:#c9d1d9;word-wrap:break-word;white-space:pre-wrap">${content}</div>
    </div>`;
  }).join("");

  const isTranscript = thread.id.startsWith("transcript-");
  const sourceLabel = isTranscript ? "Copilot Chat" : "@router";
  const sourceColor = isTranscript ? "#a78bfa" : "#58a6ff";

  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Chat Thread</title>
<style>
  :root { --bg:#0d1117; --surface:#161b22; --border:#30363d; --text:#e6edf3; --muted:#8b949e; --accent:#58a6ff; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--text); padding:32px; line-height:1.6; max-width:900px; margin:0 auto; }
  h1 { font-size:20px; margin-bottom:6px; }
  .meta { font-size:13px; color:var(--muted); margin-bottom:24px; padding-bottom:16px; border-bottom:1px solid var(--border); }
  .meta span { margin-right:16px; }
  .stats { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:24px; }
  .stat-chip { background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:8px 14px; font-size:12px; }
  .stat-chip strong { font-size:16px; display:block; margin-bottom:2px; }
  .conversation { margin-top:16px; }
</style>
</head>
<body>
<h1>💬 ${esc(thread.title)}</h1>
<div class="meta">
  <span style="display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600;background:rgba(${isTranscript ? "167,139,250" : "88,166,255"},.15);color:${sourceColor};border:1px solid rgba(${isTranscript ? "167,139,250" : "88,166,255"},.3)">${sourceLabel}</span>
  <span>🕐 Started: ${startDate}</span>
  <span>🕐 Last: ${endDate}</span>
</div>

<div class="stats">
  <div class="stat-chip"><strong style="color:var(--accent)">${userTurns}</strong>Prompts</div>
  <div class="stat-chip"><strong style="color:#4ade80">${assistantTurns}</strong>Responses</div>
  <div class="stat-chip"><strong>${thread.turns.length}</strong>Total Turns</div>
  <div class="stat-chip"><strong>${thread.models.join(", ")}</strong>Models</div>
  <div class="stat-chip"><strong>${thread.totalTokens.toLocaleString()}</strong>Est. Tokens</div>
  <div class="stat-chip"><strong>${thread.totalCost}x</strong>Total Cost</div>
</div>

<div class="conversation">
${turnHtml}
</div>
</body>
</html>`;
}

// ── HTML Renderer ─────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function getHtml(p: DashboardPayload): string {
  const { usage, models, plan, login, timestamp, sessions, activeSessions, config, rawApi, threads } = p;

  // Usage values
  const pctUsed = usage?.percentUsed ?? 0;
  const remaining = usage?.remaining ?? 0;
  const entitlement = usage?.entitlement ?? 0;
  const used = usage?.used ?? 0;
  const resetDate = usage?.resetDate || "Unknown";
  const isUnlimited = usage?.unlimited ?? false;

  let gaugeColor = "#4ade80";
  if (pctUsed > 80) { gaugeColor = "#ef4444"; }
  else if (pctUsed > 60) { gaugeColor = "#f59e0b"; }

  // Quota table
  let quotaRows = "";
  if (rawApi?.quota_snapshots) {
    for (const [key, snap] of Object.entries(rawApi.quota_snapshots) as [string, any][]) {
      const name = key.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
      if (snap.unlimited) {
        quotaRows += `<tr><td>${name}</td><td>∞</td><td>∞</td><td>0%</td><td>—</td></tr>`;
      } else {
        const u = snap.entitlement - snap.quota_remaining;
        const pc = snap.entitlement > 0 ? Math.round((u / snap.entitlement) * 100) : 0;
        quotaRows += `<tr><td>${name}</td><td>${snap.entitlement}</td><td>${snap.quota_remaining}</td><td>${pc}%</td><td>${snap.overage_count ?? 0}</td></tr>`;
      }
    }
  }

  // Models table
  const modelsRows = models.map(m =>
    `<tr><td><span class="badge badge-blue">${esc(m.family)}</span></td><td>${esc(m.id)}</td><td>${esc(m.vendor)}</td><td>${m.version}</td><td>${(m.maxInputTokens ?? 0).toLocaleString()}</td></tr>`
  ).join("");

  // Config counts
  const configTotal = config.instructions.length + config.prompts.length + config.agents.length + config.skills.length + config.hooks.length;

  // Config files lists
  function fileList(files: string[], emptyMsg: string): string {
    if (files.length === 0) { return `<div class="empty-hint">${emptyMsg}</div>`; }
    return files.map(f => `<div class="file-item">📄 ${esc(f)}</div>`).join("");
  }

  // Session history rows (last 30)
  const recentSessions = sessions.slice(0, 30);
  const sessionRows = recentSessions.map(s => {
    const date = new Date(s.timestamp).toLocaleString();
    const promptSnippet = esc(s.prompt.length > 80 ? s.prompt.slice(0, 80) + "…" : s.prompt);
    const statusBadge = s.status === "running"
      ? '<span class="badge badge-running">● Running</span>'
      : s.status === "error"
        ? '<span class="badge badge-error">✕ Error</span>'
        : '<span class="badge badge-done">✓ Done</span>';
    const tierBadge = s.tier === "advanced"
      ? '<span class="badge badge-premium">Advanced</span>'
      : '<span class="badge badge-free">Standard</span>';
    const tokens = s.estimatedTokens ? `~${s.estimatedTokens.toLocaleString()}` : "—";
    const cost = s.multiplier ? `${s.multiplier}x` : "—";
    return `<tr class="session-row" onclick="openSession('${esc(s.id)}')" title="Click to view details">
      <td>${statusBadge}</td>
      <td title="${esc(s.prompt)}">${promptSnippet}</td>
      <td><span class="badge badge-blue">${esc(s.model)}</span></td>
      <td>${tierBadge}</td>
      <td>${s.score}</td>
      <td>${tokens}</td>
      <td>${cost}</td>
      <td>${s.agentMode ? "✅" : "—"}</td>
      <td>${s.boosted ? "🚀" : "—"}</td>
      <td style="font-size:12px;color:var(--text-muted)">${date}</td>
    </tr>`;
  }).join("");

  // Active sessions
  const activeRows = activeSessions.map(s => {
    const elapsed = Math.round((Date.now() - s.timestamp) / 1000);
    const promptSnippet = esc(s.prompt.length > 60 ? s.prompt.slice(0, 60) + "…" : s.prompt);
    return `<div class="active-session">
      <div class="active-dot"></div>
      <div style="flex:1">
        <div style="font-weight:600">${promptSnippet}</div>
        <div style="font-size:12px;color:var(--text-muted)">${esc(s.model)} · ${s.tier} · ${elapsed}s elapsed</div>
      </div>
    </div>`;
  }).join("");

  // Session stats
  const totalSessions = sessions.length;
  const premiumSessions = sessions.filter(s => s.tier === "advanced").length;
  const freeSessions = sessions.filter(s => s.tier === "standard").length;
  const errorSessions = sessions.filter(s => s.status === "error").length;
  const boostedSessions = sessions.filter(s => s.boosted).length;

  // Per-model usage aggregation
  const modelUsageMap: Record<string, { count: number; tokens: number; cost: number }> = {};
  for (const s of sessions) {
    if (!modelUsageMap[s.model]) { modelUsageMap[s.model] = { count: 0, tokens: 0, cost: 0 }; }
    modelUsageMap[s.model].count++;
    modelUsageMap[s.model].tokens += s.estimatedTokens ?? 0;
    modelUsageMap[s.model].cost += (s.multiplier ?? 1);
  }
  const modelUsageRows = Object.entries(modelUsageMap)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([model, data]) => {
      const pct = totalSessions > 0 ? Math.round((data.count / totalSessions) * 100) : 0;
      const bar = "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
      return `<tr><td><span class="badge badge-blue">${esc(model)}</span></td><td>${data.count}</td><td>${pct}%</td><td><code style="font-size:11px;color:var(--text-muted)">${bar}</code></td><td>${data.tokens.toLocaleString()}</td><td>${data.cost}x</td></tr>`;
    }).join("");
  const totalEstimatedTokens = sessions.reduce((sum, s) => sum + (s.estimatedTokens ?? 0), 0);
  const totalCostMultiplier = sessions.reduce((sum, s) => sum + (s.multiplier ?? 1), 0);

  // Non-router usage: total API-reported usage minus @router tracked requests
  const apiTotalUsed = usage?.used ?? 0;
  const routerTrackedRequests = totalSessions;
  const nonRouterUsage = Math.max(0, apiTotalUsed - routerTrackedRequests);
  const routerPct = apiTotalUsed > 0 ? Math.round((routerTrackedRequests / apiTotalUsed) * 100) : 0;
  const nonRouterPct = apiTotalUsed > 0 ? 100 - routerPct : 0;

  // Thread rows (conversations)
  const sortedThreads = [...threads].sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  const threadRows = sortedThreads.map(t => {
    const title = esc(t.title.length > 60 ? t.title.slice(0, 60) + "…" : t.title);
    const isTranscript = t.id.startsWith("transcript-");
    const sourceBadge = isTranscript
      ? '<span class="badge" style="background:rgba(167,139,250,.15);color:#a78bfa;border:1px solid rgba(167,139,250,.3)">Copilot Chat</span>'
      : '<span class="badge" style="background:rgba(88,166,255,.15);color:#58a6ff;border:1px solid rgba(88,166,255,.3)">@router</span>';
    const models = t.models.length > 0
      ? t.models.map(m => `<span class="badge badge-blue">${esc(m)}</span>`).join(" ")
      : '<span style="color:var(--text-muted);font-size:12px">—</span>';
    const firstDate = new Date(t.firstTimestamp).toLocaleString();
    const lastDate = new Date(t.lastTimestamp).toLocaleString();
    const turnCount = t.turns.length;
    const userTurns = t.turns.filter(turn => turn.role === "user").length;
    return `<tr class="session-row" onclick="openThread('${esc(t.id)}')" title="Click to view conversation">
      <td>${sourceBadge}</td>
      <td title="${esc(t.title)}"><strong>${title}</strong></td>
      <td>${models}</td>
      <td>${userTurns} prompts / ${turnCount} turns</td>
      <td>${t.totalTokens.toLocaleString()}</td>
      <td>${t.totalCost}x</td>
      <td style="font-size:12px;color:var(--text-muted)">${lastDate}</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Copilot Insights Dashboard</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --surface-hover: #1c2333; --border: #30363d;
    --text-primary: #e6edf3; --text-secondary: #8b949e; --text-muted: #6e7681;
    --accent: #58a6ff; --accent-glow: rgba(88,166,255,0.15);
    --green: #4ade80; --amber: #f59e0b; --red: #ef4444; --purple: #a78bfa;
    --cyan: #22d3ee; --pink: #f472b6;
    --radius: 12px;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background:var(--bg); color:var(--text-primary); padding:24px; line-height:1.6; }

  /* Header */
  .header { display:flex; align-items:center; justify-content:space-between; margin-bottom:24px; padding-bottom:18px; border-bottom:1px solid var(--border); }
  .header h1 { font-size:22px; font-weight:700; display:flex; align-items:center; gap:10px; }
  .header .logo { width:28px; height:28px; background:linear-gradient(135deg,var(--accent),var(--purple)); border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:16px; }
  .header-meta { display:flex; align-items:center; gap:14px; font-size:13px; color:var(--text-secondary); flex-wrap:wrap; }
  .user-badge { background:var(--surface); border:1px solid var(--border); padding:4px 12px; border-radius:20px; }
  .refresh-btn { background:var(--surface); border:1px solid var(--border); color:var(--accent); padding:6px 14px; border-radius:8px; cursor:pointer; font-size:13px; transition:all .2s; }
  .refresh-btn:hover { background:var(--accent-glow); border-color:var(--accent); }

  /* Tabs */
  .tabs { display:flex; gap:2px; margin-bottom:24px; background:var(--surface); border-radius:10px; padding:3px; border:1px solid var(--border); }
  .tab { padding:8px 18px; border-radius:8px; cursor:pointer; font-size:13px; font-weight:600; color:var(--text-secondary); transition:all .2s; border:none; background:none; }
  .tab:hover { color:var(--text-primary); background:rgba(255,255,255,0.05); }
  .tab.active { background:var(--accent); color:#fff; }
  .tab-content { display:none; }
  .tab-content.active { display:block; }

  /* Grid & Cards */
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:16px; margin-bottom:24px; }
  .grid-3 { grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:20px; transition:border-color .2s,box-shadow .2s; }
  .card:hover { border-color:var(--accent); box-shadow:0 0 20px var(--accent-glow); }
  .card-wide { grid-column:1/-1; }
  .card-title { font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:.8px; color:var(--text-muted); margin-bottom:12px; display:flex; align-items:center; gap:6px; }
  .card-value { font-size:36px; font-weight:800; line-height:1.1; }
  .card-value-sm { font-size:28px; }
  .card-sub { font-size:13px; color:var(--text-secondary); margin-top:4px; }

  /* Progress */
  .progress-track { width:100%; height:8px; background:var(--border); border-radius:4px; overflow:hidden; margin:12px 0 6px; }
  .progress-fill { height:100%; border-radius:4px; transition:width 1s ease-out; }

  /* Gauge */
  .gauge-container { display:flex; flex-direction:column; align-items:center; padding:10px 0; }
  .gauge-ring { width:160px; height:160px; position:relative; }
  .gauge-ring svg { transform:rotate(-90deg); }
  .gauge-ring .bg-ring { fill:none; stroke:var(--border); stroke-width:12; }
  .gauge-ring .fg-ring { fill:none; stroke-width:12; stroke-linecap:round; transition:stroke-dashoffset 1s ease-out; }
  .gauge-center { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); text-align:center; }
  .gauge-pct { font-size:32px; font-weight:800; }
  .gauge-lbl { font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:1px; }

  /* Tables */
  .data-table { width:100%; border-collapse:collapse; font-size:13px; }
  .data-table th { text-align:left; padding:10px 12px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.5px; color:var(--text-muted); border-bottom:1px solid var(--border); background:rgba(0,0,0,.2); }
  .data-table td { padding:10px 12px; border-bottom:1px solid rgba(48,54,61,.4); color:var(--text-secondary); }
  .data-table tr:hover td { background:var(--surface-hover); color:var(--text-primary); }
  .session-row { cursor:pointer; transition:background .15s; }
  .session-row:hover td { background:var(--accent-glow) !important; color:var(--text-primary); }

  /* Badges */
  .badge { display:inline-block; padding:2px 10px; border-radius:12px; font-size:11px; font-weight:600; white-space:nowrap; }
  .badge-blue { background:linear-gradient(135deg,var(--accent),var(--purple)); color:#fff; }
  .badge-premium { background:rgba(239,68,68,.15); color:var(--red); border:1px solid rgba(239,68,68,.3); }
  .badge-free { background:rgba(74,222,128,.15); color:var(--green); border:1px solid rgba(74,222,128,.3); }
  .badge-running { background:rgba(88,166,255,.15); color:var(--accent); border:1px solid rgba(88,166,255,.3); animation:pulse 2s infinite; }
  .badge-done { background:rgba(74,222,128,.1); color:var(--green); border:1px solid rgba(74,222,128,.2); }
  .badge-error { background:rgba(239,68,68,.1); color:var(--red); border:1px solid rgba(239,68,68,.2); }

  .plan-badge { display:inline-block; padding:3px 12px; border-radius:12px; font-size:12px; font-weight:600; text-transform:capitalize; }
  .plan-free { background:rgba(74,222,128,.15); color:var(--green); border:1px solid rgba(74,222,128,.3); }
  .plan-pro { background:rgba(88,166,255,.15); color:var(--accent); border:1px solid rgba(88,166,255,.3); }
  .plan-business { background:rgba(167,139,250,.15); color:var(--purple); border:1px solid rgba(167,139,250,.3); }

  /* Stat rows */
  .stat-row { display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid rgba(48,54,61,.3); }
  .stat-row:last-child { border:none; }
  .stat-label { color:var(--text-secondary); font-size:13px; }
  .stat-value { font-weight:600; font-size:14px; }

  /* Section titles */
  .section-title { font-size:16px; font-weight:700; margin:28px 0 14px; display:flex; align-items:center; gap:8px; }
  .section-title::after { content:""; flex:1; height:1px; background:var(--border); margin-left:12px; }

  /* Config file lists */
  .file-item { padding:6px 12px; font-size:13px; color:var(--text-secondary); border-bottom:1px solid rgba(48,54,61,.2); }
  .file-item:hover { background:var(--surface-hover); color:var(--text-primary); }
  .empty-hint { padding:16px; text-align:center; color:var(--text-muted); font-size:13px; font-style:italic; }

  /* Active session */
  .active-session { display:flex; align-items:center; gap:12px; padding:12px; border-bottom:1px solid var(--border); }
  .active-session:last-child { border:none; }
  .active-dot { width:10px; height:10px; border-radius:50%; background:var(--accent); animation:pulse 2s infinite; flex-shrink:0; }

  /* Config pill grid */
  .config-pills { display:flex; gap:10px; flex-wrap:wrap; }
  .config-pill { display:flex; flex-direction:column; align-items:center; background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:16px 24px; min-width:110px; transition:border-color .2s; }
  .config-pill:hover { border-color:var(--accent); }
  .config-pill .pill-count { font-size:28px; font-weight:800; }
  .config-pill .pill-label { font-size:11px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.5px; margin-top:4px; }

  .empty-state { text-align:center; padding:40px; color:var(--text-muted); font-size:14px; }

  @keyframes fadeIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.5; } }
  .anim { animation:fadeIn .4s ease-out forwards; }
  .d1 { animation-delay:.05s; opacity:0; }
  .d2 { animation-delay:.1s; opacity:0; }
  .d3 { animation-delay:.15s; opacity:0; }
  .d4 { animation-delay:.2s; opacity:0; }
  .d5 { animation-delay:.25s; opacity:0; }
</style>
</head>
<body>

<!-- Header -->
<div class="header anim">
  <h1><span class="logo">⚡</span> Copilot Insights</h1>
  <div class="header-meta">
    <span class="user-badge">👤 ${esc(login)}</span>
    <span class="plan-badge ${plan === "free" ? "plan-free" : plan === "business" ? "plan-business" : "plan-pro"}">${esc(plan)}</span>
    <span style="color:var(--text-muted)">Updated: ${timestamp}</span>
    <button class="refresh-btn" onclick="refresh()">↻ Refresh</button>
  </div>
</div>

<!-- Tabs -->
<div class="tabs anim d1">
  <button class="tab active" onclick="switchTab('usage')">📊 Usage</button>
  <button class="tab" onclick="switchTab('agents')">🤖 Agents & Sessions</button>
  <button class="tab" onclick="switchTab('config')">⚙️ Workspace Config</button>
  <button class="tab" onclick="switchTab('models')">🧠 Models</button>
  <button class="tab" onclick="switchTab('account')">🔐 Account</button>
</div>

<!-- ═══ TAB: Usage ═══ -->
<div id="tab-usage" class="tab-content active">
${isUnlimited ? `
<div class="card card-wide anim d1" style="text-align:center;padding:40px;">
  <div style="font-size:48px;margin-bottom:12px">∞</div>
  <div style="font-size:18px;font-weight:700">Unlimited Premium Plan</div>
  <div class="card-sub">You have unlimited premium model requests.</div>
</div>
` : usage ? `
<div class="grid anim d1">
  <div class="card">
    <div class="card-title">📊 Premium Used</div>
    <div class="card-value" style="color:${gaugeColor}">${used}</div>
    <div class="card-sub">of ${entitlement} total requests</div>
    <div class="progress-track"><div class="progress-fill" style="width:${pctUsed}%;background:${gaugeColor}"></div></div>
    <div class="card-sub">${pctUsed}% consumed</div>
  </div>
  <div class="card">
    <div class="card-title">✅ Remaining</div>
    <div class="card-value" style="color:var(--green)">${remaining}</div>
    <div class="card-sub">premium requests left</div>
    <div class="progress-track"><div class="progress-fill" style="width:${100 - pctUsed}%;background:var(--green)"></div></div>
    <div class="card-sub">${(100 - pctUsed).toFixed(1)}% available</div>
  </div>
  <div class="card">
    <div class="card-title">📅 Reset Date</div>
    <div class="card-value" style="font-size:22px">${resetDate}</div>
    <div class="card-sub">quota refreshes on this date</div>
  </div>
</div>
<div class="grid anim d2">
  <div class="card" style="display:flex;align-items:center;justify-content:center">
    <div class="gauge-container">
      <div class="gauge-ring">
        <svg viewBox="0 0 160 160" width="160" height="160">
          <circle class="bg-ring" cx="80" cy="80" r="68"/>
          <circle class="fg-ring" cx="80" cy="80" r="68" stroke="${gaugeColor}" stroke-dasharray="${2 * Math.PI * 68}" stroke-dashoffset="${2 * Math.PI * 68 * (1 - pctUsed / 100)}"/>
        </svg>
        <div class="gauge-center">
          <div class="gauge-pct" style="color:${gaugeColor}">${pctUsed}%</div>
          <div class="gauge-lbl">Used</div>
        </div>
      </div>
    </div>
  </div>
  <div class="card" style="flex:1">
    <div class="card-title">📋 Quota Breakdown</div>
    <table class="data-table">
      <thead><tr><th>Category</th><th>Limit</th><th>Remaining</th><th>Used %</th><th>Overage</th></tr></thead>
      <tbody>${quotaRows || '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">No quota data</td></tr>'}</tbody>
    </table>
  </div>
</div>
` : `
<div class="card card-wide anim d1">
  <div class="empty-state">
    <div style="font-size:40px;margin-bottom:12px">⚠️</div>
    <div style="font-size:16px;font-weight:600">Unable to fetch usage data</div>
    <div style="margin-top:8px;color:var(--text-muted)">Make sure you are signed in to GitHub with Copilot enabled.</div>
  </div>
</div>
`}
</div>

<!-- ═══ TAB: Agents & Sessions ═══ -->
<div id="tab-agents" class="tab-content">

<!-- Active Sessions -->
<div class="section-title anim">🔴 Active Agent Sessions</div>
<div class="card card-wide anim d1">
  ${activeSessions.length > 0 ? activeRows : '<div class="empty-hint">No agent sessions currently running.</div>'}
</div>

<!-- Session Stats -->
<div class="section-title anim d1">📈 Session Statistics</div>
<div class="grid grid-3 anim d2">
  <div class="card">
    <div class="card-title">Total Sessions</div>
    <div class="card-value card-value-sm">${totalSessions}</div>
  </div>
  <div class="card">
    <div class="card-title">🔴 Advanced</div>
    <div class="card-value card-value-sm" style="color:var(--red)">${premiumSessions}</div>
  </div>
  <div class="card">
    <div class="card-title">🟢 Standard</div>
    <div class="card-value card-value-sm" style="color:var(--green)">${freeSessions}</div>
  </div>
  <div class="card">
    <div class="card-title">🚀 Boosted</div>
    <div class="card-value card-value-sm" style="color:var(--cyan)">${boostedSessions}</div>
  </div>
  <div class="card">
    <div class="card-title">❌ Errors</div>
    <div class="card-value card-value-sm" style="color:var(--amber)">${errorSessions}</div>
  </div>
</div>

<!-- Per-Model Usage Breakdown -->
<div class="section-title anim d2">📊 Per-Model Usage</div>
<div class="grid grid-3 anim d2">
  <div class="card">
    <div class="card-title">Total API Usage</div>
    <div class="card-value card-value-sm" style="color:var(--amber)">${apiTotalUsed}</div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:4px">requests (from GitHub API)</div>
  </div>
  <div class="card">
    <div class="card-title">Via @router</div>
    <div class="card-value card-value-sm" style="color:var(--accent)">${routerTrackedRequests} <span style="font-size:12px;color:var(--text-muted)">(${routerPct}%)</span></div>
  </div>
  <div class="card">
    <div class="card-title">Other (Chat/Completions)</div>
    <div class="card-value card-value-sm" style="color:var(--pink)">${nonRouterUsage} <span style="font-size:12px;color:var(--text-muted)">(${nonRouterPct}%)</span></div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:4px">inline, regular chat, etc.</div>
  </div>
  <div class="card">
    <div class="card-title">Est. Total Tokens</div>
    <div class="card-value card-value-sm" style="color:var(--accent)">${totalEstimatedTokens.toLocaleString()}</div>
  </div>
  <div class="card">
    <div class="card-title">Total Cost Units</div>
    <div class="card-value card-value-sm" style="color:var(--purple)">${totalCostMultiplier}x</div>
  </div>
</div>
<div class="card card-wide anim d2">
  ${modelUsageRows ? `
  <table class="data-table">
    <thead><tr><th>Model</th><th>Uses</th><th>%</th><th>Distribution</th><th>Est. Tokens</th><th>Cost</th></tr></thead>
    <tbody>${modelUsageRows}</tbody>
  </table>
  ` : '<div class="empty-hint">No model usage data yet.</div>'}
</div>

<!-- Chat Conversations -->
<div class="section-title anim d3">💬 Chat Conversations</div>
<div class="card card-wide anim d3">
  ${sortedThreads.length > 0 ? `
  <table class="data-table">
    <thead><tr><th>Source</th><th>Conversation</th><th>Models</th><th>Turns</th><th>Est. Tokens</th><th>Cost</th><th>Last Activity</th></tr></thead>
    <tbody>${threadRows}</tbody>
  </table>
  ` : '<div class="empty-hint">No conversations recorded yet. Chat with @router to start tracking!</div>'}
</div>

<!-- Individual Request Log -->
<div class="section-title anim d3">📜 Request Log (Last 30)</div>
<div class="card card-wide anim d3">
  ${recentSessions.length > 0 ? `
  <table class="data-table">
    <thead><tr><th>Status</th><th>Prompt</th><th>Model</th><th>Tier</th><th>Score</th><th>Tokens</th><th>Cost</th><th>Agent</th><th>Boost</th><th>Time</th></tr></thead>
    <tbody>${sessionRows}</tbody>
  </table>
  ` : '<div class="empty-hint">No sessions recorded yet. Use @router to start some!</div>'}
</div>
</div>

<!-- ═══ TAB: Config ═══ -->
<div id="tab-config" class="tab-content">
<div class="section-title anim">⚙️ Workspace Copilot Configuration</div>

<!-- Config summary pills -->
<div class="config-pills anim d1" style="margin-bottom:24px">
  <div class="config-pill">
    <span class="pill-count" style="color:var(--accent)">${config.instructions.length}</span>
    <span class="pill-label">Instructions</span>
  </div>
  <div class="config-pill">
    <span class="pill-count" style="color:var(--purple)">${config.prompts.length}</span>
    <span class="pill-label">Prompts</span>
  </div>
  <div class="config-pill">
    <span class="pill-count" style="color:var(--cyan)">${config.agents.length}</span>
    <span class="pill-label">Agents</span>
  </div>
  <div class="config-pill">
    <span class="pill-count" style="color:var(--green)">${config.skills.length}</span>
    <span class="pill-label">Skills</span>
  </div>
  <div class="config-pill">
    <span class="pill-count" style="color:var(--pink)">${config.hooks.length}</span>
    <span class="pill-label">Hooks</span>
  </div>
  <div class="config-pill">
    <span class="pill-count" style="color:var(--amber)">${configTotal}</span>
    <span class="pill-label">Total</span>
  </div>
</div>

<div class="grid anim d2">
  <div class="card">
    <div class="card-title">📝 Instructions</div>
    ${fileList(config.instructions, "No instruction files found. Create .github/copilot-instructions.md")}
  </div>
  <div class="card">
    <div class="card-title">💬 Prompts</div>
    ${fileList(config.prompts, "No prompt files found. Create .github/prompts/*.prompt.md")}
  </div>
</div>
<div class="grid anim d3">
  <div class="card">
    <div class="card-title">🤖 Custom Agents</div>
    ${fileList(config.agents, "No custom agents found. Create .github/agents/*.md")}
  </div>
  <div class="card">
    <div class="card-title">🛠️ Skills</div>
    ${fileList(config.skills, "No skills found.")}
  </div>
  <div class="card">
    <div class="card-title">🪝 Hooks</div>
    ${fileList(config.hooks, "No hooks found. Create .github/hooks/")}
  </div>
</div>
</div>

<!-- ═══ TAB: Models ═══ -->
<div id="tab-models" class="tab-content">
<div class="section-title anim">🧠 Available Language Models</div>
<div class="card card-wide anim d1">
  ${models.length > 0 ? `
  <table class="data-table">
    <thead><tr><th>Family</th><th>Model ID</th><th>Vendor</th><th>Version</th><th>Max Input Tokens</th></tr></thead>
    <tbody>${modelsRows}</tbody>
  </table>
  ` : '<div class="empty-state">No Copilot language models detected.</div>'}
</div>
</div>

<!-- ═══ TAB: Account ═══ -->
<div id="tab-account" class="tab-content">
<div class="section-title anim">🔐 Account Details</div>
<div class="card card-wide anim d1">
  <div class="stat-row"><span class="stat-label">GitHub Login</span><span class="stat-value">${esc(login)}</span></div>
  <div class="stat-row"><span class="stat-label">Copilot Plan</span><span class="stat-value"><span class="plan-badge ${plan === "free" ? "plan-free" : plan === "business" ? "plan-business" : "plan-pro"}">${esc(plan)}</span></span></div>
  <div class="stat-row"><span class="stat-label">Reset Date</span><span class="stat-value">${resetDate}</span></div>
  ${rawApi?.quota_reset_date_utc ? `<div class="stat-row"><span class="stat-label">Reset Date (UTC)</span><span class="stat-value">${rawApi.quota_reset_date_utc}</span></div>` : ""}
  <div class="stat-row"><span class="stat-label">Models Available</span><span class="stat-value">${models.length}</span></div>
  ${rawApi?.chat_enabled !== undefined ? `<div class="stat-row"><span class="stat-label">Chat Enabled</span><span class="stat-value">${rawApi.chat_enabled ? "✅ Yes" : "❌ No"}</span></div>` : ""}
  ${rawApi?.is_mcp_enabled !== undefined ? `<div class="stat-row"><span class="stat-label">MCP Enabled</span><span class="stat-value">${rawApi.is_mcp_enabled ? "✅ Yes" : "❌ No"}</span></div>` : ""}
  ${rawApi?.copilotignore_enabled !== undefined ? `<div class="stat-row"><span class="stat-label">.copilotignore</span><span class="stat-value">${rawApi.copilotignore_enabled ? "✅ Enabled" : "❌ Disabled"}</span></div>` : ""}
  ${rawApi?.organization_list?.length ? `<div class="stat-row"><span class="stat-label">Organizations</span><span class="stat-value">${rawApi.organization_list.map((o: any) => o.name || o.login).join(", ")}</span></div>` : ""}
  <div class="stat-row"><span class="stat-label">Workspace Config Items</span><span class="stat-value">${configTotal}</span></div>
  <div class="stat-row"><span class="stat-label">Total Router Sessions</span><span class="stat-value">${totalSessions}</span></div>
</div>
</div>

<script>
const vscode = acquireVsCodeApi();
function refresh() { vscode.postMessage({ command: 'refresh' }); }

function openSession(sessionId) { vscode.postMessage({ command: 'openSession', sessionId }); }

function openThread(threadId) { vscode.postMessage({ command: 'openThread', threadId }); }

function switchTab(tabId) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-' + tabId).classList.add('active');
  event.target.classList.add('active');
}
</script>

</body>
</html>`;
}
