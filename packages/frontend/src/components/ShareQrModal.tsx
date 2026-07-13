import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api';
import type { MobileDeviceInfo, ShareResult } from '../types';
import { Ic } from './icons';

/** Human hint from a phone's User-Agent ("iPhone", "Android", …). */
function uaSummary(ua: string): string {
  const m = /iPhone|iPad|Android|Windows|Macintosh|Linux/.exec(ua);
  return m ? m[0] : ua ? ua.slice(0, 40) : 'unknown device';
}

/**
 * Desktop modal that turns a live terminal into a phone-scannable QR. Creating
 * the share starts the LAN relay and mints a scoped, TTL'd token; the QR encodes
 * the full URL (which contains that secret token — so the QR itself is sensitive
 * and only shown on THIS machine's screen). "Stop sharing" revokes it and, if it
 * was the last share, tears the relay down.
 */
export function ShareQrModal({
  runId,
  label,
  onClose,
}: {
  runId: string;
  label: string;
  onClose: () => void;
}) {
  const [share, setShare] = useState<ShareResult | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canInput, setCanInput] = useState(true);
  const [busy, setBusy] = useState(true);
  // Phones that have knocked on / connected to THIS run's share (the monitor).
  const [devices, setDevices] = useState<MobileDeviceInfo[]>([]);
  // Track the current share id so a re-mint (toggling view-only) revokes the old.
  const currentId = useRef<string | null>(null);
  // True once the modal unmounted: a shareRun that resolves AFTER that point
  // must be revoked immediately, or it leaks a live share (and keeps the LAN
  // relay up) with no UI attached — StrictMode's dev double-mount hit this on
  // every open.
  const unmounted = useRef(false);

  const create = useCallback(
    async (input: boolean) => {
      setBusy(true);
      setError(null);
      try {
        // Revoke the previous share before minting a replacement (view-only flip).
        if (currentId.current) {
          await api.revokeShare(currentId.current).catch(() => undefined);
          currentId.current = null;
        }
        const res = await api.shareRun(runId, { canInput: input });
        if (unmounted.current) {
          await api.revokeShare(res.id).catch(() => undefined);
          return;
        }
        currentId.current = res.id;
        setShare(res);
        const dataUrl = await QRCode.toDataURL(res.url, { margin: 1, width: 240 });
        setQr(dataUrl);
      } catch (e) {
        setError((e as Error).message);
        setShare(null);
        setQr(null);
      } finally {
        setBusy(false);
      }
    },
    [runId],
  );

  useEffect(() => {
    unmounted.current = false;
    void create(true);
    // Revoke on unmount is intentional: closing the modal ends the share (and
    // stops the relay when it was the last one). The backend kicks the phone's
    // live socket on revocation; the flag also catches a shareRun still in
    // flight (see create).
    return () => {
      unmounted.current = true;
      if (currentId.current) void api.revokeShare(currentId.current).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Device monitor: while the modal (= the share) is open, poll who has knocked
  // and who is streaming. 1.5s keeps the Allow prompt snappy without a ws.
  useEffect(() => {
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async (): Promise<void> => {
      try {
        const res = await api.listShares();
        if (gone) return;
        setDevices(res.devices.filter((d) => d.runId === runId));
      } catch {
        /* transient — keep the last list */
      }
      // Re-arm OUTSIDE the try and behind the gone-check: rescheduling from the
      // success path only (or unconditionally) either kills the poll on one
      // failed fetch or leaks a detached loop past unmount.
      if (!gone) timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => {
      gone = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  const decide = (deviceId: string, action: 'allow' | 'deny'): void => {
    void api
      .setDeviceApproval(runId, deviceId, action)
      .then((res) =>
        setDevices((prev) => prev.map((d) => (d.deviceId === deviceId ? res.device : d))),
      )
      .catch(() => undefined); // next poll re-syncs
  };

  const toggleInput = (next: boolean): void => {
    setCanInput(next);
    void create(next);
  };

  const expires = share ? new Date(share.expiresAt) : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal share-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">
            <Ic name="qr" /> Share “{label}” to your phone
          </span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {error ? (
          <div className="share-error">
            <p>{error}</p>
            <p className="share-hint">
              A LAN connection is required — make sure this machine is on Wi-Fi / a
              network (not loopback-only), then try again.
            </p>
            <button className="btn btn-primary" onClick={() => void create(canInput)}>
              Retry
            </button>
          </div>
        ) : (
          <div className="share-body">
            <div className="share-qr">
              {qr ? (
                <img src={qr} alt="Scan to open this terminal on your phone" width={240} height={240} />
              ) : (
                <div className="share-qr-placeholder">{busy ? 'Generating…' : ''}</div>
              )}
            </div>
            <p className="share-instructions">
              Scan with your phone’s camera. Both devices must be on the{' '}
              <strong>same network</strong>.
            </p>
            {share && (
              <>
                <div className="share-url" title={share.url}>
                  {share.url.replace(/([?&]m=)[^&]+/, '$1•••')}
                </div>
                <div className="share-meta">
                  <label className="share-toggle">
                    <input
                      type="checkbox"
                      checked={!canInput}
                      onChange={(e) => toggleInput(!e.target.checked)}
                    />
                    View-only (phone can watch but not type)
                  </label>
                  {expires && (
                    <span className="share-expiry">
                      Expires {expires.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </div>
              </>
            )}
            {devices.length > 0 && (
              <div className="share-devices">
                <span className="share-devices-title">
                  <Ic name="shield" /> Devices ({devices.filter((d) => d.connections > 0).length}{' '}
                  connected)
                </span>
                {devices.map((d) => (
                  <div
                    key={d.deviceId}
                    className={`share-device${d.state === 'pending' ? ' pending' : ''}`}
                  >
                    <div className="share-device-info">
                      <span className="share-device-ip">{d.ip}</span>
                      <span className="share-device-ua" title={d.userAgent}>
                        {uaSummary(d.userAgent)} · last seen{' '}
                        {new Date(d.lastSeen).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        })}
                      </span>
                    </div>
                    <span
                      className={`share-device-state ${
                        d.connections > 0 ? 'connected' : d.state
                      }`}
                    >
                      {d.connections > 0 ? 'connected' : d.state}
                    </span>
                    {d.state === 'pending' && (
                      <>
                        <button
                          className="btn btn-run"
                          onClick={() => decide(d.deviceId, 'allow')}
                        >
                          Allow
                        </button>
                        <button
                          className="btn btn-danger"
                          onClick={() => decide(d.deviceId, 'deny')}
                        >
                          Deny
                        </button>
                      </>
                    )}
                    {d.state === 'approved' && (
                      <button
                        className="btn btn-danger"
                        title="Kick this phone and block it from reconnecting"
                        onClick={() => decide(d.deviceId, 'deny')}
                      >
                        Kick
                      </button>
                    )}
                    {d.state === 'denied' && (
                      <button
                        className="btn"
                        title="Let this phone connect after all"
                        onClick={() => decide(d.deviceId, 'allow')}
                      >
                        Allow
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="share-actions">
              <button className="btn btn-danger" onClick={onClose}>
                Stop sharing
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
