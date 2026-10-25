import { useEffect, useState } from 'react';
import { CloudUpload, GitBranch, Globe, RotateCcw, Camera, CheckCircle2, XCircle, Copy, ExternalLink, FolderGit2, Undo2 } from 'lucide-react';
import { post, useApi, on, waitJob, fmtDate, fmtDuration, openExternal } from '@hostwerk/api';
import { Btn, Empty, Loading, Callout, InfoTip, TileEmpty, confirmDialog, toast } from '@hostwerk/ui';
import { contextMenu } from '@hostwerk/kit';
import { t } from '@hostwerk/i18n';

/*
 * Seiten veröffentlichen, Teil „Verlauf“ (bis 1.1 eigene Erweiterung „Deploy-Protokoll“): jedes Veröffentlichen, jeder Git-Pull
 * und jede veröffentlichte Seite mit Zeit, Stand (Commit und Snapshot) und Ergebnis – je Projekt, mit einem Klick zurück.
 */

/*
 * Deploy log: per project every deploy, git pull and published site with time, state (commit + snapshot) and result.
 * "Back to the previous state" restores the snapshot of the state before the newest one (Hostwerk saves the current
 * state first) and can publish it again to the same target. Shown as an own page, as a tab on every project and as
 * a dashboard tile. Texts are English; German comes from locales/de.json (also inside JSX).
 */
const KIND = {
  deploy: { label: 'Deploy', icon: CloudUpload },
  publish: { label: 'Published site', icon: Globe },
  pull: { label: 'Git pull', icon: GitBranch },
  restore: { label: 'Snapshot restored', icon: Camera },
  rollback: { label: 'Back to an earlier state', icon: RotateCcw },
};
const TARGET = { sftp: 'SFTP', ftp: 'FTP', git: 'Git push', github: 'GitHub Pages', cloudflare: 'Cloudflare Pages' };

/** Reload when the server reports a new entry (host.broadcast → ext-event). */
function useLive(reload) {
  useEffect(() => on('ext-event', (m) => { if (m && m.id === 'static-publish') reload({ silent: true }); }), [reload]);
}

function resultText(e) {
  const r = e.result || {};
  if (!e.ok) return e.error === 'cancelled' ? t('Cancelled') : e.error || t('Failed');
  if (e.kind === 'deploy') return r.pushed ? t('Pushed') : r.uploaded != null ? t('{up} uploaded, {rm} removed', { up: r.uploaded, rm: r.removed || 0 }) : t('Done');
  if (e.kind === 'publish') return r.url || t('Done');
  if (e.kind === 'rollback') return t('to the state of {when}', { when: fmtDate(r.toT) }) + (r.redeploy ? ` · ${t('published again')}` : '');
  return t('Done');
}

/** Can this entry be restored? (own or existing snapshot that is still there) */
const restorable = (e, snaps) => !!(e.ok && e.snapshot && e.snapshot.id && !e.snapshot.pruned && snaps.includes(e.snapshot.id) && e.kind !== 'rollback');
const canRedeploy = (e) => !!(e.target && ((e.kind === 'deploy' && e.target.type !== 'git') || e.kind === 'publish'));

async function goBack(projectId, e, done) {
  const target = canRedeploy(e) ? e.target.name : null;
  const r = await confirmDialog({
    title: t('Back to the state of {when}?', { when: fmtDate(e.t) }),
    text: t('Hostwerk first saves the current state as a snapshot, then brings back the project files of that time. Databases stay as they are.'),
    confirm: t('Go back'),
    danger: true,
    checkbox: target ? { label: t('Then publish again to {name}', { name: target }), checked: true } : null,
  });
  const ok = r === true || (r && r.ok);
  if (!ok) return;
  try {
    const { job } = await post(`/deploy-log/projects/${encodeURIComponent(projectId)}/rollback`, { entryId: e.id, redeploy: !!(r && r.checked) });
    toast(t('Going back …'));
    await waitJob(job);
    toast.success(t('Back on the state of {when}', { when: fmtDate(e.t) }));
  } catch (err) { toast.error(err); }
  done();
}

