#!/usr/bin/env node

/**
 * Copilot Starter (copilot-starter)
 * ─────────────────────────────────
 * A beautiful TUI for starting new and resuming past GitHub Copilot CLI sessions.
 *
 * Usage:
 *   copilot-starter            # Launch interactive TUI
 *   copilot-starter --list     # Print sessions as a table (no TUI)
 *   copilot-starter --list N   # Print the latest N sessions
 *   copilot-starter --exclude "pat"  # Exclude sessions matching regex (repeatable)
 *   copilot-starter --version  # Show version
 *   copilot-starter --update   # Update to the latest version
 *
 * Keyboard shortcuts (TUI mode):
 *   ↑/↓           Navigate sessions
 *   Enter          Start new / resume selected session
 *   /              Start search (fuzzy filter)
 *   Esc            Clear search / cancel
 *   p              Filter by project (popup)
 *   s              Cycle sort: time → size → messages → project
 *   n              Start new session
 *   d              Resume with --allow-all (danger mode)
 *   m              Launch mode picker
 *   Home / End     Jump to top / bottom
 *   Ctrl-D/U       Page down / up
 *   c              Copy session ID to clipboard
 *   x / Delete     Delete selected session
 *   q / Ctrl-C     Quit
 *
 * Data source: Copilot CLI stores session metadata and conversation turns in
 * a SQLite database at ~/.copilot/session-store.db, with per-session artifacts
 * under ~/.copilot/session-state/<id>/.  Everything stays local.
 */

const blessed = require('blessed');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const os = require('os');

let excludePatterns = [];

function setExcludePatterns(patterns) { excludePatterns = patterns; }

// ─── CLI Detection ──────────────────────────────────────────────────────────
// Detect whether `mai-copilot` is available (binary, alias, or function).
// First checks PATH directly, then sources shell config non-interactively
// to resolve aliases.  Falls back to plain `copilot`.
//
// NOTE: We deliberately avoid `shell -i` (interactive mode) because it
// triggers SIGTTOU in terminals like Warp that strictly manage TTY process
// groups, causing `suspended (tty output)`.
//
// Returns { name, cmd } where:
//   name = display label ("mai-copilot" or "copilot")
//   cmd  = the actual command string to spawn (resolves aliases)

function detectCLI() {
  const shell = process.env.SHELL || '/bin/sh';

  // 1) Non-interactive: check if mai-copilot exists as a binary on PATH
  try {
    const binPath = execSync('command -v mai-copilot 2>/dev/null', {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3000,
      shell: true,
    }).toString().trim();
    if (binPath) {
      return { name: 'mai-copilot', cmd: 'mai-copilot' };
    }
  } catch { /* not found as binary, continue */ }

  // 2) Source shell config non-interactively to resolve aliases/functions.
  //    This avoids `-i` which would try to claim the TTY and risk SIGTTOU.
  try {
    const isZsh = shell.endsWith('/zsh');
    const rcFile = isZsh
      ? path.join(os.homedir(), '.zshrc')
      : path.join(os.homedir(), '.bashrc');

    if (fs.existsSync(rcFile)) {
      const raw = execSync(
        `${shell} -c 'source "${rcFile}" 2>/dev/null; command -v mai-copilot 2>/dev/null'`,
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 3000,
          env: { ...process.env, PS1: '', PROMPT: '', NO_TTY: '1' },
        },
      ).toString().trim();

      if (raw) {
        const lines = raw.split('\n');
        const aliasLine = lines.find(l => l.startsWith('alias ')) || lines[lines.length - 1];

        const aliasMatch = aliasLine.match(/^alias [^=]+=(?:'(.+)'|"(.+)")$/s);
        if (aliasMatch) {
          return { name: 'mai-copilot', cmd: aliasMatch[1] || aliasMatch[2] };
        }
        return { name: 'mai-copilot', cmd: 'mai-copilot' };
      }
    }
  } catch { /* alias resolution failed, fall back to copilot */ }

  return { name: 'copilot', cmd: 'copilot' };
}

const CLI = detectCLI();

// ─── Color Palette (Tokyo Night) ─────────────────────────────────────────────
const PROJECT_COLORS = [
  '#7aa2f7', '#bb9af7', '#7dcfff', '#9ece6a',
  '#e0af68', '#f7768e', '#73daca', '#ff9e64',
];

// ─── Paths ───────────────────────────────────────────────────────────────────
const COPILOT_DIR = path.join(os.homedir(), '.copilot');
const DB_FILE = path.join(COPILOT_DIR, 'session-store.db');
const SESSION_STATE_DIR = path.join(COPILOT_DIR, 'session-state');
const META_FILE = path.join(COPILOT_DIR, 'copilot-starter-meta.json');

// ─── SQLite Access ───────────────────────────────────────────────────────────
// Copilot CLI stores all session metadata + conversation turns in a single
// SQLite database at ~/.copilot/session-store.db.  We read it via the system
// `sqlite3` binary in read-only JSON mode, which is safe to run against the
// live (WAL-mode) database even while Copilot itself is running.

function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

let _sqliteOk = null;
function sqliteAvailable() {
  if (_sqliteOk !== null) return _sqliteOk;
  try {
    execSync('command -v sqlite3', { stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000 });
    _sqliteOk = true;
  } catch { _sqliteOk = false; }
  return _sqliteOk;
}

function sqliteQuery(sql) {
  if (!fs.existsSync(DB_FILE) || !sqliteAvailable()) return [];
  try {
    const out = execSync(
      `sqlite3 -readonly -json ${shQuote(DB_FILE)} ${shQuote(sql)}`,
      { maxBuffer: 256 * 1024 * 1024, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).toString().trim();
    return out ? JSON.parse(out) : [];
  } catch (e) { return []; }
}

// ─── Session Meta ────────────────────────────────────────────────────
// Stores user-defined metadata (custom titles, launch-mode overrides,
// hidden/deleted sessions) in a simple JSON file alongside Copilot's data.

function loadMeta() {
  try {
    if (fs.existsSync(META_FILE)) {
      const m = JSON.parse(fs.readFileSync(META_FILE, 'utf-8'));
      if (!m.sessions) m.sessions = {};
      if (!m.hidden) m.hidden = {};
      return m;
    }
  } catch (e) { /* corrupt file, start fresh */ }
  return { sessions: {}, hidden: {} };
}

// Launch modes map to real Copilot CLI flags (see modeToFlags).
//   default          → interactive, prompts for permission (no flag)
//   allow-all-tools  → auto-run tools without confirmation
//   allow-all        → allow all tools, paths, and URLs (danger)
//   plan             → start in plan mode
//   autopilot        → autonomous autopilot mode (danger)
const PERMISSION_MODES = ['default', 'allow-all-tools', 'allow-all', 'plan', 'autopilot'];
const DANGER_MODES = new Set(['allow-all-tools', 'allow-all', 'autopilot']);

function isDangerMode(mode) { return DANGER_MODES.has(mode); }

function modeToFlags(mode) {
  switch (mode) {
    case 'allow-all-tools': return ' --allow-all-tools';
    case 'allow-all':       return ' --allow-all';
    case 'plan':            return ' --mode plan';
    case 'autopilot':       return ' --allow-all-tools --mode autopilot';
    default:                return '';
  }
}

function saveMeta(meta) {
  try {
    fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2), 'utf-8');
  } catch (e) { /* silently fail */ }
}

function getSessionMeta(meta, sessionId) {
  return meta.sessions[sessionId] || {};
}

function getEffectivePermissionMode(meta, session) {
  // Priority: per-session override > session's original mode > global default
  const sm = meta.sessions[session.sessionId];
  if (sm && sm.permissionMode) return sm.permissionMode;
  if (session.permissionMode) return session.permissionMode;
  if (meta.defaultPermissionMode) return meta.defaultPermissionMode;
  return '';
}

function setSessionPermissionMode(meta, sessionId, mode) {
  if (!meta.sessions[sessionId]) meta.sessions[sessionId] = {};
  meta.sessions[sessionId].permissionMode = mode || undefined;
  if (!mode) delete meta.sessions[sessionId].permissionMode;
  saveMeta(meta);
}

function setGlobalPermissionMode(meta, mode) {
  meta.defaultPermissionMode = mode || undefined;
  if (!mode) delete meta.defaultPermissionMode;
  saveMeta(meta);
}


// ─── Data Layer ──────────────────────────────────────────────────────────────

