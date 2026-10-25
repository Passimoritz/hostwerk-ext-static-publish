'use strict';
// Deploy log – recognising Hostwerk's events and the bookkeeping (no Hostwerk needed).
const test = require('node:test');
const assert = require('node:assert');
const L = require('../server/deploylog-lib');

const look = {
  target: (id) => (id === 't1' ? { projectId: 'p1', projectPath: 'C:/web/shop', name: 'Live server', type: 'sftp', pass: 'sealed' } : null),
  site: (id) => (id === 's1' ? { id: 's1', name: 'Docs', dir: 'C:\\web\\shop\\docs', target: 'github' } : id === 's2' ? { id: 's2', name: 'Loose site', dir: 'D:/other', target: 'cloudflare' } : null),
  project: (id) => (id === 'p1' ? { id: 'p1', name: 'Shop', path: 'C:/web/shop' } : null),
  projectByPath: (d) => (L.samePath(d, 'C:/web/shop', { inside: true, win: true }) ? { id: 'p1', name: 'Shop', path: 'C:/web/shop' } : null),
};
const job = (key, state, extra = {}) => ({ type: 'job', job: { id: `j-${key}-${state}`, key, state, startedAt: 1000, endedAt: 4000, ...extra } });

test('Veröffentlichen (Deploy) fertig → Eintrag mit Ziel und Zahlen, ohne Zugangsdaten', () => {
  const e = L.classify(job('deploy-t1', 'done', { result: { ok: true, uploaded: 12, removed: 1, ms: 3000, secret: 'x' } }), look);
  assert.deepStrictEqual([e.kind, e.projectId, e.projectName, e.ok, e.ms], ['deploy', 'p1', 'Shop', true, 3000]);
  assert.deepStrictEqual(e.target, { id: 't1', name: 'Live server', type: 'sftp' });
  assert.deepStrictEqual(e.result, { uploaded: 12, removed: 1 });
  assert.ok(!JSON.stringify(e).includes('sealed'));
});

test('Deploy fehlgeschlagen oder abgebrochen; laufende Aufgaben und fremde Schlüssel zählen nicht', () => {
  const bad = L.classify(job('deploy-t1', 'error', { error: 'Login failed' }), look);
  assert.deepStrictEqual([bad.ok, bad.error], [false, 'Login failed']);
  assert.strictEqual(L.classify(job('deploy-t1', 'cancelled'), look).error, 'cancelled');
  assert.strictEqual(L.classify(job('deploy-t1', 'running'), look), null);
  assert.strictEqual(L.classify(job('deploy-unknown', 'done'), look), null);
  assert.strictEqual(L.classify(job('snapshot-auto-p1', 'done'), look), null);
  assert.strictEqual(L.classify(job('rollback-deploy-log-p1', 'done'), look), null);
  assert.strictEqual(L.classify({ type: 'toast' }, look), null);
  assert.strictEqual(L.classify(null, look), null);
});

test('„Seiten veröffentlichen“: Projekt über den Ordner gefunden, sonst eigener Eintrag für die Seite', () => {
  const a = L.classify(job('static-publish-s1', 'done', { result: { url: 'https://me.github.io/docs/' } }), look);
  assert.deepStrictEqual([a.kind, a.projectId, a.target.type, a.result.url], ['publish', 'p1', 'github', 'https://me.github.io/docs/']);
  const b = L.classify(job('static-publish-s2', 'error', { error: 'build failed' }), look);
  assert.deepStrictEqual([b.projectId, b.projectName, b.target.type, b.ok], ['site-s2', 'Loose site', 'cloudflare', false]);
});

test('Git-Pull kommt aus dem Änderungsprotokoll, Snapshot-Zurückholen aus der Aufgabe', () => {
  const p = L.classify({ type: 'audit', entry: { route: 'POST /projects/p1/git/pull', via: 'app' } }, look);
  assert.deepStrictEqual([p.kind, p.projectId, p.ok, p.via], ['pull', 'p1', true, 'app']);
  assert.strictEqual(L.classify({ type: 'audit', entry: { route: 'POST /projects/p1/git/push' } }, look), null);
  assert.strictEqual(L.classify({ type: 'audit', entry: { route: 'POST /projects/zz/git/pull' } }, look), null);
  assert.strictEqual(L.classify(job('snapshot-restore-p1', 'done'), look).kind, 'restore');
});