function Entry({ e, projectId, snaps, reload }) {
  const k = KIND[e.kind] || KIND.deploy;
  const canBack = restorable(e, snaps);
  const menu = (ev) => contextMenu(ev, [
    canBack && { label: t('Back to this state'), icon: RotateCcw, onClick: () => goBack(projectId, e, reload) },
    e.commit && { label: t('Copy commit hash'), icon: Copy, onClick: () => navigator.clipboard.writeText(e.commit.hash).then(() => toast.success(t('Copied'))).catch(() => {}) },
    e.result && e.result.url && { label: t('Open address'), icon: ExternalLink, onClick: () => openExternal(e.result.url) },
  ]);
  return (
    <li className={`list-item dl-entry ${e.ok ? '' : 'dl-failed'}`} onContextMenu={menu}>
      <span className="dl-ico" aria-hidden="true"><k.icon size={16} /></span>
      <div className="grow dl-main">
        <div className="row-tight dl-title">
          <b className="ellipsis">{e.target ? e.target.name : t(k.label)}</b>
          {e.target && <span className="badge">{TARGET[e.target.type] || t(k.label)}</span>}
          {e.ok ? <CheckCircle2 size={14} className="c-ok" aria-label={t('Succeeded')} /> : <XCircle size={14} className="c-err" aria-label={t('Failed')} />}
          <span className="tiny muted right">{fmtDate(e.t)}{e.ms ? ` · ${fmtDuration(e.ms)}` : ''}</span>
        </div>
        <div className={`small ellipsis ${e.ok ? 'muted' : 'c-err'}`} title={resultText(e)}>{e.target ? `${t(k.label)} · ` : ''}{resultText(e)}</div>
        <div className="row-tight tiny muted dl-state">
          {e.commit ? (
            <span className="mono ellipsis" title={`${e.commit.hash}${e.commit.subject ? ` – ${e.commit.subject}` : ''}`}>
              <GitBranch size={12} aria-hidden="true" /> {e.commit.branch ? `${e.commit.branch} · ` : ''}{e.commit.short} {e.commit.subject}
              {e.commit.changed > 0 && <span className="badge warn dl-dirty">{t('+{n} changed', { n: e.commit.changed })}</span>}
            </span>
          ) : <span>{t('No Git commit')}</span>}
          {e.snapshot && e.snapshot.pending && <span><Camera size={12} aria-hidden="true" /> {t('Snapshot is being saved …')}</span>}
          {e.snapshot && e.snapshot.id && <span title={e.snapshot.id}><Camera size={12} aria-hidden="true" /> {e.snapshot.pruned ? t('Snapshot cleared up') : e.snapshot.own ? t('Snapshot of this state') : t('Last snapshot before it')}</span>}
        </div>
      </div>
      {canBack && <Btn className="ghost sm" icon={RotateCcw} title={t('Back to this state')} onClick={() => goBack(projectId, e, reload)}>Back</Btn>}
    </li>
  );
}

/** Timeline of one project – used on the page and as a project tab. */
function Timeline({ projectId }) {
  const st = useApi(`/deploy-log/projects/${encodeURIComponent(projectId)}`, [projectId], { live: false });
  useLive(st.reload);
  const d = st.data;
  if (st.loading && !d) return <Loading />;
  if (st.error) return <Callout kind="err" dismissible={false}>{st.error}</Callout>;
  if (!d || !d.entries.length) return <Empty icon={CloudUpload} title="Nothing published yet" text="Deploys, git pulls and published sites of this project appear here as soon as they happen." />;
  return (
    <div className="stack">
      {d.back && (
        <div className="card"><div className="card-body row dl-back">
          <Undo2 size={18} aria-hidden="true" />
          <div className="grow">
            <b>{t('Previous state: {when}', { when: fmtDate(d.back.t) })}</b>
            <div className="small muted ellipsis">{d.back.commit ? `${d.back.commit.short} ${d.back.commit.subject}` : resultText(d.back)}</div>
          </div>
          <Btn className="primary" icon={RotateCcw} onClick={() => goBack(projectId, d.back, st.reload)}>Back to the previous state</Btn>
          <InfoTip inline title="How going back works">Hostwerk saves the current state as a snapshot first, then restores the project files from the snapshot of that time. Databases stay as they are. If you want, the old state is published again to the same server or site right after.</InfoTip>
        </div></div>
      )}
      {!d.real && <Callout kind="info" title="Not linked to a project">This site’s folder does not belong to any project in Hostwerk – there are no snapshots to go back to.</Callout>}
      <ul className="card dl-list">{d.entries.map((e) => <Entry key={e.id} e={e} projectId={projectId} snaps={d.snapshots} reload={st.reload} />)}</ul>
    </div>
  );
}

