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

Deploy `frontend/dist/` behind the same domain as the backend so relative API
paths and the refresh cookie work as designed. HTTPS is required for the
service worker.

### 4. Tests

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
