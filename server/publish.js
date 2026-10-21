'use strict';
/*
 * Publishing a folder of static files – without Hostwerk, so the tests can run it.
 *   GitHub Pages: files go through GitHub's git data API (no local git needed) into the branch gh-pages, Pages is
 *                 switched on for that branch. Result: https://<owner>.github.io/<repo>/ (or the user page).
 *   Cloudflare Pages: Cloudflare's own tool (wrangler) uploads the folder; Hostwerk only builds the arguments.
 *   Codeberg Pages: one commit with all changes into the branch "pages" (Forgejo API).
 *   Own server: SFTP into a folder (ssh2-sftp-client from Hostwerk).
 * Plus: own domain, a site check right on the files before publishing, going back to an earlier version.
 */
const fs = require('fs');
const path = require('path');

const LIMIT_FILES = 2000;
const LIMIT_BYTES = 200 * 1024 * 1024;
const SKIP = /(^|\/)(\.git|node_modules|\.env(\..*)?|\.DS_Store|Thumbs\.db)(\/|$)/;

/** All files below dir (relative, with /), without .git, node_modules, .env – with limits. */
function collect(dir) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw Object.assign(new Error('The folder to publish does not exist – build the project first?'), { status: 400 });
  const out = []; let bytes = 0;
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP.test(r)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) { const size = fs.statSync(p).size; bytes += size; out.push({ rel: r, file: p, size }); }
      if (out.length > LIMIT_FILES) throw Object.assign(new Error(`More than ${LIMIT_FILES} files – is this really the built site (e.g. dist/)?`), { status: 400 });
    }
  };
  walk(dir, '');
  if (!out.length) throw Object.assign(new Error('The folder is empty.'), { status: 400 });
  if (!out.some((f) => /^index\.html?$/i.test(f.rel))) throw Object.assign(new Error('There is no index.html in the folder – pick the folder with the built page.'), { status: 400 });
  if (bytes > LIMIT_BYTES) throw Object.assign(new Error('More than 200 MB – too big for static hosting.'), { status: 400 });
  return { files: out, bytes };
}

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** Deploy to GitHub Pages. gh = { token, repo: 'owner/name', create: bool, private: bool, domain }. → { url, commit, files } */
async function githubPages(dir, gh, { fetchFn = fetch, log = () => {}, api = 'https://api.github.com', message = 'Publish with Hostwerk' } = {}) {
  if (!gh.token) throw Object.assign(new Error('A GitHub token is needed.'), { status: 400 });
  if (!REPO_RE.test(gh.repo || '')) throw Object.assign(new Error('Repository as owner/name, e.g. alex/my-site'), { status: 400 });
  const { files } = collect(dir);
  const call = async (method, p, body, ok = [200, 201]) => {
    const r = await fetchFn(`${api}${p}`, { method, headers: { authorization: `Bearer ${gh.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'Hostwerk' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!ok.includes(r.status)) { const e = new Error(r.status === 401 ? 'GitHub does not accept the token.' : r.status === 403 ? 'The token may not do this (it needs the rights “Contents” and “Pages” for the repository).' : `GitHub: ${j.message || r.status}`); e.status = r.status; e.gh = r.status; throw e; }
    return { status: r.status, j };
  };
  const [owner, name] = gh.repo.split('/');
  let repo = await call('GET', `/repos/${owner}/${name}`, null, [200, 404]);
  if (repo.status === 404) {
    if (!gh.create) throw Object.assign(new Error('The repository does not exist – tick “create it” or create it on GitHub.'), { status: 400 });
    log(`Create repository ${gh.repo}`);
    const me = (await call('GET', '/user')).j.login;
    repo = await call('POST', me === owner ? '/user/repos' : `/orgs/${owner}/repos`, { name, private: !!gh.private, auto_init: true, description: 'Published with Hostwerk' });
  }
  // Current state of gh-pages (if it exists) – the new commit builds on it
  const ref = await call('GET', `/repos/${owner}/${name}/git/ref/heads/gh-pages`, null, [200, 404]);
  const parent = ref.status === 200 ? ref.j.object.sha : null;
  log(`Upload ${files.length} files`);
  const tree = [];
  for (const f of files) {
    const blob = await call('POST', `/repos/${owner}/${name}/git/blobs`, { content: fs.readFileSync(f.file).toString('base64'), encoding: 'base64' });
    tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.j.sha });
  }
  if (!tree.some((x) => x.path === '.nojekyll')) {
    const b = await call('POST', `/repos/${owner}/${name}/git/blobs`, { content: '', encoding: 'utf-8' }); tree.push({ path: '.nojekyll', mode: '100644', type: 'blob', sha: b.j.sha });
  }
  // Eigene Domain: GitHub liest sie aus der Datei CNAME im veröffentlichten Zweig
  if (gh.domain) {
    const b = await call('POST', `/repos/${owner}/${name}/git/blobs`, { content: `${gh.domain}\n`, encoding: 'utf-8' });
    const i = tree.findIndex((x) => x.path === 'CNAME');
    const entry = { path: 'CNAME', mode: '100644', type: 'blob', sha: b.j.sha };
    if (i >= 0) tree[i] = entry; else tree.push(entry);
  }
  const t = await call('POST', `/repos/${owner}/${name}/git/trees`, { tree });
  const c = await call('POST', `/repos/${owner}/${name}/git/commits`, { message, tree: t.j.sha, parents: parent ? [parent] : [] });
  if (parent) await call('PATCH', `/repos/${owner}/${name}/git/refs/heads/gh-pages`, { sha: c.j.sha, force: true });
  else await call('POST', `/repos/${owner}/${name}/git/refs`, { ref: 'refs/heads/gh-pages', sha: c.j.sha });
  // Switch Pages on for gh-pages (already on → 409, fine)
  const pages = await call('POST', `/repos/${owner}/${name}/pages`, { source: { branch: 'gh-pages', path: '/' } }, [201, 409, 422]);
  if (pages.status !== 201) await call('PUT', `/repos/${owner}/${name}/pages`, { source: { branch: 'gh-pages', path: '/' } }, [204, 200, 409, 422]).catch(() => {});
  if (gh.domain) await call('PUT', `/repos/${owner}/${name}/pages`, { cname: gh.domain, source: { branch: 'gh-pages', path: '/' } }, [204, 200, 400, 409, 422]);
  const info = await call('GET', `/repos/${owner}/${name}/pages`, null, [200, 404]);
  const url = (gh.domain && `https://${gh.domain}/`) || (info.status === 200 && info.j.html_url) || (name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${owner.toLowerCase()}.github.io/` : `https://${owner.toLowerCase()}.github.io/${name}/`);
  return { url, commit: c.j.sha, files: files.length };
}

/** Cloudflare Pages: project name rules and wrangler arguments (run through npx). */
const CF_NAME = /^[a-z0-9][a-z0-9-]{0,57}$/;
function wranglerArgs(dir, project, branch = 'main') {
  if (!CF_NAME.test(project || '')) throw Object.assign(new Error('Project name: small letters, digits and -, e.g. my-site'), { status: 400 });
  return ['--yes', 'wrangler@3', 'pages', 'deploy', dir, '--project-name', project, '--branch', branch, '--commit-dirty=true'];
}
/** URL printed by wrangler (…pages.dev) */
const wranglerUrl = (out) => { const m = String(out || '').match(/https:\/\/[a-z0-9.-]+\.pages\.dev\S*/i); return m ? m[0].replace(/[).,]+$/, '') : null; };


/* ---------------- Eigene Domain ---------------- */
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** "https://www.Example.com/" → "www.example.com"; empty stays empty; anything else is refused. */
function cleanDomain(d) {
  const v = String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!v) return '';
  if (!DOMAIN_RE.test(v)) throw Object.assign(new Error('Domain like www.example.com – without https:// and without a path'), { status: 400 });
  return v;
}

/* ---------------- Seiten-Check vor dem Veröffentlichen (ohne Server, direkt auf den Dateien) ---------------- */
const DEBUG = [
  [/<b>(Warning|Notice|Deprecated|Fatal error|Parse error)<\/b>:/i, 'PHP message visible'],
  [/Stack trace:|Traceback \(most recent call last\)|Uncaught (Exception|Error|TypeError)/i, 'Error stack trace visible'],
  [/SQLSTATE\[|You have an error in your SQL syntax/i, 'SQL error message visible'],
];
/**
 * Checks the built folder like Hostwerk's site check, but right on the files: broken links and missing images/CSS/JS
 * between the pages, links starting with "/" that break on a GitHub project page (it lives under /<repo>/), missing
 * <title>, http:// content, left-over debug output. → { pages, errors: [{ file, text, ref }], warnings: [...] }
 */
function checkSite(dir, { base = '/' } = {}) {
  const { files } = collect(dir);
  const have = new Set(files.map((f) => f.rel.toLowerCase()));
  const errors = []; const warnings = [];
  const exists = (rel) => {
    const r = rel.replace(/^\/+/, '').toLowerCase();
    return have.has(r) || have.has(`${r.replace(/\/$/, '')}/index.html`) || have.has(`${r}.html`) || (r === '' && have.has('index.html'));
  };
  const pages = files.filter((f) => /\.html?$/i.test(f.rel));
  for (const p of pages) {
    const html = fs.readFileSync(p.file, 'utf8');
    if (!/<title[^>]*>[^<]+<\/title>/i.test(html)) warnings.push({ file: p.rel, text: 'No <title> – bad for search engines and bookmarks' });
    if (/\b(src|href)\s*=\s*["']http:\/\//i.test(html)) warnings.push({ file: p.rel, text: 'Insecure http:// content – browsers block it on https pages' });
    for (const [re, text] of DEBUG) if (re.test(html)) errors.push({ file: p.rel, text });
    const dirOf = p.rel.includes('/') ? p.rel.slice(0, p.rel.lastIndexOf('/') + 1) : '';
    for (const m of html.matchAll(/\b(?:href|src)\s*=\s*["']([^"'#?]+)[^"']*["']/gi)) {
      const ref = m[1].trim();
      if (!ref || /^(https?:|mailto:|tel:|javascript:|data:|\/\/)/i.test(ref) || ref.includes('{')) continue;
      if (ref.startsWith('/')) {
        // Auf einer Projektseite (user.github.io/repo/) zeigt "/css/a.css" ins Leere – vorher warnen
        if (base !== '/' && !ref.startsWith(base)) warnings.push({ file: p.rel, text: 'Link starts with / – on this page it points outside the site', ref });
        const inside = base !== '/' && ref.startsWith(base) ? ref.slice(base.length) : ref;
        if (!exists(inside)) errors.push({ file: p.rel, text: 'Missing file or page', ref });
        continue;
      }
      let target;
      try { target = decodeURIComponent(new URL(ref, `http://x/${dirOf}`).pathname); } catch { continue; }
      if (!exists(target)) errors.push({ file: p.rel, text: 'Missing file or page', ref });
    }
  }
  return { pages: pages.length, errors, warnings };
}
/**
 * Ergebnis von Hostwerks Seiten-Check (SDK 3.1, host.service('sitecheck').checkDir) in die Form von checkSite():
 * { pages, errors: [{ file, text, ref }], warnings }. Hostwerk schreibt deutsch – bekannte Befunde bekommen den englischen
 * Text dieser Erweiterung (host.t übersetzt ihn), Langsamkeit zählt bei der lokalen Probe nicht.
 */
const CORE_TEXT = [
  [/^PHP-/, 'PHP message visible'], [/^Fehler-Stacktrace/, 'Error stack trace visible'], [/^SQL-Fehlermeldung/, 'SQL error message visible'],
  [/^var_dump/, 'var_dump output visible'], [/^Debug-Seite/, 'Framework debug page visible'],
  [/^Kein <title>/, 'No <title> – bad for search engines and bookmarks'], [/^Unsichere http:/, 'Insecure http:// content – browsers block it on https pages'],
  [/^Sehr groß/, 'Very large HTML page'],
];
function fromCore(r, base = '/') {
  const b = `/${String(base || '/').replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
  const rel = (u) => { const s = String(u || ''); if (!s.startsWith(b)) return s.replace(/^\/+/, '') || 'index.html'; const x = s.slice(b.length); return !x ? 'index.html' : x.endsWith('/') ? `${x}index.html` : x; };
  const errors = []; const warnings = [];
  for (const p of (r && r.pages) || []) {
    for (const i of p.issues || []) {
      if (/^(HTTP-Fehler|Nicht erreichbar|Langsam)/.test(i.text)) continue; // kaputte Seiten stehen unten, Tempo zählt lokal nicht
      const hit = CORE_TEXT.find(([re]) => re.test(i.text));
      const text = hit ? hit[1] : i.text;
      if (i.level === 'err') errors.push({ file: rel(p.url), text });
      else if (i.level === 'warn' || (hit && /<title>/.test(text))) warnings.push({ file: rel(p.url), text });
    }
  }
  for (const x of (r && r.broken) || []) {
    const outside = b !== '/' && String(x.url).startsWith('/') && !String(x.url).startsWith(b);
    errors.push({ file: x.foundOn && x.foundOn[0] ? rel(x.foundOn[0]) : '–', text: outside ? 'Link starts with / – on this page it points outside the site' : 'Missing file or page', ref: x.url });
  }
  return { pages: ((r && r.pages) || []).filter((p) => p.status > 0 && p.status < 400).length, errors, warnings, truncated: !!(r && r.summary && r.summary.truncated) };
}

/** Path under which a target serves the site: GitHub project pages live under /<repo>/, everything else at /. */
function sitePath(site) {
  if (site.target === 'github' && !site.domain && REPO_RE.test(site.repo || '')) { const [owner, name] = site.repo.split('/'); return name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? '/' : `/${name}/`; }
  if (site.target === 'codeberg' && !site.domain && REPO_RE.test(site.repo || '')) { const name = site.repo.split('/')[1]; return name === 'pages' ? '/' : `/${name}/`; }
  return '/';
}

/* ---------------- Zurück auf eine frühere Veröffentlichung ---------------- */
/**
 * GitHub: a NEW commit on gh-pages with the files of an earlier one – the history stays complete and the step can be
 * undone in turn. → { url, commit }
 */
async function githubRollback(gh, sha, { fetchFn = fetch, api = 'https://api.github.com' } = {}) {
  if (!REPO_RE.test(gh.repo || '') || !/^[a-f0-9]{7,40}$/i.test(sha || '')) throw Object.assign(new Error('This entry cannot be restored.'), { status: 400 });
  const [owner, name] = gh.repo.split('/');
  const call = async (method, p, body, ok = [200, 201]) => {
    const r = await fetchFn(`${api}${p}`, { method, headers: { authorization: `Bearer ${gh.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'Hostwerk' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!ok.includes(r.status)) throw Object.assign(new Error(r.status === 401 ? 'GitHub does not accept the token.' : `GitHub: ${j.message || r.status}`), { status: r.status });
    return j;
  };
  const old = await call('GET', `/repos/${owner}/${name}/git/commits/${sha}`);
  const head = await call('GET', `/repos/${owner}/${name}/git/ref/heads/gh-pages`);
  const c = await call('POST', `/repos/${owner}/${name}/git/commits`, { message: `Back to ${sha.slice(0, 7)} (Hostwerk)`, tree: old.tree.sha, parents: [head.object.sha] });
  await call('PATCH', `/repos/${owner}/${name}/git/refs/heads/gh-pages`, { sha: c.sha, force: true });
  return { commit: c.sha };
}
/** Cloudflare: add an own domain to the project (already there → fine). Cloudflare shows the DNS entry it needs. */
async function cloudflareDomain(cf, domain, { fetchFn = fetch, api = 'https://api.cloudflare.com/client/v4' } = {}) {
  const r = await fetchFn(`${api}/accounts/${cf.account}/pages/projects/${cf.project}/domains`, { method: 'POST', headers: { authorization: `Bearer ${cf.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: domain }) });
  const j = await r.json().catch(() => ({}));
  if (r.ok || r.status === 409 || /already/i.test(JSON.stringify(j.errors || ''))) return { ok: true };
  throw Object.assign(new Error(`Cloudflare: ${(j.errors && j.errors[0] && j.errors[0].message) || r.status}`), { status: r.status });
}
/** Cloudflare: find the deployment by its address (abc123.project.pages.dev) and roll back to it. */
async function cloudflareRollback(cf, url, { fetchFn = fetch, api = 'https://api.cloudflare.com/client/v4' } = {}) {
  if (!CF_NAME.test(cf.project || '') || !/^[a-f0-9]{32}$/i.test(cf.account || '')) throw Object.assign(new Error('Add the Cloudflare API token and account ID first.'), { status: 400 });
  const call = async (method, p) => {
    const r = await fetchFn(`${api}/accounts/${cf.account}/pages/projects/${cf.project}${p}`, { method, headers: { authorization: `Bearer ${cf.token}`, 'content-type': 'application/json' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.success === false) throw Object.assign(new Error(`Cloudflare: ${(j.errors && j.errors[0] && j.errors[0].message) || r.status}`), { status: r.status });
    return j.result;
  };
  const host = (() => { try { return new URL(url).host; } catch { return ''; } })();
  const list = await call('GET', '/deployments');
  const d = (list || []).find((x) => { try { return new URL(x.url).host === host; } catch { return false; } });
  if (!d) throw Object.assign(new Error('Cloudflare no longer knows this version.'), { status: 404 });
  await call('POST', `/deployments/${d.id}/rollback`);
  return { deployment: d.id };
}

/* ---------------- Codeberg Pages (Forgejo-API) ---------------- */
const gitBlobSha = (buf) => require('crypto').createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
/**
 * Codeberg Pages: the files go into the branch "pages" of a Codeberg repository in ONE commit (create, update, delete –
 * unchanged files are left alone). Result: https://<owner>.codeberg.page/<repo>/ (repository "pages" = main page).
 */
async function codebergPages(dir, cb, { fetchFn = fetch, log = () => {}, api = 'https://codeberg.org/api/v1', message = 'Publish with Hostwerk' } = {}) {
  if (!cb.token) throw Object.assign(new Error('A Codeberg token is needed.'), { status: 400 });
  if (!REPO_RE.test(cb.repo || '')) throw Object.assign(new Error('Repository as owner/name, e.g. alex/my-site'), { status: 400 });
  const { files } = collect(dir);
  // Eigene Domain: Codeberg Pages liest sie aus der Datei .domains
  const extra = cb.domain ? [{ rel: '.domains', buf: Buffer.from(`${cb.domain}\n`) }] : [];
  const call = async (method, p, body, ok = [200, 201]) => {
    const r = await fetchFn(`${api}${p}`, { method, headers: { authorization: `token ${cb.token}`, accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'Hostwerk' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!ok.includes(r.status)) throw Object.assign(new Error(r.status === 401 ? 'Codeberg does not accept the token.' : r.status === 403 ? 'The token may not write to this repository.' : `Codeberg: ${j.message || r.status}`), { status: r.status });
    return { status: r.status, j };
  };
  const [owner, name] = cb.repo.split('/');
  const repo = await call('GET', `/repos/${owner}/${name}`, null, [200, 404]);
  if (repo.status === 404) {
    if (!cb.create) throw Object.assign(new Error('The repository does not exist – tick “create it” or create it on Codeberg.'), { status: 400 });
    log(`Create repository ${cb.repo}`);
    await call('POST', '/user/repos', { name, private: false, auto_init: true, default_branch: 'main', description: 'Published with Hostwerk' });
  }
  const tree = await call('GET', `/repos/${owner}/${name}/git/trees/pages?recursive=true&per_page=10000`, null, [200, 404]);
  const existing = new Map(tree.status === 200 ? (tree.j.tree || []).filter((x) => x.type === 'blob').map((x) => [x.path, x.sha]) : []);
  const ops = [];
  for (const f of [...files.filter((x) => !(extra.length && x.rel === '.domains')), ...extra]) {
    const buf = f.buf || fs.readFileSync(f.file);
    const old = existing.get(f.rel);
    if (old === gitBlobSha(buf)) { existing.delete(f.rel); continue; }
    ops.push({ operation: old ? 'update' : 'create', path: f.rel, content: buf.toString('base64'), ...(old ? { sha: old } : {}) });
    existing.delete(f.rel);
  }
  for (const [p, sha] of existing) ops.push({ operation: 'delete', path: p, sha });
  log(`Upload ${ops.length} changes`);
  let commit = null;
  if (ops.length) {
    const r = await call('POST', `/repos/${owner}/${name}/contents`, { files: ops, message, ...(tree.status === 404 ? { new_branch: 'pages' } : { branch: 'pages' }) });
    commit = (r.j.commit && r.j.commit.sha) || null;
  }
  const url = cb.domain ? `https://${cb.domain}/` : name === 'pages' ? `https://${owner.toLowerCase()}.codeberg.page/` : `https://${owner.toLowerCase()}.codeberg.page/${name}/`;
  return { url, commit, files: files.length, changed: ops.length };
}

/* ---------------- Eigener Server per SFTP ---------------- */
/**
 * Copies the folder to an own server over SFTP (ssh2-sftp-client from Hostwerk). sftp: a connected client with
 * mkdir/put/list/delete – injectable for the tests. Files that are no longer part of the site are removed
 * (only inside the target folder). → { url, files }
 */
async function sftpUpload(dir, target, sftp, { log = () => {} } = {}) {
  const remote = String(target.path || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!remote.startsWith('/') || remote.split('/').length < 3 || /\/\.\.(\/|$)/.test(remote)) throw Object.assign(new Error('Target folder on the server as an absolute path, at least two levels deep – e.g. /var/www/my-site'), { status: 400 });
  const { files } = collect(dir);
  const dirs = new Set(files.map((f) => f.rel.split('/').slice(0, -1).join('/')).filter(Boolean));
  await sftp.mkdir(remote, true);
  for (const d of [...dirs].sort()) await sftp.mkdir(`${remote}/${d}`, true);
  log(`Upload ${files.length} files`);
  for (const f of files) await sftp.put(f.file, `${remote}/${f.rel}`);
  // Aufräumen: was nicht mehr zur Seite gehört (nur Dateien, nur im Zielordner)
  const keep = new Set(files.map((f) => f.rel));
  const walk = async (rel) => {
    for (const e of await sftp.list(rel ? `${remote}/${rel}` : remote)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.type === 'd') { if (dirs.has(r)) await walk(r); } else if (!keep.has(r)) await sftp.delete(`${remote}/${r}`);
    }
  };
  await walk('');
  return { url: target.url || null, files: files.length };
}

module.exports = { collect, githubPages, wranglerArgs, wranglerUrl, REPO_RE, CF_NAME, cleanDomain, checkSite, fromCore, sitePath, githubRollback, cloudflareRollback, cloudflareDomain, codebergPages, sftpUpload, gitBlobSha };

