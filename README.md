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

## Repo layout

- `docs/` — data model, auth, and AI chat storage design
- `backend/` — FastAPI + SQLite backend
- `frontend/` — Vue 3 + Vite + Dexie PWA (local-first data layer)
