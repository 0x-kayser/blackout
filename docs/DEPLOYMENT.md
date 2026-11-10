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

The server should report that the economy is enabled on NEAR Testnet. Confirm that status and verify account balances before presenting the on-chain demo. No transaction hash is recorded here unless a real transaction has been observed and independently verified.

## Login providers

Guest access is enabled for the initial demo. Google sign-in requires a valid `GOOGLE_CLIENT_ID` and the Railway origin registered with that OAuth client. Email magic links require Supabase configuration (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) and matching redirect URLs. Do not claim either provider works until it has been exercised on the deployed domain.

## Verify a deployment

1. Open <https://blackout-production-c7fc.up.railway.app/api/health> and confirm HTTP 200.
2. Start a guest session and complete the tutorial.
3. Confirm Railway logs report NEAR Testnet mode and show no missing economy settings.
4. Open **Money** and verify the contract, wallet, and transaction evidence load.
5. Confirm a genuine test transaction in the NEAR Testnet explorer before claiming on-chain settlement.
6. Restart the service and verify the same player and city state persist from `/data`.

Railway healthchecks run at deployment time; they are not continuous health monitoring. Volumes prevent overlapping live deployments and can cause brief downtime during redeploys. See Railway's [healthcheck guide](https://docs.railway.com/deployments/healthchecks), [volume guide](https://docs.railway.com/volumes), and [region guide](https://docs.railway.com/deployments/regions).

## Local image check

```bash
docker build -t blackout .
```
