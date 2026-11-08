# Auth provider decision

**Decision:** Supabase Auth for Google and email (magic link), plus server-issued guest sessions. X is deferred.
Checked 2026-11-08.

## Why Supabase
* Maintained provider with Google OAuth and passwordless email out of the box; PKCE flow in `@supabase/supabase-js`.
* Free plan includes 50,000 monthly active users (supabase.com/pricing). Free projects pause after one week of
  inactivity — keep the project active during judging or use a paid plan.
* Backend verification without a shared secret: Supabase recommends asymmetric signing keys and local verification
  against `https://<project>.supabase.co/auth/v1/.well-known/jwks.json` (supabase.com/docs/guides/auth/jwts). We do
  exactly that with `jose` (`createRemoteJWKSet`, issuer `<url>/auth/v1`, audience `authenticated`, ES256/RS256/EdDSA,
  10-minute key cache in line with Supabase's guidance on key rotation).
* We store **no passwords and no email addresses**: only `(provider="supabase", subject=sub)`, the login method and a
  display name.

## Flow
1. Browser loads `/api/config/public`; if the server has `SUPABASE_URL` + `SUPABASE_ANON_KEY`, it initialises
   supabase-js (PKCE, auto refresh). Buttons for providers that are not configured are **not rendered**.
2. Google → `signInWithOAuth({provider:'google', redirectTo: origin})`; email → `signInWithOtp` (magic link).
3. On return, supabase-js exchanges the code (PKCE + state handled by the SDK) and keeps the session.
4. Every API call sends `Authorization: Bearer <access token>`; SSE passes it as `?token=` (EventSource limitation;
   accepted only on GET `/events` routes).
5. API verifies the JWT → finds or creates exactly one player for `(supabase, sub)` (re-checked inside a write
   transaction) → resolves the player's active save.
6. Guest upgrade: after a guest signs in, the browser calls `/api/auth/link-guest` with the guest token; the identity
   is attached to the guest player **only if** the account has no city yet, otherwise `409 ACCOUNT_EXISTS` and
   nothing is overwritten. The guest token is then revoked.

## Security properties
PKCE + state (SDK), local signature/issuer/audience/expiry checks, no client-supplied player ids (tested), HTTP-only
`SameSite=Lax` guest cookie (`Secure` in production), origin allow-list on writes (CSRF), rate limits on writes and
on guest creation, logout revokes guest sessions and signs out of Supabase, no secrets in the bundle (the anon key is
public by design and served at runtime). Session renewal: supabase-js refresh tokens; guest sessions expire after 14 days.

## What is verified
* Tested: JWT verification and player mapping using a locally generated ES256 key and JWKS (wrong issuer/audience/
  signature/expiry rejected; repeat logins reuse one player; guest upgrade; conflict protection; logout).
* **Not verified end-to-end:** a real Google or email sign-in, because no Supabase project credentials were provided.
  To enable: create a Supabase project, enable Email and Google providers (Google needs an OAuth client in Google
  Cloud with the Supabase callback URL), add your site URL to Supabase "Redirect URLs", then set `SUPABASE_URL`,
  `SUPABASE_ANON_KEY`, `AUTH_GOOGLE_ENABLED=true`.

## Sign-in that works everywhere
* **One tap Google.** "Continue with Google" opens Google's account picker (`prompt=select_account`) and returns to
  the same page. Google blocks sign-in inside embedded app browsers (Instagram, Facebook, LinkedIn, TikTok and
  similar), so the game detects them and offers the email code or a "Copy link" button for Safari/Chrome instead.
* **Email: link AND code.** One email contains both. The link works in the same browser (PKCE); the 6-digit code
  works anywhere (another device, an in-app browser, a phone that opens mail in a different app).
* **Guest cities move automatically.** After sign-in, the server links the guest city using the guest's own
  HTTP-only cookie, which survives the Google/email redirect. The page never needs to remember a token. An account
  that already has a city is never overwritten.
* **No dead ends.** If the server has no Supabase project, the sign-in buttons are simply not shown; players can
  still play and their city saves on this device.

## Turning it on (operator checklist)
1. Create a Supabase project. Copy the project URL and the anon (public) key into `SUPABASE_URL` and
   `SUPABASE_ANON_KEY`.
2. **Authentication → URL configuration:** set the Site URL to your production origin and add every origin you
   serve from (production, preview and `http://localhost:5173`) to Redirect URLs.
3. **Email provider:** enable it. In **Email Templates → Magic Link**, include the code so cross-device sign-in
   works, for example: `Your BLACKOUT code is {{ .Token }}` next to the `{{ .ConfirmationURL }}` link.
   For production volume, add your own SMTP sender (Supabase's default sender is rate-limited).
4. **Google provider:** in Google Cloud, create an OAuth client (Web), and add Supabase's callback URL
   (`https://<project>.supabase.co/auth/v1/callback`) as an authorized redirect URI. Paste the client id and
   secret into Supabase, then set `AUTH_GOOGLE_ENABLED=true` on the API.
5. Restart the API and check `GET /api/config/public` shows `google: true` and `email: true`.

