import { useState, type FormEvent } from 'react';
import { api } from '../api';
import type { AnalyzerResult, Project, RunCommand } from '../types';

interface Props {
  project: Project;
  onAnalyze: (id: string) => Promise<{ project: Project; analysis: AnalyzerResult }>;
  onRun: (project: Project, command: RunCommand) => void;
  onShell: (project: Project, admin?: boolean) => void;
  onClaude: (project: Project) => void;
  onContinueClaude: (project: Project) => void;
  onChanged: () => void | Promise<void>;
}

export function ProjectPanel({
  project,
  onAnalyze,
  onRun,
  onShell,
  onClaude,
  onContinueClaude,
  onChanged,
}: Props) {
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<AnalyzerResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // manual add
  const [label, setLabel] = useState('');
  const [command, setCommand] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  // claude add
  const [describe, setDescribe] = useState('');
  const [asking, setAsking] = useState(false);

  const analyze = async () => {
    setAnalyzing(true);
    setErr(null);
    try {
      const res = await onAnalyze(project.id);
      setAnalysis(res.analysis);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  };

  const addManual = async (e: FormEvent) => {
    e.preventDefault();
    const l = label.trim();
    const c = command.trim();
    if (!l || !c) return;
    setErr(null);
    try {
      await api.addCommand(project.id, { label: l, command: c, isDefault: makeDefault });
      setLabel('');
      setCommand('');
      setMakeDefault(false);
      await onChanged();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  };

  const askClaude = async (e: FormEvent) => {
    e.preventDefault();
    const q = describe.trim();
    if (!q) return;
    setErr(null);
    setAsking(true);
    try {
      await api.suggestCommand(project.id, q);
      setDescribe('');
      await onChanged();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setAsking(false);
    }
  };

  const del = async (commandId: string) => {
    setErr(null);
    try {
      await api.deleteCommand(commandId);
      await onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-headinfo">
          <h2>{project.name}</h2>
          <div className="panel-path">{project.path}</div>
          <div className="panel-meta">
            <span className={`status status-${project.status}`}>{project.status}</span>
            {project.type && <span className="tag">{project.type}</span>}
            {project.packageMgr && <span className="tag">{project.packageMgr}</span>}
          </div>
        </div>
        <div className="panel-head-actions">
          <button className="btn btn-shell" onClick={() => onShell(project)}>
            ⌨ Shell
          </button>
          <button
            className="btn btn-shell"
            title="Open an elevated PowerShell (Administrator) — triggers a UAC prompt"
            onClick={() => onShell(project, true)}
          >
            🛡 Shell (Admin)
          </button>
          <button
            className="btn btn-claude"
            title="Interactive Claude Code session (starts with /effort ultracode)"
            onClick={() => onClaude(project)}
          >
            ✦ Claude Code
          </button>
          <button
            className="btn btn-claude"
            title="Resume the last Claude conversation in this project (claude --continue)"
            onClick={() => onContinueClaude(project)}
          >
            ✦ Continue
          </button>
          <button className="btn btn-primary" onClick={analyze} disabled={analyzing}>
            {analyzing ? 'Analyzing…' : 'Analyze'}
          </button>
        </div>
      </div>

      {err && (
        <div className="banner banner-error" onClick={() => setErr(null)}>
          {err}
        </div>
      )}

      {analysis?.warnings?.length ? (
        <ul className="warnings">
          {analysis.warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      ) : null}

      <h3>Run commands</h3>
      {project.commands.length === 0 ? (
        <div className="muted">
          No commands yet — click <b>Analyze</b> to detect them, or add one below.
        </div>
      ) : (
        <ul className="command-list">
          {project.commands.map((c) => (
            <li key={c.id} className="command-item">
              <div className="cmd-info">
                <span className="cmd-label">
                  {c.label}
                  {c.isDefault && <span className="default-badge">default</span>}
                  {c.source === 'custom' && <span className="custom-badge">custom</span>}
                </span>
                <code className="cmd-text">{c.command}</code>
              </div>
              <div className="cmd-actions">
                <button className="btn btn-run" onClick={() => onRun(project, c)}>
                  ▶ Run
                </button>
                <button className="btn-icon" title="Delete command" onClick={() => del(c.id)}>
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Add a custom command */}
      <div className="add-command">
        <h4>Add a command</h4>
        <form className="add-command-row" onSubmit={addManual}>
          <input
            className="cmd-label-input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="label (e.g. test)"
            spellCheck={false}
          />
          <input
            className="cmd-command-input"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="shell command (e.g. npm test)"
            spellCheck={false}
          />
          <label className="default-check">
            <input
              type="checkbox"
              checked={makeDefault}
              onChange={(e) => setMakeDefault(e.target.checked)}
            />
            default
          </label>
          <button type="submit" className="btn">
            Add
          </button>
        </form>

        <form className="add-command-row" onSubmit={askClaude}>
          <input
            className="cmd-command-input"
            value={describe}
            onChange={(e) => setDescribe(e.target.value)}
            placeholder="…or describe it: “run the tests in watch mode”"
            spellCheck={false}
            disabled={asking}
          />
          <button type="submit" className="btn btn-claude" disabled={asking}>
            {asking ? 'Asking Claude…' : '✦ Ask Claude'}
          </button>
        </form>
      </div>

      {analysis?.envVarsNeeded?.length ? (
        <div className="env-note">
          <h4>Env vars this project may need</h4>
          <div className="env-tags">
            {analysis.envVarsNeeded.map((v) => (
              <code key={v}>{v}</code>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
