import { useCallback, useEffect, useRef, useState } from 'react';
import { api, downloadReleaseZip } from '../api';
import type { Project, ReleaseCommitResult, ReleaseDoc, ReleasePreflight, ReleasePushResult } from '../types';
import { Ic } from './icons';

const VERSION_RE = /^\d+\.\d+\.\d+$/;
// Mirrors SGA_VERSION_FILES on the backend — these change as part of a release,
// so they don't count toward the dirty-tree confirmation.
const VERSION_FILES = new Set(['VERSION.md', 'bridge/package.json', 'extension/manifest.json']);

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function zipName(r: ReleaseDoc): string {
  return r.zipPath.split(/[\\/]/).pop() ?? `sgen-claude-chat-v${r.version}.zip`;
}

export function SgaRelease({
  project,
  projects,
  onSelectProject,
}: {
  project: Project;
  /** All registered projects — used to offer a switch when this one isn't the SGA. */
  projects: Project[];
  onSelectProject: (id: string) => void;
}) {
  const [pre, setPre] = useState<ReleasePreflight | null>(null);
  const [sgaSiblings, setSgaSiblings] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState('');
  const [includeDirty, setIncludeDirty] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [notesBusy, setNotesBusy] = useState(false);
  const [release, setRelease] = useState<ReleaseDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Commit-the-bump → Push flow (session-scoped; commit swaps the button to push).
  const [gitBusy, setGitBusy] = useState<'commit' | 'push' | null>(null);
  const [committed, setCommitted] = useState<ReleaseCommitResult | null>(null);
  const [pushed, setPushed] = useState<ReleasePushResult | null>(null);
  // Permanent zip output folder (AppSetting) — only changes when Save is hit.
  const [zipDirInput, setZipDirInput] = useState('');
  const [savingZipDir, setSavingZipDir] = useState(false);
  const [zipDirFlash, setZipDirFlash] = useState(false);
  const zipDirSeeded = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const p = await api.releasePreflight(project.id);
      setPre(p);
      setVersion((v) => v || p.suggestedVersion || '');
      if (!zipDirSeeded.current) {
        setZipDirInput(p.zipDir);
        zipDirSeeded.current = true;
      }
      if (!p.isRepo || !p.isSga) {
        // Dead-end state (this project isn't the SGA): probe the other
        // registered projects so the tab can offer a one-click switch to the
        // right one instead of a bare explanation.
        const siblings = projects.filter((x) => x.id !== project.id);
        const probed = await Promise.all(
          siblings.map(async (x) => {
            try {
              const sp = await api.releasePreflight(x.id);
              return sp.isRepo && sp.isSga ? x : null;
            } catch {
              return null;
            }
          }),
        );
        setSgaSiblings(probed.filter((x): x is Project => x !== null));
      } else {
        setSgaSiblings([]);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [project.id, projects]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh preflight without flashing the loading state (post-release refresh).
  const refreshSilently = useCallback(() => {
    void api.releasePreflight(project.id).then(setPre).catch(() => undefined);
  }, [project.id]);

  const copy = (label: string, text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(label);
    window.setTimeout(() => setCopied((c) => (c === label ? null : c)), 1600);
  };

  const generateNotes = useCallback(
    async (rel: ReleaseDoc) => {
      setNotesBusy(true);
      setErr(null);
      try {
        const updated = await api.generateReleaseNotes(rel.id);
        setRelease(updated);
        refreshSilently();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setNotesBusy(false);
      }
    },
    [refreshSilently],
  );

  const doRelease = async () => {
    if (!VERSION_RE.test(version)) {
      setErr(`Invalid version "${version}" — expected MAJOR.MINOR.PATCH (e.g. 2.7.1).`);
      return;
    }
    setReleasing(true);
    setErr(null);
    setRelease(null);
    let rel: ReleaseDoc | null = null;
    try {
      rel = await api.createRelease(project.id, { version, includeDirty });
      setRelease(rel);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setReleasing(false);
    }
    if (rel) {
      refreshSilently();
      setVersion(''); // re-seed from the fresh preflight's suggestion next load
      await generateNotes(rel);
    }
  };

  const download = async (rel: ReleaseDoc) => {
    setErr(null);
    try {
      await downloadReleaseZip(rel.id, zipName(rel));
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const saveZipDir = async () => {
    setSavingZipDir(true);
    setErr(null);
    try {
      const res = await api.setReleaseZipDir(zipDirInput.trim());
      setPre((p) => (p ? { ...p, zipDir: res.zipDir } : p));
      setZipDirInput(res.zipDir);
      setZipDirFlash(true);
      window.setTimeout(() => setZipDirFlash(false), 1800);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSavingZipDir(false);
    }
  };

  const doCommit = async () => {
    setGitBusy('commit');
    setErr(null);
    try {
      const res = await api.commitRelease(project.id);
      setCommitted(res);
      setPushed(null);
      refreshSilently(); // the version files are clean now
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setGitBusy(null);
    }
  };

  const doPush = async () => {
    setGitBusy('push');
    setErr(null);
    try {
      setPushed(await api.pushRelease(project.id));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setGitBusy(null);
    }
  };

  const removeRelease = async (id: string) => {
    setErr(null);
    try {
      await api.deleteRelease(id);
      if (release?.id === id) setRelease(null);
      refreshSilently();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const dirtyOthers = (pre?.dirty ?? []).filter((f) => !VERSION_FILES.has(f.path));
  const bumpDirty = (pre?.dirty ?? []).some((f) => VERSION_FILES.has(f.path));
  const zipDirEdited = pre !== null && zipDirInput.trim() !== pre.zipDir;
  const needsDirtyConfirm = dirtyOthers.length > 0 && !includeDirty;
  const notSga = !loading && pre !== null && (!pre.isRepo || !pre.isSga);
  const lastRelease = pre?.releases[0] ?? null;
  const canRelease =
    !loading &&
    !releasing &&
    !notesBusy &&
    pre !== null &&
    pre.isRepo &&
    pre.isSga &&
    !pre.releasing &&
    VERSION_RE.test(version) &&
    !needsDirtyConfirm;

  return (
    <div className="rel">
      <div className="eod-head">
        <h2>SGA Release</h2>
        <div className="muted">
          One click: bump the three version files (uncommitted), build the upload-ready zip via{' '}
          <code>git archive</code>, and have Claude write the patch-note summary + description.
        </div>
      </div>

      {err && (
        <div className="banner banner-error" onClick={() => setErr(null)}>
          {err}
        </div>
      )}

      {notSga ? (
        <section className="eod-card">
          <div className="eod-card-head">
            <span>Version &amp; repo state</span>
            <span className="eod-card-sub">not the SGA repo</span>
          </div>
          <div className="muted rel-empty">
            {!pre?.isRepo
              ? 'This project folder is not a git repository.'
              : `This project doesn't look like the SG Claude Assistant repo — missing: ${pre?.missing.join(', ')}.`}
            {' '}
            {sgaSiblings.length > 0
              ? 'This registered project is the SGA:'
              : 'Select the SGEN × Claude Chat project in the sidebar (or register it by its folder path).'}
          </div>
          {sgaSiblings.length > 0 && (
            <div className="rel-row rel-switch">
              {sgaSiblings.map((x) => (
                <button
                  key={x.id}
                  className="btn btn-primary"
                  onClick={() => onSelectProject(x.id)}
                  title={x.path}
                >
                  <Ic name="bolt" /> Switch to {x.name}
                </button>
              ))}
            </div>
          )}
        </section>
      ) : (
        <>
          {/* ── stat tiles ─────────────────────────────────────────────── */}
          <div className="rel-tiles">
            <div className="eod-card rel-tile">
              <div className="rel-tile-label">Current version</div>
              <div className="rel-tile-value">{loading ? '…' : pre?.currentVersion ?? '?'}</div>
              <div className="rel-tile-sub muted">bridge/package.json</div>
            </div>
            <div className="eod-card rel-tile">
              <div className="rel-tile-label">Next version</div>
              <input
                className="rel-tile-input"
                value={version}
                spellCheck={false}
                onChange={(e) => setVersion(e.target.value.trim())}
                placeholder={pre?.suggestedVersion ?? 'x.y.z'}
                aria-label="next"
              />
              <div className="rel-tile-sub muted">suggested patch bump — editable</div>
            </div>
            <div className="eod-card rel-tile">
              <div className="rel-tile-label">Repo state</div>
              <div className={`rel-tile-value ${dirtyOthers.length ? 'rel-state-dirty' : 'rel-state-clean'}`}>
                {loading ? (
                  '…'
                ) : dirtyOthers.length ? (
                  <>
                    <Ic name="warn" /> {dirtyOthers.length} dirty
                  </>
                ) : (
                  <>
                    <Ic name="check" /> clean
                  </>
                )}
              </div>
              <div className="rel-tile-sub muted rel-branch" title={pre?.branch ?? undefined}>
                <Ic name="branch" /> {pre?.branch ?? 'working tree'}
              </div>
            </div>
            <div className="eod-card rel-tile">
              <div className="rel-tile-label">Last release</div>
              <div className="rel-tile-value">{lastRelease ? lastRelease.version : '—'}</div>
              <div className="rel-tile-sub muted">
                {lastRelease
                  ? `${new Date(lastRelease.createdAt).toLocaleDateString()} · ${fmtBytes(lastRelease.zipBytes)}`
                  : 'none cut yet'}
              </div>
            </div>
          </div>

          {/* ── action card ────────────────────────────────────────────── */}
          <section className="eod-card rel-action">
            <div className="eod-card-head">
              <span>Cut a release</span>
              <span className="eod-card-sub">
                {releasing
                  ? 'building zip…'
                  : `zip → sgen-claude-chat-v${VERSION_RE.test(version) ? version : 'x.y.z'}.zip`}
              </span>
            </div>

            {dirtyOthers.length > 0 && (
              <div className="rel-dirty">
                <div className="rel-dirty-head">
                  <Ic name="warn" /> {dirtyOthers.length} uncommitted change(s) would ship in the zip:
                </div>
                <ul className="rel-dirty-list">
                  {dirtyOthers.slice(0, 12).map((f) => (
                    <li key={f.path}>
                      <code>{f.path}</code> <span className="muted">({f.status})</span>
                    </li>
                  ))}
                  {dirtyOthers.length > 12 && (
                    <li className="muted">…and {dirtyOthers.length - 12} more</li>
                  )}
                </ul>
                <label className="rel-check">
                  <input
                    type="checkbox"
                    checked={includeDirty}
                    onChange={(e) => setIncludeDirty(e.target.checked)}
                  />
                  Include these uncommitted changes in the zip
                </label>
              </div>
            )}

            <div className="rel-row rel-action-row">
              <button className="btn btn-primary rel-go" onClick={() => void doRelease()} disabled={!canRelease}>
                {releasing ? (
                  <>
                    <Ic name="refresh" /> Building zip…
                  </>
                ) : (
                  <>
                    <Ic name="bolt" /> Release
                  </>
                )}
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => void load()}
                disabled={loading || releasing}
                title="Re-check versions and working-tree state"
              >
                <Ic name="refresh" /> Refresh
              </button>

              {pushed ? (
                <span className="rel-git-done">
                  <Ic name="check" /> Pushed to {pushed.branch}
                  {pushed.upstreamCreated ? ' (upstream created)' : ''}
                </span>
              ) : committed ? (
                <button
                  className="btn btn-run"
                  onClick={() => void doPush()}
                  disabled={gitBusy !== null}
                  title={`git push (${pre?.branch ?? 'current branch'})`}
                >
                  {gitBusy === 'push' ? (
                    <>
                      <Ic name="refresh" /> Pushing…
                    </>
                  ) : (
                    <>
                      <Ic name="external" /> Push
                    </>
                  )}
                </button>
              ) : bumpDirty ? (
                <button
                  className="btn btn-run"
                  onClick={() => void doCommit()}
                  disabled={gitBusy !== null || releasing}
                  title={`git commit -m "chore(release): bump to v${pre?.currentVersion ?? '?'}" — only the 3 version files`}
                >
                  {gitBusy === 'commit' ? (
                    <>
                      <Ic name="refresh" /> Committing…
                    </>
                  ) : (
                    <>
                      <Ic name="check" /> Commit bump
                    </>
                  )}
                </button>
              ) : null}

              <span className="muted rel-action-note">
                {pushed
                  ? `Done — ${pushed.branch} is up to date on the remote.`
                  : committed
                    ? `Committed ${committed.commit.slice(0, 7)} · "${committed.message}" — push when ready.`
                    : bumpDirty
                      ? `Version bump pending — Commit bump runs "chore(release): bump to v${pre?.currentVersion ?? '?'}" on the 3 version files only.`
                      : 'The version bump stays uncommitted after a release — Commit bump appears here.'}
              </span>
            </div>

            <div className="rel-row rel-zipdir">
              <span className="rel-zipdir-label">
                <Ic name="folder" /> Zip folder
              </span>
              <input
                className="rel-zipdir-input"
                value={zipDirInput}
                spellCheck={false}
                onChange={(e) => setZipDirInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && zipDirEdited && !savingZipDir) void saveZipDir();
                }}
                placeholder="absolute path — empty resets to your home folder"
                aria-label="Zip output folder"
              />
              {zipDirEdited ? (
                <button className="btn" onClick={() => void saveZipDir()} disabled={savingZipDir}>
                  {savingZipDir ? 'Saving…' : 'Save'}
                </button>
              ) : zipDirFlash ? (
                <span className="rel-git-done">
                  <Ic name="check" /> Saved
                </span>
              ) : null}
            </div>
          </section>

          {/* ── dashboard grid: results + history rail ─────────────────── */}
          <div className="rel-grid">
            <div className="rel-main">
              {release ? (
                <>
                  <section className="eod-card">
                    <div className="eod-card-head">
                      <span>Zip · v{release.version}</span>
                      <span className="eod-card-sub">
                        {fmtBytes(release.zipBytes)}
                        {release.dirtyIncluded ? ' · includes uncommitted changes' : ''}
                      </span>
                    </div>
                    <div className="rel-row rel-artifact">
                      <code className="rel-path" title={release.zipPath}>
                        {release.zipPath}
                      </code>
                      <button className="btn" onClick={() => copy('path', release.zipPath)}>
                        {copied === 'path' ? <><Ic name="check" /> Copied</> : 'Copy path'}
                      </button>
                      <button className="btn" onClick={() => void download(release)}>
                        Download zip
                      </button>
                    </div>
                    <div className="muted rel-note">
                      Upload this file in the SGA version control, then paste the notes below.
                    </div>
                  </section>

                  <section className="eod-card">
                    <div className="eod-card-head">
                      <span>Patch notes</span>
                      {notesBusy ? (
                        <span className="eod-card-sub">Claude is writing — up to ~2 minutes</span>
                      ) : (
                        <span className="eod-report-btns">
                          {release.summary && release.notes && (
                            <button
                              className="btn"
                              onClick={() => copy('both', `${release.summary}\n\n${release.notes}`)}
                            >
                              {copied === 'both' ? <><Ic name="check" /> Copied</> : 'Copy both'}
                            </button>
                          )}
                          <button className="btn btn-claude" onClick={() => void generateNotes(release)}>
                            <Ic name="spark" /> {release.summary ? 'Regenerate' : 'Generate notes'}
                          </button>
                        </span>
                      )}
                    </div>

                    {notesBusy ? (
                      <div className="muted rel-empty">
                        <Ic name="spark" /> Reading the changelog and commit history…
                      </div>
                    ) : release.summary || release.notes ? (
                      <>
                        <div className="rel-notes-block">
                          <div className="rel-notes-head">
                            <span>Summary</span>
                            <button
                              className="btn rel-copy"
                              onClick={() => release.summary && copy('summary', release.summary)}
                            >
                              {copied === 'summary' ? <><Ic name="check" /> Copied</> : 'Copy'}
                            </button>
                          </div>
                          <div className="rel-text">{release.summary}</div>
                        </div>
                        <div className="rel-notes-block">
                          <div className="rel-notes-head">
                            <span>Description</span>
                            <button
                              className="btn rel-copy"
                              onClick={() => release.notes && copy('notes', release.notes)}
                            >
                              {copied === 'notes' ? <><Ic name="check" /> Copied</> : 'Copy'}
                            </button>
                          </div>
                          <div className="rel-text">{release.notes}</div>
                        </div>
                      </>
                    ) : (
                      <div className="muted rel-empty">
                        Notes failed or haven't been generated — hit <b>Generate notes</b> to retry
                        (the zip is already safe on disk).
                      </div>
                    )}
                  </section>
                </>
              ) : (
                <section className="eod-card rel-placeholder">
                  <div className="eod-card-head">
                    <span>This session</span>
                    <span className="eod-card-sub">idle</span>
                  </div>
                  <div className="muted rel-empty">
                    No release cut yet — hit <b>Release</b> above and the zip + patch notes land here.
                  </div>
                </section>
              )}
            </div>

            <aside className="rel-rail">
              <section className="eod-card">
                <div className="eod-card-head">
                  <span>Past releases</span>
                  <span className="eod-card-sub">{pre?.releases.length || 'none'}</span>
                </div>
                {!pre || pre.releases.length === 0 ? (
                  <div className="muted rel-empty">Releases you cut land here, notes stay re-copyable.</div>
                ) : (
                  <ul className="rel-list">
                    {pre.releases.map((r) => (
                      <li key={r.id} className={`rel-item${release?.id === r.id ? ' active' : ''}`}>
                        <button className="rel-item-open" onClick={() => setRelease(r)} title={r.zipPath}>
                          <span className="rel-item-ver">v{r.version}</span>
                          <span className="muted rel-item-meta">
                            {new Date(r.createdAt).toLocaleString()} · {fmtBytes(r.zipBytes)}
                            {r.zipExists === false ? ' · zip missing' : ''}
                            {r.summary ? '' : ' · no notes'}
                          </span>
                        </button>
                        <button
                          className="btn-icon rel-item-del"
                          title="Remove from history (keeps the zip file)"
                          onClick={() => void removeRelease(r.id)}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
