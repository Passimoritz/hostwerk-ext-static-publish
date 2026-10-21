import { useState } from 'react';
import { Rocket, Plus, Trash2, GitBranch, Cloud, ExternalLink, KeyRound, Save, CheckCircle2, XCircle, Server, Mountain, SearchCheck, History, Undo2, RefreshCw } from 'lucide-react';
import { put, post, useApi, waitJob, openExternal } from '@hostwerk/api';
import { Btn, Seg, Field, Modal, Empty, Loading, InfoTip, PathInput, Callout, toast, confirmDialog } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import './style.css';

/*
 * Static publish: sites (project folder + build + output folder + target) as cards, accounts in a dialog.
 * Targets: GitHub Pages, Cloudflare Pages, Codeberg Pages, own server per SFTP – each with an own domain if wanted.
 * Before publishing a site check runs right on the built files; the history can go back to an earlier version.
 * Texts are English; German comes from locales/de.json (also inside JSX).
 */
const uid = () => Math.random().toString(36).slice(2, 12);
const locale = () => (document.documentElement.lang === 'en' ? 'en-GB' : 'de-DE');
const when = (ts) => new Date(ts).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
const TARGETS = [{ id: 'github', label: 'GitHub Pages', icon: GitBranch }, { id: 'cloudflare', label: 'Cloudflare Pages', icon: Cloud }, { id: 'codeberg', label: 'Codeberg Pages', icon: Mountain }, { id: 'sftp', label: 'Own server (SFTP)', icon: Server }];
const targetOf = (id) => TARGETS.find((x) => x.id === id) || TARGETS[0];
const CAN_ROLLBACK = ['github', 'cloudflare'];

function Accounts({ a, onClose, onSaved }) {
  const [gh, setGh] = useState('');
  const [cf, setCf] = useState('');
  const [cb, setCb] = useState('');
  const [acc, setAcc] = useState(a.cloudflareAccount || '');
  const save = async () => {
    try {
      onSaved(await put('/static-publish/accounts', { ...(gh ? { githubToken: gh } : {}), ...(cf ? { cloudflareToken: cf } : {}), ...(cb ? { codebergToken: cb } : {}), cloudflareAccount: acc }));
      toast.success('Saved'); onClose();
    } catch (e) { toast.error(e); }
  };
  return (
    <Modal title="Accounts" subtitle="Stored sealed on this PC – they never leave it except to GitHub, Cloudflare or Codeberg." onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" icon={Save} onClick={save}>Save</Btn></>}>
      <div className="stack">
        <Field label={a.github ? 'GitHub token (saved – enter a new one to replace it)' : 'GitHub token'} hint="Fine-grained token with “Contents: read and write” and “Pages: read and write” (and “Administration” if Hostwerk should create the repository).">
          <input className="input mono" type="password" autoComplete="off" value={gh} onChange={(e) => setGh(e.target.value)} placeholder="github_pat_…" />
        </Field>
        <div><Btn className="sm ghost" icon={ExternalLink} onClick={() => openExternal('https://github.com/settings/personal-access-tokens/new')}>Create a GitHub token</Btn></div>
        <Field label={a.cloudflare ? 'Cloudflare API token (saved)' : 'Cloudflare API token'} hint="Template “Edit Cloudflare Workers” or a token with “Cloudflare Pages: Edit”."><input className="input mono" type="password" autoComplete="off" value={cf} onChange={(e) => setCf(e.target.value)} /></Field>
        <Field label="Cloudflare account ID" hint="Shown on the right in the Cloudflare dashboard (Workers & Pages)."><input className="input mono" value={acc} onChange={(e) => setAcc(e.target.value)} /></Field>
        <Field label={a.codeberg ? 'Codeberg token (saved)' : 'Codeberg token'} hint="Codeberg → Settings → Applications → token with “repository: read and write”."><input className="input mono" type="password" autoComplete="off" value={cb} onChange={(e) => setCb(e.target.value)} /></Field>
        <div><Btn className="sm ghost" icon={ExternalLink} onClick={() => openExternal('https://codeberg.org/user/settings/applications')}>Create a Codeberg token</Btn></div>
      </div>
    </Modal>
  );
}

