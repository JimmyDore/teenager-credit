# Crédit ados — spec

Source of truth for the implementation. Decided with the product owner during a grilling session (2026-09-16). Code and identifiers in English; **all UI copy in French, vouvoiement** for families.

## Context

A youth group ("ados") earns fictitious credit through fundraising actions ("actions d'autofinancement"). Credit is later deducted from their families' invoices. One admin enters everything; each family can look up its own teens' credit, **never another family's**. ~20 teens, changes every 2–3 months. The app is the single source of truth (no Excel). One season at a time; next season = manual reset outside the app.

Title shown on pages: `APP_TITLE`, default **`Crédit ados 2026-2027`**.

## Domain

- **Family**: `name` (family name only). Has a **code**: 6 chars from alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L), generated with crypto randomness, unique. Input is normalized: uppercase, strip spaces and dashes. Admin can regenerate it (old code stops working immediately).
- **Teen**: `firstName` only, belongs to one family. No other personal data is stored (no phone, email…).
- **Action** (collective fundraising event): `label` (required), `date` (YYYY-MM-DD), `totalCents` (> 0), `participants: [{teenId, parts}]` (≥ 1 participant, parts > 0, max 2 decimals, default 1 in the UI). Split **Tricount-style**: `share = total × parts / Σparts`.
  - Rounding — **largest remainder**, all-integer math (scale parts ×100 to integers): `base_i = floor(total·p_i / P)`, `rem_i = total·p_i mod P`; leftover cents `total − Σbase` go one each to the participants with the largest `rem_i`; ties broken by first name (`localeCompare` with `'fr'`), then teen id. **Σshares always equals total exactly.** Example: 100 € with 5 teens × 2 parts and 5 teens × 1 part → 13,33 € ×5 and 6,67 € ×5 = 100,00 €.
  - Shares are computed on create/update and **stored** on each participant (`amountCents`), so later renames never shift cents.
  - An action is editable as a whole (label, date, total, participants, parts → shares recomputed) and deletable.
- **Movement** (individual): `teenId`, `kind: "credit" | "debit"` (UI: « + Ajouter » for bonus/report, « − Déduire » for invoice deduction), `label` (required), `date` (default today in UI), `amountCents` (> 0). Deletable, **not editable**.
- **Balance(teen)** = Σ action shares + Σ credit movements − Σ debit movements.
- **Invariant: no negative balance.** Any mutation (debit creation, action update/delete, credit movement delete) that would leave any teen's balance < 0 is rejected (HTTP 409) with a French message naming the affected teen(s).
- **Deletion rules**: a teen can be deleted only if it has no movement and is in no action. A family can be deleted only if all its teens are deletable (deleting it deletes its teens).
- Admin can rename a family and a teen.
- Validation: labels/names trimmed, non-empty, ≤ 100 chars; dates valid `YYYY-MM-DD`; amounts integer cents.

## Storage

Single JSON file `${DATA_DIR}/credits.json` (`DATA_DIR` default `./data`, `/data` in the container). Created empty on first start. Writes are **atomic** (write temp file in the same dir, fsync, rename) and **serialized** (in-process queue/mutex). Shape (indicative):

```json
{
  "version": 1,
  "families":  [{ "id": "…", "name": "Martin", "code": "K7MQ4X", "createdAt": "ISO" }],
  "teens":     [{ "id": "…", "familyId": "…", "firstName": "Léa", "createdAt": "ISO" }],
  "actions":   [{ "id": "…", "label": "…", "date": "2026-12-14", "totalCents": 10000,
                  "participants": [{ "teenId": "…", "parts": 2, "amountCents": 1333 }],
                  "createdAt": "ISO", "updatedAt": "ISO" }],
  "movements": [{ "id": "…", "teenId": "…", "kind": "debit", "label": "…", "date": "…",
                  "amountCents": 2500, "createdAt": "ISO" }]
}
```

No in-app backup copies — backups are nightly to Cloudflare R2 (see Deploy).

## Access

### Families
- `POST /api/family/session {code}` → 200 + sets httpOnly cookie `family_code` (SameSite=Lax, `Secure` when `NODE_ENV=production`, Max-Age 400 days). Unknown code → 401 `{error:"Code inconnu"}`.
- `GET /api/family` → reads the cookie; 401 if missing/unknown (so a regenerated code logs the family out).
- `POST /api/family/logout` → clears cookie.
- **Brute-force protection**: every failed code lookup (session POST *or* GET with a bad cookie) counts against the client IP (`trustProxy: true`, the app sits behind Caddy). More than 10 failures in 15 min → 429 `{error:"Trop d'essais, réessayez dans quelques minutes"}`. In-memory, no extra dependency.
- `GET /api/family` response — **only this family's data**, never action totals, other participants, or participant counts:

```json
{
  "title": "Crédit ados 2026-2027",
  "family": { "name": "Martin" },
  "teens": [{
    "firstName": "Léa",
    "balanceCents": 1833,
    "history": [
      { "date": "2026-12-14", "label": "Vente de gâteaux", "amountCents": 1333, "parts": 2 },
      { "date": "2026-11-02", "label": "Déduit facture", "amountCents": -2500, "parts": null }
    ]
  }],
  "totalCents": 1833,
  "updatedAt": "ISO — latest change affecting this family's teens, null if none"
}
```
History sorted by date desc, then createdAt desc.

