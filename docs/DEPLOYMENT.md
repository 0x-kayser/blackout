# Deployment

**Status: not deployed.** No hosting, Supabase or NEAR credentials were available, so there is no public URL yet.
The container below was built and smoke-tested locally (see TEST_REPORT.md).

## Shape
One container: `apps/api` serves `/api/*` and the built web app (`dist/`) on the same origin. SQLite on a persistent
volume at `/data`. HTTPS from the host's proxy. NEAR testnet only.

```bash
docker build -t blackout .
```
```bash
docker run -p 8787:8787 -v blackout-data:/data -e WEB_ORIGINS=https://your.domain blackout
```

## Hosts
Any host that runs a Docker container with a persistent volume works (Render with a disk, Railway with a volume,
Fly.io with a volume). `render.yaml` is a ready Blueprint (persistent disks need a paid Render instance — check
current pricing). Single instance only: runs live in process memory and SQLite is local, so do not scale out.

The existing `.openai/hosting.json` static deployment can serve `dist/` only; it cannot run the API, so a static-only
deploy would show the welcome screen and then fail to reach the server.

## Production checklist
| Item | Setting |
|---|---|
| Public URL | `WEB_ORIGINS=https://<your-domain>` |
| HTTPS + proxy | `COOKIE_SECURE=true`, `TRUST_PROXY=true` (Dockerfile defaults) |
| Database | volume at `/data`; migrations run automatically at boot (`pnpm db:migrate` also available) |
| Health check | `GET /api/health` |
| Logs | JSON on stdout; credentials redacted; `x-request-id` per request |
| Auth (optional) | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `AUTH_GOOGLE_ENABLED=true`; add `https://<your-domain>` to Supabase Redirect URLs and the Google OAuth client |
| NEAR (optional) | `NEAR_CHAIN_ENABLED=true` + the `.env.chain` values as secrets; never mainnet |

## Exact external actions still required
1. Choose a host and create the service from this repo (Dockerfile) with a 1 GB volume at `/data`.
2. (Google/email) Create a Supabase project, enable providers, set the env vars above.
3. (NEAR) Run `pnpm chain:bootstrap` with a funded testnet account; store `.env.chain` values as secrets.
4. Open `https://<domain>/api/health`, then play the guest tutorial to verify.