function SiteEditor({ site, projects, onClose, onSave }) {
  const [s, setS] = useState({ check: 'warn', domain: '', sftp: { host: '', port: 22, user: '', path: '', url: '' }, ...site });
  const set = (k) => (v) => setS({ ...s, [k]: v && v.target ? v.target.value : v });
  const setSftp = (k) => (e) => setS({ ...s, sftp: { ...s.sftp, [k]: e.target.value } });
  const repoTarget = s.target === 'github' || s.target === 'codeberg';
  return (
    <Modal title={site.name ? t('Site “{name}”', { name: site.name }) : 'New site'} size="lg" onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" icon={Save} disabled={!s.name || !s.dir} onClick={() => onSave(s)}>Save</Btn></>}>
      <div className="stack">
        <Field label="Name"><input className="input" value={s.name} onChange={set('name')} placeholder="e.g. Club website" /></Field>
        <Field label="Project folder">
          <PathInput mode="folder" title="Project folder" value={s.dir} onChange={set('dir')} />
        </Field>
        {projects.length > 0 && <div className="row-tight sp-chips"><span className="tiny muted">Your projects:</span>{projects.slice(0, 10).map((p) => <button type="button" key={p.path} className="chip-btn" onClick={() => setS({ ...s, dir: p.path, name: s.name || p.name })}>{p.name}</button>)}</div>}
        <div className="grid grid-2">
          <Field label="Build command (optional)" hint="e.g. npm run build – empty for plain HTML"><input className="input mono" value={s.build} onChange={set('build')} placeholder="npm run build" /></Field>
          <Field label="Folder with the finished page" hint="e.g. dist, build, public – “.” for the project folder"><input className="input mono" value={s.out} onChange={set('out')} placeholder="dist" /></Field>
        </div>
        <Field label="Where to"><Seg options={TARGETS.map((x) => ({ id: x.id, label: x.label }))} value={s.target} onChange={set('target')} /></Field>
        {repoTarget && (
          <>
            <Field label="Repository" hint={s.target === 'github' ? 'owner/name – e.g. alex/club-site. owner/owner.github.io becomes your main page.' : 'owner/name – e.g. alex/club-site. A repository called “pages” becomes your main page.'}><input className="input mono" value={s.repo} onChange={set('repo')} placeholder="alex/club-site" /></Field>
            <label className="check"><input type="checkbox" checked={s.create} onChange={(e) => setS({ ...s, create: e.target.checked })} />Create it if it does not exist</label>
          </>
        )}
        {s.target === 'cloudflare' && <Field label="Cloudflare project name" hint="small letters, digits and - · the page will be at NAME.pages.dev"><input className="input mono" value={s.project} onChange={set('project')} placeholder="club-site" /></Field>}
        {s.target === 'sftp' && (
          <div className="grid grid-2">
            <Field label="Server"><input className="input mono" value={s.sftp.host} onChange={setSftp('host')} placeholder="example.com" /></Field>
            <Field label="Port"><input className="input mono" inputMode="numeric" value={s.sftp.port} onChange={setSftp('port')} /></Field>
            <Field label="User"><input className="input mono" autoComplete="off" value={s.sftp.user} onChange={setSftp('user')} /></Field>
            <Field label={s.sftpLogin ? 'Password or private key (saved – enter to replace)' : 'Password or private key'} hint="Stored sealed on this PC."><input className="input mono" type="password" autoComplete="off" value={s.sftpSecret || ''} onChange={(e) => setS({ ...s, sftpSecret: e.target.value })} /></Field>
            <Field label="Folder on the server" hint="Absolute path, e.g. /var/www/club-site – files that no longer belong to the site are removed there."><input className="input mono" value={s.sftp.path} onChange={setSftp('path')} placeholder="/var/www/club-site" /></Field>
            <Field label="Address of the page (optional)"><input className="input mono" value={s.sftp.url} onChange={setSftp('url')} placeholder="https://club.example.com/" /></Field>
          </div>
        )}
        {s.target !== 'sftp' && (
          <Field label="Own domain (optional)" hint={s.target === 'cloudflare' ? 'Cloudflare then shows the DNS entry it needs under Workers & Pages → Custom domains.' : 'Point a CNAME entry of your domain to the address of the page – Hostwerk sets the domain at the host.'}>
            <input className="input mono" value={s.domain} onChange={set('domain')} placeholder="www.club.example" />
          </Field>
        )}
        <Field label="Site check before publishing" hint="Looks through the built files for broken links, missing pictures, CSS or JS and left-over error messages.">
          <Seg options={[{ id: 'warn', label: 'Only warn' }, { id: 'block', label: 'Stop on problems' }, { id: 'off', label: 'Off' }]} value={s.check} onChange={set('check')} />
        </Field>
      </div>
    </Modal>
  );
}

