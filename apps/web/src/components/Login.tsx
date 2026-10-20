import { type FormEvent, useState } from 'react';
import { authClient } from '../lib/auth.js';

function nextUrl(): string {
  const n = new URLSearchParams(window.location.search).get('next');
  // Only same-site relative paths (no open redirect).
  return n && n.startsWith('/') && !n.startsWith('//') ? n : '/app/';
}

export function Login() {
  const [step, setStep] = useState<'password' | 'totp'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signIn = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (r.error) return setError(r.error.message ?? 'Sign-in failed');
    if ((r.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) return setStep('totp');
    window.location.href = nextUrl();
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await authClient.twoFactor.verifyTotp({ code });
    setBusy(false);
    if (r.error) return setError(r.error.message ?? 'Invalid code');
    window.location.href = nextUrl();
  };

  return (
    <main className="auth-box" id="content">
      <h1>Sign in to FUTUREGROW</h1>
      {step === 'password' ? (
        <form onSubmit={signIn}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error ? (
            <div className="notice error" role="alert">
              {error}
            </div>
          ) : null}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Continue'}
          </button>
          <p className="small muted" style={{ marginTop: '1rem' }}>
            Access is by invitation during the controlled beta.
          </p>
        </form>
      ) : (
        <form onSubmit={verify}>
          <p className="small">Enter the 6-digit code from your authenticator app.</p>
          <div className="field">
            <label htmlFor="code">Authentication code</label>
            <input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
          </div>
          {error ? (
            <div className="notice error" role="alert">
              {error}
            </div>
          ) : null}
          <button type="submit" className="primary" disabled={busy || code.length !== 6}>
            {busy ? 'Verifying…' : 'Verify'}
          </button>
        </form>
      )}
    </main>
  );
}
