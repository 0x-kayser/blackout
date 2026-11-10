# Deployment

## Railway service

BLACKOUT is configured in Railway project `miraculous-appreciation`, production environment, as the `blackout` service. Its GitHub source is `0x-kayser/blackout` on `main`.

- Public URL: <https://blackout-production-c7fc.up.railway.app>
- Region: `sfo`
- Replicas: one (the live simulation keeps in-process state)
- Persistent volume: `blackout-blackout-data`, mounted at `/data` (500 MB)
- Healthcheck: `/api/health`

The Railway service was initially failing its healthcheck because a mounted volume hides the image's original directory ownership. The container entrypoint now changes ownership of the mounted `/data` directory to the `blackout` user, then runs the API as UID 10001. A local container smoke check with a root-owned volume returned HTTP 200 and wrote SQLite files as `blackout`.

## Runtime and persistence

The root `Dockerfile` builds the web client and runs the API, which serves both the game and `/api/*` from one origin. SQLite lives at `/data/blackout.sqlite`; the Railway volume preserves it across deployments. Railway injects `PORT`; the server binds to `0.0.0.0`.

The image excludes `.env*` files. The entrypoint only adjusts the mounted data directory before dropping to the unprivileged app account.

## Railway environment

The production service has these runtime settings:

| Variable | Value |
|---|---|
| `HOST` | `0.0.0.0` |
| `DATABASE_PATH` | `/data/blackout.sqlite` |
| `COOKIE_SECURE` | `true` |
| `TRUST_PROXY` | `true` |
| `ALLOW_GUEST_PLAY` | `true` |
| `WEB_ORIGINS` | `https://blackout-production-c7fc.up.railway.app` |

The Testnet economy variables are stored as Railway runtime variables from the ignored local `.env.economy` file. Their values must never be committed, copied into the Docker image, or printed in logs. Do not add mainnet keys.

The separate power-economy module and the legacy resource-market adapter are different integrations. Check the actual
runtime state before describing a gameplay flow as on-chain. The public game UI does not expose chain status or
transaction hashes. For judge/operator review, set `ECONOMY_ADMIN_TOKEN` as a Railway secret and send it only from a
trusted operator environment as the `x-admin-token` header to `GET /api/admin/chain-audit`. The endpoint returns
recorded operations and real hashes where present; it reports disabled mode and empty evidence honestly.

A public Railway check on 2026-11-10 found the separate NEP-245 resource adapter disabled. Its legacy
`NEAR_CHAIN_ENABLED`, resource-contract, vault, and merchant-signer settings were not configured in that deployment.
The NEAR power-economy module is separate; do not treat it as evidence that resource-market transfers are live.

## Login providers

Guest access is enabled for the initial demo. Google uses the direct Google Identity Services flow: Railway receives `GOOGLE_CLIENT_ID`, the browser returns a Google ID token, and the server verifies its signature and audience. This flow does not require a Google client secret or Supabase. In Google Cloud, register `https://blackout-production-c7fc.up.railway.app` under **Authorized JavaScript origins**; the app posts the credential to its same-origin API.

Email magic links are not configured. They require Supabase settings (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) and matching redirect URLs. Verify the deployed public config and complete a real Google sign-in before claiming provider login works.

## Verify a deployment

1. Open <https://blackout-production-c7fc.up.railway.app/api/health> and confirm HTTP 200.
2. Start a guest session and complete the tutorial.
3. Sign in or start as a guest and complete the tutorial; confirm the Career and Weekly challenge cards appear after onboarding.
4. From a trusted operator environment, query `/api/admin/chain-audit` with `x-admin-token`; verify the reported mode before presenting any transaction as live evidence.
5. Confirm a genuine transaction independently in the NEAR Testnet explorer before claiming on-chain settlement.
6. Restart the service and verify the same player and city state persist from `/data`.

Railway healthchecks run at deployment time; they are not continuous health monitoring. Volumes prevent overlapping live deployments and can cause brief downtime during redeploys. See Railway's [healthcheck guide](https://docs.railway.com/deployments/healthchecks), [volume guide](https://docs.railway.com/volumes), and [region guide](https://docs.railway.com/deployments/regions).

## Local image check

```bash
docker build -t blackout .
```