function getProjectDisplayName(cwd, repository) {
  // Prefer the repository's short name (e.g. "owner/my-app" → "my-app"),
  // otherwise fall back to the last segment of the working directory.
  if (repository) {
    const parts = String(repository).split('/').filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  if (cwd) {
    const base = path.basename(cwd);
    if (base && base !== '/' && base !== '.') return base;
    if (cwd === os.homedir()) return '~';
  }
  return '~';
}

function cleanUserText(text) {
  if (!text) return '';
  let t = String(text).trim();
  // Skip slash-command / tool envelopes that aren't real user prose.
  if (!t) return '';
  if (t.startsWith('<') && /^<[a-zA-Z/]/.test(t)) return '';
  if (t.startsWith('/') && !/\s/.test(t)) return '';
  return t;
}

// Kept for API/test parity with the original loader: accepts either a raw
// string or a turn-like object and returns cleaned user text.
function extractUserText(d) {
  if (!d) return '';
  if (typeof d === 'string') return cleanUserText(d);
  if (typeof d.user_message === 'string') return cleanUserText(d.user_message);
  if (d.message && typeof d.message === 'object') {
    const content = d.message.content;
    if (typeof content === 'string') return cleanUserText(content);
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c && c.type === 'text' && c.text) return cleanUserText(c.text);
      }
    }
  }
  return '';
}

function folderSize(dir) {
  let total = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try {
        const st = fs.statSync(path.join(dir, f));
        if (st.isFile()) total += st.size;
      } catch { /* skip */ }
    }
  } catch { /* missing dir */ }
  return total;
}

// Normalize a DB sessions row into the session object shape used by the TUI.
function buildSession(row) {
  const sessionId = row.id;
  const cwd = row.cwd || '';
  const repository = row.repository || '';
  const project = getProjectDisplayName(cwd, repository);
  const firstTs = row.created_at || null;
  const lastTs = row.updated_at || row.created_at || null;
  const stateDir = path.join(SESSION_STATE_DIR, sessionId);
  const eventsPath = path.join(stateDir, 'events.jsonl');

  let topic = cleanUserText(row.first_user || '');
  if (!topic && row.summary) topic = String(row.summary).trim();
  topic = topic.replace(/\s+/g, ' ').trim();
  if (topic.length > 120) topic = topic.substring(0, 120) + '…';

  let duration = '';
  if (firstTs && lastTs) {
    const diffMs = new Date(lastTs).getTime() - new Date(firstTs).getTime();
    if (diffMs > 0) {
      const hours = Math.floor(diffMs / 3600000);
      const minutes = Math.floor((diffMs % 3600000) / 60000);
      duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    }
  }

  const hasState = fs.existsSync(stateDir);

  return {
    sessionId,
    project,
    repository,
    topic: topic || '(no user messages)',
    summary: (row.summary || '').trim(),
    userTitle: '',
    permissionMode: '',
    firstTs, lastTs,
    version: '',
    gitBranch: row.branch || '',
    cwd,
    stateDir,
    filePath: eventsPath,
    fileSize: hasState ? folderSize(stateDir) : 0,
    duration,
    estimatedMessages: row.msg_count || 0,
    _detailLoaded: false,
  };
}

const SESSION_SELECT = `
  SELECT s.id, s.cwd, s.repository, s.branch, s.summary, s.created_at, s.updated_at,
         (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS msg_count,
         (SELECT t2.user_message FROM turns t2
            WHERE t2.session_id = s.id AND t2.user_message IS NOT NULL
              AND TRIM(t2.user_message) <> ''
            ORDER BY t2.turn_index ASC LIMIT 1) AS first_user
  FROM sessions s`;

function loadSessionQuick(sessionId) {
  const rows = sqliteQuery(`${SESSION_SELECT} WHERE s.id = ${shQuote(sessionId)}`);
  return rows[0] ? buildSession(rows[0]) : null;
}

function loadSessionDetail(session) {
  if (session._detailLoaded) return session;

  const turns = sqliteQuery(
    `SELECT turn_index, user_message, assistant_response FROM turns
       WHERE session_id = ${shQuote(session.sessionId)} ORDER BY turn_index ASC`);

  const userMessages = [];
  const assistantSnippets = [];
  let total = 0;
  for (const t of turns) {
    const u = cleanUserText(t.user_message);
    if (u) {
      userMessages.push(u.substring(0, 400));
      const a = (t.assistant_response || '').replace(/\s+/g, ' ').trim();
      assistantSnippets.push(a ? a.substring(0, 400) : '');
      total++;
    }
  }

  const tools = sqliteQuery(
    `SELECT DISTINCT tool_name FROM session_files
       WHERE session_id = ${shQuote(session.sessionId)} AND tool_name IS NOT NULL`)
    .map(r => r.tool_name).filter(Boolean);

  const refs = sqliteQuery(
    `SELECT ref_type, ref_value FROM session_refs
       WHERE session_id = ${shQuote(session.sessionId)} LIMIT 12`);

  const fileCount = sqliteQuery(
    `SELECT COUNT(*) AS n FROM session_files WHERE session_id = ${shQuote(session.sessionId)}`);

  session.userMessages = userMessages;
  session.assistantSnippets = assistantSnippets;
  session.totalMessages = total || session.estimatedMessages;
  session.estimatedMessages = session.totalMessages;
  session.toolsUsed = tools;
  session.refs = refs;
  session.fileCount = (fileCount[0] && fileCount[0].n) || 0;
  session._detailLoaded = true;

  if (userMessages.length > 0) {
    let topic = userMessages[0].replace(/\s+/g, ' ').trim();
    if (topic.length > 120) topic = topic.substring(0, 120) + '…';
    session.topic = topic;
  }
  return session;
}

function loadAllSessions() {
  const meta = loadMeta();
  const rows = sqliteQuery(SESSION_SELECT);

  const sessions = [];
  for (const row of rows) {
    try {
      if (meta.hidden && meta.hidden[row.id]) continue;
      const session = buildSession(row);
      if (!session.firstTs) continue;
      // Skip empty shells: no conversation turns and no summary.
      if (session.estimatedMessages === 0 && !session.summary) continue;
      if (excludePatterns.some(re => re.test(session.topic))) continue;
      sessions.push(session);
    } catch (e) { /* skip */ }
  }

  sessions.sort((a, b) => {
    const ta = a.lastTs ? new Date(a.lastTs).getTime() : 0;
    const tb = b.lastTs ? new Date(b.lastTs).getTime() : 0;
    return tb - ta;
  });
  return sessions;
}

// ─── Formatting Helpers ──────────────────────────────────────────────────────

