import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { THEMES, type ThemeId } from '../lib/themes';
import { themeMenuKey } from './themePickerNav';

interface Props {
  themeId: ThemeId;
  onSelect: (id: ThemeId) => void;
}

// Header dropdown to pick one of the 5 themes. Implements the ARIA menu keyboard
// pattern: focus moves into the menu on open, Arrow/Home/End roam the items, and
// focus returns to the toggle on close (Escape, select, or outside click via keys).
// The selection is applied + persisted by the parent (App).
export function ThemePicker({ themeId, onSelect }: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const current = THEMES.find((t) => t.id === themeId) ?? THEMES[0];

  const items = useCallback(
    () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []),
    [],
  );

  const close = useCallback((returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus) toggleRef.current?.focus();
  }, []);

  // On open, move focus to the checked item (or the first) so the keyboard user
  // lands inside the menu instead of on the toggle.
  useEffect(() => {
    if (!open) return;
    const list = items();
    const active = list.findIndex((el) => el.getAttribute('aria-checked') === 'true');
    list[active >= 0 ? active : 0]?.focus();
  }, [open, items]);

  // Close on outside pointer (mouse: no focus return needed).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const action = themeMenuKey(e.key, i, list.length);
    if (action.type === 'none') return;
    if (action.preventDefault) e.preventDefault();
    if (action.type === 'focus') list[action.index].focus();
    else close(action.returnFocus);
  };

  return (
    <div className="theme-picker" ref={wrapRef}>
      <button
        ref={toggleRef}
        className="theme-toggle"
        title={`Theme: ${current.name}`}
        aria-label="Change theme"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="theme-swatch" style={{ background: current.swatch[1] }} />
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path
            d="M4 6l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div className="theme-menu" role="menu" ref={menuRef} onKeyDown={onMenuKeyDown}>
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitemradio"
              aria-checked={t.id === themeId}
              className={`theme-item ${t.id === themeId ? 'active' : ''}`}
              onClick={() => {
                onSelect(t.id);
                close(true);
              }}
            >
              <span
                className="theme-item-swatch"
                style={{
                  background: `linear-gradient(135deg, ${t.swatch[0]} 0%, ${t.swatch[0]} 36%, ${t.swatch[1]} 36%, ${t.swatch[2]} 100%)`,
                }}
              />
              <span className="theme-item-name">{t.name}</span>
              <span className="theme-item-kind">{t.kind}</span>
              {t.id === themeId && (
                <span className="theme-item-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
