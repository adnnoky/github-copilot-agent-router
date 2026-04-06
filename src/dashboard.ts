import * as vscode from "vscode";

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
  tier: "free" | "premium";
  score: number;
  agentMode: boolean;
  boosted: boolean;
  timestamp: number;
  status: "running" | "completed" | "error";
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

export function updateSessionStatus(context: vscode.ExtensionContext, sessionId: string, status: "completed" | "error") {
  const sessions = getStoredSessions(context);
  const s = sessions.find(s => s.id === sessionId);
  if (s) {
    s.status = status;
    context.globalState.update(SESSION_KEY, sessions);
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

  const payload: DashboardPayload = {
    usage, models, rawApi,
    plan: rawApi?.copilot_plan ?? "Unknown",
    login: rawApi?.login ?? "Unknown",
    timestamp: new Date().toLocaleString(),
    sessions: allSessions,
    activeSessions,
    config: wsConfig,
  };

  currentPanel.webview.html = getHtml(payload);
}

// ── HTML Renderer ─────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function getHtml(p: DashboardPayload): string {
  const { usage, models, plan, login, timestamp, sessions, activeSessions, config, rawApi } = p;

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
    const tierBadge = s.tier === "premium"
      ? '<span class="badge badge-premium">Premium</span>'
      : '<span class="badge badge-free">Free</span>';
    return `<tr>
      <td>${statusBadge}</td>
      <td title="${esc(s.prompt)}">${promptSnippet}</td>
      <td><span class="badge badge-blue">${esc(s.model)}</span></td>
      <td>${tierBadge}</td>
      <td>${s.score}</td>
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
  const premiumSessions = sessions.filter(s => s.tier === "premium").length;
  const freeSessions = sessions.filter(s => s.tier === "free").length;
  const errorSessions = sessions.filter(s => s.status === "error").length;
  const boostedSessions = sessions.filter(s => s.boosted).length;

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
    <div class="card-title">🔴 Premium</div>
    <div class="card-value card-value-sm" style="color:var(--red)">${premiumSessions}</div>
  </div>
  <div class="card">
    <div class="card-title">🟢 Free</div>
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

<!-- Session History -->
<div class="section-title anim d3">📜 Session History (Last 30)</div>
<div class="card card-wide anim d3">
  ${recentSessions.length > 0 ? `
  <table class="data-table">
    <thead><tr><th>Status</th><th>Prompt</th><th>Model</th><th>Tier</th><th>Score</th><th>Agent</th><th>Boost</th><th>Time</th></tr></thead>
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
