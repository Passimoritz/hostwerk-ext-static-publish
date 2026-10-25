'use strict';
/*
 * Static publish – server part (SDK 2.7 native extension).
 *   GET  /api/static-publish                      → { sites, accounts: { github, cloudflare, codeberg }, projects }
 *   PUT  /api/static-publish/accounts             → { githubToken, cloudflareToken, cloudflareAccount, codebergToken } (sealed on this PC)
 *   PUT  /api/static-publish/sites                → save the list of sites (an SFTP password/key comes along once and is sealed)
 *   POST /api/static-publish/sites/:id/check      → site check of the built files (no upload) – Hostwerk's own check (SDK 3.1),
 *                                                   on older Hostwerk the built-in one right on the files
 *   POST /api/static-publish/sites/:id/deploy     → job: build (optional), check, then publish; result in the site's history
 *   POST /api/static-publish/sites/:id/rollback   → { index } job: back to an earlier publish from the history (GitHub, Cloudflare)
 * Targets: GitHub Pages, Cloudflare Pages, Codeberg Pages, own server per SFTP – each with an own domain if wanted.
 * Data: data/static-publish/{sites,accounts}.json – tokens and SFTP logins sealed with Hostwerk's key.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./publish');

const TARGETS = ['github', 'cloudflare', 'codeberg', 'sftp'];
const CHECK = ['warn', 'block', 'off'];

function activate(host) {
  const { ctx } = host;
  const { runJob } = host.core('jobs');
  const { exec } = host.core('util');
  const secrets = host.core('secrets');
  const IS_WIN = process.platform === 'win32';
  const dir = path.join(ctx.paths.data, 'static-publish');
  fs.mkdirSync(dir, { recursive: true });
  const file = (n) => path.join(dir, `${n}.json`);
  const read = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return d; } };
  const write = (n, v) => { fs.writeFileSync(`${file(n)}.tmp`, JSON.stringify(v, null, 1)); fs.renameSync(`${file(n)}.tmp`, file(n)); };
  const accounts = () => read('accounts', {});
  const shell = (cmd, opts) => exec(IS_WIN ? 'cmd.exe' : 'sh', IS_WIN ? ['/d', '/s', '/c', cmd] : ['-c', cmd], opts);
  const clean = (list) => (Array.isArray(list) ? list : []).slice(0, 50).map((s) => {
    const sftp = s.sftp || {};
    return {
      id: /^[a-z0-9]{6,16}$/.test(s.id || '') ? s.id : crypto.randomBytes(5).toString('hex'),
      name: String(s.name || 'Site').slice(0, 80), dir: String(s.dir || '').slice(0, 500), build: String(s.build || '').slice(0, 300), out: String(s.out || '').slice(0, 200),
      target: TARGETS.includes(s.target) ? s.target : 'github', repo: String(s.repo || '').trim().slice(0, 140), create: !!s.create, private: !!s.private, project: String(s.project || '').trim().toLowerCase().slice(0, 58),
      domain: P.cleanDomain(s.domain), check: CHECK.includes(s.check) ? s.check : 'warn',
      sftp: { host: String(sftp.host || '').trim().slice(0, 200), port: Math.min(65535, Math.max(1, Number(sftp.port) || 22)), user: String(sftp.user || '').trim().slice(0, 80), path: String(sftp.path || '').trim().slice(0, 300), url: String(sftp.url || '').trim().slice(0, 300) },
      history: (Array.isArray(s.history) ? s.history : []).slice(0, 10),
    };
  });
  const projects = () => { try { return (ctx.devtools ? ctx.devtools.list() : []).map((p) => ({ name: p.name, path: p.path })).slice(0, 100); } catch { return []; } };
  const view = () => {
    const a = accounts();
    const sftp = a.sftp || {};
    return { sites: read('sites', []).map((s) => ({ ...s, sftpLogin: !!sftp[s.id] })), accounts: { github: !!a.github, cloudflare: !!a.cloudflare, cloudflareAccount: a.cloudflareAccount || '', codeberg: !!a.codeberg }, projects: projects() };
  };
  const outDir = (site) => {
    const out = path.resolve(site.dir, site.out || '.');
    if (!out.startsWith(path.resolve(site.dir))) throw host.error(400, 'The output folder must be inside the project.');
    return out;
  };
  const tr = (list) => list.map((x) => ({ ...x, text: host.t(x.text) }));
  /**
   * Seiten-Check: Hostwerks eigener (SDK 3.1, host.service('sitecheck') – liefert den Ordner kurz lokal aus und geht ihn ab
   * wie ein Besucher), auf älterem Hostwerk der eingebaute direkt auf den Dateien. → { pages, errors, warnings, engine }
   */
  const coreCheck = () => { try { const sc = host.service('sitecheck'); return sc && typeof sc.checkDir === 'function' ? sc : null; } catch { return null; } };
  async function checkSite(out, site) {
    const base = P.sitePath(site);
    const sc = coreCheck();
    if (sc) {
      try { return { ...P.fromCore(await sc.checkDir(out, { base, max: 200 }), base), engine: 'hostwerk' }; } catch (e) { if (e && e.status === 400) throw e; /* sonst eigener Check */ }
    }
    return { ...P.checkSite(out, { base }), engine: 'own' };
  }

  host.router.get('/static-publish', (req, res) => res.json(view()));
  host.router.put('/static-publish/accounts', (req, res) => {
    const b = req.body || {}; const a = accounts();
    for (const [k, field] of [['github', 'githubToken'], ['cloudflare', 'cloudflareToken'], ['codeberg', 'codebergToken']]) {
      if (typeof b[field] === 'string') { if (b[field]) a[k] = secrets.seal(b[field].trim()); else delete a[k]; }
    }
    if (typeof b.cloudflareAccount === 'string') a.cloudflareAccount = b.cloudflareAccount.trim().slice(0, 64);
    write('accounts', a); res.json(view());
  });
  host.router.put('/static-publish/sites', (req, res) => {
    // History is kept from the server side (the client may send an older copy)
    const raw = (req.body || {}).sites;
    const old = new Map(read('sites', []).map((s) => [s.id, s.history || []]));
    const list = clean(raw).map((s) => ({ ...s, history: old.get(s.id) || [] }));
    // SFTP-Anmeldung (Passwort oder privater Schlüssel) kommt nur beim Ändern mit – versiegelt, nie in sites.json
    const a = accounts(); a.sftp = a.sftp || {};
    (Array.isArray(raw) ? raw : []).forEach((s, i) => { const l = list[i]; if (l && typeof s.sftpSecret === 'string' && s.sftpSecret) a.sftp[l.id] = secrets.seal(s.sftpSecret); });
    for (const id of Object.keys(a.sftp)) if (!list.some((s) => s.id === id)) delete a.sftp[id];
    write('accounts', a);
    write('sites', list); res.json(view());
  });

  host.router.post('/static-publish/sites/:id/check', async (req, res) => {
    const site = read('sites', []).find((s) => s.id === req.params.id);
    if (!site) throw host.error(404, 'Site not found');
    const out = outDir(site);
    if (!fs.existsSync(out)) throw host.error(400, 'The output folder does not exist yet – build the site first.');
    const r = await checkSite(out, site);
    res.json({ ...r, errors: tr(r.errors), warnings: tr(r.warnings) });
  });

  host.router.post('/static-publish/sites/:id/deploy', (req, res) => {
    const site = read('sites', []).find((s) => s.id === req.params.id);
    if (!site) throw host.error(404, 'Site not found');
    const a = accounts();
    const job = runJob(host.t('Publish {name}', { name: site.name }), async (j) => {
      const record = (entry) => { const list = read('sites', []); const s = list.find((x) => x.id === site.id); if (s) { s.history = [{ t: Date.now(), target: site.target, ...entry }, ...(s.history || [])].slice(0, 10); write('sites', list); } };
      try {
        if (!site.dir || !fs.existsSync(site.dir)) throw host.error(400, 'The project folder does not exist.');
        if (site.build) {
          j.progress(10, host.t('Build: {cmd}', { cmd: site.build }));
          const r = await shell(site.build, { cwd: site.dir, timeout: 15 * 60000, env: { ...process.env, CI: '1' } });
          for (const l of `${r.stdout}\n${r.stderr}`.split(/\r?\n/).filter(Boolean).slice(-40)) j.log(l);
          if (r.code !== 0) throw host.error(400, 'The build failed – see the log.');
        }
        const out = outDir(site);
        // Seiten-Check vor dem Hochladen: kaputte Links, fehlende Dateien, Debug-Ausgaben
        if (site.check !== 'off') {
          j.progress(30, host.t('Checking the site …'));
          const c = await checkSite(out, site);
          for (const x of [...c.errors, ...c.warnings].slice(0, 40)) j.log(`${x.file}: ${host.t(x.text)}${x.ref ? ` (${x.ref})` : ''}`);
          if (c.errors.length && site.check === 'block') throw host.error(400, 'The site check found {n} problem(s) – see the log. Fix them or set the check to “only warn”.', { n: c.errors.length });
        }
        let result;
        if (site.target === 'github') {
          if (!a.github) throw host.error(409, 'Add a GitHub token first.');
          j.progress(40, host.t('Upload to GitHub Pages …'));
          result = await P.githubPages(out, { token: secrets.open(a.github), repo: site.repo, create: site.create, private: site.private, domain: site.domain }, { log: (l) => j.log(host.t(l)) });
          result.ref = result.commit;
        } else if (site.target === 'codeberg') {
          if (!a.codeberg) throw host.error(409, 'Add a Codeberg token first.');
          j.progress(40, host.t('Upload to Codeberg Pages …'));
          result = await P.codebergPages(out, { token: secrets.open(a.codeberg), repo: site.repo, create: site.create, domain: site.domain }, { log: (l) => j.log(host.t(l)) });
        } else if (site.target === 'sftp') {
          const login = (a.sftp || {})[site.id];
          if (!site.sftp || !site.sftp.host || !site.sftp.user || !login) throw host.error(409, 'Enter server, user and password or key for the own server first.');
          const Client = host.lib('ssh2-sftp-client');
          const sftp = new Client();
          const secret = secrets.open(login);
          j.progress(40, host.t('Upload to {host} …', { host: site.sftp.host }));
          try {
            await sftp.connect({ host: site.sftp.host, port: site.sftp.port || 22, username: site.sftp.user, ...(/BEGIN [A-Z ]*PRIVATE KEY/.test(secret) ? { privateKey: secret } : { password: secret }), readyTimeout: 20000 });
            result = await P.sftpUpload(out, { path: site.sftp.path, url: site.sftp.url || (site.domain ? `https://${site.domain}/` : null) }, sftp, { log: (l) => j.log(host.t(l)) });
          } finally { await sftp.end().catch(() => {}); }
        } else {
          if (!a.cloudflare || !a.cloudflareAccount) throw host.error(409, 'Add the Cloudflare API token and account ID first.');
          P.collect(out); // same checks as for GitHub (index.html, size)
          // Project name is checked here (a–z, 0–9, -) before it goes into any command line
          const args = P.wranglerArgs(out, site.project).map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ');
          if (/["&|<>^%]/.test(out)) throw host.error(400, 'The output folder path contains characters that are not allowed.');
          const env = { ...process.env, CLOUDFLARE_API_TOKEN: secrets.open(a.cloudflare), CLOUDFLARE_ACCOUNT_ID: a.cloudflareAccount };
          j.progress(40, host.t('Upload to Cloudflare Pages …'));
          await shell(`npx --yes wrangler@3 pages project create ${site.project} --production-branch main`, { cwd: site.dir, env, timeout: 5 * 60000 }); // exists already → fine
          const r = await shell(`npx ${args}`, { cwd: site.dir, env, timeout: 15 * 60000 });
          for (const l of `${r.stdout}\n${r.stderr}`.split(/\r?\n/).filter(Boolean).slice(-30)) j.log(l);
          if (r.code !== 0) throw host.error(400, /npx|not recognized|not found/i.test(r.stderr) ? 'Node.js (npx) is needed for Cloudflare – install it under Projects & apps → Runtimes.' : 'Cloudflare did not accept the upload – see the log.');
          const deployUrl = P.wranglerUrl(r.stdout);
          if (site.domain) { j.log(host.t('Own domain {domain} at Cloudflare …', { domain: site.domain })); await P.cloudflareDomain({ token: secrets.open(a.cloudflare), account: a.cloudflareAccount, project: site.project }, site.domain).catch((e) => j.log(e.message)); }
          result = { url: site.domain ? `https://${site.domain}/` : `https://${site.project}.pages.dev/`, ref: deployUrl };
        }
        record({ ok: true, url: result.url, ref: result.ref || null });
        j.log(`→ ${result.url}`);
        return result;
      } catch (e) { record({ ok: false, error: e.message }); throw e; }
    }, { key: `static-publish-${site.id}` });
    res.json({ job: job.id });
  });

  // Zurück auf eine frühere Veröffentlichung (aus dem Verlauf): GitHub legt einen neuen Commit mit den alten Dateien an,
  // Cloudflare stellt die alte Bereitstellung wieder her – beides lässt sich wieder umkehren
  host.router.post('/static-publish/sites/:id/rollback', (req, res) => {
    const site = read('sites', []).find((s) => s.id === req.params.id);
    if (!site) throw host.error(404, 'Site not found');
    const entry = (site.history || [])[Number((req.body || {}).index)];
    if (!entry || !entry.ok || !entry.ref || (entry.target && entry.target !== site.target)) throw host.error(400, 'This entry cannot be restored.');
    const a = accounts();
    const job = runJob(host.t('Back to an earlier version of {name}', { name: site.name }), async (j) => {
      if (site.target === 'github') {
        if (!a.github) throw host.error(409, 'Add a GitHub token first.');
        const r = await P.githubRollback({ token: secrets.open(a.github), repo: site.repo }, entry.ref);
        const list = read('sites', []); const s = list.find((x) => x.id === site.id);
        if (s) { s.history = [{ t: Date.now(), target: site.target, ok: true, url: entry.url, ref: r.commit, restored: entry.t }, ...(s.history || [])].slice(0, 10); write('sites', list); }
        return { url: entry.url };
      }
      if (site.target === 'cloudflare') {
        if (!a.cloudflare || !a.cloudflareAccount) throw host.error(409, 'Add the Cloudflare API token and account ID first.');
        await P.cloudflareRollback({ token: secrets.open(a.cloudflare), account: a.cloudflareAccount, project: site.project }, entry.ref);
        j.log(host.t('Cloudflare shows the earlier version again.'));
        return { url: entry.url };
      }
      throw host.error(400, 'This entry cannot be restored.');
    }, { key: `static-publish-${site.id}` });
    res.json({ job: job.id });
  });

  // 2.0: Teil „Verlauf“ (bis 1.1 eigene Erweiterung „Deploy-Protokoll“) – Routen /deploy-log/…, Daten data/deploy-log/
  require('./deploylog').mount(host);
}

function deactivate() {}

module.exports = { activate, deactivate };
