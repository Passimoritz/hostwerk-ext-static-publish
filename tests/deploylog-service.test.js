'use strict';
// Deploy log – the whole flow with a fake Hostwerk: events in, entries with commit and snapshot, rollback through
// Hostwerk's snapshot and deploy services. Nothing real is deployed or restored.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createService } = require('../server/deploylog');

const temp = [];
test.after(() => { for (const d of temp) fs.rmSync(d, { recursive: true, force: true }); });

function fakeHostwerk(settings = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-deploy-log-'));
  const proj = path.join(data, 'shop');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  temp.push(data);
  const calls = []; const audit = []; const events = [];
  const snaps = []; let n = 0;
  const fill = (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? String(v[k]) : m)) : String(s));
  const jobs = [];
  const runJob = (title, fn, { key } = {}) => {
    const j = { id: `job${jobs.length + 1}`, key, title, logs: [], progress: () => {}, log: () => {} };
    j.promise = Promise.resolve().then(() => fn(j));
    j.promise.catch(() => {});
    jobs.push(j);
    return j;
  };
  const ctx = {
    paths: { data },
    extMarket: { settingsFor: () => settings },
    devtools: { get: (id) => (id === 'p1' ? { id: 'p1', name: 'Shop', path: proj } : null), list: () => [{ id: 'p1', name: 'Shop', path: proj }] },
    deploy: {
      raw: (id) => { if (id !== 't1') throw new Error('Ziel nicht gefunden'); return { id: 't1', projectId: 'p1', projectPath: proj, name: 'Live server', type: 'sftp', pass: 'sealed' }; },
      deploy: (id) => { calls.push(`deploy ${id}`); return { id: 'd', promise: Promise.resolve({ ok: true }) }; },
    },
    git: { git: async (dir, args) => ({ code: 0, stdout: args[0] === 'log' ? `${'a'.repeat(40)}\taaaaaaa\tRelease ${n}` : args[0] === 'rev-parse' ? 'main' : '' }) },
    snapshots: {
      list: () => [...snaps].sort((a, b) => b.createdAt - a.createdAt),
      create: (pid, o) => { const s = { id: `snap${++n}`, createdAt: Date.now() + n, label: o.label, auto: o.auto }; snaps.push(s); calls.push(`snapshot ${pid} ${o.includeDb}`); return { promise: Promise.resolve(s) }; },
      restore: (pid, sid, o) => { calls.push(`restore ${pid} ${sid} db=${o.database}`); return { promise: Promise.resolve({ ok: true }) }; },
      remove: (pid, sid) => { calls.push(`remove ${sid}`); const i = snaps.findIndex((s) => s.id === sid); if (i >= 0) snaps.splice(i, 1); },
    },
    audit: { record: (e) => audit.push(e), selfCall: async (m, p) => { calls.push(`${m} ${p}`); return { job: 'x' }; } },
  };
  const host = {
    id: 'deploy-log', ctx, t: fill, lang: () => 'de', log: () => {}, broadcast: (m) => events.push(m),
    error: (status, text) => Object.assign(new Error(text), { status }),
    core: (name) => (name === 'jobs' ? { runJob } : null),
  };
  return { host, calls, audit, events, snaps, jobs, data };
}
const jobMsg = (key, state, extra = {}) => ({ type: 'job', job: { id: `${key}-${Math.random()}`, key, state, startedAt: 1, endedAt: 2, ...extra } });

test('Deploy fertig → Eintrag mit Commit, eigenem Snapshot (ohne Datenbank) und Ergebnis', async () => {
  const f = fakeHostwerk();
  const svc = createService(f.host);
  svc.onMessage(jobMsg('deploy-t1', 'done', { result: { uploaded: 4, removed: 0 } }));
  await new Promise((r) => setTimeout(r, 20)); await svc.idle();
  const v = svc.projectView('p1');
  assert.strictEqual(v.entries.length, 1);
  const e = v.entries[0];
  assert.deepStrictEqual([e.kind, e.ok, e.target.name, e.result.uploaded, e.commit.short, e.commit.branch], ['deploy', true, 'Live server', 4, 'aaaaaaa', 'main']);
  assert.deepStrictEqual(e.snapshot, { id: 'snap1', createdAt: e.snapshot.createdAt, own: true });
  assert.ok(f.calls.includes('snapshot p1 false'));
  assert.ok(f.events.some((m) => m.type === 'ext-event' && m.event === 'entry'));
});

test('dieselbe Aufgabe zweimal gemeldet → nur ein Eintrag; fehlgeschlagen → kein Snapshot', async () => {
  const f = fakeHostwerk();
  const svc = createService(f.host);
  const m = jobMsg('deploy-t1', 'error', { error: 'Login failed' });
  svc.onMessage(m); svc.onMessage(m);
  await new Promise((r) => setTimeout(r, 20)); await svc.idle();
  const [e, ...rest] = svc.projectView('p1').entries;
  assert.strictEqual(rest.length, 0);
  assert.deepStrictEqual([e.ok, e.error, e.snapshot], [false, 'Login failed', null]);
  assert.ok(!f.calls.some((c) => c.startsWith('snapshot')));
});

