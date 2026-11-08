/**
 * Google / email sign-in via Supabase Auth (PKCE). Loaded only when the server advertises a
 * Supabase project in /api/config/public; otherwise those buttons are not rendered at all.
 * We never see or store passwords. Email sign-in sends a link AND a 6-digit code: the link works
 * in the same browser, the code works anywhere (another device, an in-app browser).
 */
import type { SupabaseClient, Session } from '@supabase/supabase-js'
import type { PublicConfig } from './client'
import { setBearer } from './client'

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
  if (client) await client.auth.signOut()
  setBearer(null)
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
