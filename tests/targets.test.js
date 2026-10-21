'use strict';
/*
 * Own domain, site check on the files, going back to an earlier version (GitHub, Cloudflare), Codeberg Pages and the
 * own server per SFTP – all against small stand-ins, nothing goes to the internet.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const P = require('../server/publish');

const folder = (files) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-t-'));
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); }
  return d;
};
/** A tiny JSON API stand-in: handler(method, url, body) → [status, json] */
async function fakeApi(handler) {
  const calls = [];
  const srv = http.createServer((q, res) => {
    let b = ''; q.on('data', (x) => { b += x; }); q.on('end', () => {
      const body = b ? JSON.parse(b) : null; calls.push({ method: q.method, url: q.url, body, auth: q.headers.authorization });
      const [code, j] = handler(q.method, q.url, body, q) || [404, { message: 'unknown' }];
      res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j || {}));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { api: `http://127.0.0.1:${srv.address().port}`, calls, close: () => srv.close() };
}

test('own domain: cleaned and checked', () => {
  assert.strictEqual(P.cleanDomain(' https://WWW.Example.com/path '), 'www.example.com');
  assert.strictEqual(P.cleanDomain(''), '');
  for (const bad of ['localhost', 'a b.de', 'x', '-x.de', 'exa mple.com']) assert.throws(() => P.cleanDomain(bad), /Domain like/, bad);
});

test('site check: broken links, missing assets, root links on GitHub project pages, title, debug output', () => {
  const d = folder({
    'index.html': '<title>Home</title><a href="about/">About</a><a href="gone.html">Gone</a><img src="img/logo.png"><link href="/css/a.css" rel="stylesheet"><a href="https://ok.example">x</a><a href="#top">t</a>',
    'about/index.html': '<h1>No title</h1><a href="../index.html">back</a><script src="http://cdn.example/x.js"></script>',
    'css/a.css': 'h1{}',
    'debug.html': '<title>D</title>Stack trace: at x',
  });
  const r = P.checkSite(d, { base: '/' });
  assert.strictEqual(r.pages, 3);
  assert.deepStrictEqual(r.errors.filter((e) => e.ref).map((e) => e.ref).sort(), ['gone.html', 'img/logo.png']);
  assert.ok(r.errors.some((e) => e.file === 'debug.html' && /stack trace/i.test(e.text)));
  assert.ok(r.warnings.some((w) => w.file === 'about/index.html' && /title/.test(w.text)));
  assert.ok(r.warnings.some((w) => /http:\/\//.test(w.text)));
  // Auf user.github.io/club/ zeigt "/css/a.css" ins Leere
  const gh = P.checkSite(d, { base: P.sitePath({ target: 'github', repo: 'alex/club' }) });
  assert.ok(gh.warnings.some((w) => w.ref === '/css/a.css'));
  assert.strictEqual(P.sitePath({ target: 'github', repo: 'alex/alex.github.io' }), '/');
  assert.strictEqual(P.sitePath({ target: 'github', repo: 'alex/club', domain: 'club.de' }), '/');
  assert.strictEqual(P.sitePath({ target: 'codeberg', repo: 'alex/pages' }), '/');
});

test('GitHub: own domain goes into CNAME and the Pages settings; back to an earlier commit as a new commit', async () => {
  const blobs = {};
  const f = await fakeApi((m, u, b) => {
    if (u === '/repos/alex/club') return [200, {}];
    if (/git\/blobs$/.test(u)) { const sha = `b${Object.keys(blobs).length}`; blobs[sha] = Buffer.from(b.content, b.encoding === 'base64' ? 'base64' : 'utf8').toString(); return [201, { sha }]; }
    if (/git\/trees$/.test(u)) return [201, { sha: 'tree1', paths: b.tree.map((x) => x.path) }];
    if (/git\/commits$/.test(u)) return [201, { sha: `c-${b.tree}` }];
    if (/git\/commits\/abc1234$/.test(u)) return [200, { tree: { sha: 'oldtree' } }];
    if (/git\/ref\/heads\/gh-pages$/.test(u)) return [200, { object: { sha: 'head' } }];
    if (/git\/refs\/heads\/gh-pages$/.test(u)) return [200, {}];
    if (/\/pages$/.test(u)) return m === 'POST' ? [409, {}] : m === 'PUT' ? [204, {}] : [200, { html_url: 'https://alex.github.io/club/' }];
    return null;
  });
  const d = folder({ 'index.html': '<title>x</title>' });
  const r = await P.githubPages(d, { token: 't', repo: 'alex/club', domain: 'club.example.com' }, { api: f.api });
  assert.strictEqual(r.url, 'https://club.example.com/');
  assert.ok(Object.values(blobs).includes('club.example.com\n'), 'CNAME file');
  assert.ok(f.calls.some((c) => c.method === 'PUT' && /\/pages$/.test(c.url) && c.body.cname === 'club.example.com'));
  const back = await P.githubRollback({ token: 't', repo: 'alex/club' }, 'abc1234', { api: f.api });
  assert.strictEqual(back.commit, 'c-oldtree');
  const commit = f.calls.find((c) => c.method === 'POST' && /git\/commits$/.test(c.url) && c.body.tree === 'oldtree');
  assert.deepStrictEqual(commit.body.parents, ['head'], 'builds on the current state – nothing is lost');
  await assert.rejects(P.githubRollback({ token: 't', repo: 'alex/club' }, 'not-a-sha', { api: f.api }), /cannot be restored/);
  f.close();
});

test('Cloudflare: own domain and back to a deployment found by its address', async () => {
  const acc = 'a'.repeat(32);
  const f = await fakeApi((m, u) => {
    if (m === 'POST' && /\/domains$/.test(u)) return [409, { success: false, errors: [{ message: 'already added' }] }];
    if (m === 'GET' && /\/deployments$/.test(u)) return [200, { success: true, result: [{ id: 'dep-new', url: 'https://new1.club.pages.dev' }, { id: 'dep-old', url: 'https://old1.club.pages.dev' }] }];
    if (m === 'POST' && /\/deployments\/dep-old\/rollback$/.test(u)) return [200, { success: true, result: {} }];
    return null;
  });
  const cf = { token: 'tok', account: acc, project: 'club' };
  assert.deepStrictEqual(await P.cloudflareDomain(cf, 'club.example.com', { api: f.api }), { ok: true });
  assert.deepStrictEqual(await P.cloudflareRollback(cf, 'https://old1.club.pages.dev', { api: f.api }), { deployment: 'dep-old' });
  await assert.rejects(P.cloudflareRollback(cf, 'https://gone.club.pages.dev', { api: f.api }), /no longer knows/);
  assert.ok(f.calls.every((c) => c.auth === 'Bearer tok'));
  f.close();
});

test('Codeberg Pages: one commit with create, update and delete; unchanged files stay; own domain in .domains', async () => {
  const same = Buffer.from('h1{}');
  const f = await fakeApi((m, u, b) => {
    if (u === '/repos/alex/club') return [200, {}];
    if (u.startsWith('/repos/alex/club/git/trees/pages')) return [200, { tree: [{ type: 'blob', path: 'index.html', sha: 'old' }, { type: 'blob', path: 'css/a.css', sha: P.gitBlobSha(same) }, { type: 'blob', path: 'old.html', sha: 'x1' }] }];
    if (m === 'POST' && u === '/repos/alex/club/contents') return [201, { commit: { sha: 'cb1' }, files: b.files }];
    return null;
  });
  const d = folder({ 'index.html': '<title>new</title>', 'css/a.css': 'h1{}', 'new.html': '<title>n</title>' });
  const r = await P.codebergPages(d, { token: 'cbt', repo: 'alex/club', domain: 'club.example.org' }, { api: f.api });
  assert.strictEqual(r.url, 'https://club.example.org/');
  const ops = f.calls.find((c) => c.method === 'POST' && c.url === '/repos/alex/club/contents').body;
  assert.strictEqual(ops.branch, 'pages');
  assert.deepStrictEqual(ops.files.map((x) => `${x.operation} ${x.path}`).sort(), ['create .domains', 'create new.html', 'delete old.html', 'update index.html']);
  assert.strictEqual(Buffer.from(ops.files.find((x) => x.path === '.domains').content, 'base64').toString(), 'club.example.org\n');
  assert.ok(f.calls.every((c) => c.auth === 'token cbt'));
  f.close();
  assert.strictEqual(P.gitBlobSha(Buffer.from('')), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', 'same as git');
});

test('own server per SFTP: creates folders, uploads, removes what no longer belongs to the site', async () => {
  const remote = { '/srv/www/club/stale.html': 1, '/srv/www/club/index.html': 1, '/srv/www/club/css/old.css': 1 };
  const dirs = new Set();
  const sftp = {
    mkdir: async (p) => { dirs.add(p); },
    put: async (local, p) => { remote[p] = fs.readFileSync(local, 'utf8'); },
    list: async (p) => {
      const kids = new Map();
      for (const k of Object.keys(remote)) if (k.startsWith(`${p}/`)) { const rest = k.slice(p.length + 1); const name = rest.split('/')[0]; kids.set(name, rest.includes('/') ? 'd' : '-'); }
      return [...kids].map(([name, type]) => ({ name, type }));
    },
    delete: async (p) => { delete remote[p]; },
  };
  const d = folder({ 'index.html': '<title>x</title>', 'css/a.css': 'h1{}' });
  const r = await P.sftpUpload(d, { path: '/srv/www/club/', url: 'https://club.example.com/' }, sftp);
  assert.deepStrictEqual(r, { url: 'https://club.example.com/', files: 2 });
  assert.deepStrictEqual(Object.keys(remote).sort(), ['/srv/www/club/css/a.css', '/srv/www/club/index.html'], 'stale files removed, new ones there');
  assert.ok(dirs.has('/srv/www/club') && dirs.has('/srv/www/club/css'));
  for (const bad of ['relative/path', '/', '/var', '/srv/../etc/x']) await assert.rejects(P.sftpUpload(d, { path: bad }, sftp), /absolute path/, bad);
});

test('messages of the new targets have German', () => {
  const de = require('../locales/de.json');
  for (const s of ['Missing file or page', 'Domain like www.example.com – without https:// and without a path', 'Codeberg does not accept the token.', 'This entry cannot be restored.', 'Target folder on the server as an absolute path, at least two levels deep – e.g. /var/www/my-site']) assert.ok(de[s], s);
  void crypto;
});
