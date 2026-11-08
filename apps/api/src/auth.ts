/**
 * Authentication and player identity.
 *
 *  - Guest: POST /api/session/start creates a guest player + an opaque 256-bit token
 *    (only sha256(token) is stored), sent as HTTP-only cookie or bearer.
 *  - Google / email: handled by Supabase Auth in the browser (PKCE). The browser sends the
 *    Supabase access token as `Authorization: Bearer <jwt>`. We verify it locally against the
 *    project's JWKS (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`) with issuer and audience
 *    checks, then map (provider="supabase", subject=sub) to exactly one player.
 *    We never store passwords; email sign-in is Supabase magic link / OTP.
 *  - The frontend never supplies a player id; it is always derived from a verified credential.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { nowIso, tx, type Db } from "./db.ts";

export const SESSION_COOKIE = "bo_session";
const SESSION_DAYS = 14;

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export interface AuthedUser {
  /** Internal player id (also the run owner id). */
  userId: string;
  sessionId: string;
  provider: "guest" | "supabase";
  kind: "guest" | "registered";
  loginMethod: string;
}

export interface SupabaseConfig {
  enabled: boolean;
  url: string | null;
  /** Publishable/anon key: public by design, served to the browser via /api/config/public. */
  anonKey: string | null;
  issuer: string | null;
  audience: string;
  providers: { google: boolean; email: boolean };
}

export function loadSupabaseConfig(env: NodeJS.ProcessEnv = process.env): SupabaseConfig {
  const url = env.SUPABASE_URL?.trim().replace(/\/$/, "") || null;
  const anonKey = env.SUPABASE_ANON_KEY?.trim() || null;
  const enabled = !!(url && anonKey);
  return {
    enabled,
    url,
    anonKey,
    issuer: url ? `${url}/auth/v1` : null,
    audience: env.SUPABASE_JWT_AUDIENCE?.trim() || "authenticated",
    // A provider is only advertised when the operator says it is configured in the Supabase dashboard.
    providers: { google: enabled && env.AUTH_GOOGLE_ENABLED === "true", email: enabled && env.AUTH_EMAIL_ENABLED !== "false" },
  };
}

export class AuthService {
  private jwks: JWTVerifyGetKey | null;

  constructor(
    private readonly db: Db,
    readonly supabase: SupabaseConfig,
    jwks?: JWTVerifyGetKey,
  ) {
    // jose caches keys and refetches on unknown `kid` (cooldown 30 s, max age 10 min), matching Supabase guidance.
    this.jwks = jwks ?? (supabase.enabled ? createRemoteJWKSet(new URL(`${supabase.issuer}/.well-known/jwks.json`), { cacheMaxAge: 600_000 }) : null);
  }

  // ------------------------------------------------------------ players

  private createPlayer(kind: "guest" | "registered", displayName: string, playerId = `player_${randomUUID()}`): string {
    const now = nowIso();
    this.db.prepare("INSERT INTO players (player_id, display_name, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(playerId, displayName, kind, now, now);
    return playerId;
  }

  createGuestSession(): { token: string; sessionId: string; userId: string } {
    const userId = `guest_${randomUUID()}`;
    const sessionId = `sess_${randomUUID()}`;
    const token = randomBytes(32).toString("base64url");
    const now = nowIso();
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
    tx(this.db, () => {
      this.db.prepare("INSERT INTO users (user_id, kind, created_at) VALUES (?, 'guest', ?)").run(userId, now);
      this.createPlayer("guest", "Guest operator", userId);
      this.db.prepare("INSERT INTO auth_identities (provider, subject, player_id, login_method, created_at, last_login_at) VALUES ('guest', ?, ?, 'guest', ?, ?)").run(userId, userId, now, now);
      this.db.prepare("INSERT INTO sessions (session_id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(sessionId, userId, hash(token), now, expires);
    });
    return { token, sessionId, userId };
  }

  revokeGuestSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash(token));
  }

  /** Finds or creates the player for a verified provider identity. Never duplicates on repeat logins. */
  resolveIdentity(provider: "supabase", subject: string, loginMethod: string, displayName: string): string {
    const row = this.db.prepare("SELECT player_id FROM auth_identities WHERE provider = ? AND subject = ?").get(provider, subject) as { player_id: string } | undefined;
    const now = nowIso();
    if (row) {
      this.db.prepare("UPDATE auth_identities SET last_login_at = ?, login_method = ? WHERE provider = ? AND subject = ?").run(now, loginMethod, provider, subject);
      return row.player_id;
    }
    return tx(this.db, () => {
      // re-check inside the write transaction (two concurrent first logins)
      const again = this.db.prepare("SELECT player_id FROM auth_identities WHERE provider = ? AND subject = ?").get(provider, subject) as { player_id: string } | undefined;
      if (again) return again.player_id;
      const pid = this.createPlayer("registered", displayName);
      this.db.prepare("INSERT INTO auth_identities (provider, subject, player_id, login_method, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)").run(provider, subject, pid, loginMethod, now, now);
      return pid;
    });
  }

