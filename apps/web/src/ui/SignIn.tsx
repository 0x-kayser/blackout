import { useCallback, useRef, useState } from 'react'
import { useLogin, usePrivy } from '@privy-io/react-auth'
import { api, BlackoutApiError, explainError } from '../api/client'
import { inAppBrowser, signInWithPrivyToken } from '../api/auth'
import type { Game } from '../game/useGame'

const GoogleMark = () => (
  <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
)

const EmailMark = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m4 7 8 6 8-6" />
  </svg>
)

/** Privy verifies Google/email; the API exchanges its access token for BLACKOUT's HTTP-only session. */
export function SignInOptions({ g, compact = false, onSignedIn }: { g: Game; compact?: boolean; onSignedIn?: () => Promise<void> | void }) {
  const auth = g.config?.auth
  const { ready, getAccessToken } = usePrivy()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const inFlight = useRef(false)
  const syncedUser = useRef<string | null>(null)
  const loginIntent = useRef<'google' | 'email' | 'discord' | null>(null)
  const gameRef = useRef(g)
  gameRef.current = g
  const onSignedInRef = useRef(onSignedIn)
  onSignedInRef.current = onSignedIn
  const getAccessTokenRef = useRef(getAccessToken)
  getAccessTokenRef.current = getAccessToken
  const embedded = inAppBrowser()

  const finishLogin = useCallback(async ({ user, wasAlreadyAuthenticated }: { user: { id: string }; wasAlreadyAuthenticated: boolean }) => {
    const wasRequestedHere = loginIntent.current !== null
    // On page load, let an existing BLACKOUT session win. Only use the remembered Privy session
    // when BLACKOUT has no valid session; explicit button clicks can still upgrade a guest.
    if (!wasRequestedHere && wasAlreadyAuthenticated) {
      try {
        await api.me()
        return
      } catch (error) {
        if (!(error instanceof BlackoutApiError) || error.code !== 'UNAUTHORIZED') throw error
      }
    }
    if (inFlight.current || syncedUser.current === user.id) return
    inFlight.current = true
    setBusy(true)
    setMsg(null)
    loginIntent.current = null
    try {
      const accessToken = await getAccessTokenRef.current()
      if (!accessToken) throw new Error('Privy could not finish verification. Please try signing in again.')
      const result = await signInWithPrivyToken(accessToken)
      syncedUser.current = user.id
      const game = gameRef.current
      const onSignedIn = onSignedInRef.current
      if (result.upgradedGuest) game.toast('Your company is now saved to your account.', 'good')
      if (wasRequestedHere && onSignedIn) await onSignedIn()
      else if (wasRequestedHere || wasAlreadyAuthenticated) await game.boot()
    } catch (error) {
      setMsg(explainError(error))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [])

  const handleLoginComplete = useCallback((params: { user: { id: string }; wasAlreadyAuthenticated: boolean }) => {
    void finishLogin(params)
  }, [finishLogin])

  const handleLoginError = useCallback(() => {
    loginIntent.current = null
    setBusy(false)
    setMsg('Sign-in was canceled or could not be completed. Try again or choose email.')
  }, [])

  const { login } = useLogin({
    onComplete: handleLoginComplete,
    onError: handleLoginError,
  })

  if (!auth?.privy) return null

  const startLogin = (method: 'google' | 'email' | 'discord') => {
    if (!ready || busy) return
    loginIntent.current = method
    setMsg(null)
    try {
      login({ loginMethods: [method] })
    } catch (error) {
      loginIntent.current = null
      setMsg(explainError(error))
    }
  }

  return (
    <div className={`signin2 ${compact ? 'compact' : ''}`}>
      {embedded && <p className="fine">Social sign-in can be restricted inside some in-app browsers. Email sign-in is also available.</p>}
      <button className="button wide google" disabled={!ready || busy} onClick={() => startLogin('google')}>
        <GoogleMark /> {busy ? 'Finishing sign-in…' : 'Continue with Google'}
      </button>
      <button className="button wide secondary" disabled={!ready || busy} onClick={() => startLogin('email')}>
        <EmailMark /> Continue with email
      </button>
      <button className="button wide discord" disabled={!ready || busy} onClick={() => startLogin('discord')}>
        Continue with Discord
      </button>
      {msg && <p className="warn" role="alert">{msg}</p>}
    </div>
  )
}
