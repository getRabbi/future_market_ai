import { type FormEvent, useState } from 'react';
import { authClient } from '../lib/auth.js';
import { formatValue } from '../lib/format.js';

export const MIN_PASSWORD_LENGTH = 12;

/** Client-side hints only; the API enforces the same rules (account-security.ts). */
export function passwordHint(next: string, confirm: string, current: string): string | null {
  if (!next) return null;
  if (next.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (next.length > 256) return 'Use at most 256 characters.';
  if (new Set(next).size < 5) return 'Use at least 5 different characters.';
  if (current && next === current) return 'The new password must be different from the current one.';
  if (confirm && next !== confirm) return 'The two new passwords do not match.';
  return null;
}

/**
 * Change password: requires the current password; the API revokes every other session and
 * records the change in the audit trail of each organization.
 */
export function ChangePassword({ email, passwordChangedAt }: { email?: string | null; passwordChangedAt?: string | null }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const hint = passwordHint(next, confirm, current);
  const ready = current.length > 0 && next.length >= MIN_PASSWORD_LENGTH && next === confirm && !hint;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    setDone(false);
    const r = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
    setBusy(false);
    if (r.error) {
      setError(r.error.status === 400 && /invalid password/i.test(r.error.message ?? '') ? 'The current password is incorrect.' : (r.error.message ?? 'Could not change the password.'));
      return;
    }
    setCurrent('');
    setNext('');
    setConfirm('');
    setDone(true);
  };

  return (
    <section className="card" aria-labelledby="change-password-title">
      <h2 id="change-password-title">Change password</h2>
      <p className="small muted">
        Changing your password signs out every other session.
        {passwordChangedAt ? ` Last changed ${formatValue('changedAt', passwordChangedAt)}.` : null}
      </p>
      {done ? (
        <div className="notice ok" role="status">
          Password changed. Other sessions were signed out.
        </div>
      ) : null}
      {error ? (
        <div className="notice error" role="alert">
          {error}
        </div>
      ) : null}
      <form onSubmit={submit} className="stack">
        {/* Lets password managers associate the new password with the account. */}
        <input type="text" name="username" autoComplete="username" hidden readOnly value={email ?? ''} />
        <div className="field">
          <label htmlFor="pw-current">Current password</label>
          <input id="pw-current" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div className="row">
          <div className="field" style={{ flex: '1 1 14rem' }}>
            <label htmlFor="pw-new">New password</label>
            <input id="pw-new" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} maxLength={256} value={next} onChange={(e) => setNext(e.target.value)} aria-describedby="pw-hint" />
          </div>
          <div className="field" style={{ flex: '1 1 14rem' }}>
            <label htmlFor="pw-confirm">Confirm new password</label>
            <input id="pw-confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-describedby="pw-hint" />
          </div>
        </div>
        <p id="pw-hint" className="small muted" aria-live="polite">
          {hint ?? `At least ${MIN_PASSWORD_LENGTH} characters; a long passphrase is best.`}
        </p>
        <div>
          <button type="submit" className="primary" disabled={!ready || busy}>
            {busy ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </form>
    </section>
  );
}
