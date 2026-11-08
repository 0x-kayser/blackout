/**
 * Google / email sign-in via Supabase Auth (PKCE). Loaded only when the server advertises a
 * Supabase project in /api/config/public; otherwise those buttons are not rendered at all.
 * We never see or store passwords; email sign-in is a magic link.
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

export async function signInWithGoogle(): Promise<void> {
  if (!client) throw new Error('Google sign-in is not configured on this server.')
  const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } })
  if (error) throw error
}

export async function sendEmailLink(email: string): Promise<void> {
  if (!client) throw new Error('Email sign-in is not configured on this server.')
  const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin, shouldCreateUser: true } })
  if (error) throw error
}

export async function signOutProvider(): Promise<void> {
  if (client) await client.auth.signOut()
  setBearer(null)
}