/** Verlauf aller Projekte – als ganze Seite oder (bare) unter dem Umschalter der Seite „Seiten veröffentlichen“. */
function DeployLogPage({ path = [], bare = false }) {
  const st = useApi('/deploy-log', [], { live: false });
  useLive(st.reload);
  const list = (st.data && st.data.projects) || [];
  const [sel, setSel] = useState(path[0] || null);
  const cur = sel && list.some((p) => p.id === sel) ? sel : list[0] ? list[0].id : null;
  const body = (
    <>
      {st.loading && !st.data ? <Loading /> : st.error ? <Callout kind="err" dismissible={false}>{st.error}</Callout> : !list.length ? (
        <Empty icon={CloudUpload} title="Nothing published yet" text="As soon as you publish a project (Projects → Publish), pull with Git or publish a site, it is logged here." />
      ) : (
        <div className="dl-layout">
          <nav className="card dl-projects" aria-label={t('Projects')}>
            {list.map((p) => (
              <button type="button" key={p.id} className="list-item dl-project" aria-current={p.id === cur ? 'true' : undefined} onClick={() => setSel(p.id)}>
                <FolderGit2 size={15} aria-hidden="true" />
                <span className="grow dl-main"><span className="ellipsis bold">{p.name}</span><span className="tiny muted ellipsis">{fmtDate(p.last.t)} · {t((KIND[p.last.kind] || KIND.deploy).label)}</span></span>
                {p.last.ok ? <CheckCircle2 size={14} className="c-ok" aria-label={t('Succeeded')} /> : <XCircle size={14} className="c-err" aria-label={t('Failed')} />}
              </button>
            ))}
          </nav>
          {cur && <Timeline key={cur} projectId={cur} />}
        </div>
      )}
    </>
  );
  if (bare) return body;
  return (
    <div className="page fade-in">
      <div className="page-head">
        <div>
          <h1><CloudUpload /> Deploy log</h1>
          <p>What was published when – with commit and snapshot, and one click back to an earlier state.</p>
        </div>
      </div>
      {body}
    </div>
  );
}

/** Tab on every project (Projects → <project> → Deploy log). */
function ProjectTab({ p }) {
  return <Timeline projectId={p.id} />;
}

/** Dashboard tile: the newest five entries over all projects. */
function DeployLogTile() {
  const st = useApi('/deploy-log', [], { live: false });
  useLive(st.reload);
  const d = st.data;
  if (st.loading && !d) return <div className="card-body"><div className="skeleton dl-skel" /></div>;
  if (!d || !d.recent.length) return <TileEmpty icon={CloudUpload} text="Nothing published yet" href="#/ext/static-publish/log" />;
  return (
    <div className="card-body stack dl-tile">
      {d.recent.slice(0, 5).map((e) => {
        const k = KIND[e.kind] || KIND.deploy;
        return (
          <a key={e.id} className="row-tight dl-tile-row" href={`#/ext/static-publish/log/${encodeURIComponent(e.projectId)}`} title={resultText(e)}>
            <k.icon size={14} className={e.ok ? 'muted' : 'c-err'} aria-hidden="true" />
            <span className="grow ellipsis small">{e.projectName}{e.target ? ` → ${e.target.name}` : ''}</span>
            <span className="tiny muted">{fmtDate(e.t)}</span>
          </a>
        );
      })}
    </div>
  );
}

export { DeployLogPage, ProjectTab, DeployLogTile };