test('ohne automatische Snapshots: der letzte vorhandene Snapshot wird vermerkt (nicht als eigener)', async () => {
  const f = fakeHostwerk({ snapshot: false });
  f.snaps.push({ id: 'manual', createdAt: Date.now() - 1000 });
  const svc = createService(f.host);
  svc.onMessage({ type: 'audit', entry: { route: 'POST /projects/p1/git/pull' } });
  await new Promise((r) => setTimeout(r, 20)); await svc.idle();
  const e = svc.projectView('p1').entries[0];
  assert.strictEqual(e.kind, 'pull');
  assert.deepStrictEqual([e.snapshot.id, e.snapshot.own], ['manual', false]);
});

test('ein Klick zurück: Snapshot des vorherigen Stands zurückholen und erneut veröffentlichen', async () => {
  const f = fakeHostwerk();
  const svc = createService(f.host);
  svc.onMessage(jobMsg('deploy-t1', 'done', { result: { uploaded: 4 } }));
  await new Promise((r) => setTimeout(r, 20)); await svc.idle();
  svc.onMessage(jobMsg('deploy-t1', 'done', { result: { uploaded: 2 } }));
  await new Promise((r) => setTimeout(r, 20)); await svc.idle();
  const v = svc.projectView('p1');
  assert.strictEqual(v.back.snapshot.id, 'snap1'); // vorheriger Stand
  const job = svc.rollback('p1', v.back.id, { redeploy: true });
  // Das Zurückholen meldet Hostwerk selbst als Aufgabe – sie gehört zum Rollback und wird nicht doppelt protokolliert
  svc.onMessage(jobMsg('snapshot-restore-p1', 'done'));
  await job.promise;
  await new Promise((r) => setTimeout(r, 20)); await svc.idle();
  assert.ok(f.calls.includes('restore p1 snap1 db=false'));
  assert.ok(f.calls.includes('deploy t1'));
  const after = svc.projectView('p1').entries;
  assert.deepStrictEqual(after.map((e) => e.kind), ['rollback', 'deploy', 'deploy']);
  assert.deepStrictEqual([after[0].ok, after[0].result.to, after[0].result.redeploy], [true, v.back.id, true]);
  assert.match(f.audit[0].action, /Deploy-Protokoll/);
});

test('zurück geht nicht ohne Snapshot oder für unbekannte Einträge', async () => {
  const f = fakeHostwerk({ snapshot: false });
  const svc = createService(f.host);
  svc.onMessage(jobMsg('deploy-t1', 'done'));
  await new Promise((r) => setTimeout(r, 20)); await svc.idle();
  const e = svc.projectView('p1').entries[0];
  assert.throws(() => svc.rollback('p1', e.id), (err) => err.status === 409);
  assert.throws(() => svc.rollback('p1', 'nope'), (err) => err.status === 404);
  assert.throws(() => svc.rollback('zz', e.id), (err) => err.status === 404);
});

test('eigene Snapshots über der Grenze werden aufgeräumt, fremde nie', async () => {
  const f = fakeHostwerk({ keep: 2 });
  f.snaps.push({ id: 'manual', createdAt: 0 });
  const svc = createService(f.host);
  for (let i = 0; i < 3; i++) { svc.onMessage(jobMsg('deploy-t1', 'done')); await new Promise((r) => setTimeout(r, 20)); await svc.idle(); }
  await new Promise((r) => setTimeout(r, 20)); await svc.idle();
  assert.deepStrictEqual(f.calls.filter((c) => c.startsWith('remove')), ['remove snap1']);
  assert.ok(f.snaps.some((s) => s.id === 'manual'));
  assert.strictEqual(svc.projectView('p1').entries[2].snapshot.pruned, true);
});

test('„Seiten veröffentlichen“ ohne passendes Projekt → eigener Eintrag, erneut veröffentlichen über deren Route', async () => {
  const f = fakeHostwerk();
  const svc = createService(f.host, { readSites: () => [{ id: 's1', name: 'Docs', dir: path.join(f.data, 'shop', 'docs'), target: 'github' }, { id: 's2', name: 'Elsewhere', dir: 'Z:/x', target: 'cloudflare' }] });
  svc.onMessage(jobMsg('static-publish-s1', 'done', { result: { url: 'https://me.github.io/docs/' } }));
  svc.onMessage(jobMsg('static-publish-s2', 'done', { result: { url: 'https://x.pages.dev/' } }));
  await new Promise((r) => setTimeout(r, 30)); await svc.idle();
  assert.strictEqual(svc.projectView('p1').entries[0].result.url, 'https://me.github.io/docs/');
  const o = svc.overview();
  assert.deepStrictEqual(o.projects.map((p) => p.id).sort(), ['p1', 'site-s2']);
  assert.strictEqual(svc.projectView('site-s2').real, false);
});