  /**
   * Attaches a verified provider identity to the current guest player (guest upgrade).
   * Refuses if that identity already owns a player, so existing progress is never overwritten.
   */
  linkGuest(guest: AuthedUser, provider: "supabase", subject: string, loginMethod: string, displayName: string): { ok: true; playerId: string } | { ok: false; existingPlayerId: string } {
    if (guest.kind !== "guest") throw new Error("only guest players can be upgraded");
    return tx(this.db, () => {
      const existing = this.db.prepare("SELECT player_id FROM auth_identities WHERE provider = ? AND subject = ?").get(provider, subject) as { player_id: string } | undefined;
      if (existing) return { ok: false as const, existingPlayerId: existing.player_id };
      const now = nowIso();
      this.db.prepare("INSERT INTO auth_identities (provider, subject, player_id, login_method, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)").run(provider, subject, guest.userId, loginMethod, now, now);
      this.db.prepare("UPDATE players SET kind = 'registered', display_name = ?, updated_at = ? WHERE player_id = ?").run(displayName, now, guest.userId);
      return { ok: true as const, playerId: guest.userId };
    });
  }

  // ------------------------------------------------------------ verification

  async verifySupabaseToken(jwt: string): Promise<{ sub: string; loginMethod: string; displayName: string; payload: JWTPayload }> {
    if (!this.jwks || !this.supabase.issuer) throw new Error("AUTH_PROVIDER_UNAVAILABLE");
    const { payload } = await jwtVerify(jwt, this.jwks, {
      issuer: this.supabase.issuer,
      audience: this.supabase.audience,
      algorithms: ["ES256", "RS256", "EdDSA"],
      clockTolerance: 5,
    });
    if (!payload.sub) throw new Error("token has no subject");
    if ((payload as { role?: string }).role && (payload as { role?: string }).role !== "authenticated") throw new Error("not an authenticated user token");
    const appMeta = (payload as { app_metadata?: { provider?: string } }).app_metadata;
    const userMeta = (payload as { user_metadata?: { full_name?: string; name?: string } }).user_metadata;
    const loginMethod = appMeta?.provider ?? "unknown";
    // Display name only; we never store the email address itself.
    const displayName = (userMeta?.full_name || userMeta?.name || "Operator").slice(0, 40);
    return { sub: payload.sub, loginMethod, displayName, payload };
  }

  private bearerOrCookie(req: FastifyRequest): string | null {
    const h = req.headers.authorization;
    if (h && h.startsWith("Bearer ")) return h.slice(7).trim();
    const cookie = req.headers.cookie;
    if (cookie) {
      for (const part of cookie.split(";")) {
        const [k, ...v] = part.trim().split("=");
        if (k === SESSION_COOKIE) return decodeURIComponent(v.join("="));
      }
    }
    // EventSource cannot set headers; allow ?token= on GET SSE routes only
    const q = (req.query as Record<string, string> | undefined)?.token;
    if (q && req.method === "GET" && req.url.includes("/events")) return q;
    return null;
  }

  guestFromToken(t: string): AuthedUser | null {
    const row = this.db
      .prepare("SELECT s.session_id, s.user_id, s.expires_at, p.kind FROM sessions s JOIN players p ON p.player_id = s.user_id WHERE s.token_hash = ?")
      .get(hash(t)) as { session_id: string; user_id: string; expires_at: string; kind: "guest" | "registered" } | undefined;
    if (!row || row.expires_at < nowIso()) return null;
    return { userId: row.user_id, sessionId: row.session_id, provider: "guest", kind: row.kind, loginMethod: "guest" };
  }

  /** Resolves the caller from a guest token or a Supabase JWT. Returns null if neither verifies. */
  async authenticate(req: FastifyRequest): Promise<AuthedUser | null> {
    const t = this.bearerOrCookie(req);
    if (!t || t.length > 4096) return null;
    if (t.split(".").length === 3) {
      if (!this.supabase.enabled) return null;
      try {
        const v = await this.verifySupabaseToken(t);
        const pid = this.resolveIdentity("supabase", v.sub, v.loginMethod, v.displayName);
        return { userId: pid, sessionId: `jwt:${hash(t).slice(0, 16)}`, provider: "supabase", kind: "registered", loginMethod: v.loginMethod };
      } catch {
        return null;
      }
    }
    return this.guestFromToken(t);
  }

  player(playerId: string) {
    return this.db.prepare("SELECT * FROM players WHERE player_id = ?").get(playerId) as
      | { player_id: string; display_name: string; kind: string; active_run_id: string | null; near_account_mode: string; near_account_id: string | null; near_provisioning_state: string; created_at: string; updated_at: string }
      | undefined;
  }

  identities(playerId: string) {
    return this.db.prepare("SELECT provider, login_method, created_at, last_login_at FROM auth_identities WHERE player_id = ?").all(playerId) as {
      provider: string;
      login_method: string | null;
      created_at: string;
      last_login_at: string;
    }[];
  }

  setActiveRun(playerId: string, runId: string): void {
    this.db.prepare("UPDATE players SET active_run_id = ?, updated_at = ? WHERE player_id = ?").run(runId, nowIso(), playerId);
  }

  setDisplayName(playerId: string, name: string): void {
    this.db.prepare("UPDATE players SET display_name = ?, updated_at = ? WHERE player_id = ?").run(name, nowIso(), playerId);
  }
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.header(
    "set-cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86_400}${secure ? "; Secure" : ""}`,
  );
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.header("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`);
}
