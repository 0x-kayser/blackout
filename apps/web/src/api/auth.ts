/**
 * Authentication helpers. Google can use direct Google Identity Services or Supabase Auth
 * (PKCE); email uses Supabase magic links/codes or the local email-code provider. We never
 * see or store passwords. The 6-digit email code works across devices and in-app browsers.
 */
import type { SupabaseClient, Session } from '@supabase/supabase-js'
import type { PublicConfig } from './client'
import { bearerHeader, setBearer } from './client'

let client: SupabaseClient | null = null

export async function initSupabase(cfg: PublicConfig): Promise<SupabaseClient | null> {
  if (!cfg.auth.supabaseUrl || !cfg.auth.supabaseAnonKey) return null
  if (client) return client
  const { createClient } = await import('@supabase/supabase-js')
  client = createClient(cfg.auth.supabaseUrl, cfg.auth.supabaseAnonKey, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  })
  // keep the API bearer in sync with refreshed tokens
  client.auth.onAuthStateChange((_evt, session) => setBearer(session?.access_token ?? null))
  return client
}

export async function currentSession(): Promise<Session | null> {
  if (!client) return null
  const { data } = await client.auth.getSession()
  setBearer(data.session?.access_token ?? null)
  return data.session
}

const returnUrl = () => `${window.location.origin}${window.location.pathname}`

/**
 * Google refuses OAuth inside embedded app browsers (Instagram, Facebook, LinkedIn, TikTok and similar),
 * so we detect them and steer players to the email code or to their real browser instead.
 */
export function inAppBrowser(ua = navigator.userAgent): string | null {
  const known: [RegExp, string][] = [
    [/Instagram/i, 'Instagram'],
    [/FBAN|FBAV|FB_IAB/i, 'Facebook'],
    [/LinkedInApp/i, 'LinkedIn'],
    [/TikTok|musical_ly|Bytedance/i, 'TikTok'],
    [/Snapchat/i, 'Snapchat'],
    [/Line\//i, 'LINE'],
    [/Telegram/i, 'Telegram'],
    [/Discord/i, 'Discord'],
  ]
  for (const [re, name] of known) if (re.test(ua)) return name
  // generic Android WebView / iOS in-app view (no "Safari" token on iOS)
  if (/; wv\)/.test(ua)) return 'this app'
  if (/iPhone|iPad|iPod/.test(ua) && !/Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)) return 'this app'
  return null
}

export async function signInWithGoogle(): Promise<void> {
  if (!client) throw new Error('Google sign-in is not available right now.')
  const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: returnUrl(), queryParams: { prompt: 'select_account' } } })
  if (error) throw error
}

export async function sendEmailLink(email: string): Promise<void> {
  if (!client) throw new Error('Email sign-in is not available right now.')
  const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: returnUrl(), shouldCreateUser: true } })
  if (error) throw error
}

/** Completes email sign-in with the 6-digit code from the same email (works on any device). */
export async function verifyEmailCode(email: string, code: string): Promise<void> {
  if (!client) throw new Error('Email sign-in is not available right now.')
  const { data, error } = await client.auth.verifyOtp({ email, token: code.trim(), type: 'email' })
  if (error) throw error
  setBearer(data.session?.access_token ?? null)
}

export async function signOutProvider(): Promise<void> {
  try {
    if (client) await client.auth.signOut()
  } finally {
    // The app session has already been revoked server-side. Clear the API token even if
    // Supabase is temporarily offline so the next screen cannot keep making signed-in calls.
    setBearer(null)
  }
}

/** Direct Google sign-in: hands the ID token Google issued in the browser to our server, which verifies it. */
export async function signInWithGoogleCredential(credential: string): Promise<{ upgradedGuest: boolean }> {
  const res = await fetch('/api/auth/google', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', ...bearerHeader() }, body: JSON.stringify({ credential }) })
  const json = await res.json().catch(() => null)
  if (!json?.ok) throw new Error(json?.error?.message ?? 'Google sign-in failed.')
  return { upgradedGuest: !!json.upgradedGuest }
}

type Gis = { accounts: { id: { initialize: (o: Record<string, unknown>) => void; renderButton: (el: HTMLElement, o: Record<string, unknown>) => void } } }
let gis: Promise<Gis> | null = null
/** Loads Google Identity Services once (the official script that draws Google's own button). */
export function loadGoogleIdentity(): Promise<Gis> {
  gis ??= new Promise((resolve, reject) => {
    const w = window as unknown as { google?: Gis }
    if (w.google?.accounts?.id) return resolve(w.google)
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.onload = () => (w.google?.accounts?.id ? resolve(w.google) : reject(new Error('Google sign-in did not load.')))
    s.onerror = () => {
      gis = null
      reject(new Error('Could not reach Google. Check your connection or use email.'))
    }
    document.head.appendChild(s)
  })
  return gis
}

/** Local email-code sign-in (servers without Supabase, e.g. localhost). Returns the code only in local test mode. */
export async function startLocalEmail(email: string): Promise<{ devCode?: string }> {
  const res = await fetch('/api/auth/email/start', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) })
  const json = await res.json().catch(() => null)
  if (!json?.ok) throw new Error(json?.error?.message ?? 'Could not send a sign-in code.')
  return { devCode: json.devCode }
}

export async function verifyLocalEmail(email: string, code: string): Promise<{ upgradedGuest: boolean }> {
  const res = await fetch('/api/auth/email/verify', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: code.trim() }) })
  const json = await res.json().catch(() => null)
  if (!json?.ok) throw new Error(json?.error?.message ?? 'Could not sign in.')
  return { upgradedGuest: !!json.upgradedGuest }
}
