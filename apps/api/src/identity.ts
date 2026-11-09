/**
 * GameIdentity (§25): one shape for "who is playing", whatever signed them in. The game only ever asks this
 * abstraction; providers (guest cookie, Google or email via Supabase, local email codes, and later passkeys) plug
 * in behind AuthService. The chain account is derived, never shown in play.
 */
import type { AuthService, AuthedUser } from "./auth.ts";
import { playerChainId, type ChainConfig } from "./chain.ts";

export type IdentityProvider = "guest" | "google" | "email" | "passkey" | "unknown";

export interface GameIdentity {
  userId: string;
  displayName: string;
  kind: "guest" | "registered";
  providers: IdentityProvider[];
  /** The player's namespaced account under the game operator, when a chain is configured. */
  chainAccountId: string | null;
  /** Gasless: the relayer pays for anything this player signs. */
  gasless: boolean;
}

const asProvider = (m: string | null | undefined): IdentityProvider => (m === "google" ? "google" : m === "email" || m === "local_email" || m === "magiclink" ? "email" : m === "passkey" ? "passkey" : m === "guest" ? "guest" : "unknown");

export function gameIdentity(auth: AuthService, chain: ChainConfig, u: AuthedUser, relayEnabled: boolean): GameIdentity {
  const p = auth.player(u.userId);
  const providers = auth.identities(u.userId).map((i) => asProvider(i.login_method ?? i.provider));
  return {
    userId: u.userId,
    displayName: p?.display_name ?? "Operator",
    kind: u.kind,
    providers: providers.length ? [...new Set(providers)] : ["guest"],
    chainAccountId: chain.enabled && chain.vaultAccountId ? playerChainId(chain, u.userId) : null,
    gasless: relayEnabled,
  };
}
