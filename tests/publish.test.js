'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../server/publish');
const de = require('../locales/de.json');

const site = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
  fs.mkdirSync(path.join(d, 'css')); fs.mkdirSync(path.join(d, 'node_modules', 'x'), { recursive: true }); fs.mkdirSync(path.join(d, '.git'));
  fs.writeFileSync(path.join(d, 'index.html'), '<h1>Hi</h1>'); fs.writeFileSync(path.join(d, 'css', 'a.css'), 'h1{}');
  fs.writeFileSync(path.join(d, '.env'), 'SECRET=1'); fs.writeFileSync(path.join(d, 'node_modules', 'x', 'i.js'), ''); fs.writeFileSync(path.join(d, '.git', 'HEAD'), '');
  return d;
};

test('collect: only the site, never .git, node_modules or .env; index.html required', () => {
  const d = site();
  assert.deepStrictEqual(P.collect(d).files.map((f) => f.rel).sort(), ['css/a.css', 'index.html']);
  fs.rmSync(path.join(d, 'index.html'));
  assert.throws(() => P.collect(d), /index\.html/);
  assert.throws(() => P.collect(path.join(d, 'nope')), /does not exist/);
});

test('Cloudflare: project name checked before it reaches a command line, URL read from the output', () => {
  assert.deepStrictEqual(P.wranglerArgs('C:\\x\\dist', 'club-site').slice(0, 5), ['--yes', 'wrangler@3', 'pages', 'deploy', 'C:\\x\\dist']);
  for (const bad of ['Club', 'a b', 'x&calc', '']) assert.throws(() => P.wranglerArgs('d', bad), /small letters/);
  assert.strictEqual(P.wranglerUrl('✨ Deployment complete! Take a peek over at https://abc123.club-site.pages.dev.'), 'https://abc123.club-site.pages.dev');
});

/** A small GitHub API stand-in: repos, git data, refs, pages. */
function fakeGitHub() {
  const st = { repos: new Set(['alex/existing']), blobs: [], refs: {}, pages: new Set(), calls: [] };
  const srv = http.createServer((q, res) => {
    let b = ''; q.on('data', (x) => { b += x; }); q.on('end', () => {
      const body = b ? JSON.parse(b) : null; const u = q.url; st.calls.push(`${q.method} ${u}`);
      const send = (code, j) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j || {})); };
      if (q.headers.authorization !== 'Bearer good') return send(401, { message: 'Bad credentials' });
      let m;
      if (u === '/user') return send(200, { login: 'alex' });
      if (q.method === 'POST' && u === '/user/repos') { st.repos.add(`alex/${body.name}`); return send(201, { name: body.name }); }
      if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(u))) return send(st.repos.has(m[1]) ? 200 : 404, {});
      if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/blobs$/.exec(u))) { st.blobs.push(Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8').toString()); return send(201, { sha: `b${st.blobs.length}` }); }
      if (/\/git\/trees$/.test(u)) return send(201, { sha: `t-${body.tree.map((t) => t.path).sort().join(',')}` });
      if (/\/git\/commits$/.test(u)) return send(201, { sha: `c${body.parents.length}` });
      if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/ref\/heads\/gh-pages$/.exec(u))) return st.refs[m[1]] ? send(200, { object: { sha: st.refs[m[1]] } }) : send(404, {});
      if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/refs(\/heads\/gh-pages)?$/.exec(u))) { st.refs[m[1]] = body.sha; return send(q.method === 'POST' ? 201 : 200, {}); }
      if ((m = /^\/repos\/([^/]+\/[^/]+)\/pages$/.exec(u))) {
        if (q.method === 'POST') { if (st.pages.has(m[1])) return send(409, {}); st.pages.add(m[1]); return send(201, {}); }
        return send(200, { html_url: `https://alex.github.io/${m[1].split('/')[1]}/` });
      }
      return send(404, { message: `unknown ${q.method} ${u}` });
    });
  });
  return { srv, st };
}

test('GitHub Pages: creates the repo, uploads the files and .nojekyll, switches Pages on; second run builds on it', async () => {
  const { srv, st } = fakeGitHub(); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${srv.address().port}`;
  const d = site();
  await assert.rejects(P.githubPages(d, { token: 'bad', repo: 'alex/new-site', create: true }, { api }), /does not accept the token/);
  await assert.rejects(P.githubPages(d, { token: 'good', repo: 'alex/new-site' }, { api }), /does not exist/);
  const r = await P.githubPages(d, { token: 'good', repo: 'alex/new-site', create: true }, { api });
  assert.strictEqual(r.url, 'https://alex.github.io/new-site/'); assert.strictEqual(r.files, 2);
  assert.ok(st.repos.has('alex/new-site'));
  assert.ok(st.blobs.includes('<h1>Hi</h1>') && st.blobs.includes('h1{}') && !st.blobs.includes('SECRET=1'), 'no .env uploaded');
  assert.strictEqual(r.commit, 'c0', 'first commit has no parent');
  const r2 = await P.githubPages(d, { token: 'good', repo: 'alex/new-site' }, { api });
  assert.strictEqual(r2.commit, 'c1', 'second publish builds on gh-pages');
  assert.ok(st.calls.includes('PATCH /repos/alex/new-site/git/refs/heads/gh-pages'));
  assert.ok(!P.REPO_RE.test('no-slash') && P.REPO_RE.test('alex/site.io'));
  srv.close();
});

test('messages have German', () => {
  for (const s of ['There is no index.html in the folder – pick the folder with the built page.', 'GitHub does not accept the token.', 'The build failed – see the log.']) assert.ok(de[s], s);
});
