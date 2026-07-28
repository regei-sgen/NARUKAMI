import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { PcStatsPanel } from './PcStatsPanel';
import type { StatsLanState } from '../types';
import './pcstats.css';

/** The pin bridge the desktop preload exposes (absent in a plain browser tab). */
interface DesktopBridge {
  setAlwaysOnTop: (flag: boolean) => Promise<boolean>;
}
const bridge = (): DesktopBridge | null =>
  (window as unknown as { narukamiDesktop?: DesktopBridge }).narukamiDesktop ?? null;

/**
 * The detached PC Stats window. The readout fills the whole surface — the
 * controls live in a kebab menu on the system rail rather than a title strip,
 * so a phone in landscape spends every pixel on instruments.
 */
export function PcStatsWindow(): JSX.Element {
  const [pinned, setPinned] = useState(true);
  const [canPin, setCanPin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [lan, setLan] = useState<StatsLanState | null>(null);
  const [showLan, setShowLan] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setCanPin(bridge() !== null);
    document.title = 'NARUKAMI · PC Stats';
  }, []);

  useEffect(() => {
    if (!canPin) return; // only the desktop window controls the listener
    void api.getStatsLan().then(setLan).catch(() => undefined);
  }, [canPin]);

  // Close the menu on Escape or an outside pointer.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    const onDoc = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDoc);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [menuOpen]);

  const togglePin = useCallback(async () => {
    const b = bridge();
    if (!b) return;
    setPinned(await b.setAlwaysOnTop(!pinned));
  }, [pinned]);

  const [copied, setCopied] = useState<'address' | 'token' | null>(null);

  /**
   * Copy with a clipboard fallback: this window is served over plain HTTP on a
   * LAN IP when opened from a phone, and navigator.clipboard is undefined in a
   * non-secure context.
   */
  const copy = useCallback(async (text: string, what: 'address' | 'token') => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(what);
      setTimeout(() => setCopied(null), 1400);
    } catch {
      /* leave the value on screen to copy by hand */
    }
  }, []);

  const toggleLan = useCallback(async () => {
    try {
      const next = lan?.running ? await api.stopStatsLan() : await api.startStatsLan();
      setLan(next);
      setShowLan(next.running);
    } catch {
      /* keep the previous state visible */
    }
  }, [lan]);

  return (
    <div className="pcvw" ref={wrapRef}>
      <PcStatsPanel onMenu={() => setMenuOpen((o) => !o)} />

      {menuOpen && (
        <div className="pcv-menu" role="menu">
          {canPin && (
            <button
              role="menuitem"
              onClick={() => {
                void togglePin();
                setMenuOpen(false);
              }}
            >
              {pinned ? 'Unpin from top' : 'Pin above all windows'}
            </button>
          )}
          {canPin && (
            <button
              role="menuitem"
              onClick={() => {
                if (lan?.running) setShowLan((s) => !s);
                else void toggleLan();
                setMenuOpen(false);
              }}
            >
              {lan?.running ? 'Phone address…' : 'Share to phone (Wi-Fi)'}
            </button>
          )}
          <button role="menuitem" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}

      {showLan && lan?.running && lan.info && (
        <div className="pcv-share">
          {/* The native phone app takes the address and the token as SEPARATE
              fields, so each is shown (and copied) on its own. */}
          <div className="pcv-share-lab">address</div>
          <code>{lan.info.urls[0]}</code>
          <div className="pcv-share-lab">token</div>
          <code>{lan.info.token}</code>
          <div className="pcv-share-note">
            Read-only: this listener serves the stats and nothing else. The token changes each time
            the server restarts.
          </div>
          <div className="pcv-share-acts">
            <button onClick={() => void copy(lan.info?.urls[0] ?? '', 'address')}>
              {copied === 'address' ? 'COPIED' : 'COPY ADDRESS'}
            </button>
            <button onClick={() => void copy(lan.info?.token ?? '', 'token')}>
              {copied === 'token' ? 'COPIED' : 'COPY TOKEN'}
            </button>
            <button onClick={() => void toggleLan()}>TURN OFF</button>
          </div>
        </div>
      )}
    </div>
  );
}
