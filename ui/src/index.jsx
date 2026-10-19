import { useState } from 'react';
import { Rocket, Plus, Trash2, GitBranch, Cloud, ExternalLink, KeyRound, Save, CheckCircle2, XCircle } from 'lucide-react';
import { put, post, useApi, waitJob, openExternal } from '@hostwerk/api';
import { Btn, Seg, Field, Modal, Empty, Loading, InfoTip, PathInput, toast, confirmDialog } from '@hostwerk/ui';
import './style.css';

/*
 * Static publish: sites (project folder + build + output folder + target) as cards, accounts in a dialog.
 * Texts are English; German comes from locales/de.json (also inside JSX).
 */
const uid = () => Math.random().toString(36).slice(2, 12);

function Accounts({ a, onClose, onSaved }) {
  const [gh, setGh] = useState('');
  const [cf, setCf] = useState('');
  const [acc, setAcc] = useState(a.cloudflareAccount || '');
  const save = async () => {
    try {
      onSaved(await put('/static-publish/accounts', { ...(gh ? { githubToken: gh } : {}), ...(cf ? { cloudflareToken: cf } : {}), cloudflareAccount: acc }));
      toast.success('Saved'); onClose();
    } catch (e) { toast.error(e); }
  };
  return (
    <Modal title="Accounts" subtitle="Stored sealed on this PC – they never leave it except to GitHub or Cloudflare." onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" icon={Save} onClick={save}>Save</Btn></>}>
      <div className="stack">
        <Field label={a.github ? 'GitHub token (saved – enter a new one to replace it)' : 'GitHub token'} hint="Fine-grained token with “Contents: read and write” and “Pages: read and write” (and “Administration” if Hostwerk should create the repository).">
          <input className="input mono" type="password" value={gh} onChange={(e) => setGh(e.target.value)} placeholder="github_pat_…" />
        </Field>
        <div><Btn className="sm ghost" icon={ExternalLink} onClick={() => openExternal('https://github.com/settings/personal-access-tokens/new')}>Create a GitHub token</Btn></div>
        <Field label={a.cloudflare ? 'Cloudflare API token (saved)' : 'Cloudflare API token'} hint="Template “Edit Cloudflare Workers” or a token with “Cloudflare Pages: Edit”."><input className="input mono" type="password" value={cf} onChange={(e) => setCf(e.target.value)} /></Field>
        <Field label="Cloudflare account ID" hint="Shown on the right in the Cloudflare dashboard (Workers & Pages)."><input className="input mono" value={acc} onChange={(e) => setAcc(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function SiteEditor({ site, projects, onClose, onSave }) {
  const [s, setS] = useState(site);
  const set = (k) => (v) => setS({ ...s, [k]: v && v.target ? v.target.value : v });
  return (
    <Modal title={site.name ? `Site “${site.name}”` : 'New site'} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn className="primary" icon={Save} disabled={!s.name || !s.dir} onClick={() => onSave(s)}>Save</Btn></>}>
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
        <Field label="Where to"><Seg options={[{ id: 'github', label: 'GitHub Pages' }, { id: 'cloudflare', label: 'Cloudflare Pages' }]} value={s.target} onChange={set('target')} /></Field>
        {s.target === 'github' ? (
          <>
            <Field label="Repository" hint="owner/name – e.g. alex/club-site. owner/owner.github.io becomes your main page."><input className="input mono" value={s.repo} onChange={set('repo')} placeholder="alex/club-site" /></Field>
            <label className="check"><input type="checkbox" checked={s.create} onChange={(e) => setS({ ...s, create: e.target.checked })} />Create it if it does not exist</label>
          </>
        ) : (
          <Field label="Cloudflare project name" hint="small letters, digits and - · the page will be at NAME.pages.dev"><input className="input mono" value={s.project} onChange={set('project')} placeholder="club-site" /></Field>
        )}
      </div>
    </Modal>
  );
}

function StaticPublishPage() {
  const st = useApi('/static-publish', [], { live: false });
  const [acc, setAcc] = useState(false);
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(null);
  const d = st.data;
  if (!d) return <Loading />;
  const saveSites = async (sites) => st.setData(await put('/static-publish/sites', { sites }));
  const saveSite = async (s) => { try { await saveSites(d.sites.some((x) => x.id === s.id) ? d.sites.map((x) => (x.id === s.id ? s : x)) : [...d.sites, s]); setEdit(null); } catch (e) { toast.error(e); } };
  const remove = async (s) => { if (await confirmDialog({ title: `Remove “${s.name}”?`, text: 'Only the entry in Hostwerk – the published page stays online.', confirm: 'Remove', danger: true })) saveSites(d.sites.filter((x) => x.id !== s.id)); };
  const deploy = async (s) => {
    setBusy(s.id);
    try { const r = await post(`/static-publish/sites/${s.id}/deploy`); const j = await waitJob(r.job); toast.success(`Published: ${j.result.url}`); } catch (e) { toast.error(e); }
    st.reload({ silent: true }); setBusy(null);
  };
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <h1><Rocket /> Publish static sites</h1>
          <p>Put a project online with one click – on GitHub Pages or Cloudflare Pages, free and with HTTPS.</p>
        </div>
        <div className="actions">
          <Btn className="sm ghost" icon={KeyRound} onClick={() => setAcc(true)}>Accounts</Btn>
          <Btn className="sm primary" icon={Plus} onClick={() => setEdit({ id: uid(), name: '', dir: '', build: '', out: 'dist', target: 'github', repo: '', create: true, project: '' })}>New site</Btn>
        </div>
      </div>
      {!d.accounts.github && !d.accounts.cloudflare && <div className="card mb"><div className="card-body row-tight"><span className="small grow">First add a GitHub token or a Cloudflare API token – Hostwerk uses it only for publishing.</span><Btn className="sm" icon={KeyRound} onClick={() => setAcc(true)}>Add account</Btn></div></div>}
      {!d.sites.length ? <Empty icon={Rocket} title="No site yet" text="Add a site: project folder, build command, folder with the finished page and where it should go." /> : (
        <div className="grid grid-2">
          {d.sites.map((s) => {
            const last = (s.history || [])[0];
            return (
              <div key={s.id} className="card">
                <div className="card-head">{s.target === 'github' ? <GitBranch size={16} /> : <Cloud size={16} />}<h3 className="ellipsis">{s.name}</h3>
                  <div className="right row-tight"><Btn className="xs ghost" onClick={() => setEdit(s)}>Edit</Btn><Btn className="xs ghost icon" icon={Trash2} title="Remove" aria-label="Remove" onClick={() => remove(s)} /></div></div>
                <div className="card-body stack" style={{ gap: 8 }}>
                  <div className="small muted ellipsis" title={s.dir}>{s.dir}{s.out && s.out !== '.' ? ` → ${s.out}` : ''}</div>
                  <div className="small">{s.target === 'github' ? `GitHub Pages · ${s.repo}` : `Cloudflare Pages · ${s.project}`}{s.build ? <span className="muted"> · {s.build}</span> : null}</div>
                  {last && (
                    <div className={`small row-tight ${last.ok ? '' : 'c-err'}`}>
                      {last.ok ? <CheckCircle2 size={14} className="c-ok" /> : <XCircle size={14} />}
                      <span>{new Date(last.t).toLocaleString()}</span>
                      {last.ok ? <button type="button" className="link-btn" onClick={() => openExternal(last.url)}>{last.url}</button> : <span className="ellipsis">{last.error}</span>}
                    </div>
                  )}
                  <div className="row-tight"><Btn className="primary sm" icon={Rocket} busy={busy === s.id} onClick={() => deploy(s)}>Publish now</Btn>
                    <InfoTip title="What happens">Hostwerk runs the build command (if set), checks the folder (index.html, size) and uploads it. Every publish replaces the previous version.</InfoTip></div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {acc && <Accounts a={d.accounts} onClose={() => setAcc(false)} onSaved={(v) => st.setData(v)} />}
      {edit && <SiteEditor site={edit} projects={d.projects} onClose={() => setEdit(null)} onSave={saveSite} />}
    </div>
  );
}

export default {
  pages: { main: StaticPublishPage },
};