test('Pfade: Groß/klein und Schrägstriche unter Windows egal, „liegt in“ nur auf Wunsch', () => {
  assert.ok(L.samePath('C:\\Web\\Shop\\', 'c:/web/shop', { win: true }));
  assert.ok(!L.samePath('C:/web/shop2', 'C:/web/shop', { inside: true, win: true }));
  assert.ok(L.samePath('C:/web/shop/dist', 'C:/web/shop', { inside: true, win: true }));
  assert.ok(!L.samePath('/srv/Site', '/srv/site', { win: false }));
  assert.ok(!L.samePath(null, '/srv'));
});

test('Einträge: neueste zuerst, höchstens LIMIT je Projekt, Übersicht und Verlauf', () => {
  const s = {};
  for (let i = 0; i < 5; i++) L.add(s, { id: `e${i}`, t: i, projectId: 'p1', projectName: 'Shop', kind: 'deploy', ok: true }, 3);
  L.add(s, { id: 'x', t: 10, projectId: 'p2', projectName: 'Blog', kind: 'pull', ok: true });
  assert.deepStrictEqual(s.projects.p1.entries.map((e) => e.id), ['e4', 'e3', 'e2']);
  assert.deepStrictEqual(L.overview(s).map((p) => [p.id, p.count]), [['p2', 1], ['p1', 3]]);
  assert.deepStrictEqual(L.recent(s, 2).map((e) => e.id), ['x', 'e4']);
});

test('„Zurück auf den vorherigen Stand“ = letzter erfolgreicher Stand vor dem neuesten, mit Snapshot', () => {
  const E = (id, ok, snap, kind = 'deploy') => ({ id, ok, kind, snapshot: snap ? { id: snap } : null });
  assert.strictEqual(L.rollbackTarget([E('a', true, 's3')]), null);
  assert.strictEqual(L.rollbackTarget([E('c', true, 's3'), E('b', false, null), E('a', true, 's1')]).id, 'a');
  assert.strictEqual(L.rollbackTarget([E('r', true, null, 'rollback'), E('c', true, 's3'), E('b', true, null), E('a', true, 's1')]).id, 'a');
  assert.strictEqual(L.rollbackTarget([E('c', true, 's3'), E('b', true, null)]), null);
});

test('Aufräumen: nur eigene Snapshots über die Grenze, 0 = alle behalten', () => {
  const E = (id, own, pruned) => ({ id, snapshot: { id: `s-${id}`, own, pruned } });
  const list = [E('5', true), E('4', false), E('3', true), E('2', true), E('1', true, true)];
  assert.deepStrictEqual(L.snapshotsToPrune(list, 2), ['s-2']);
  assert.deepStrictEqual(L.snapshotsToPrune(list, 0), []);
  assert.deepStrictEqual(L.snapshotsToPrune([{ id: 'x', snapshot: null }], 1), []);
});

test('Commit aus git log, Zweig und geänderte Dateien', () => {
  const c = L.parseCommit('0123456789abcdef0123456789abcdef01234567\t0123456\tFix: Warenkorb\twith tab\n', 'main\n', ' M a.js\n?? b.js\n');
  assert.deepStrictEqual(c, { hash: '0123456789abcdef0123456789abcdef01234567', short: '0123456', subject: 'Fix: Warenkorb\twith tab', branch: 'main', changed: 2 });
  assert.strictEqual(L.parseCommit('fatal: not a git repository', 'HEAD', ''), null);
  assert.strictEqual(L.parseCommit('', '', ''), null);
  assert.strictEqual(L.parseCommit('abcdef1\tabcdef1\tx', 'HEAD\n', '').branch, null); // abgelöster Kopf
});
