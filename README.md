> Personal AI slop, but i hope it can be useful.

A mobile-first, offline-first bookkeeping PWA for a clothing processing factory.

## Vision

Factory bookkeeping is repetitive and easy to get wrong. This project makes daily work order entry, editing, querying, and end-of-period reporting quick and reliable — even in a warehouse with no signal.

- **Local-first**: every action lands on the device instantly; the app stays fully usable offline.
- **Sync when possible**: the backend keeps the authoritative copy and reconciles work across devices.
- **AI where it helps**: an AI assistant drafts changes through controlled business operations — never raw SQL.

## Stack

- **Frontend**: Vue 3 + Vite + Vant 4, deployed as a PWA (Dexie/IndexedDB for local data)
- **Backend**: Python + FastAPI + SQLite (repositories, dependency injection, admin CLI)
- **AI**: Pydantic AI

## Running locally

Prerequisites: Node (project uses nvm v24) and Python 3.12 with `uv`. The backend already has a local `.venv`; use it directly.

### 1. Backend (FastAPI, port 8000)

```bash
cd backend

# optional: create a local dev account (first run only)
.venv/bin/python -m backend.scripts.manage add-account 13800000000 --password cb123456

# start the API server
PYTHONPATH=src .venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Local dev account (if created as above): `13800000000` / `cb123456` (development only).

### 2. Frontend (Vite, port 5173)

```bash
cd frontend
npm install        # first run only
npm run dev
```

The dev server proxies `/auth`, `/sync`, and `/chat` to `http://127.0.0.1:8000`
(override with `CB_API_TARGET`). Open `http://localhost:5173` and log in.

### 3. Production build

```bash
cd frontend
npm run build      # vue-tsc -b + vite build; emits dist/ with PWA files
```

## Deployment

### 1. Build and serve

```bash
cd frontend
npm install
npm run build      # emits dist/ (index.html, assets, sw.js, manifest)
```

Serve `frontend/dist/` as static files and run the backend with the same
stack, e.g.:

```bash
cd backend
PYTHONPATH=src .venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

### 2. Backend configuration

```bash
cd backend
cp config.example.toml config.toml   # edit as needed; config.toml is git-ignored
```

- `[database] path` — SQLite file location; `busy_timeout_ms` for write-lock queueing.
- `CB_JWT_SECRET` environment variable is required at startup (or set
  `[auth] jwt_secret` in `config.toml`, but never commit a real secret).
- `[auth] secure_cookie` must be `true` in production (HTTPS).
- `[model]` is only needed when the AI chat feature is enabled.

### 3. Same-origin reverse proxy (required)

The frontend calls `/auth`, `/sync`, and `/chat` with relative paths, and the
refresh token is an HttpOnly cookie. Serve the SPA and the API from the same
origin, proxying those three prefixes to the backend:

```nginx
server {
    listen 443 ssl;
    server_name app.example.com;
    # ssl_certificate / ssl_certificate_key ...

    root /var/www/cb/frontend/dist;
    location / {
        try_files $uri $uri/ /index.html;
    }

    location /auth/ { proxy_pass http://127.0.0.1:8000; }
    location /sync/ { proxy_pass http://127.0.0.1:8000; }
    location /chat/ { proxy_pass http://127.0.0.1:8000; }
}
```

### 4. HTTPS and PWA

HTTPS is mandatory: the service worker only registers in a secure context.
The PWA uses auto-update (`registerSW({ immediate: true })`), so users get the
new version after the next reload.

### 5. Database

The default path is `backend/data/app.db` (WAL mode). Back up the file plus
`-wal`/`-shm` consistently, e.g. with `sqlite3 app.db ".backup app-backup.db"`,
or back up the whole `backend/data/` directory while the server is stopped.

### 6. Create the first account

The backend has an admin CLI that talks to SQLite directly (no HTTP auth):

```bash
cd backend
.venv/bin/python -m backend.scripts.manage add-account 13800000000 --password 'a-strong-password'
```

Useful commands: `list-accounts`, `list-devices <phone>`,
`revoke-device <phone> <device_id>`, `set-password`, `set-account-status`.
See `docs/manage-cli.md` for the full manual.

### 7. Post-deploy smoke test

1. Open the site over HTTPS and log in with the account created above.
2. Record one work order on the desk page.
3. Check the ledger: the order shows 已同步 (synced) after push + pull.

## Deployment caveats

- Same-origin proxy is not optional: cookies and relative API paths break otherwise.
- HTTPS is required for PWA installation and sync.
- Production build must be `npm run build`; `npx vue-tsc --noEmit` alone is a
  false signal (see `frontend/README` note in AGENTS.md).
- Never put `CB_JWT_SECRET` or `[model] api_key` into tracked files; use
  environment variables or git-ignored `config.toml`.
- Order dates use the device's local date; keep device clocks/time zones sane.
- Deploy frontend and backend from matching versions — the sync protocol,
  error codes, and field names evolve together.

## Tests

```bash
cd backend && .venv/bin/python -m pytest -m "not live"   # backend tests
cd frontend && npm run test                               # frontend tests (vitest)
cd frontend && npx vue-tsc -b                             # type check
```

## Repo layout

- `docs/` — data model, auth, and AI chat storage design
- `backend/` — FastAPI + SQLite backend
- `frontend/` — Vue 3 + Vite + Dexie PWA (local-first data layer)
- `frontend/prototype/` — archived UI prototype (mock data, not part of the build)

## Git conventions

Commit messages follow the Conventional Commits style, in English:

```
<type>(<scope>): <summary>
```

- `type`: `feat` / `fix` / `docs` / `chore` / `test` / `refactor`
- `scope` (optional): the affected module, e.g. `frontend`, `auth`, `ai`, `cli`
- `summary`: short English phrase capturing the core change, no trailing period

Examples:

```
feat(frontend): PWA frontend database foundation
fix(auth): rate limiter singleton, persistent refresh cookie, config defaults
docs(ai): add AI chat storage design for sessions and turns
```
