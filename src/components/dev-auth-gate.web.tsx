import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  C, EDITOR_CSS, FONT_STACK, MONO_STACK, SHADOW, inputStyle, primaryButtonStyle,
} from '@/lib/design-tokens';
import { CODE_VERSION, SHOW_DEV_UI } from '@/lib/env';

// Sign-in wall for dev builds. A dev deployment is publicly reachable but isn't for the
// public: it carries the dev rail, the AI tools panel and the review-host plumbing. This
// asks for the EXPO_ADMIN credentials before any of it is mounted.
//
// Inert in a production build — SHOW_DEV_UI is false there, and this renders its children
// straight through, so the shipped app never sees a login box.
//
// The children are not rendered until the session checks out, rather than being covered
// by an overlay: an overlay would still mount the editor, which starts fetching from the
// review host on load. Nothing behind the gate runs until it opens.

type Status = 'checking' | 'in' | 'out';

const centred: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 200,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: C.appBg,
  fontFamily: FONT_STACK,
};

export function DevAuthGate({ children }: { children: React.ReactNode }) {
  // A production build starts (and stays) open. SHOW_DEV_UI is a build-time constant, so
  // this is decided once and can't change between renders — and it's the same value
  // during SSR as it is after hydration, so the two agree on what to paint.
  const [status, setStatus] = useState<Status>(SHOW_DEV_UI ? 'checking' : 'in');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!SHOW_DEV_UI) return;
    let live = true;
    // A valid cookie from an earlier sign-in means straight through — the gate should
    // cost one login per session, not one per reload.
    fetch('/api/auth', { credentials: 'same-origin' })
      .then((res) => res.json())
      .then((data: { authed?: boolean; error?: { message?: string } }) => {
        if (!live) return;
        if (data.authed) return setStatus('in');
        // A server that can't authenticate anyone still shows the form, with the reason
        // on it — the alternative is an unexplained wall.
        if (data.error?.message) setError(data.error.message);
        setStatus('out');
      })
      .catch(() => {
        if (!live) return;
        setError('Could not reach the server');
        setStatus('out');
      });
    return () => { live = false; };
  }, []);

  // Put the caret in the password box whenever the form is sitting idle — on first paint,
  // and again after a rejected attempt.
  //
  // Keyed on `busy` rather than done inline in the submit handler: the fields are
  // disabled while the request is in flight, and focus() on a disabled input does
  // nothing, so a call made before the re-enable is silently dropped and the retry gets
  // typed into no field at all. Waiting for busy to fall is what makes it land.
  useEffect(() => {
    if (status === 'out' && !busy) passwordRef.current?.focus();
  }, [status, busy, error]);

  const submit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username, password }),
      });
      const data = (await res.json()) as { authed?: boolean; error?: { message?: string } };
      if (res.ok && data.authed) {
        setStatus('in');
        return;
      }
      setError(data.error?.message ?? `Sign-in failed (${res.status})`);
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }, [busy, username, password]);

  if (status === 'in') return <>{children}</>;

  // Blank field of the app's own background while the session check is in flight. Not a
  // spinner: the check is a local request that normally resolves before anything would
  // have had time to animate, and a flash of spinner reads as a fault.
  if (status === 'checking') return <div style={centred} />;

  return (
    <div style={centred}>
      {/* The editor mounts this itself, but it lives behind the gate — without it here
          the .ed-input focus ring and placeholder colour are missing on these two fields,
          and inputStyle has already suppressed the browser's own outline. */}
      <style>{EDITOR_CSS}</style>
      <form
        onSubmit={submit}
        style={{
          width: 320, maxWidth: '90vw',
          background: C.surface, borderRadius: 14, boxShadow: SHADOW.modal,
          padding: '20px 20px 18px',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}
      >
        <div>
          <h1 style={{ fontSize: 15, fontWeight: 700, color: C.textPrimary, margin: 0 }}>
            Development build
          </h1>
          <p style={{ fontSize: 12.5, color: C.textMuted, lineHeight: 1.55, margin: '6px 0 0' }}>
            This build isn’t public. Sign in with the EXPO_ADMIN credentials to continue.
          </p>
        </div>

        <input
          className="ed-input"
          type="text"
          name="username"
          autoComplete="username"
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={busy}
          style={inputStyle}
        />
        <input
          ref={passwordRef}
          className="ed-input"
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          style={inputStyle}
        />

        {error && (
          <span style={{ fontSize: 12, color: C.dangerText, lineHeight: 1.4 }}>{error}</span>
        )}

        <button
          type="submit"
          disabled={busy || password.length === 0}
          style={{
            ...primaryButtonStyle,
            width: '100%',
            opacity: busy || password.length === 0 ? 0.45 : 1,
            cursor: busy || password.length === 0 ? 'default' : 'pointer',
          }}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {/* Same build stamp as the dev rail's title, readable before sign-in — which is
            the point of it: telling a stale deployment apart shouldn't need credentials. */}
        <span style={{ fontSize: 10, color: C.textFaint, fontFamily: MONO_STACK, textAlign: 'center' }}>
          {CODE_VERSION}
        </span>
      </form>
    </div>
  );
}
