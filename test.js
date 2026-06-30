'use strict';

// ─── Copilot Starter — Data Layer Tests ─────────────────────────────────────
// These tests exercise the SQLite-backed data layer and pure helpers against
// the real ~/.copilot/session-store.db when present.  They are tolerant of an
// empty/missing database so they pass in CI environments without Copilot.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cs = require('./index.js');

const DB_EXISTS = fs.existsSync(path.join(os.homedir(), '.copilot', 'session-store.db'));

test('exports the expected public surface', () => {
  for (const name of [
    'loadAllSessions', 'loadSessionQuick', 'loadSessionDetail',
    'getProjectDisplayName', 'extractUserText', 'modeToFlags', 'isDangerMode',
    'formatTimestamp', 'formatFileSize', 'esc', 'loadMeta', 'detectCLI',
    'PERMISSION_MODES', 'COPILOT_DIR', 'DB_FILE', 'SESSION_STATE_DIR',
  ]) {
    assert.ok(name in cs, `missing export: ${name}`);
  }
});

test('getProjectDisplayName prefers repo short name, then cwd basename', () => {
  assert.strictEqual(cs.getProjectDisplayName('/Users/x/dev/my-app', 'owner/my-repo'), 'my-repo');
  assert.strictEqual(cs.getProjectDisplayName('/Users/x/dev/my-app', ''), 'my-app');
  assert.strictEqual(cs.getProjectDisplayName('', ''), '~');
});

test('modeToFlags maps launch modes to real Copilot flags', () => {
  assert.strictEqual(cs.modeToFlags('default'), '');
  assert.strictEqual(cs.modeToFlags('allow-all-tools'), ' --allow-all-tools');
  assert.strictEqual(cs.modeToFlags('allow-all'), ' --allow-all');
  assert.strictEqual(cs.modeToFlags('plan'), ' --mode plan');
  assert.ok(cs.modeToFlags('autopilot').includes('--mode autopilot'));
});

test('isDangerMode flags the destructive modes', () => {
  assert.ok(cs.isDangerMode('allow-all'));
  assert.ok(cs.isDangerMode('allow-all-tools'));
  assert.ok(cs.isDangerMode('autopilot'));
  assert.ok(!cs.isDangerMode('default'));
  assert.ok(!cs.isDangerMode('plan'));
});

test('extractUserText cleans strings and turn-like objects', () => {
  assert.strictEqual(cs.extractUserText('  hello  '), 'hello');
  assert.strictEqual(cs.extractUserText({ user_message: 'hi there' }), 'hi there');
  assert.strictEqual(cs.extractUserText('<system_notification>noise</system_notification>'), '');
  assert.strictEqual(cs.extractUserText(null), '');
});

test('esc neutralizes blessed tag braces', () => {
  assert.strictEqual(cs.esc('a{b}c'), 'a{open}b{close}c');
});

test('formatFileSize is human readable', () => {
  assert.strictEqual(cs.formatFileSize(512), '512B');
  assert.strictEqual(cs.formatFileSize(2048), '2K');
  assert.match(cs.formatFileSize(2 * 1048576), /M$/);
});

test('detectCLI returns a copilot command', () => {
  const cli = cs.detectCLI();
  assert.ok(cli && cli.cmd);
  assert.match(cli.name, /copilot/);
});

test('loadAllSessions returns well-formed session objects', () => {
  const sessions = cs.loadAllSessions();
  assert.ok(Array.isArray(sessions));
  if (!DB_EXISTS || sessions.length === 0) return; // tolerate empty store

  // Sorted newest-first
  for (let i = 1; i < sessions.length; i++) {
    const a = new Date(sessions[i - 1].lastTs).getTime();
    const b = new Date(sessions[i].lastTs).getTime();
    assert.ok(a >= b, 'sessions must be sorted by lastTs desc');
  }

  const s = sessions[0];
  for (const f of ['sessionId', 'project', 'topic', 'cwd', 'stateDir', 'firstTs', 'lastTs']) {
    assert.ok(f in s, `session missing field: ${f}`);
  }
  assert.match(s.sessionId, /[0-9a-f-]{8}/i);
});

test('loadSessionDetail enriches a session with conversation data', () => {
  const sessions = cs.loadAllSessions();
  if (!DB_EXISTS || sessions.length === 0) return;
  const detail = cs.loadSessionDetail(sessions[0]);
  assert.ok(Array.isArray(detail.userMessages));
  assert.ok(Array.isArray(detail.assistantSnippets));
  assert.ok(Array.isArray(detail.toolsUsed));
  assert.strictEqual(detail._detailLoaded, true);
  // user/assistant arrays stay index-aligned
  assert.strictEqual(detail.userMessages.length, detail.assistantSnippets.length);
});

test('loadSessionQuick(id) round-trips a known session', () => {
  const sessions = cs.loadAllSessions();
  if (!DB_EXISTS || sessions.length === 0) return;
  const again = cs.loadSessionQuick(sessions[0].sessionId);
  assert.ok(again);
  assert.strictEqual(again.sessionId, sessions[0].sessionId);
});
