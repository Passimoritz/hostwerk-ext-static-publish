'use strict';
/*
 * Publish sites, part “History” (until 1.1 the own extension “Deploy log”, merged with SDK 3.8 "replaces").
 * Same routes and data as before, so links, the project tab and the tile keep working.
 *   GET  /api/deploy-log                         → { projects: [{ id, name, count, last }], recent: [entry] }
 *   GET  /api/deploy-log/projects/:id            → { name, entries, back: entry | null, snapshots: [id] }
 *   POST /api/deploy-log/projects/:id/rollback   → { entryId, redeploy } → { job } – restore that entry's snapshot
 *                                                   (and publish again to the same target if wanted)
 * Listens to Hostwerk's own events (deploy jobs, “Publish sites” jobs, git pull requests, snapshot restores) and
 * keeps one entry per event with time, state (commit + snapshot) and result. Nothing is added to Hostwerk's core:
 * rollback uses Hostwerk's snapshots (which save the current state first) and its deploy service.
 * Data: data/deploy-log/log.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./deploylog-lib');

/** The service – deps = { readSites() } can be replaced by the tests. */
function createService(host, deps = {}) {
  const { ctx } = host;
  const { runJob } = host.core('jobs');
  const dir = path.join(ctx.paths.data, 'deploy-log');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'log.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { projects: {} }; } };
  const write = (v) => { fs.writeFileSync(`${file}.tmp`, JSON.stringify(v)); fs.renameSync(`${file}.tmp`, file); };
  // One change at a time (events can arrive while a snapshot is still being written)
  let queue = Promise.resolve();
  const change = (fn) => { const p = queue.then(() => { const s = read(); const r = fn(s); write(s); return r; }); queue = p.catch(() => {}); return p; };

  const settings = () => {
    let s = {};
    try { s = ctx.extMarket.settingsFor(host.id) || {}; } catch { /* defaults */ }
    return { snapshot: s.snapshot !== false, keep: Number.isFinite(s.keep) ? Math.max(0, s.keep) : 10 };
  };
  const readSites = deps.readSites || (() => { try { return JSON.parse(fs.readFileSync(path.join(ctx.paths.data, 'static-publish', 'sites.json'), 'utf8')); } catch { return []; } });
  const projects = () => { try { return ctx.devtools ? ctx.devtools.list() : []; } catch { return []; } };
  const look = {
    target: (id) => { try { const t = ctx.deploy.raw(id); return { projectId: t.projectId, projectPath: t.projectPath, name: t.name, type: t.type }; } catch { return null; } },
    site: (id) => (readSites() || []).find((s) => s && s.id === id) || null,
    project: (id) => { try { const p = ctx.devtools.get(id); return p ? { id: p.id, name: p.name, path: p.path } : null; } catch { return null; } },
    projectByPath: (d) => {
      const list = projects();
      const p = list.find((x) => L.samePath(d, x.path)) || list.find((x) => L.samePath(d, x.path, { inside: true }));
      return p ? { id: p.id, name: p.name, path: p.path } : null;
    },
  };

  /** State of the working copy: commit (hash, subject, branch) and how many files differ from it. */
  const commitOf = async (p) => {
    if (!p || !ctx.git || !fs.existsSync(path.join(p, '.git'))) return null;
    try {
      const [log, br, st] = await Promise.all([
        ctx.git.git(p, ['log', '-1', '--format=%H%x09%h%x09%s'], { ok: true, timeout: 15000 }),
        ctx.git.git(p, ['rev-parse', '--abbrev-ref', 'HEAD'], { ok: true, timeout: 15000 }),
        ctx.git.git(p, ['status', '--porcelain'], { ok: true, timeout: 15000 }),
      ]);
      return L.parseCommit(log.stdout, br.stdout, st.stdout);
    } catch { return null; }
  };
  const realProject = (id) => !!look.project(id);
  const latestSnapshot = (projectId, before) => {
    try { const s = ctx.snapshots.list(projectId).find((x) => x.createdAt <= before); return s ? { id: s.id, createdAt: s.createdAt, own: false } : null; } catch { return null; }
  };

  /** Snapshot of the state that is live now – made by Hostwerk's own snapshot service (zip without node_modules/.git). */
  const takeSnapshot = async (e) => {
    const job = ctx.snapshots.create(e.projectId, { label: host.t('Deploy log: {what}', { what: e.target ? e.target.name : host.t(KIND_LABEL[e.kind] || e.kind) }), includeDb: false, auto: true });
    const r = await job.promise;
    return r && r.id ? { id: r.id, createdAt: r.createdAt || Date.now(), own: true } : null;
  };
  const prune = async (projectId) => {
    const { keep } = settings();
    const ids = L.snapshotsToPrune((read().projects[projectId] || { entries: [] }).entries, keep);
    if (!ids.length) return;
    for (const id of ids) { try { ctx.snapshots.remove(projectId, id); } catch { /* already gone */ } }
    await change((s) => { for (const e of (s.projects[projectId] || { entries: [] }).entries) if (e.snapshot && ids.includes(e.snapshot.id)) e.snapshot.pruned = true; });
  };

  const seen = new Set();
  /** One Hostwerk event → one entry (state is captured right away, the snapshot follows when it is written). */
  const record = async (ev, extra = {}) => {
    if (ev.jobId) { if (seen.has(ev.jobId)) return null; seen.add(ev.jobId); if (seen.size > 500) seen.delete(seen.values().next().value); }
    const t = Date.now();
    const e = { id: crypto.randomBytes(6).toString('hex'), t, ...ev, ...extra, commit: await commitOf(ev.path), snapshot: null };
    const cfg = settings();
    const wantSnap = cfg.snapshot && e.ok && realProject(e.projectId) && ['deploy', 'publish', 'pull'].includes(e.kind);
    if (!wantSnap) e.snapshot = realProject(e.projectId) ? latestSnapshot(e.projectId, t) : null;
    else e.snapshot = { pending: true };
    await change((s) => L.add(s, e));
    host.broadcast({ type: 'ext-event', id: host.id, event: 'entry', data: { projectId: e.projectId } });
    if (wantSnap) {
      let snap = null;
      try { snap = await takeSnapshot(e); } catch (err) { host.log('snapshot failed:', err.message); }
      await change((s) => { const x = (s.projects[e.projectId] || { entries: [] }).entries.find((y) => y.id === e.id); if (x) x.snapshot = snap || latestSnapshot(e.projectId, t); });
      await prune(e.projectId).catch(() => {});
      host.broadcast({ type: 'ext-event', id: host.id, event: 'entry', data: { projectId: e.projectId } });
    }
    return e;
  };

  /** Listener for Hostwerk's bus: { type: 'job' | 'audit', … }. Our own rollback jobs are recorded by rollback(). */
  const onMessage = (msg) => {
    let ev = null;
    try { ev = L.classify(msg, look); } catch { return; }
    if (!ev || (ev.jobId && ownJobs.has(ev.jobId))) return;
    // The restore inside our own rollback is part of the rollback entry
    if (ev.kind === 'restore' && rollingBack.has(ev.projectId)) return;
    record(ev).catch((err) => host.log('record failed:', err.message));
  };

  const ownJobs = new Set();
  const rollingBack = new Set();
  /** Back to the state of one entry: Hostwerk restores the snapshot (after saving the current state) – then publish again if wanted. */
  const rollback = (projectId, entryId, { redeploy = false } = {}) => {
    const p = look.project(projectId);
    if (!p) throw host.error(404, 'Project not found');
    const list = (read().projects[projectId] || { entries: [] }).entries;
    const e = list.find((x) => x.id === entryId);
    if (!e) throw host.error(404, 'Entry not found');
    if (!e.snapshot || !e.snapshot.id || e.snapshot.pruned) throw host.error(409, 'There is no snapshot for this state any more.');
    if (!ctx.snapshots.list(projectId).some((s) => s.id === e.snapshot.id)) throw host.error(409, 'The snapshot of this state was deleted.');
    const again = redeploy && e.target && ((e.kind === 'deploy' && e.target.type !== 'git') || e.kind === 'publish') ? e.target : null;
    const when = new Date(e.t).toLocaleString(host.lang() === 'en' ? 'en-GB' : 'de-DE', { dateStyle: 'short', timeStyle: 'short' });
    rollingBack.add(projectId);
    const job = runJob(host.t('Back to the state of {when}: {name}', { when, name: p.name }), async (j) => {
      const started = Date.now();
      let error = null;
      try {
        j.progress(5, host.t('Restore snapshot …'));
        try { await ctx.snapshots.restore(projectId, e.snapshot.id, { files: true, database: false }).promise; } finally { setTimeout(() => rollingBack.delete(projectId), 2000).unref?.(); }
        if (again && e.kind === 'deploy') { j.progress(60, host.t('Publish again to {name} …', { name: again.name })); await ctx.deploy.deploy(again.id).promise; }
        // “Publish sites” is an extension of its own – its route starts the upload (and is logged by this extension when it ends)
        if (again && e.kind === 'publish') { j.progress(60, host.t('Publish again to {name} …', { name: again.name })); await ctx.audit.selfCall('POST', `/static-publish/sites/${encodeURIComponent(again.id)}/deploy`, {}); }
        return { ok: true };
      } catch (err) { error = err.message; throw err; } finally {
        const ev = { kind: 'rollback', projectId, projectName: p.name, path: p.path, target: again, ok: !error, error, result: { to: e.id, toT: e.t, snapshot: e.snapshot.id, redeploy: !!again }, ms: Date.now() - started, jobId: null };
        record(ev).catch(() => {});
        try { ctx.audit.record({ kind: 'Projekt', target: p.name, action: `Zurück auf den Stand vom ${new Date(e.t).toLocaleString('de-DE')} (Deploy-Protokoll)`, via: 'erweiterung' }); } catch { /* the change log is optional */ }
      }
    }, { key: `rollback-deploy-log-${projectId}` });
    ownJobs.add(job.id);
    return job;
  };

  const projectView = (id) => {
    const p = read().projects[id] || { name: (look.project(id) || {}).name || id, entries: [] };
    let snaps = [];
    try { snaps = realProject(id) ? ctx.snapshots.list(id).map((s) => s.id) : []; } catch { /* none */ }
    const back = L.rollbackTarget(p.entries);
    return { id, name: p.name, real: realProject(id), entries: p.entries, back: back && snaps.includes(back.snapshot.id) ? back : null, snapshots: snaps };
  };

  return { onMessage, record, rollback, projectView, overview: () => { const s = read(); return { projects: L.overview(s), recent: L.recent(s, 20) }; }, settings, idle: () => queue };
}

