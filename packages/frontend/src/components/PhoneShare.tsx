import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../api';
import { desktop } from '../lib/desktop';

// Per-project "scan from your phone" panel. Shows a QR code that opens the
// lightweight mobile page (/m) for THIS project on a phone that's on the same
// Wi-Fi — no app install. Also hosts the opt-in "phone access" switch: turning it
// on rebinds the backend to the LAN (needs a one-time restart), off by default.
export function PhoneShare({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Runtime state from the backend.
  const [enabled, setEnabled] = useState(false); // is the server CURRENTLY LAN-bound
  const [port, setPort] = useState(0);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [token, setToken] = useState('');
  const [addr, setAddr] = useState('');
  // A toggle was saved that only takes effect after a restart.
  const [needsRestart, setNeedsRestart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () => {
    setLoading(true);
    api
      .getShare()
      .then((s) => {
        setEnabled(s.enabled);
        setPort(s.port);
        setAddresses(s.addresses);
        setToken(s.token);
        setAddr((cur) => (cur && s.addresses.includes(cur) ? cur : s.addresses[0] ?? ''));
        setErr(null);
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const url = useMemo(() => {
    if (!enabled || !addr || !port || !token) return '';
    return `http://${addr}:${port}/m?project=${encodeURIComponent(projectId)}&token=${encodeURIComponent(token)}`;
  }, [enabled, addr, port, token, projectId]);

  // Render the QR whenever the target URL changes.
  useEffect(() => {
    if (!url) {
      setQr(null);
      return;
    }
    let live = true;
    QRCode.toDataURL(url, { margin: 1, width: 260, errorCorrectionLevel: 'M' })
      .then((d) => {
        if (live) setQr(d);
      })
      .catch(() => {
        if (live) setQr(null);
      });
    return () => {
      live = false;
    };
  }, [url]);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.setShare(next);
      setNeedsRestart(res.needsRestart);
      // The runtime bind only changes on restart; reflect the saved intent so the
      // switch stays where the user put it, and the restart banner shows.
      if (!res.needsRestart) setEnabled(res.enabled);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    const bridge = desktop();
    if (bridge) bridge.relaunch();
    else
      setErr('Restart the backend (npm run dev) to apply the change — auto-restart is desktop-only.');
  };

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  // The switch reflects the desired state: runtime-enabled XOR a pending change.
  const desiredOn = needsRestart ? !enabled : enabled;

  return (
    <div className="phone-share">
      <div className="ps-head">
        <span className="ps-title">📱 Phone access</span>
        <label className="ps-switch" title="Share to your phone over Wi-Fi (off by default)">
          <input
            type="checkbox"
            checked={desiredOn}
            disabled={busy || loading}
            onChange={(e) => toggle(e.target.checked)}
          />
          <span className="ps-slider" />
        </label>
        <button className="btn-icon ps-close" title="Close" onClick={onClose}>
          ×
        </button>
      </div>

      {err && (
        <div className="banner banner-error" onClick={() => setErr(null)}>
          {err}
        </div>
      )}

      {needsRestart && (
        <div className="ps-restart">
          <span>
            {desiredOn
              ? 'Turning on phone access needs a restart to open your Wi-Fi.'
              : 'Turning off phone access needs a restart to close your Wi-Fi.'}{' '}
            Running processes will stop (their history is kept).
          </span>
          <button className="btn btn-primary ps-restart-btn" onClick={restart}>
            {desktop() ? 'Restart now' : 'How to restart'}
          </button>
        </div>
      )}

      {loading ? (
        <div className="ps-note muted">Checking…</div>
      ) : !enabled ? (
        <div className="ps-note">
          <p>
            Scan a QR code with your phone to watch this project’s processes and open a live terminal
            — no app to install. Your phone just needs to be on the <b>same Wi-Fi</b>.
          </p>
          <p className="muted">
            This exposes NARUKAMI to your local network (still protected by the QR’s secret token).
            It stays off until you turn it on.
          </p>
        </div>
      ) : addresses.length === 0 ? (
        <div className="ps-note">
          <p>Phone access is on, but no Wi-Fi/LAN address was found.</p>
          <p className="muted">Connect this computer to Wi-Fi (or a LAN) and reopen this panel.</p>
        </div>
      ) : (
        <div className="ps-qr-wrap">
          {qr ? <img className="ps-qr" src={qr} alt="Project QR code" width={220} height={220} /> : <div className="ps-qr ps-qr-empty" />}
          <div className="ps-qr-side">
            <p className="ps-scan">Scan with your phone’s camera.</p>
            {addresses.length > 1 && (
              <label className="ps-addr">
                <span className="muted">Wi-Fi address</span>
                <select value={addr} onChange={(e) => setAddr(e.target.value)}>
                  {addresses.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button className="btn ps-copy" onClick={copyUrl} title={url}>
              {copied ? 'Copied ✓' : 'Copy link'}
            </button>
            <p className="ps-hint muted">
              Anyone on your Wi-Fi with this QR can access it — treat it like a password.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
