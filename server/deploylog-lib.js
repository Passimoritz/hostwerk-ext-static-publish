'use strict';
/*
 * Deploy log – pure logic without Hostwerk (tested in tests/log.test.js).
 *
 *   classify(msg, look)       → which Hostwerk event is a deploy, a git pull, a published site or a restore – or null
 *   add(store, entry)         → newest first, at most LIMIT per project
 *   rollbackTarget(list, id)  → the entry whose state "back to the previous state" restores
 *   snapshotsToPrune(list, n) → own snapshots beyond the newest n (only ones this extension made itself)
 *
 * Hostwerk tells the extension about events through its internal broadcast bus:
 *   { type: 'job', job: { key: 'deploy-<target>' | 'static-publish-<site>' | 'snapshot-restore-<project>', state, … } }
 *   { type: 'audit', entry: { route: 'POST /projects/<id>/git/pull', … } }   (only successful requests are recorded)
 */
const LIMIT = 200;
const FINAL = new Set(['done', 'error', 'cancelled']);

/**
 * look = { target(id) → { projectId, name, type } | null, site(id) → { name, dir, target, repo, project } | null,
 *          projectByPath(dir) → { id, name, path } | null, project(id) → { id, name, path } | null }
 * Returns { kind, projectId, projectName, path, target, ok, error, result, ms, jobId } or null.
 */
function classify(msg, look) {
  if (!msg || typeof msg !== 'object') return null;
  if (msg.type === 'job' && msg.job && typeof msg.job.key === 'string' && FINAL.has(msg.job.state)) {
    const j = msg.job;
    const base = { ok: j.state === 'done', error: j.state === 'done' ? null : j.state === 'cancelled' ? 'cancelled' : String(j.error || 'failed').slice(0, 300), ms: j.endedAt && j.startedAt ? j.endedAt - j.startedAt : null, jobId: j.id || null };
    let m = /^deploy-([\w-]+)$/.exec(j.key);
    if (m) {
      const t = look.target(m[1]);
      if (!t) return null;
      const p = look.project(t.projectId);
      return { kind: 'deploy', projectId: t.projectId, projectName: p ? p.name : t.projectId, path: p ? p.path : t.projectPath || null, target: { id: m[1], name: t.name, type: t.type }, result: pickDeploy(j.result), ...base };
    }
    m = /^static-publish-([\w-]+)$/.exec(j.key);
    if (m) {
      const s = look.site(m[1]);
      if (!s) return null;
      const p = s.dir ? look.projectByPath(s.dir) : null;
      return {
        kind: 'publish', projectId: p ? p.id : `site-${m[1]}`, projectName: p ? p.name : s.name, path: p ? p.path : s.dir || null,
        target: { id: m[1], name: s.name, type: s.target === 'cloudflare' ? 'cloudflare' : 'github' }, result: j.result && j.result.url ? { url: String(j.result.url).slice(0, 300) } : null, ...base,
      };
    }
    m = /^snapshot-restore-([\w-]+)$/.exec(j.key);
    if (m) {
      const p = look.project(m[1]);
      return p ? { kind: 'restore', projectId: p.id, projectName: p.name, path: p.path, target: null, result: null, ...base } : null;
    }
    return null;
  }
  if (msg.type === 'audit' && msg.entry && typeof msg.entry.route === 'string') {
    const m = /^POST \/projects\/([\w-]+)\/git\/pull$/.exec(msg.entry.route);
    if (!m) return null;
    const p = look.project(m[1]);
    // Hostwerk only records successful requests – a failed pull never arrives here
    return p ? { kind: 'pull', projectId: p.id, projectName: p.name, path: p.path, target: null, ok: true, error: null, result: null, ms: null, jobId: null, via: msg.entry.via || null } : null;
  }
  return null;
}

/** Only the harmless numbers of a deploy result (never anything from the target's settings). */
function pickDeploy(r) {
  if (!r || typeof r !== 'object') return null;
  const out = {};
  for (const k of ['uploaded', 'removed']) if (Number.isFinite(r[k])) out[k] = r[k];
  if (r.pushed) out.pushed = true;
  return Object.keys(out).length ? out : null;
}

/** Same folder (case-insensitive on Windows, without trailing slashes)? `inside`: dir lies inside root. */
function samePath(a, b, { inside = false, win = process.platform === 'win32' } = {}) {
  if (!a || !b) return false;
  const n = (x) => { let s = String(x).replace(/\\/g, '/').replace(/\/+$/, ''); if (win) s = s.toLowerCase(); return s; };
  const x = n(a); const y = n(b);
  return x === y || (inside && x.startsWith(`${y}/`));
}

/** New entry at the top of its project; store = { projects: { [id]: { name, entries: [] } } }. */
function add(store, e, limit = LIMIT) {
  if (!store.projects) store.projects = {};
  const p = store.projects[e.projectId] || { name: e.projectName, entries: [] };
  p.name = e.projectName || p.name;
  p.entries = [e, ...p.entries.filter((x) => x.id !== e.id)].slice(0, limit);
  store.projects[e.projectId] = p;
  return e;
}

/**
 * "Back to the previous state": the newest successful entry with a snapshot BEFORE the newest successful
 * deploy/publish/pull. Returns null when there is nothing to go back to.
 */
function rollbackTarget(entries) {
  const okOnes = entries.filter((e) => e.ok && e.kind !== 'rollback' && e.kind !== 'restore');
  if (okOnes.length < 2) return null;
  return okOnes.slice(1).find((e) => e.snapshot && e.snapshot.id) || null;
}

/** Ids of own snapshots beyond the newest `keep` (0 = keep all). Snapshots made by people are never touched. */
function snapshotsToPrune(entries, keep) {
  if (!keep || keep < 1) return [];
  const own = entries.filter((e) => e.snapshot && e.snapshot.own && e.snapshot.id && !e.snapshot.pruned);
  return own.slice(keep).map((e) => e.snapshot.id);
}

/** Overview: projects with their newest entry, newest first. */
function overview(store) {
  return Object.entries(store.projects || {}).map(([id, p]) => ({ id, name: p.name, count: p.entries.length, last: p.entries[0] || null }))
    .filter((p) => p.last).sort((a, b) => b.last.t - a.last.t);
}

/** Newest entries over all projects. */
function recent(store, n = 20) {
  return Object.values(store.projects || {}).flatMap((p) => p.entries).sort((a, b) => b.t - a.t).slice(0, n);
}

/** `git log -1` line "<hash>\t<short>\t<subject>" + branch + dirty count → commit info. */
function parseCommit(logLine, branch, porcelain) {
  const [hash, short, ...rest] = String(logLine || '').trim().split('\t');
  if (!/^[0-9a-f]{7,64}$/.test(hash || '')) return null;
  const changed = String(porcelain || '').split(/\r?\n/).filter((l) => l.trim()).length;
  return { hash, short: short || hash.slice(0, 7), subject: rest.join('\t').slice(0, 200), branch: branch && branch.trim() !== 'HEAD' ? branch.trim() : null, changed };
}

module.exports = { classify, add, rollbackTarget, snapshotsToPrune, overview, recent, parseCommit, samePath, pickDeploy, LIMIT };
