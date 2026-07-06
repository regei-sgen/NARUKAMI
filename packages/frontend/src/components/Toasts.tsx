import type { Toast } from '../types';
import { toastText } from '../lib/notify';

interface Props {
  toasts: Toast[];
  onFocus: (t: Toast) => void;
  onDismiss: (id: string) => void;
}

const ICON: Record<Toast['kind'], string> = { shell: '⌨', claude: '✦', command: '▶' };

export function Toasts({ toasts, onFocus, onDismiss }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {toasts.map((t) => {
        const { title, body } = toastText(t);
        return (
          <div
            key={t.id}
            className={`toast ${t.event === 'task' ? 'toast-task' : `toast-${t.status}`}`}
            role="button"
            tabIndex={0}
            title="Go to this terminal"
            onClick={() => onFocus(t)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onFocus(t);
              }
            }}
          >
            <span className="toast-icon">{ICON[t.kind]}</span>
            <div className="toast-body">
              <div className="toast-title">{title}</div>
              <div className="toast-sub">{body}</div>
            </div>
            <button
              className="toast-close"
              title="Dismiss"
              onClick={(e) => {
                e.stopPropagation();
                onDismiss(t.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