function CheckReport({ site, r, onClose }) {
  return (
    <Modal title={t('Site check: {name}', { name: site.name })} size="lg" onClose={onClose} footer={<Btn className="primary" onClick={onClose}>Done</Btn>}>
      <div className="stack">
        <Callout kind={r.errors.length ? 'err' : r.warnings.length ? 'warn' : 'ok'} dismissible={false}>{r.errors.length || r.warnings.length ? t('{p} pages · {e} problems · {w} hints', { p: r.pages, e: r.errors.length, w: r.warnings.length }) : t('{p} pages – no problems found.', { p: r.pages })}</Callout>
        {r.engine && <div className="tiny muted">{r.engine === 'hostwerk' ? t('Checked like a visitor: Hostwerk served the built folder for a moment and went through every page.') : t('Checked right on the built files.')}{r.truncated ? ` ${t('Only the first 200 pages were checked.')}` : ''}</div>}
        {[...r.errors.map((x) => ({ ...x, err: true })), ...r.warnings].slice(0, 200).map((x, i) => (
          <div key={i} className="row-tight small sp-issue">
            {x.err ? <XCircle size={14} className="c-err" aria-label="Problem" /> : <SearchCheck size={14} className="c-warn" aria-label="Hint" />}
            <code className="sp-file">{x.file}</code><span className="grow">{x.text}{x.ref ? <> – <code>{x.ref}</code></> : null}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function StaticPublishPage() {
  const st = useApi('/static-publish', [], { live: false });
  const [acc, setAcc] = useState(false);
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(null);
  const [report, setReport] = useState(null);
  const [hist, setHist] = useState(null);
  const d = st.data;
  if (st.error && !d) return <div className="page"><Empty icon={Rocket} title="Couldn't load the sites" text={String(st.error.message || st.error)} action={<Btn className="sm" icon={RefreshCw} onClick={() => st.reload()}>Try again</Btn>} /></div>;
  if (!d) return <Loading />;
  const saveSites = async (sites) => st.setData(await put('/static-publish/sites', { sites }));
  const saveSite = async (s) => { try { await saveSites(d.sites.some((x) => x.id === s.id) ? d.sites.map((x) => (x.id === s.id ? s : x)) : [...d.sites, s]); setEdit(null); } catch (e) { toast.error(e); } };
  const remove = async (s) => { if (await confirmDialog({ title: t('Remove “{name}”?', { name: s.name }), text: 'Only the entry in Hostwerk – the published page stays online.', confirm: 'Remove', danger: true })) saveSites(d.sites.filter((x) => x.id !== s.id)); };
  const deploy = async (s) => {
    setBusy(s.id);
    try { const r = await post(`/static-publish/sites/${s.id}/deploy`); const j = await waitJob(r.job); toast.success(t('Published: {url}', { url: j.result.url })); } catch (e) { toast.error(e); }
    st.reload({ silent: true }); setBusy(null);
  };
  const check = async (s) => { setBusy(`c${s.id}`); try { setReport({ site: s, r: await post(`/static-publish/sites/${s.id}/check`) }); } catch (e) { toast.error(e); } setBusy(null); };
  const rollback = async (s, index) => {
    const e = s.history[index];
    if (!(await confirmDialog({ title: 'Back to this version?', text: t('The page shows the version from {when} again. The current one stays in the history.', { when: when(e.t) }), confirm: 'Go back' }))) return;
    setBusy(s.id);
    try { const r = await post(`/static-publish/sites/${s.id}/rollback`, { index }); await waitJob(r.job); toast.success('Earlier version is online again'); } catch (er) { toast.error(er); }
    st.reload({ silent: true }); setBusy(null); setHist(null);
  };
  const noAccount = !d.accounts.github && !d.accounts.cloudflare && !d.accounts.codeberg && !d.sites.some((s) => s.target === 'sftp');
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <h1><Rocket /> Publish static sites</h1>
          <p>Put a project online with one click – on GitHub Pages, Cloudflare Pages, Codeberg Pages or your own server.</p>
        </div>
        <div className="actions">
          <Btn className="sm ghost" icon={KeyRound} onClick={() => setAcc(true)}>Accounts</Btn>
          <Btn className="sm primary" icon={Plus} onClick={() => setEdit({ id: uid(), name: '', dir: '', build: '', out: 'dist', target: 'github', repo: '', create: true, project: '', domain: '', check: 'warn' })}>New site</Btn>
        </div>
      </div>
      {noAccount && <div className="card mb"><div className="card-body row-tight"><span className="small grow">First add a token for GitHub, Cloudflare or Codeberg – Hostwerk uses it only for publishing. For your own server you enter the login at the site.</span><Btn className="sm" icon={KeyRound} onClick={() => setAcc(true)}>Add account</Btn></div></div>}
      {!d.sites.length ? <Empty icon={Rocket} title="No site yet" text="Add a site: project folder, build command, folder with the finished page and where it should go." /> : (
        <div className="grid grid-2">
          {d.sites.map((s) => {
            const last = (s.history || [])[0];
            const T = targetOf(s.target);
            const where = s.target === 'cloudflare' ? s.project : s.target === 'sftp' ? `${(s.sftp || {}).user || ''}@${(s.sftp || {}).host || ''}` : s.repo;
            return (
              <div key={s.id} className="card">
                <div className="card-head"><T.icon size={16} /><h3 className="ellipsis">{s.name}</h3>
                  <div className="right row-tight"><Btn className="xs ghost" onClick={() => setEdit(s)}>Edit</Btn><Btn className="xs ghost icon" icon={Trash2} title={t('Remove {name}', { name: s.name })} aria-label={t('Remove {name}', { name: s.name })} onClick={() => remove(s)} /></div></div>
                <div className="card-body stack sp-body">
                  <div className="small muted ellipsis" title={s.dir}>{s.dir}{s.out && s.out !== '.' ? ` → ${s.out}` : ''}</div>
                  <div className="small">{T.label} · {where}{s.domain ? <span className="muted"> · {s.domain}</span> : null}{s.build ? <span className="muted"> · {s.build}</span> : null}</div>
                  {last && (
                    <div className={`small row-tight ${last.ok ? '' : 'c-err'}`}>
                      {last.ok ? <CheckCircle2 size={14} className="c-ok" aria-label="Published" /> : <XCircle size={14} aria-label="Failed" />}
                      <span>{when(last.t)}</span>
                      {last.ok ? (last.url ? <button type="button" className="link-btn" onClick={() => openExternal(last.url)}>{last.url}</button> : null) : <span className="ellipsis">{last.error}</span>}
                    </div>
                  )}
                  <div className="row-tight sp-actions">
                    <Btn className="primary sm" icon={Rocket} busy={busy === s.id} onClick={() => deploy(s)}>Publish now</Btn>
                    <Btn className="sm" icon={SearchCheck} busy={busy === `c${s.id}`} onClick={() => check(s)}>Check</Btn>
                    {(s.history || []).length > 0 && <Btn className="sm ghost" icon={History} onClick={() => setHist(s)}>History</Btn>}
                    <InfoTip title="What happens">Hostwerk runs the build command (if set), checks the built files (links, pictures, index.html, size) and uploads them. Every publish replaces the previous version – the history can go back.</InfoTip>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {acc && <Accounts a={d.accounts} onClose={() => setAcc(false)} onSaved={(v) => st.setData(v)} />}
      {edit && <SiteEditor site={edit} projects={d.projects} onClose={() => setEdit(null)} onSave={saveSite} />}
      {report && <CheckReport site={report.site} r={report.r} onClose={() => setReport(null)} />}
      {hist && (
        <Modal title={t('History: {name}', { name: hist.name })} onClose={() => setHist(null)} footer={<Btn onClick={() => setHist(null)}>Close</Btn>}>
          <div className="stack">
            {hist.history.map((e, i) => (
              <div key={`${e.t}-${i}`} className="list-item row-tight">
                {e.ok ? <CheckCircle2 size={14} className="c-ok" aria-label="Published" /> : <XCircle size={14} className="c-err" aria-label="Failed" />}
                <span className="small grow">{when(e.t)}{e.restored ? <span className="muted"> · {t('back to {when}', { when: when(e.restored) })}</span> : null}{!e.ok ? <span className="c-err"> · {e.error}</span> : null}</span>
                {i === 0 ? <span className="badge ok">Online</span>
                  : e.ok && e.ref && CAN_ROLLBACK.includes(hist.target) && (!e.target || e.target === hist.target) ? <Btn className="xs" icon={Undo2} busy={busy === hist.id} onClick={() => rollback(hist, i)}>Go back</Btn> : null}
              </div>
            ))}
            {!CAN_ROLLBACK.includes(hist.target) && <p className="tiny muted">Going back works for GitHub Pages and Cloudflare Pages – for other targets publish the older state again.</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}

export default {
  pages: { main: StaticPublishPage },
};