### Admin
- Single password from env `ADMIN_PASSWORD` (required; server refuses to start without it outside tests).
- `POST /api/admin/login {password}` → constant-time compare; sets httpOnly cookie `admin_session` = `<expiresAtMs>.<HMAC-SHA256(ADMIN_PASSWORD, expiresAtMs)>`, Max-Age **90 days** (changing the password invalidates sessions — no extra secret). Same failure rate limit as families (separate counter). 401 `{error:"Mot de passe incorrect"}`.
- `POST /api/admin/logout`. Every other `/api/admin/*` route requires a valid session → 401.

### Admin API (JSON; errors `{error: "<French message>"}` with 400/404/409)
| Method | Path | Body / notes |
|---|---|---|
| GET | `/api/admin/state` | Everything: families (with code, teens, balances, family total, `shareMessage`), actions (with shares), movements. Small data, one call. |
| POST | `/api/admin/families` | `{name}` → family with generated code |
| PATCH | `/api/admin/families/:id` | `{name}` |
| POST | `/api/admin/families/:id/regenerate-code` | → new code |
| DELETE | `/api/admin/families/:id` | deletion rules above |
| POST | `/api/admin/families/:id/teens` | `{firstName}` |
| PATCH | `/api/admin/teens/:id` | `{firstName}` |
| DELETE | `/api/admin/teens/:id` | deletion rules above |
| POST | `/api/admin/actions` | `{label, date, totalCents, participants:[{teenId, parts}]}` |
| PUT | `/api/admin/actions/:id` | same body, recomputes shares |
| DELETE | `/api/admin/actions/:id` | |
| POST | `/api/admin/movements` | `{teenId, kind, label, date, amountCents}` |
| DELETE | `/api/admin/movements/:id` | |
| GET | `/api/admin/export.csv` | UTF-8 with BOM, `;` separator, French decimals (`13,33`). One row per history line: `Date;Famille;Ado;Type;Libellé;Parts;Montant`. Type ∈ `Action`, `Ajout`, `Déduction`. Montant signed. |

`shareMessage` (for the « Copier le message » button): `Bonjour, retrouvez les crédits ados de la famille {name} sur {PUBLIC_URL} avec le code : {code}` (`PUBLIC_URL` default `https://credit-ado.jimmydore.fr`).

### Other
- `GET /api/config` → `{title}` (public).
- `GET /health` → `{ok:true}`.
- Static files from `public/`; HTML with `cache-control: no-cache`, other assets `maxAge 1d` (same as chifoumi — avoids stale front after deploy).

## UI (vanilla HTML/CSS/JS, mobile-first, French)

- **`/` (families)**: if no valid cookie → code form (« Votre code famille »). Otherwise: title, family name, one card per teen (first name, balance big, history list: date `dd/mm/yyyy`, label, signed amount, « 2 parts » when applicable), « Total famille » when > 1 teen, « Mis à jour le … », link « Changer de code » (logout). Amounts formatted `Intl.NumberFormat('fr-FR', {style:'currency', currency:'EUR'})`.
- **`/admin`**: login form, then sections:
  - **Familles**: list with teens + balances; create family; add/rename/delete teen; rename/delete family; « Copier le message »; « Nouveau code ».
  - **Nouvelle action**: label, date, total (€ with comma or dot), list of all teens (grouped by family) each with a checkbox + parts input (default 1, decimals allowed); **live preview of each share** using the same split rule; save. Actions list with edit (same form prefilled) and delete.
  - **Fiche ado**: balance, history, « + Ajouter » / « − Déduire » forms, delete a movement.
  - **Export CSV** link; « Se déconnecter ».
  - Confirmations via in-page dialog (`<dialog>`), never `window.confirm/alert`. Server error messages shown inline.

## Deploy (same pattern as ~/Projets/chifoumi)

- Node 22 + Fastify 5, `node --test`. Docker image built on the server from `deploy/Dockerfile`; runs as `node` user (uid 1000).
- `docker-compose.yml`: service/container **`credit-ado-web`** (never `web`/`api`), `restart: unless-stopped`, no published ports, external network `ravetycoon_default`, bind mount `/root/credit-ado-data:/data`, env from a gitignored `.env` written by CI (`ADMIN_PASSWORD`), plus `NODE_ENV=production`, `DATA_DIR=/data`, `PORT=8787`.
- Routing/TLS: block `credit-ado.jimmydore.fr { reverse_proxy credit-ado-web:8787 }` in the **RaveTycoon** repo's `deploy/Caddyfile` (done separately, not in this repo).
- GitHub Actions `.github/workflows/deploy.yml` on push to `main` + `workflow_dispatch`: `test` → `deploy` (SSH root@77.42.23.215, repo dir `/root/credit-ado`, data dir `/root/credit-ado-data` owned by 1000:1000) → `health` (poll `https://credit-ado.jimmydore.fr/health`).
- **Backups**: host cron `/etc/cron.d/credit-ado-backup` at 02:00 runs `deploy/backup.sh`, which runs `rclone/rclone` via `docker run` (nothing installed on the host) to copy `/root/credit-ado-data` to `r2:hetzner-backups/credit-ado/<YYYYMMDD_HHMMSS>/`, then prunes objects older than 365 days under that prefix only. rclone configured via `RCLONE_CONFIG_R2_*` env vars (provider Cloudflare, `no_check_bucket = true` since the token is bucket-scoped). No encryption. Slack message **only on failure**. Installed by CI only when R2 secrets are present (removed otherwise).
- GitHub secrets: `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `ADMIN_PASSWORD`, `SLACK_WEBHOOK_URL`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.
