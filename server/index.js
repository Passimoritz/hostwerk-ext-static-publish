'use strict';
/*
 * Static publish – server part (SDK 2.7 native extension).
 *   GET  /api/static-publish                    → { sites, accounts: { github, cloudflare }, projects }
 *   PUT  /api/static-publish/accounts           → { githubToken, cloudflareToken, cloudflareAccount } (sealed on this PC)
 *   PUT  /api/static-publish/sites              → save the list of sites
 *   POST /api/static-publish/sites/:id/deploy   → job: build (optional), then publish; result in the site's history
 * Data: data/static-publish/{sites,accounts}.json – tokens sealed with Hostwerk's key.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./publish');

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
  const clean = (list) => (Array.isArray(list) ? list : []).slice(0, 50).map((s) => ({
    id: /^[a-z0-9]{6,16}$/.test(s.id || '') ? s.id : crypto.randomBytes(5).toString('hex'),
    name: String(s.name || 'Site').slice(0, 80), dir: String(s.dir || '').slice(0, 500), build: String(s.build || '').slice(0, 300), out: String(s.out || '').slice(0, 200),
    target: s.target === 'cloudflare' ? 'cloudflare' : 'github', repo: String(s.repo || '').trim().slice(0, 140), create: !!s.create, private: !!s.private, project: String(s.project || '').trim().toLowerCase().slice(0, 58),
    history: (Array.isArray(s.history) ? s.history : []).slice(0, 10),
  }));
  const projects = () => { try { return (ctx.devtools ? ctx.devtools.list() : []).map((p) => ({ name: p.name, path: p.path })).slice(0, 100); } catch { return []; } };
  const view = () => { const a = accounts(); return { sites: read('sites', []), accounts: { github: !!a.github, cloudflare: !!a.cloudflare, cloudflareAccount: a.cloudflareAccount || '' }, projects: projects() }; };

  host.router.get('/static-publish', (req, res) => res.json(view()));
  host.router.put('/static-publish/accounts', (req, res) => {
    const b = req.body || {}; const a = accounts();
    if (typeof b.githubToken === 'string') { if (b.githubToken) a.github = secrets.seal(b.githubToken.trim()); else delete a.github; }
    if (typeof b.cloudflareToken === 'string') { if (b.cloudflareToken) a.cloudflare = secrets.seal(b.cloudflareToken.trim()); else delete a.cloudflare; }
    if (typeof b.cloudflareAccount === 'string') a.cloudflareAccount = b.cloudflareAccount.trim().slice(0, 64);
    write('accounts', a); res.json(view());
  });
  host.router.put('/static-publish/sites', (req, res) => {
    // History is kept from the server side (the client may send an older copy)
    const old = new Map(read('sites', []).map((s) => [s.id, s.history || []]));
    const list = clean((req.body || {}).sites).map((s) => ({ ...s, history: old.get(s.id) || [] }));
    write('sites', list); res.json(view());
  });
  host.router.post('/static-publish/sites/:id/deploy', (req, res) => {
    const site = read('sites', []).find((s) => s.id === req.params.id);
    if (!site) throw host.error(404, 'Site not found');
    const a = accounts();
    const job = runJob(host.t('Publish {name}', { name: site.name }), async (j) => {
      const record = (entry) => { const list = read('sites', []); const s = list.find((x) => x.id === site.id); if (s) { s.history = [{ t: Date.now(), ...entry }, ...(s.history || [])].slice(0, 10); write('sites', list); } };
      try {
        if (!site.dir || !fs.existsSync(site.dir)) throw host.error(400, 'The project folder does not exist.');
        if (site.build) {
          j.progress(10, host.t('Build: {cmd}', { cmd: site.build }));
          const r = await shell(site.build, { cwd: site.dir, timeout: 15 * 60000, env: { ...process.env, CI: '1' } });
          for (const l of `${r.stdout}\n${r.stderr}`.split(/\r?\n/).filter(Boolean).slice(-40)) j.log(l);
          if (r.code !== 0) throw host.error(400, 'The build failed – see the log.');
        }
        const out = path.resolve(site.dir, site.out || '.');
        if (!out.startsWith(path.resolve(site.dir))) throw host.error(400, 'The output folder must be inside the project.');
        let result;
        if (site.target === 'github') {
          if (!a.github) throw host.error(409, 'Add a GitHub token first.');
          j.progress(40, host.t('Upload to GitHub Pages …'));
          result = await P.githubPages(out, { token: secrets.open(a.github), repo: site.repo, create: site.create, private: site.private }, { log: (l) => j.log(host.t(l)) });
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
          result = { url: P.wranglerUrl(r.stdout) || `https://${site.project}.pages.dev/` };
        }
        record({ ok: true, url: result.url });
        j.log(`→ ${result.url}`);
        return result;
      } catch (e) { record({ ok: false, error: e.message }); throw e; }
    }, { key: `static-publish-${site.id}` });
    res.json({ job: job.id });
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
