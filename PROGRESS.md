# Mini URL Shortener — Progress Log

Puzzle #145 (Task Forge series). Running log, short timestamped entries per phase.

## 2026-10-23 21:45 — Supabase project + schema
Created a new dedicated Supabase project `mini-url-shortener` (ref `yfvwfccaubmrqgqkabcf`, eu-west-1) via the `mcp__claude_ai_Supabase__*` MCP tools (create_project, confirmed $0/month cost on the free tier). Applied a real migration (`create_links_table`) rather than ad-hoc SQL, creating the `links` table (`id`, `short_code` unique, `original_url`, `created_at`, `last_clicked_at`, `click_count` default 0, `is_active` default true) plus two indexes and RLS policies scoped to this table only (anon: select/insert/update/delete all `true` — no auth gate per the brief, but scoped so the anon key grants nothing on any other table). Security advisor check came back clean (no lints).

## 2026-10-23 — gh auth blocker found early
`gh auth status` / `gh repo list` both return `401 Bad credentials` — the cached GitHub CLI token (and the separate cached Git Credential Manager PAT) are both revoked/stale this session. `gh auth login --web` needs an interactive browser step I can't complete non-interactively. Noting this now so it's not a surprise at push time; building everything locally first, will attempt push at the end and document the real outcome either way.

## 2026-10-23 22:05 — Worker + dashboard built
Built a single Cloudflare Worker (Hono router) at `src/index.ts` serving three things: the dashboard HTML/JS at `/`, a small JSON API (`GET/POST /api/links`, `PATCH /api/links/:id`, `DELETE /api/links/:id`), and the real redirect route at `/:code`. The redirect handler does a server-side Supabase read, a 404 page if no match, a 410 "disabled" page if `is_active` is false, otherwise updates `click_count`/`last_clicked_at` in the same request before issuing a real HTTP 302. Short codes are random base62 (6 chars), checked against the table for collisions before insert (retries up to 8 times).

## 2026-10-23 22:05 — XSS fix before shipping
First draft of the dashboard interpolated `original_url` and `short_code` straight into `innerHTML` without escaping. Since `original_url` is user-submitted and only loosely validated by `new URL()` (which does not block quote/angle-bracket characters in the path), that was a real reflected-XSS hole in an admin tool with no login. Added an `escapeHtml` helper on both the client JS and the server-side `statusPage` (the 404 page echoes the requested code back) and routed all interpolated values through it. Also stopped leaking raw Supabase/Postgres error text into the public-facing "lookup failed" page.

## 2026-10-23 22:15 — Deployed and typechecked
`npx tsc --noEmit` clean. `npx wrangler deploy --dry-run` then a real `wrangler deploy` succeeded: live at https://mini-url-shortener.krikormher.workers.dev. Set `SUPABASE_ANON_KEY` as a Worker secret via `wrangler secret put` (not committed anywhere).

## 2026-10-23 22:20 — Click tracking verified for real, end to end
Created a link via `curl POST /api/links` against the live Worker (`https://www.anthropic.com/claude-code` -> code `bd98Jd`). Queried Supabase directly (not through the Worker) and confirmed the row existed with `click_count: 0`. Hit `GET /bd98Jd` on the live Worker with curl -D- and got a real `HTTP/1.1 302` with `Location: https://www.anthropic.com/claude-code`. Queried Supabase again directly afterward: `click_count` was now `1` and `last_clicked_at` was set to the actual click timestamp. Then PATCHed `is_active: false` and re-hit the short URL: got `HTTP 410` (no redirect, no crash). Then DELETEd the row and re-hit the short URL: got `HTTP 404`, and `GET /api/links` confirmed the row was gone from the table.

## 2026-10-23 22:30 — GitHub push blocked, documented honestly
Local git repo initialized and committed (`2496c0e`). `gh repo create mini-url-shortener --public --source=. --push` failed with `HTTP 401: Bad credentials` -- same stale-token problem flagged earlier in this log, confirmed at push time rather than assumed. Did not fabricate a GitHub URL. To finish this step: run `gh auth login` interactively (browser device-code flow) from this machine, then re-run `gh repo create mini-url-shortener --public --source=. --push` from `C:\Users\h\mini-url-shortener`.
