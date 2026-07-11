import { useEffect, useRef, useState } from 'react';
import { Ic } from './icons';

export interface ThemeOption {
  /** [data-theme] value; '' = the default (Beni). */
  value: string;
  label: string;
  /** the variant's accent, shown as the swatch */
  accent: string;
}

interface Props {
  themes: ReadonlyArray<ThemeOption>;
  value: string;
  onChange: (value: string) => void;
}

/**
 * Header theme picker — replaces the native <select> so the closed state can
 * carry the active theme's accent swatch and the open list can preview every
 * variant's color. Closes on outside click and Escape; arrows move, Enter picks.
 */
export function ThemeSelector({ themes, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const current = themes.find((t) => t.value === value) ?? themes[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Focus the active option when the list opens (keyboard flow).
  useEffect(() => {
    if (open) {
      const active = listRef.current?.querySelector<HTMLButtonElement>('.theme-opt.active');
      active?.focus();
    }
  }, [open]);

  const move = (from: number, delta: number) => {
    const next = (from + delta + themes.length) % themes.length;
    listRef.current?.querySelectorAll<HTMLButtonElement>('.theme-opt')[next]?.focus();
  };

  return (
    <div className="theme-sel" ref={wrapRef}>
      <button
        className="theme-sel-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Theme"
        title="Theme"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="theme-sw" style={{ background: current.accent }} />
        {current.label}
        <Ic name="chevron" className={`theme-chev ${open ? 'up' : ''}`} />
      </button>
      {open && (
        <div className="theme-sel-list" role="listbox" aria-label="Themes" ref={listRef}>
          {themes.map((t, i) => (
            <button
              key={t.value}
              role="option"
              aria-selected={t.value === value}
              className={`theme-opt ${t.value === value ? 'active' : ''}`}
              onClick={() => {
                onChange(t.value);
                setOpen(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  move(i, 1);
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  move(i, -1);
                }
              }}
            >
              <span className="theme-sw" style={{ background: t.accent }} />
              {t.label}
              {t.value === value && <Ic name="check" className="theme-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
