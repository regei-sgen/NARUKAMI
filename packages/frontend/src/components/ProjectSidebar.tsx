import { useState, type FormEvent, type MouseEvent } from 'react';
import type { Project } from '../types';
import { Ic } from './icons';

interface Props {
  projects: Project[];
  selectedId: string | null;
  collapsed?: boolean;
  // Project ids where a run is actively producing output → bright pulsing dot.
  workingProjectIds: Set<string>;
  // Project ids with a Claude session open but idle → dim steady dot.
  claudeIdleProjectIds: Set<string>;
  onSelect: (id: string) => void;
  onAdd: (path: string) => void;
  onDelete: (id: string) => void;
}

export function ProjectSidebar({
  projects,
  selectedId,
  collapsed,
  workingProjectIds,
  claudeIdleProjectIds,
  onSelect,
  onAdd,
  onDelete,
}: Props) {
  const [path, setPath] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = path.trim();
    if (!value) return;
    onAdd(value);
    setPath('');
  };

  const del = (e: MouseEvent, id: string) => {
    e.stopPropagation();
    onDelete(id);
  };

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <form className="add-form" onSubmit={submit}>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="Absolute path to a project…"
          spellCheck={false}
          autoComplete="off"
        />
        <button type="submit" className="btn">
          Add
        </button>
      </form>

      <ul className="project-list">
        {projects.map((p) => (
          <li
            key={p.id}
            className={`project-item ${selectedId === p.id ? 'selected' : ''}`}
            onClick={() => onSelect(p.id)}
          >
            <div className="project-main">
              <span className="project-namewrap">
                {workingProjectIds.has(p.id) ? (
                  <span className="claude-live working" title="A task is running in this project">
                    <Ic name="spark" />
</span>
                ) : claudeIdleProjectIds.has(p.id) ? (
                  <span className="claude-live idle" title="Claude session open (idle)">
                    <Ic name="spark" />
</span>
                ) : null}
                <span className="project-name">{p.name}</span>
              </span>
              <span className={`status status-${p.status}`}>{p.status}</span>
            </div>
            <div className="project-path" title={p.path}>
              {p.path}
            </div>
            <button className="project-del" title="Remove project" onClick={(e) => del(e, p.id)}>
              ×
            </button>
          </li>
        ))}
        {projects.length === 0 && <li className="muted pad">No projects yet.</li>}
      </ul>
    </aside>
  );
}
