'use strict';
/*
 * Publishing a folder of static files – without Hostwerk, so the tests can run it.
 *   GitHub Pages: files go through GitHub's git data API (no local git needed) into the branch gh-pages, Pages is
 *                 switched on for that branch. Result: https://<owner>.github.io/<repo>/ (or the user page).
 *   Cloudflare Pages: Cloudflare's own tool (wrangler) uploads the folder; Hostwerk only builds the arguments.
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

/** Deploy to GitHub Pages. gh = { token, repo: 'owner/name', create: bool, private: bool }. → { url, commit, files } */
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
  const t = await call('POST', `/repos/${owner}/${name}/git/trees`, { tree });
  const c = await call('POST', `/repos/${owner}/${name}/git/commits`, { message, tree: t.j.sha, parents: parent ? [parent] : [] });
  if (parent) await call('PATCH', `/repos/${owner}/${name}/git/refs/heads/gh-pages`, { sha: c.j.sha, force: true });
  else await call('POST', `/repos/${owner}/${name}/git/refs`, { ref: 'refs/heads/gh-pages', sha: c.j.sha });
  // Switch Pages on for gh-pages (already on → 409, fine)
  const pages = await call('POST', `/repos/${owner}/${name}/pages`, { source: { branch: 'gh-pages', path: '/' } }, [201, 409, 422]);
  if (pages.status !== 201) await call('PUT', `/repos/${owner}/${name}/pages`, { source: { branch: 'gh-pages', path: '/' } }, [204, 200, 409, 422]).catch(() => {});
  const info = await call('GET', `/repos/${owner}/${name}/pages`, null, [200, 404]);
  const url = (info.status === 200 && info.j.html_url) || (name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${owner.toLowerCase()}.github.io/` : `https://${owner.toLowerCase()}.github.io/${name}/`);
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

module.exports = { collect, githubPages, wranglerArgs, wranglerUrl, REPO_RE, CF_NAME };
