import { useEffect, useRef, useState } from 'react'
import { explainError } from '../api/client'
import { inAppBrowser, loadGoogleIdentity, sendEmailLink, signInWithGoogle, signInWithGoogleCredential, startLocalEmail, verifyEmailCode, verifyLocalEmail } from '../api/auth'
import type { Game } from '../game/useGame'

const GoogleMark = () => (
  <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden>
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
)

/** Google's own "Sign in with Google" button (Google Identity Services); the ID token goes to our server. */
function GoogleIdentityButton({ clientId, onCredential, onError }: { clientId: string; onCredential: (credential: string) => void; onError: (msg: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const cb = useRef(onCredential)
  cb.current = onCredential
  useEffect(() => {
    let live = true
    loadGoogleIdentity().then(
      (g) => {
        if (!live || !ref.current) return
        g.accounts.id.initialize({ client_id: clientId, callback: (r: { credential: string }) => cb.current(r.credential), ux_mode: 'popup', auto_select: false, cancel_on_tap_outside: true })
        g.accounts.id.renderButton(ref.current, { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'rectangular', logo_alignment: 'center', width: Math.min(400, Math.max(220, ref.current.offsetWidth || 320)) })
      },
      (e: Error) => live && onError(e.message),
    )
    return () => {
      live = false
    }
  }, [clientId])
  return <div ref={ref} className="gis-button" data-testid="google-button" />
}

/**
 * One sign-in block used on the welcome screen and in the profile panel.
 * Google is one tap; email sends a link AND a 6-digit code so it works on any device and inside
 * in-app browsers (where Google blocks sign-in). A guest's city moves to the account automatically.
 */
export function SignInOptions({ g, compact = false, onSignedIn }: { g: Game; compact?: boolean; onSignedIn?: () => Promise<void> | void }) {
  const auth = g.config?.auth
  const [stage, setStage] = useState<'choose' | 'email' | 'code'>('choose')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null)
  const [cooldown, setCooldown] = useState(0)
  const [devCode, setDevCode] = useState<string | null>(null)
  const embedded = inAppBrowser()
  const local = !!auth?.local

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  if (!auth?.google && !auth?.email) return null
  const googleClientId = auth.googleClientId ?? null
  const googleReady = !!auth.google && !googleClientId

  const withGoogle = (credential: string) =>
    run(async () => {
      const r = await signInWithGoogleCredential(credential)
      await g.boot()
      if (r.upgradedGuest) g.toast('Signed in with Google. Your company is saved to your account.', 'good')
      await onSignedIn?.()
    })

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
    } catch (e) {
      setMsg({ text: explainError(e), tone: 'warn' })
    } finally {
      setBusy(false)
    }
  }

  const send = () =>
    run(async () => {
      if (local) setDevCode((await startLocalEmail(email.trim())).devCode ?? null)
      else await sendEmailLink(email.trim())
      setStage('code')
      setCooldown(30)
    })

  const verify = () =>
    run(async () => {
      if (local) {
        const r = await verifyLocalEmail(email.trim(), code)
        await g.boot()
        if (r.upgradedGuest) g.toast('Signed in. Your city is saved to your account.', 'good')
      } else {
        await verifyEmailCode(email.trim(), code)
        await g.boot()
      }
      await onSignedIn?.()
    })

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setMsg({ text: 'Link copied. Paste it into Safari or Chrome to use Google sign-in.', tone: 'ok' })
    } catch {
      setMsg({ text: window.location.href, tone: 'ok' })
    }
  }

  return (
    <div className={`signin2 ${compact ? 'compact' : ''}`}>
      {stage === 'choose' && (
        <>
          {googleClientId && !embedded && <GoogleIdentityButton clientId={googleClientId} onCredential={(c) => void withGoogle(c)} onError={(m) => setMsg({ text: m, tone: 'warn' })} />}
          {googleClientId && embedded && (
            <div className="inapp-note">
              <p>Google sign-in doesn't work inside {embedded}'s built-in browser. Use your email below, or open BLACKOUT in Safari or Chrome.</p>
              <button className="button mini" onClick={() => void copyLink()}>Copy link</button>
            </div>
          )}
          {!googleClientId && (auth.google || local) &&
            (embedded && googleReady ? (
              <div className="inapp-note">
                <p>Google sign-in doesn't work inside {embedded}'s built-in browser. Use your email below, or open BLACKOUT in Safari or Chrome.</p>
                <button className="button mini" onClick={() => void copyLink()}>Copy link</button>
              </div>
            ) : (
              <button
                className="button wide google"
                disabled={busy}
                onClick={() => (googleReady ? void run(signInWithGoogle) : setMsg({ text: 'Google sign-in switches on once this server is connected to the account provider (Supabase). On this server, continue with email: it takes 20 seconds.', tone: 'warn' }))}
              >
                <GoogleMark /> Continue with Google
              </button>
            ))}
          {auth.email && (
            <button className={`button wide ${auth.google && !embedded ? 'secondary' : 'email'}`} disabled={busy} onClick={() => setStage('email')}>
              ✉ Continue with email
            </button>
          )}
        </>
      )}
      {stage === 'email' && (
        <form onSubmit={(e) => { e.preventDefault(); void send() }}>
          <label className="sr-only" htmlFor="signin-email">Email address</label>
          <input id="signin-email" type="email" required autoFocus autoComplete="email" inputMode="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="button wide primary" disabled={busy || !email}>{busy ? 'Sending…' : 'Send my sign-in code'}</button>
          <button type="button" className="text-link" onClick={() => setStage('choose')}>← Other options</button>
        </form>
      )}
      {stage === 'code' && (
        <form onSubmit={(e) => { e.preventDefault(); void verify() }}>
          {local ? (
            <p className="fine">{devCode ? <>Local test mode: there is no mail server, so your code is <b className="dev-code">{devCode}</b>. On a live server it arrives by email.</> : <>We sent a 6-digit code for <b>{email}</b>. Type it here.</>}</p>
          ) : (
            <p className="fine">We emailed <b>{email}</b> a 6-digit code and a link. Type the code here, or tap the link in the email on this device.</p>
          )}
          <label className="sr-only" htmlFor="signin-code">Six-digit code</label>
          <input id="signin-code" className="code-input" required autoFocus autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
          <button className="button wide primary" disabled={busy || code.length !== 6}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <div className="code-actions">
            <button type="button" className="text-link" disabled={cooldown > 0 || busy} onClick={() => void send()}>{cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}</button>
            <button type="button" className="text-link" onClick={() => { setStage('email'); setCode('') }}>Use a different email</button>
          </div>
        </form>
      )}
      {msg && <p className={msg.tone === 'ok' ? 'ok-line' : 'warn'}>{msg.text}</p>}
    </div>
  )
}