const KIND_LABEL = { deploy: 'Deploy', publish: 'Published site', pull: 'Git pull', restore: 'Snapshot restored', rollback: 'Rollback' };

/** Settings of the former “Deploy log” (snapshot, keep) once into the own settings – Hostwerk keeps them under replaced:deploy-log. */
function takeOverSettings(host) {
  const { ctx } = host;
  const mk = ctx && ctx.extMarket;
  if (!mk || typeof mk.storageAll !== 'function' || typeof mk.saveSettings !== 'function') return null;
  const old = (mk.storageAll(host.id) || {})['replaced:deploy-log'];
  const own = ((ctx.settings.get().extSettings || {})[host.id]) || {};
  if (!old || !old.settings || own.snapshot !== undefined || own.keep !== undefined) return null;
  const values = Object.fromEntries(['snapshot', 'keep'].filter((k) => old.settings[k] !== undefined).map((k) => [k, old.settings[k]]));
  if (Object.keys(values).length) mk.saveSettings(host.id, values);
  return values;
}

/** Called by server/index.js (activate). */
function mount(host) {
  try { takeOverSettings(host); } catch (e) { if (host.log) host.log('take over settings:', e.message); }
  const svc = createService(host);
  // Ohne Hostwerks Ereignisse (Tests mit nachgebautem Host) gibt es eben keine neuen Einträge – die Routen bleiben
  const { bus } = host.core('events') || {};
  const listener = (m) => { if (m && (m.type === 'job' || m.type === 'audit')) svc.onMessage(m); };
  if (bus && typeof bus.on === 'function') {
    bus.on('broadcast', listener);
    if (typeof host.on === 'function') host.on('shutdown', () => bus.off('broadcast', listener));
  }

  host.router.get('/deploy-log', (req, res) => res.json(svc.overview()));
  host.router.get('/deploy-log/projects/:id', (req, res) => res.json(svc.projectView(req.params.id)));
  host.router.post('/deploy-log/projects/:id/rollback', (req, res) => {
    const b = req.body || {};
    res.json({ job: svc.rollback(req.params.id, String(b.entryId || ''), { redeploy: !!b.redeploy }).id });
  });
}

module.exports = { mount, createService, takeOverSettings, KIND_LABEL };