function formatTimestamp(ts) {
  if (!ts) return 'unknown';
  const d = new Date(ts);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((todayStart.getTime() - targetStart.getTime()) / 86400000);
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (diffDays === 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  if (diffDays < 7) return `${diffDays}d ago ${time}`;
  if (diffDays < 365) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / 1048576).toFixed(1)}M`;
}

function getProjectColor(projectName, colorMap) {
  if (!colorMap.has(projectName)) {
    colorMap.set(projectName, PROJECT_COLORS[colorMap.size % PROJECT_COLORS.length]);
  }
  return colorMap.get(projectName);
}

function esc(text) {
  return text.replace(/[{}]/g, m => m === '{' ? '{open}' : '{close}');
}

// Resolve which title to show and where it came from:
//   'user'    → a title the user typed via rename (stored in meta)
//   'summary' → Copilot's own auto-generated session summary
//   'message' → fallback to the first user message
function titleInfo(meta, session) {
  const sm = meta && meta.sessions ? meta.sessions[session.sessionId] : null;
  const userTitle = (sm && sm.customTitle) || session.userTitle || '';
  if (userTitle) return { text: userTitle, source: 'user' };
  if (session.summary) return { text: session.summary, source: 'summary' };
  return { text: session.topic || '', source: 'message' };
}

// ─── CLI Mode (--list) ───────────────────────────────────────────────────────

function runListMode(limit) {
  const sessions = loadAllSessions();
  const meta = loadMeta();
  const display = sessions.slice(0, limit || 30);
  const C = {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    cyan: '\x1b[36m', yellow: '\x1b[33m', green: '\x1b[32m',
    magenta: '\x1b[35m', blue: '\x1b[34m', white: '\x1b[37m',
  };
  console.log(`\n${C.cyan}${C.bold}🤖 Copilot Sessions${C.reset} ${C.dim}(${sessions.length} total, showing ${display.length})${C.reset}\n`);
  console.log(`${C.dim}${'─'.repeat(100)}${C.reset}`);
  console.log(`${C.bold}${'#'.padStart(3)}  ${'Time'.padEnd(18)} ${'Project'.padEnd(18)} ${'Branch'.padEnd(22)} ${'Msgs'.padStart(5)}  ${'Size'.padStart(6)}  Topic${C.reset}`);
  console.log(`${C.dim}${'─'.repeat(100)}${C.reset}`);
  display.forEach((s, i) => {
    const ti = titleInfo(meta, s);
    const topicCol = ti.source === 'user'
      ? `${C.cyan}${C.bold}✎ ${ti.text.substring(0,38)}${C.reset}`
      : ti.source === 'summary'
        ? `${C.white}${ti.text.substring(0,40)}${C.reset}`
        : `${C.dim}${ti.text.substring(0,40)}${C.reset}`;
    console.log(`${C.dim}${`${i+1}`.padStart(3)}${C.reset}  ${C.yellow}${formatTimestamp(s.lastTs).padEnd(18)}${C.reset} ${C.magenta}${s.project.substring(0,17).padEnd(18)}${C.reset} ${C.green}${(s.gitBranch||'').substring(0,21).padEnd(22)}${C.reset} ${C.blue}${`${s.estimatedMessages}`.padStart(5)}${C.reset}  ${C.dim}${formatFileSize(s.fileSize).padStart(6)}${C.reset}  ${topicCol}`);
  });
  console.log(`${C.dim}${'─'.repeat(100)}${C.reset}`);
  console.log(`\n${C.dim}Resume: ${C.cyan}${CLI.name} --resume=<session-id>${C.reset}\n`);
}

// ─── TUI Application ────────────────────────────────────────────────────────

function createApp() {
  const allSessions = loadAllSessions();
  const meta = loadMeta();

  // Attach any user-provided rename (stored in meta). We keep this separate
  // from Copilot's own auto-generated summary so the UI can tell them apart.
  for (const session of allSessions) {
    const sm = meta.sessions[session.sessionId];
    if (sm && sm.customTitle) {
      session.userTitle = sm.customTitle;
    }
  }

  let filteredSessions = [...allSessions];
  let selectedIndex = -1;  // -1 = "New Session", 0+ = session index
  let filterText = '';
  let isSearchMode = false;
  let sortMode = 'time';

  const projectColorMap = new Map();
  const uniqueProjects = [...new Set(allSessions.map(s => s.project))];
  uniqueProjects.forEach(p => getProjectColor(p, projectColorMap));

  // ─── Screen ────────────────────────────────────────────────────────────
  const screen = blessed.screen({
    smartCSR: false,
    fastCSR: false,
    title: 'Copilot Starter',
    fullUnicode: true,
    autoPadding: true,
    dockBorders: true,
  });

  // Force screen-level fill color so no terminal bg leaks through
  screen.style = { bg: 234 };  // 234 = xterm color closest to #1a1b26

  // ─── Header ────────────────────────────────────────────────────────────
  const header = blessed.box({
    parent: screen, top: 0, left: 0, width: '100%', height: 3,
    tags: true, style: { fg: 'white', bg: '#1a1b26' },
  });

  function updateHeader() {
    const title = '{bold}{#7aa2f7-fg}Copilot Starter{/}';
    const count = `{#9ece6a-fg}${filteredSessions.length}{/}{#565f89-fg}/${allSessions.length} sessions{/}`;
    const proj = `{#bb9af7-fg}${uniqueProjects.length}{/}{#565f89-fg} projects{/}`;
    const sort = `{#73daca-fg}[${sortMode}]{/}`;
    const search = isSearchMode
      ? `{#e0af68-fg}/ ${filterText}▌{/}`
      : (filterText ? `{#e0af68-fg}/ ${filterText}{/}` : '');
    let parts = [title, count, proj];
    parts.push(sort);
    if (search) parts.push(search);
    header.setContent(`\n ${parts.join(' {#414868-fg}│{/} ')}`);
  }

  blessed.line({ parent: screen, top: 3, left: 0, width: '100%', orientation: 'horizontal', style: { fg: '#414868', bg: '#1a1b26' } });

  // ─── Left Panel: blessed.list for correct scroll tracking ──────────────
  const listPanel = blessed.list({
    parent: screen,
    top: 4, left: 0, width: '50%', height: '100%-7',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: '▐', style: { fg: '#565f89' } },
    style: {
      bg: '#1a1b26',
      fg: '#a9b1d6',
      selected: { bg: '#3d59a1', fg: 'white', bold: true },
    },
    keys: false,
    vi: false,
    mouse: true,
    interactive: true,
  });

  blessed.line({ parent: screen, top: 4, left: '50%', height: '100%-7', orientation: 'vertical', style: { fg: '#414868', bg: '#1a1b26' } });

  // ─── Right Panel ───────────────────────────────────────────────────────
  const detailPanel = blessed.box({
    parent: screen,
    top: 4, left: '50%+1', width: '50%-1', height: '100%-7',
    tags: true, scrollable: true, alwaysScroll: true,
    scrollbar: { ch: '▐', style: { fg: '#565f89' } },
    style: { bg: '#1a1b26' },
    mouse: true,
  });

  blessed.line({ parent: screen, bottom: 2, left: 0, width: '100%', orientation: 'horizontal', style: { fg: '#414868', bg: '#1a1b26' } });

  // ─── Footer ────────────────────────────────────────────────────────────
  const footer = blessed.box({
    parent: screen, bottom: 0, left: 0, width: '100%', height: 2,
    tags: true, style: { fg: '#a9b1d6', bg: '#1a1b26' },
  });

  function updateFooter() {
    if (isSearchMode) {
      const keys = [
        '{#e0af68-fg}{bold}↵{/} {#e0af68-fg}Confirm{/}',
        '{#7aa2f7-fg}{bold}↑↓{/} {#7aa2f7-fg}Navigate{/}',
        '{#565f89-fg}{bold}⌫{/} {#565f89-fg}Delete char{/}',
        '{#565f89-fg}{bold}Esc{/} {#565f89-fg}Clear{/}',
      ];
      footer.setContent(`\n ${keys.join(' {#414868-fg}│{/} ')}`);
      return;
    }
    const keys = [
      '{#9ece6a-fg}{bold}n{/} {#9ece6a-fg}New{/}',
      '{#7aa2f7-fg}{bold}↵{/} {#7aa2f7-fg}Resume{/}',
      '{#bb9af7-fg}{bold}m{/} {#bb9af7-fg}Mode{/}',
      '{#f7768e-fg}{bold}d{/} {#f7768e-fg}Danger{/}',
      '{#e0af68-fg}{bold}/{/} {#e0af68-fg}Search{/}',
      '{#7dcfff-fg}{bold}p{/} {#7dcfff-fg}Project{/}',
      '{#73daca-fg}{bold}s{/} {#73daca-fg}Sort{/}',
      '{#565f89-fg}{bold}c{/} {#565f89-fg}Copy ID{/}',
      '{#ff9e64-fg}{bold}r{/} {#ff9e64-fg}Rename{/}',
      '{#f7768e-fg}{bold}x{/} {#f7768e-fg}Delete{/}',
      '{#565f89-fg}{bold}q{/} {#565f89-fg}Quit{/}',
    ];
    footer.setContent(`\n ${keys.join(' {#414868-fg}│{/} ')}`);
  }

  // ─── Build list items from sessions ────────────────────────────────────
  function buildListItems() {
    const listW = Math.floor((screen.width || 100) / 2) - 2;

    return filteredSessions.map((session) => {
      const color = getProjectColor(session.project, projectColorMap);
      const proj = `{${color}-fg}${session.project.substring(0, 14).padEnd(14)}{/}`;
      const time = `{#e0af68-fg}${formatTimestamp(session.lastTs).padEnd(18)}{/}`;
      const msgs = `{#7aa2f7-fg}${String(session.estimatedMessages).padStart(4)}{/}{#565f89-fg}msg{/}`;
      const size = `{#565f89-fg}${formatFileSize(session.fileSize).padStart(6)}{/}`;

      const topicMaxLen = Math.max(20, listW - 2);
      let topic = session.topic;
      if (topic.length > topicMaxLen) topic = topic.substring(0, topicMaxLen) + '…';

      const branch = session.gitBranch
        ? `{#73daca-fg}${session.gitBranch.substring(0, 25)}{/}`
        : '';
      const dur = session.duration ? `{#565f89-fg}${session.duration}{/}` : '';

      // Compose a multi-line string for each list item.
      // blessed.list renders each item as a single row, so we pack info densely.
      // Line: project | time | msgs | size
      // (topic + branch shown on next visual line via padding trick)
      let line1 = ` ${proj} ${time} ${msgs} ${size}`;
      let line2 = `   {#a9b1d6-fg}${esc(topic)}{/}`;
      let line3 = branch ? `   ${branch}  ${dur}` : (dur ? `   ${dur}` : '');

      // blessed.list items are single-line, but we can use \n inside them
      // if the list height per item supports it. Unfortunately blessed.list
      // doesn't natively support multi-line items well.
      //
      // So we use a compact two-line format:
      return `${line1}\n${line2}${line3 ? '\n' + line3 : ''}`;
    });
  }

  // ─── Populate list ─────────────────────────────────────────────────────
  // Index 0 = "New Session", index 1+ = sessions
  const NEW_SESSION_LABEL = ' {#9ece6a-fg}{bold}+ New Conversation{/}';

  function refreshList() {
    const listW = Math.floor((screen.width || 100) / 2) - 2;

    const sessionItems = filteredSessions.map((session) => {
      const color = getProjectColor(session.project, projectColorMap);
      const eMode = getEffectivePermissionMode(meta, session);
      const modeIcon = isDangerMode(eMode) ? '{#f7768e-fg}!{/}' : ' ';
      const proj = `{${color}-fg}${session.project.substring(0, 12).padEnd(12)}{/}`;
      const time = `{#e0af68-fg}${formatTimestamp(session.lastTs).padEnd(16)}{/}`;

      const fixedLen = 1 + 12 + 1 + 16 + 1 + 3;
      const ti = titleInfo(meta, session);
      const marker = ti.source === 'user' ? '✎ ' : '';
      const topicMaxLen = Math.max(10, listW - fixedLen - marker.length);
      let topic = ti.text;

      if (topic.length > topicMaxLen) topic = topic.substring(0, topicMaxLen) + '…';

      let label = `${modeIcon}${proj} ${time} `;
      if (ti.source === 'user') {
        label += `{#73daca-fg}{bold}${marker}${esc(topic)}{/}`;
      } else if (ti.source === 'summary') {
        label += `{#a9b1d6-fg}${esc(topic)}{/}`;
      } else {
        label += `{#565f89-fg}${esc(topic)}{/}`;
      }

      return label;
    });

    const items = [NEW_SESSION_LABEL, ...sessionItems];

    listPanel.setItems(items);
    listPanel.select(selectedIndex + 1);  // +1 because index 0 is "New Session"
    screen.render();
  }

  // ─── Render Detail Panel ───────────────────────────────────────────────
  function renderDetail() {
    if (selectedIndex === -1) {
      const cli = CLI.name;
      const defaultMode = meta.defaultPermissionMode || '';
      const modeFlag = modeToFlags(defaultMode);
      let c = '';
      c += `\n {#9ece6a-fg}{bold}Start a New Conversation{/}\n`;
      c += ` {#414868-fg}${'─'.repeat(44)}{/}\n\n`;
      c += ` {#a9b1d6-fg}Open a fresh Copilot session and start{/}\n`;
      c += ` {#a9b1d6-fg}coding from scratch.{/}\n\n`;
      c += ` {#565f89-fg}Working Dir{/}  {#7dcfff-fg}${process.cwd()}{/}\n`;
      c += ` {#565f89-fg}CLI{/}          {#73daca-fg}${cli}{/}\n`;
      if (defaultMode && defaultMode !== 'default') {
        c += ` {#565f89-fg}Mode{/}         {#f7768e-fg}${defaultMode}{/}\n`;
      }
      c += ` {#565f89-fg}Command{/}      {#565f89-fg}${cli}${modeFlag}{/}\n\n`;
      c += ` {#414868-fg}${'─'.repeat(44)}{/}\n`;
      c += ` {#9ece6a-fg}{bold}↵ Enter{/}{#9ece6a-fg} or {/}{#9ece6a-fg}{bold}n{/}{#9ece6a-fg} to launch{/}\n`;
      detailPanel.setContent(c);
      detailPanel.setScroll(0);
      return;
    }

    if (filteredSessions.length === 0 || !filteredSessions[selectedIndex]) {
      detailPanel.setContent('\n  {#565f89-fg}No session selected{/}');
      return;
    }

    const session = filteredSessions[selectedIndex];
    loadSessionDetail(session);

    // Sync any user rename from meta onto the session
    const sm = meta.sessions[session.sessionId];
    if (sm && sm.customTitle) session.userTitle = sm.customTitle;

    const color = getProjectColor(session.project, projectColorMap);
    let c = '';
    const sep = ` {#414868-fg}${'─'.repeat(44)}{/}`;

    // Title
    c += `\n {${color}-fg}{bold}█ ${session.project}{/}\n`;
    const ti = titleInfo(meta, session);
    if (ti.source === 'user') {
      c += ` {#73daca-fg}{bold}✎ ${esc(ti.text)}{/} {#565f89-fg}(your name){/}\n`;
    } else if (ti.source === 'summary') {
      c += ` {#a9b1d6-fg}${esc(ti.text)}{/} {#565f89-fg}(auto summary){/}\n`;
    } else {
      c += ` {#565f89-fg}${esc(ti.text)}{/} {#414868-fg}(first message){/}\n`;
    }
    c += sep + '\n\n';

    const fields = [
      ['Session', `{#7dcfff-fg}${session.sessionId}{/}`],
      ['Started', `{#e0af68-fg}${session.firstTs ? new Date(session.firstTs).toLocaleString() : '?'}{/}`],
      ['Last active', `{#e0af68-fg}${session.lastTs ? new Date(session.lastTs).toLocaleString() : '?'}{/}`],
      ['Duration', `{#9ece6a-fg}${session.duration || '<1m'}{/}`],
      ['Messages', `{#7aa2f7-fg}${session.totalMessages || session.estimatedMessages}{/}`],
      ['Size', `{#bb9af7-fg}${formatFileSize(session.fileSize)}{/}`],
    ];
    if (session.gitBranch) fields.push(['Branch', `{#73daca-fg} ${session.gitBranch}{/}`]);
    if (session.repository) fields.push(['Repository', `{#73daca-fg}${session.repository}{/}`]);
    if (session.cwd) fields.push(['Directory', `{#565f89-fg}${session.cwd}{/}`]);

    const effectiveMode = getEffectivePermissionMode(meta, session);
    if (effectiveMode && effectiveMode !== 'default') {
      const modeColor = isDangerMode(effectiveMode) ? '#f7768e' : '#e0af68';
      fields.push(['Mode', `{${modeColor}-fg}${effectiveMode}{/}`]);
    }

    for (const [label, value] of fields) {
      c += ` {#565f89-fg}${label.padEnd(12)}{/} ${value}\n`;
    }

    if (session.toolsUsed && session.toolsUsed.length > 0) {
      c += `\n {#7dcfff-fg}{bold}Files Touched{/}{#565f89-fg} (${session.fileCount || 0}){/}\n`;
      const chips = session.toolsUsed.slice(0, 10).map(t => `{#414868-fg}[{/}{#7dcfff-fg}${t}{/}{#414868-fg}]{/}`).join(' ');
      c += ` ${chips}\n`;
      if (session.toolsUsed.length > 10) c += ` {#565f89-fg}+${session.toolsUsed.length - 10} more{/}\n`;
    }

    if (session.refs && session.refs.length > 0) {
      c += `\n {#ff9e64-fg}{bold}References{/}\n`;
      const chips = session.refs.slice(0, 8).map(r => `{#414868-fg}[{/}{#ff9e64-fg}${r.ref_type}:${esc(String(r.ref_value).substring(0, 24))}{/}{#414868-fg}]{/}`).join(' ');
      c += ` ${chips}\n`;
    }

    c += `\n {#bb9af7-fg}{bold}Conversation{/}\n`;
    c += sep + '\n';

    const detailHeight = detailPanel.height || screen.height || 24;
    const previewLimit = Math.max(10, Math.floor(Math.max(0, detailHeight - 18) / 3));
    const msgs = (session.userMessages || []).slice(0, previewLimit);
    const assists = (session.assistantSnippets || []);

    if (msgs.length === 0) {
      c += `\n  {#565f89-fg}(no readable messages){/}\n`;
    } else {
      msgs.forEach((msg, i) => {
        const clean = esc(msg.replace(/\n/g, ' ').trim());
        const trunc = clean.length > 80 ? clean.substring(0, 80) + '…' : clean;
        c += `\n {#7aa2f7-fg}{bold}You >{/} ${trunc}\n`;
        if (assists[i]) {
          const aClean = esc(assists[i].replace(/\n/g, ' ').trim());
          const aTrunc = aClean.length > 80 ? aClean.substring(0, 80) + '…' : aClean;
          c += ` {#9ece6a-fg}Copilot >{/} {#565f89-fg}${aTrunc}{/}\n`;
        }
      });
    }

    c += `\n${sep}`;
    c += `\n {#9ece6a-fg}{bold}↵ Enter{/}{#9ece6a-fg} to resume this conversation{/}`;
    c += `\n {#565f89-fg}${CLI.name} --resume=${session.sessionId}{/}\n`;

    detailPanel.setContent(c);
    detailPanel.setScroll(0);
  }

  // ─── Render All ────────────────────────────────────────────────────────
  function renderAll() {
    updateHeader();
    refreshList();
    renderDetail();
    updateFooter();
    listPanel.focus();
    screen.render();
  }

  // ─── Filter ────────────────────────────────────────────────────────────
  function applyFilter() {
    if (!filterText) {
      filteredSessions = [...allSessions];
    } else {
      const terms = filterText.toLowerCase().split(/\s+/);
      filteredSessions = allSessions.filter(s => {
        const haystack = [s.project, s.topic, s.userTitle || '', s.summary || '', s.gitBranch || '', s.sessionId, ...(s.userMessages || [])].join(' ').toLowerCase();

        return terms.every(t => {
          return haystack.includes(t);
        });
      });
    }
    selectedIndex = Math.min(selectedIndex, Math.max(-1, filteredSessions.length - 1));
    // When filtering, select first result; when clearing, select New Session
    if (filterText && filteredSessions.length > 0) {
      selectedIndex = 0;
    }
    listPanel.childBase = 0;  // reset scroll to top
    renderAll();
  }

  // ─── Sort ──────────────────────────────────────────────────────────────
  function cycleSort() {
    const modes = ['time', 'size', 'messages', 'project'];
    sortMode = modes[(modes.indexOf(sortMode) + 1) % modes.length];
    const sorters = {
      time: (a, b) => (new Date(b.lastTs || 0).getTime()) - (new Date(a.lastTs || 0).getTime()),
      size: (a, b) => b.fileSize - a.fileSize,
      messages: (a, b) => b.estimatedMessages - a.estimatedMessages,
      project: (a, b) => a.project.localeCompare(b.project) || (new Date(b.lastTs || 0).getTime()) - (new Date(a.lastTs || 0).getTime()),
    };
    allSessions.sort(sorters[sortMode]);
    selectedIndex = 0;
    applyFilter();
  }

  // ─── Project Picker ────────────────────────────────────────────────────
  let popupOpen = false;

  function showProjectPicker() {
    const projects = ['  All Projects', ...uniqueProjects.map(p => `  ${p}`)];
    const popup = blessed.list({
      parent: screen, top: 'center', left: 'center',
      width: Math.min(50, Math.max(...projects.map(p => p.length)) + 8),
      height: Math.min(projects.length + 4, 20),
      label: ' {bold}{#7aa2f7-fg}Filter by Project{/} ',
      tags: true, border: { type: 'line' },
      style: {
        border: { fg: '#7aa2f7' }, bg: '#24283b', fg: '#a9b1d6',
        selected: { bg: '#3d59a1', fg: 'white', bold: true },
        label: { fg: '#7aa2f7' },
      },
      items: projects, keys: true, vi: true, mouse: true,
    });
    popupOpen = true;
    popup.focus(); screen.render();
    popup.on('select', (item, index) => {
      filterText = index === 0 ? '' : uniqueProjects[index - 1];
      popup.destroy(); popupOpen = false; selectedIndex = 0; applyFilter();
    });
    popup.key(['escape', 'q'], () => { popup.destroy(); popupOpen = false; screen.render(); });
  }

  // ─── Key Bindings ──────────────────────────────────────────────────────

  // Monkey-patch listPanel.select: update selection WITHOUT scrolling.
  const _origSelect = listPanel.select.bind(listPanel);
  listPanel.select = function(index) {
    const sb = this.childBase;
    _origSelect(index);
    this.childBase = sb;
  };

  // Prevent blessed's internal select-on-click from double-firing moveSelection
  let suppressSelectEvent = false;

  listPanel.on('select item', (item, index) => {
    if (suppressSelectEvent) return;
    selectedIndex = index - 1;  // list index 0 = New Session = -1
    renderDetail(); updateHeader(); screen.render();
  });

  function moveSelection(delta) {
    const newIdx = selectedIndex + delta;
    // -1 = New Session, 0..length-1 = sessions
    if (newIdx >= -1 && newIdx < filteredSessions.length) {
      selectedIndex = newIdx;
      const listIdx = selectedIndex + 1;  // list index (0 = New Session row)
      suppressSelectEvent = true;
      listPanel.select(listIdx);
      suppressSelectEvent = false;

      // Scroll only if selection went out of viewport
      const base = listPanel.childBase;
      const visible = listPanel.height;
      if (listIdx < base) {
        listPanel.childBase = listIdx;
      } else if (listIdx >= base + visible) {
        listPanel.childBase = listIdx - visible + 1;
      }

      renderDetail();
      updateHeader();
      screen.render();
    }
  }

  screen.key(['down'], () => {
    if (renameMode || popupOpen) return;
    if (isSearchMode) { isSearchMode = false; updateHeader(); updateFooter(); screen.render(); }
    moveSelection(1);
  });
  screen.key(['up'], () => {
    if (renameMode || popupOpen) return;
    if (isSearchMode) { isSearchMode = false; updateHeader(); updateFooter(); screen.render(); }
    moveSelection(-1);
  });
  screen.key(['home'], () => {
    if (renameMode || popupOpen) return;
    if (isSearchMode) { isSearchMode = false; }
    selectedIndex = -1;
    suppressSelectEvent = true; listPanel.select(0); suppressSelectEvent = false;
    listPanel.childBase = 0;
    renderDetail(); updateHeader(); screen.render();
  });
  screen.key(['end'], () => {
    if (renameMode || popupOpen) return;
    if (isSearchMode) { isSearchMode = false; }
    selectedIndex = Math.max(0, filteredSessions.length - 1);
    suppressSelectEvent = true; listPanel.select(selectedIndex + 1); suppressSelectEvent = false;
    listPanel.childBase = Math.max(0, selectedIndex + 1 - listPanel.height + 1);
    renderDetail(); updateHeader(); screen.render();
  });
  screen.key(['pagedown', 'C-d'], () => {
    if (renameMode || popupOpen) return;
    if (isSearchMode) { isSearchMode = false; updateHeader(); screen.render(); }
    moveSelection(Math.floor((listPanel.height || 20) / 2));
  });
  screen.key(['pageup', 'C-u'], () => {
    if (renameMode || popupOpen) return;
    if (isSearchMode) { isSearchMode = false; updateHeader(); screen.render(); }
    moveSelection(-Math.floor((listPanel.height || 20) / 2));
  });

  // Search
  screen.key(['/'], () => {
    if (renameMode || isSearchMode) return;
    isSearchMode = true;
    if (!filterText) filterText = '';  // keep existing filterText if any
    updateHeader(); updateFooter(); screen.render();
  });

  screen.on('keypress', (ch, key) => {
    // ── Rename mode: capture all input ──
    if (renameMode) {
      if (key.name === 'return' || key.name === 'enter') {
        const session = renameSession;
        const value = renameValue;
        closeRename();
        submitRename(session, value);
        return;
      }
      if (key.name === 'escape') {
        closeRename();
        listPanel.focus();
        screen.render();
        return;
      }
      if (key.name === 'backspace') {
        if (renameValue.length > 0) {
          renameValue = [...renameValue].slice(0, -1).join('');
          renderRenameInput();
        }
        return;
      }
      if (ch && ch.length >= 1 && ch.charCodeAt(0) >= 32 && !key.ctrl && !key.meta) {
        renameValue += ch;
        renderRenameInput();
      }
      return;  // swallow all keys while in rename mode
    }

    // Backspace: delete search char, or exit search mode if empty
    if (key.name === 'backspace') {
      if (filterText) {
        filterText = filterText.slice(0, -1);
        selectedIndex = -1;
        isSearchMode = !!filterText;
        applyFilter();
      } else if (isSearchMode) {
        isSearchMode = false;
        applyFilter();
      }
      return;
    }

    // Vim-like navigation (only when NOT in search mode)
    if (!isSearchMode && !popupOpen) {
      if (ch === 'j') { moveSelection(1); return; }
      if (ch === 'k') { moveSelection(-1); return; }
      if (ch === 'G') {
        selectedIndex = Math.max(0, filteredSessions.length - 1);
        suppressSelectEvent = true; listPanel.select(selectedIndex + 1); suppressSelectEvent = false;
        listPanel.childBase = Math.max(0, selectedIndex + 1 - listPanel.height + 1);
        renderDetail(); updateHeader(); screen.render();
        return;
      }
      if (ch === 'g') {
        selectedIndex = -1;
        suppressSelectEvent = true; listPanel.select(0); suppressSelectEvent = false;
        listPanel.childBase = 0;
        renderDetail(); updateHeader(); screen.render();
        return;
      }
    }

    if (!isSearchMode) return;
    if (key.name === 'return' || key.name === 'enter') { isSearchMode = false; searchJustConfirmed = true; renderAll(); return; }
    if (key.name === 'escape') { isSearchMode = false; filterText = ''; applyFilter(); return; }
    // Only accept printable characters (exclude control chars like \r \n \t)
    if (ch && ch.length === 1 && ch.charCodeAt(0) >= 32 && !key.ctrl && !key.meta) { filterText += ch; selectedIndex = -1; applyFilter(); }
  });

  // ─── Resume Session ─────────────────────────────────────────────────────
  // Auto-detect: use mai-copilot if available, otherwise fall back to copilot

  function resumeSession(session, modeOverride) {
    process.stdout.write('\x1b[0m');
    screen.destroy();

    const label = CLI.name;
    const mode = modeOverride || getEffectivePermissionMode(meta, session);
    const modeFlag = modeToFlags(mode);

    console.log(`\n\x1b[36m⚡ Resuming conversation with ${label}\x1b[0m`);
    console.log(`\x1b[90m   Session: ${session.sessionId}\x1b[0m`);
    console.log(`\x1b[90m   Project: ${session.project}  │  Branch: ${session.gitBranch || 'N/A'}  │  Messages: ${session.estimatedMessages}\x1b[0m`);
    if (mode && mode !== 'default') console.log(`\x1b[33m   Mode: ${mode}\x1b[0m`);
    console.log('');

    const child = spawn(
      `${CLI.cmd} --resume=${session.sessionId}${modeFlag}`,
      { stdio: 'inherit', cwd: session.cwd || process.cwd(), shell: true },
    );
    child.on('error', (err) => {
      console.error(`\x1b[31mFailed to resume: ${err.message}\x1b[0m`);
      console.log(`\x1b[33mManual: ${label} --resume=${session.sessionId}${modeFlag}\x1b[0m`);
      process.exit(1);
    });
    child.on('exit', (code) => process.exit(code || 0));
  }

  function startNewSession() {
    process.stdout.write('\x1b[0m');
    screen.destroy();

    const label = CLI.name;
    const mode = meta.defaultPermissionMode || '';
    const modeFlag = modeToFlags(mode);

    console.log(`\n\x1b[36m✨ Starting new conversation with ${label}\x1b[0m`);
    if (mode && mode !== 'default') console.log(`\x1b[33m   Mode: ${mode}\x1b[0m`);
    console.log('');

    const cmd = modeFlag ? `${CLI.cmd}${modeFlag}` : CLI.cmd;
    const child = spawn(cmd, { stdio: 'inherit', cwd: process.cwd(), shell: true });
    child.on('error', (err) => {
      console.error(`\x1b[31mFailed to start: ${err.message}\x1b[0m`);
      process.exit(1);
    });
    child.on('exit', (code) => process.exit(code || 0));
  }

  // Track the rename confirm popup and its session for Enter handling
  let renameConfirmPopup = null;
  let renameConfirmSession = null;
  let searchJustConfirmed = false;

  screen.key(['enter'], () => {
    if (renameMode) return;
    if (renameJustFinished) return;
    if (searchJustConfirmed) { searchJustConfirmed = false; return; }
    // Handle rename confirm popup Enter
    if (renameConfirmPopup && popupOpen) {
      const session = renameConfirmSession;
      renameConfirmPopup.destroy();
      renameConfirmPopup = null;
      renameConfirmSession = null;
      popupOpen = false;
      resumeSession(session);
      return;
    }
    if (isSearchMode) { isSearchMode = false; renderAll(); return; }
    if (popupOpen) return;
    if (selectedIndex === -1) { startNewSession(); return; }
    if (filteredSessions.length === 0) return;
    resumeSession(filteredSessions[selectedIndex]);
  });

  // Quick shortcut: n = new session
  screen.key(['n'], () => {
    if (renameMode || isSearchMode) return;
    startNewSession();
  });

  // Copy session ID
  screen.key(['c'], () => {
    if (renameMode || isSearchMode) return;
    if (filteredSessions.length === 0) return;
    const sid = filteredSessions[selectedIndex].sessionId;
    try {
      const proc = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
      proc.stdin.write(sid); proc.stdin.end();
      footer.setContent(`\n  {#9ece6a-fg}{bold}✓ Copied:{/} {#7dcfff-fg}${sid}{/}`);
      screen.render();
      setTimeout(() => { updateFooter(); screen.render(); }, 1500);
    } catch (e) { /* silently fail */ }
  });


  // ─── Permission Mode Picker ──────────────────────────────────────────────

  function showResumeConfirm(session) {
    // Delay to avoid the Enter key from mode picker leaking into this popup
    setTimeout(() => {
      const mode = getEffectivePermissionMode(meta, session);
      const modeLabel = (mode && mode !== 'default') ? `{#bb9af7-fg}${mode}{/}` : '{#565f89-fg}default{/}';
      const confirmPopup = blessed.box({
        parent: screen, top: 'center', left: 'center',
        width: 44, height: 7,
        label: ' {bold}{#9ece6a-fg}Resume?{/} ',
        tags: true, border: { type: 'line' },
        style: {
          border: { fg: '#9ece6a' }, bg: '#24283b', fg: '#a9b1d6',
          label: { fg: '#9ece6a' },
        },
        content: `\n  Mode: ${modeLabel}\n\n  {#9ece6a-fg}{bold}Enter{/}{#a9b1d6-fg} Resume  {/}{#565f89-fg}Esc{/}{#a9b1d6-fg} Cancel{/}`,
      });
      popupOpen = true;
      confirmPopup.focus();
      screen.render();

      confirmPopup.key(['enter', 'return'], () => {
        confirmPopup.destroy();
        popupOpen = false;
        resumeSession(session);
      });
      confirmPopup.key(['escape', 'q'], () => {
        confirmPopup.destroy();
        popupOpen = false;
        renderAll();
      });
    }, 50);
  }

  function showPermissionModePicker(session) {
    const currentSessionMode = (meta.sessions[session.sessionId] && meta.sessions[session.sessionId].permissionMode) || '';
    const currentGlobalMode = meta.defaultPermissionMode || '';
    const effectiveMode = getEffectivePermissionMode(meta, session);

    const items = [
      '  {#bb9af7-fg}{bold}── Session Override ──{/}',
      ...PERMISSION_MODES.map(m => {
        const checked = currentSessionMode === m ? '{#9ece6a-fg}✓{/}' : ' ';
        const label = m === 'default' ? 'default (none)' : m;
        return `  ${checked} {#a9b1d6-fg}${label}{/}`;
      }),
      '  {#7aa2f7-fg}{bold}Clear session override{/}',
      '',
      '  {#bb9af7-fg}{bold}── Global Default ──{/}',
      ...PERMISSION_MODES.map(m => {
        const checked = currentGlobalMode === m ? '{#9ece6a-fg}✓{/}' : ' ';
        const label = m === 'default' ? 'default (none)' : m;
        return `  ${checked} {#a9b1d6-fg}${label}{/}`;
      }),
      '  {#7aa2f7-fg}{bold}Clear global default{/}',
    ];

    const popup = blessed.list({
      parent: screen, top: 'center', left: 'center',
      width: 42,
      height: Math.min(items.length + 4, 24),
      label: ' {bold}{#bb9af7-fg}Launch Mode{/} ',
      tags: true, border: { type: 'line' },
      style: {
        border: { fg: '#bb9af7' }, bg: '#24283b', fg: '#a9b1d6',
        selected: { bg: '#3d59a1', fg: 'white', bold: true },
        label: { fg: '#bb9af7' },
      },
      items: items, keys: true, vi: true, mouse: true,
    });
    popupOpen = true;
    popup.focus(); screen.render();

    // Section header indices (0-indexed)
    const sessionHeaderIdx = 0;
    const sessionClearIdx = PERMISSION_MODES.length + 1;
    const spacerIdx = sessionClearIdx + 1;
    const globalHeaderIdx = spacerIdx + 1;
    const globalClearIdx = globalHeaderIdx + PERMISSION_MODES.length + 1;

    popup.on('select', (item, index) => {
      // Skip headers and spacer
      if (index === sessionHeaderIdx || index === globalHeaderIdx || index === spacerIdx) return;

      if (index === sessionClearIdx) {
        // Clear session override
        setSessionPermissionMode(meta, session.sessionId, '');
        popup.destroy(); popupOpen = false; renderAll();
        showResumeConfirm(session);
        return;
      }

      if (index === globalClearIdx) {
        // Clear global default
        setGlobalPermissionMode(meta, '');
        footer.setContent(`\n  {#9ece6a-fg}{bold}> Global default mode cleared{/}`);
        popup.destroy(); popupOpen = false; renderAll();
        setTimeout(() => { updateFooter(); screen.render(); }, 1500);
        return;
      }

      // Session mode selection (indices 1 to PERMISSION_MODES.length)
      if (index > sessionHeaderIdx && index <= sessionClearIdx - 1) {
        const mode = PERMISSION_MODES[index - 1];
        setSessionPermissionMode(meta, session.sessionId, mode === 'default' ? '' : mode);
        popup.destroy(); popupOpen = false; renderAll();
        showResumeConfirm(session);
        return;
      }

      // Global mode selection
      if (index > globalHeaderIdx && index <= globalClearIdx - 1) {
        const mode = PERMISSION_MODES[index - globalHeaderIdx - 1];
        setGlobalPermissionMode(meta, mode === 'default' ? '' : mode);
        footer.setContent(`\n  {#9ece6a-fg}{bold}> Global default:{/} {#bb9af7-fg}${mode}{/}`);
        popup.destroy(); popupOpen = false; renderAll();
        setTimeout(() => { updateFooter(); screen.render(); }, 1500);
        return;
      }
    });

    popup.key(['escape', 'q'], () => {
      popup.destroy();
      popupOpen = false;
      renderAll();
    });
  }

  // ─── Quick dangerous resume (d key) ────────────────────────────────────
  screen.key(['d'], () => {
    if (renameMode || isSearchMode || popupOpen) return;
    if (selectedIndex < 0 || selectedIndex >= filteredSessions.length) return;
    resumeSession(filteredSessions[selectedIndex], 'allow-all');
  });

  // ─── Permission mode picker (m key) ───────────────────────────────────
  screen.key(['m'], () => {
    if (renameMode || isSearchMode || popupOpen) return;
    if (selectedIndex < 0 || selectedIndex >= filteredSessions.length) return;
    showPermissionModePicker(filteredSessions[selectedIndex]);
  });

  // ─── Delete Session ───────────────────────────────────────────────────
  function deleteSession(session) {
    try {
      // Hide from copilot-starter (the session stays in Copilot's own store
      // unless its on-disk state is also removed below).
      if (!meta.hidden) meta.hidden = {};
      meta.hidden[session.sessionId] = true;
      if (meta.sessions[session.sessionId]) delete meta.sessions[session.sessionId];
      saveMeta(meta);
      // Best-effort: remove the on-disk session-state folder to reclaim space.
      try {
        if (session.stateDir && fs.existsSync(session.stateDir)) {
          fs.rmSync(session.stateDir, { recursive: true, force: true });
        }
      } catch (e) { /* ignore */ }
      // Remove from in-memory arrays
      const allIdx = allSessions.indexOf(session);
      if (allIdx !== -1) allSessions.splice(allIdx, 1);
      const filtIdx = filteredSessions.indexOf(session);
      if (filtIdx !== -1) filteredSessions.splice(filtIdx, 1);
      // Adjust selection
      if (selectedIndex >= filteredSessions.length) {
        selectedIndex = Math.max(-1, filteredSessions.length - 1);
      }
    } catch (e) { /* silently fail */ }
  }

  function showDeleteConfirm(session) {
    const topic = (session.userTitle || session.summary || session.topic || '').substring(0, 30);
    const confirmPopup = blessed.box({
      parent: screen, top: 'center', left: 'center',
      width: 50, height: 9,
      label: ' {bold}{#f7768e-fg}Delete Session?{/} ',
      tags: true, border: { type: 'line' },
      style: {
        border: { fg: '#f7768e' }, bg: '#24283b', fg: '#a9b1d6',
        label: { fg: '#f7768e' },
      },
      content:
        `\n  {#a9b1d6-fg}${esc(topic)}{/}\n`
        + `  {#565f89-fg}${session.sessionId}{/}\n\n`
        + `  {#f7768e-fg}{bold}y{/}{#a9b1d6-fg} Delete  {/}{#565f89-fg}n / Esc{/}{#a9b1d6-fg} Cancel{/}`,
    });
    popupOpen = true;
    confirmPopup.focus();
    screen.render();

    confirmPopup.key(['y'], () => {
      confirmPopup.destroy();
      popupOpen = false;
      deleteSession(session);
      footer.setContent(`\n  {#f7768e-fg}{bold}✗ Deleted:{/} {#565f89-fg}${session.sessionId}{/}`);
      renderAll();
      setTimeout(() => { updateFooter(); screen.render(); }, 1500);
    });
    confirmPopup.key(['n', 'escape', 'q'], () => {
      confirmPopup.destroy();
      popupOpen = false;
      screen.render();
    });
  }

  screen.key(['x', 'delete'], () => {
    if (renameMode || isSearchMode || popupOpen) return;
    if (selectedIndex < 0 || selectedIndex >= filteredSessions.length) return;
    showDeleteConfirm(filteredSessions[selectedIndex]);
  });

  // ─── Rename Session ───────────────────────────────────────────────────
  const stringWidth = require('string-width');
  let renameMode = false;
  let renameJustFinished = false;
  let renameValue = '';
  let renameSession = null;
  let renamePopup = null;
  let renameDisplay = null;
  const renameMaxWidth = 46;

  function renderRenameInput() {
    let display = renameValue;
    while (stringWidth(display) > renameMaxWidth && display.length > 0) {
      display = display.substring(1);
    }
    renameDisplay.setContent(display + '▌');
    screen.render();
  }

  function showRenameInput(session) {
    renameSession = session;
    renameValue = session.userTitle || '';

    renamePopup = blessed.box({
      parent: screen, top: 'center', left: 'center',
      width: 52, height: 7,
      label: ' {bold}{#73daca-fg}Rename Session{/} ',
      tags: true, border: { type: 'line' },
      style: {
        border: { fg: '#73daca' }, bg: '#24283b', fg: '#a9b1d6',
        label: { fg: '#73daca' },
      },
    });

    renameDisplay = blessed.box({
      parent: renamePopup,
      top: 1, left: 1, right: 1, height: 1,
      tags: false,
      style: { fg: 'white', bg: '#1a1b26' },
    });

    blessed.box({
      parent: renamePopup,
      top: 3, left: 1, right: 1, height: 1,
      tags: true,
      style: { bg: '#24283b' },
      content: '  {#9ece6a-fg}{bold}Enter{/}{#a9b1d6-fg} Save  {/}{#565f89-fg}Esc{/}{#a9b1d6-fg} Cancel{/}',
    });

    popupOpen = true;
    renameMode = true;
    renderRenameInput();
  }

  function closeRename() {
    renameMode = false;
    if (renamePopup) { renamePopup.destroy(); renamePopup = null; }
    popupOpen = false;
    renameSession = null;
    renameDisplay = null;
  }

  function submitRename(session, newTitle) {
    newTitle = (newTitle || '').trim();

    // Save to meta
    if (!meta.sessions[session.sessionId]) meta.sessions[session.sessionId] = {};
    meta.sessions[session.sessionId].customTitle = newTitle || undefined;
    if (!newTitle) delete meta.sessions[session.sessionId].customTitle;
    saveMeta(meta);

    // Update in-memory session (empty clears back to summary/first-message)
    session.userTitle = newTitle || '';

    renderAll();

    // Ask whether to resume this session after rename
    // We use renameJustFinished flag to prevent the Enter key from rename
    // from immediately triggering resume
    renameJustFinished = true;
    setTimeout(() => { renameJustFinished = false; }, 200);

    setTimeout(() => {
      const titleLabel = newTitle ? `{#73daca-fg}${esc(newTitle)}{/}` : '{#565f89-fg}(title cleared){/}';
      renameConfirmSession = session;
      renameConfirmPopup = blessed.box({
        parent: screen, top: 'center', left: 'center',
        width: 48, height: 8,
        label: ' {bold}{#9ece6a-fg}Renamed{/} ',
        tags: true, border: { type: 'line' },
        style: {
          border: { fg: '#9ece6a' }, bg: '#24283b', fg: '#a9b1d6',
          label: { fg: '#9ece6a' },
        },
        content: `\n  ${titleLabel}\n\n  {#9ece6a-fg}{bold}Enter{/}{#a9b1d6-fg} Resume  {/}{#565f89-fg}Esc{/}{#a9b1d6-fg} Back to list{/}`,
      });
      popupOpen = true;
      renameConfirmPopup.focus();
      screen.render();

      renameConfirmPopup.key(['escape', 'q'], () => {
        renameConfirmPopup.destroy();
        renameConfirmPopup = null;
        renameConfirmSession = null;
        popupOpen = false;
        renderAll();
      });
    }, 50);
  }

  screen.key(['r'], () => {
    if (isSearchMode || popupOpen) return;
    if (selectedIndex < 0 || selectedIndex >= filteredSessions.length) return;
    showRenameInput(filteredSessions[selectedIndex]);
  });

  screen.key(['s'], () => { if (!renameMode && !isSearchMode) cycleSort(); });
  screen.key(['p'], () => { if (!renameMode && !isSearchMode) showProjectPicker(); });
  screen.key(['escape'], () => {
    if (renameMode) return;  // handled in keypress
    if (isSearchMode) { isSearchMode = false; filterText = ''; applyFilter(); return; }
    filterText = ''; selectedIndex = -1; applyFilter();
  });
  screen.key(['q', 'C-c'], () => { if (renameMode) return; process.stdout.write('\x1b[0m'); screen.destroy(); process.exit(0); });

  // Remove blessed's built-in wheel handlers (they call select which changes selection)
  listPanel.removeAllListeners('element wheeldown');
  listPanel.removeAllListeners('element wheelup');

  // Mouse wheel on list — scroll viewport, keep selection in view
  function clampSelection() {
    const base = listPanel.childBase;
    const visible = listPanel.height;
    const listIdx = selectedIndex + 1;  // +1 for New Session row
    if (listIdx < base) {
      selectedIndex = base - 1;  // -1 to convert back
      suppressSelectEvent = true; listPanel.select(base); suppressSelectEvent = false;
      renderDetail(); updateHeader();
    } else if (listIdx >= base + visible) {
      selectedIndex = base + visible - 1 - 1;  // -1 for list→session offset
      suppressSelectEvent = true; listPanel.select(base + visible - 1); suppressSelectEvent = false;
      renderDetail(); updateHeader();
    }
  }

  listPanel.on('element wheeldown', () => {
    const maxBase = Math.max(0, listPanel.items.length - listPanel.height);
    if (listPanel.childBase < maxBase) {
      listPanel.childBase++;
      clampSelection();
      screen.render();
    }
  });
  listPanel.on('element wheelup', () => {
    if (listPanel.childBase > 0) {
      listPanel.childBase--;
      clampSelection();
      screen.render();
    }
  });

  // Mouse wheel on detail
  detailPanel.on('wheeldown', () => { detailPanel.scroll(2); screen.render(); });
  detailPanel.on('wheelup', () => { detailPanel.scroll(-2); screen.render(); });

  // ─── Go! ───────────────────────────────────────────────────────────────
  renderAll();
  listPanel.focus();
}

