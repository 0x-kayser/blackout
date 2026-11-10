# Deployment

## Current status

The Docker image is ready for a single-service Railway deployment. No Railway service or public URL has been created yet: the authenticated Railway workspace rejected project creation because its Free plan resource limit has been reached. The Testnet economy configuration exists locally in the ignored `.env.economy` file; it must be added to Railway as runtime secrets and must never be committed or copied into the image.

## Runtime shape

The root `Dockerfile` builds the web client and runs the API, which serves both the game and `/api/*` from one origin. SQLite is stored at `/data/blackout.sqlite`. Use one service replica because the game also keeps live simulation state in process memory.

Railway's default Dockerfile detection uses this root `Dockerfile`. The application listens on Railway's injected `PORT` and binds to `0.0.0.0`.

## Railway setup

After the Railway workspace can provision another project:

```bash
railway init --name blackout
railway add --service blackout
railway volume add --service blackout --mount-path /data
```

Attach the volume before sharing the URL. Railway volumes are mounted as root while this Docker image uses an unprivileged user, so set `RAILWAY_RUN_UID=0` to allow SQLite write access. Keep a single replica and use Railway's preferred region near the players. Railway documents the current volume behavior and location settings in its [volume guide](https://docs.railway.com/volumes) and [region guide](https://docs.railway.com/deployments/regions).

Set these service variables:

| Variable | Value |
|---|---|
| `HOST` | `0.0.0.0` |
| `DATABASE_PATH` | `/data/blackout.sqlite` |
| `COOKIE_SECURE` | `true` |
| `TRUST_PROXY` | `true` |
| `ALLOW_GUEST_PLAY` | `true` |
| `RAILWAY_RUN_UID` | `0` |
| `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` | `300` |
| `WEB_ORIGINS` | `https://<generated-railway-domain>` |

Do not set a fixed `PORT`; Railway injects it. Generate the Railway domain, set `WEB_ORIGINS` to its HTTPS origin, configure `/api/health` as the service healthcheck, then deploy:

```bash
railway domain --service blackout --port 8787
railway up --service blackout
```

Add the Testnet settings from the local `.env.economy` file through Railway's secret-variable interface or the CLI's stdin mode. Never put key values in shell arguments, source control, build arguments, or logs. The application is configured for NEAR Testnet; do not add mainnet keys.

```bash
printf '%s' "$VALUE" | railway variable set VARIABLE_NAME --stdin --service blackout --skip-deploys
```

After setting the variables, redeploy and confirm the startup logs report `economy: NEAR testnet (...)`. The image excludes `.env*` files by `.dockerignore`.

## Login providers

Guest play can be enabled without external auth setup. Google sign-in needs `GOOGLE_CLIENT_ID` and the generated Railway origin added to that OAuth client's allowed JavaScript origins. Email magic links require a configured Supabase project (`SUPABASE_URL` and `SUPABASE_ANON_KEY`) and provider redirect URLs. Do not enable local on-screen email codes in production.

## Verify the service

1. Open `https://<generated-railway-domain>/api/health` and confirm HTTP 200.
2. Start a guest session and complete the tutorial.
3. Confirm the server logs report Testnet mode and no missing economy settings.
4. Open **Money** and verify that the contract, wallet, and final transaction evidence load.
5. Restart the service and confirm the same player and game state persist from `/data`.

Railway healthchecks run at deployment time; the platform does not continuously monitor that endpoint. Volumes prevent overlapping live deployments and cause brief downtime during redeploys. See the official [healthcheck guide](https://docs.railway.com/deployments/healthchecks).

## Local build

```bash
docker build -t blackout .
```

## Current blockers

- Railway Free plan resource limit currently prevents creating a new project in the authenticated workspace.
- The supplied GitHub repository is not visible to the currently authenticated GitHub account, so a push or GitHub auto-deploy connection cannot be completed from this workspace yet.
- Google OAuth and Supabase production login still require their provider settings. Guest access can be used for the initial demo.