// ─── Exports for Testing ────────────────────────────────────────────────────
// When required as a module (e.g. by tests), export helpers without launching
// the CLI / TUI.  The entry-point logic only runs when executed directly.

if (typeof module !== 'undefined') {
  module.exports = {
    // Data helpers
    getProjectDisplayName,
    extractUserText,
    loadSessionQuick,
    loadSessionDetail,
    loadAllSessions,
    // Formatting
    formatTimestamp,
    formatFileSize,
    getProjectColor,
    esc,
    // Meta
    loadMeta,
    saveMeta,
    getSessionMeta,
    getEffectivePermissionMode,
    setSessionPermissionMode,
    setGlobalPermissionMode,
    setExcludePatterns,
    // Constants
    PERMISSION_MODES,
    PROJECT_COLORS,
    COPILOT_DIR,
    DB_FILE,
    SESSION_STATE_DIR,
    META_FILE,
    // Mode helpers
    modeToFlags,
    isDangerMode,
    // CLI
    detectCLI,
    // List mode (for integration tests)
    runListMode,
    // TUI (for interaction tests)
    createApp,
  };
}

// ─── Entry Point ─────────────────────────────────────────────────────────────
// Only run CLI/TUI when executed directly (not when required as a module).

if (require.main === module) {
  const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));

  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--exclude' && args[i + 1]) {
      try { excludePatterns.push(new RegExp(args[i + 1], 'i')); } catch {}
      i++;
    }
  }
  if (process.env.COPILOT_STARTER_EXCLUDE) {
    for (const p of process.env.COPILOT_STARTER_EXCLUDE.split(',')) {
      if (p.trim()) {
        try { excludePatterns.push(new RegExp(p.trim(), 'i')); } catch {}
      }
    }
  }

  if (args.includes('--version') || args.includes('-v') || args.includes('-V')) {
    console.log(`copilot-starter v${PKG.version}`);
    process.exit(0);
  }

  if (args.includes('--update') || args.includes('-u')) {
    const C = {
      reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
      cyan: '\x1b[36m', yellow: '\x1b[33m', green: '\x1b[32m',
      red: '\x1b[31m',
    };
    console.log(`\n${C.cyan}🔄 Checking for updates…${C.reset}\n`);

    try {
      const latest = execSync('npm view copilot-starter version 2>/dev/null', {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      }).toString().trim();

      if (latest === PKG.version) {
        console.log(`${C.green}✓ Already on the latest version (v${PKG.version})${C.reset}\n`);
        process.exit(0);
      }

      console.log(`${C.yellow}  Current: v${PKG.version}${C.reset}`);
      console.log(`${C.green}  Latest:  v${latest}${C.reset}\n`);
      console.log(`${C.cyan}📦 Updating…${C.reset}\n`);

      try {
        execSync('npm install -g copilot-starter@latest', { stdio: 'inherit', timeout: 60000 });
        console.log(`\n${C.green}${C.bold}✓ Updated to v${latest}${C.reset}\n`);
      } catch (e) {
        console.error(`\n${C.red}✗ Update failed. Try manually:${C.reset}`);
        console.log(`${C.yellow}  npm install -g copilot-starter@latest${C.reset}\n`);
        process.exit(1);
      }
    } catch (e) {
      console.error(`${C.red}✗ Could not check for updates (network error or npm not found)${C.reset}\n`);
      process.exit(1);
    }

    process.exit(0);
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
\x1b[36m🤖 Copilot Starter\x1b[0m  \x1b[2mv${PKG.version}\x1b[0m

Usage:
  copilot-starter              Launch interactive TUI
  copilot-starter --list [N]   Print latest N sessions (default: 30)
  copilot-starter --exclude "pat"  Exclude sessions matching regex (repeatable)
  copilot-starter --version    Show version
  copilot-starter --update     Update to the latest version
  copilot-starter --help       Show this help

Environment Variables:
  COPILOT_STARTER_EXCLUDE=pat1,pat2   Comma-separated regex patterns to exclude

TUI Keyboard Shortcuts:
  ↑/↓           Navigate sessions
  Enter         Start new / resume selected session
  n             Start new session
  d             Resume with --allow-all (danger mode)
  m             Launch mode picker
  /             Search (fuzzy filter)
  p             Filter by project
  s             Cycle sort mode (time/size/messages/project)
  c             Copy session ID
  x / Delete    Delete selected session
  Home / End    Jump to top / bottom
  Ctrl-D/U      Page down / up
  Esc           Clear filter
  q / Ctrl-C    Quit
`);
    process.exit(0);
  }

  if (args.includes('--list') || args.includes('-l')) {
    const limitIdx = args.indexOf('--list') !== -1 ? args.indexOf('--list') : args.indexOf('-l');
    const limit = parseInt(args[limitIdx + 1]) || 30;
    runListMode(limit);
    process.exit(0);
  }

  createApp();
}
