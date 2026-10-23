import { Hono } from "hono";
import { createClient } from "@supabase/supabase-js";

type Env = {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
};

type Link = {
  id: string;
  short_code: string;
  original_url: string;
  created_at: string;
  last_clicked_at: string | null;
  click_count: number;
  is_active: boolean;
};

const app = new Hono<{ Bindings: Env }>();

function supa(env: Env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomCode(len = 6): string {
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (let i = 0; i < len; i++) out += BASE62[bytes[i] % BASE62.length];
  return out;
}

async function generateUniqueCode(env: Env): Promise<string> {
  const client = supa(env);
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode(6);
    const { data, error } = await client
      .from("links")
      .select("id")
      .eq("short_code", code)
      .maybeSingle();
    if (error) throw error;
    if (!data) return code;
  }
  throw new Error("could not generate a unique short code after 8 attempts");
}

function isValidUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------- API ----------

app.get("/api/links", async (c) => {
  const client = supa(c.env);
  const { data, error } = await client
    .from("links")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ links: data as Link[] });
});

app.post("/api/links", async (c) => {
  const body = await c.req
    .json<{ original_url?: string }>()
    .catch(() => ({ original_url: undefined }));
  const original_url = (body.original_url || "").trim();
  if (!isValidUrl(original_url)) {
    return c.json({ error: "original_url must be a valid http(s) URL" }, 400);
  }
  const client = supa(c.env);
  let short_code: string;
  try {
    short_code = await generateUniqueCode(c.env);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
  const { data, error } = await client
    .from("links")
    .insert({ short_code, original_url })
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ link: data as Link }, 201);
});

app.patch("/api/links/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req
    .json<{ is_active?: boolean }>()
    .catch(() => ({ is_active: undefined }));
  if (typeof body.is_active !== "boolean") {
    return c.json({ error: "is_active (boolean) required" }, 400);
  }
  const client = supa(c.env);
  const { data, error } = await client
    .from("links")
    .update({ is_active: body.is_active })
    .eq("id", id)
    .select()
    .single();
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ link: data as Link });
});

app.delete("/api/links/:id", async (c) => {
  const id = c.req.param("id");
  const client = supa(c.env);
  const { error } = await client.from("links").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

// ---------- Dashboard ----------

app.get("/", (c) => c.html(DASHBOARD_HTML));

// ---------- Redirect route (real server-side, runs for ANY visitor) ----------

app.get("/:code", async (c) => {
  const code = c.req.param("code");
  // Reserve the api/dashboard namespace; anything else is treated as a short code.
  if (code === "favicon.ico") return c.notFound();

  const client = supa(c.env);
  const { data: link, error } = await client
    .from("links")
    .select("*")
    .eq("short_code", code)
    .maybeSingle<Link>();

  if (error) return c.html(statusPage("Lookup failed", "Something went wrong looking up this link."), 500);
  if (!link) return c.html(statusPage("Link not found", `No short link matches "/${escapeHtmlServer(code)}".`), 404);
  if (!link.is_active) {
    return c.html(
      statusPage("Link disabled", "This short link has been deactivated by its owner."),
      410
    );
  }

  // Update click_count + last_clicked_at BEFORE redirecting the visitor.
  const { error: updateError } = await client
    .from("links")
    .update({
      click_count: link.click_count + 1,
      last_clicked_at: new Date().toISOString(),
    })
    .eq("id", link.id);

  if (updateError) {
    // Don't block the redirect on a tracking failure, but don't pretend it worked either.
    console.error("click tracking update failed:", updateError.message);
  }

  return c.redirect(link.original_url, 302);
});

function escapeHtmlServer(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function statusPage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;display:flex;
  align-items:center;justify-content:center;height:100vh;margin:0}
  .box{text-align:center;max-width:420px;padding:2rem}
  h1{font-size:1.4rem;margin-bottom:.5rem}
  p{color:#9aa0a6}
  a{color:#6ea8fe}</style></head>
  <body><div class="box"><h1>${title}</h1><p>${message}</p><p><a href="/">Back to dashboard</a></p></div></body></html>`;
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Mini URL Shortener</title>
<style>
  :root { color-scheme: dark light; }
  body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; background: #0f1115; color: #e6e6e6; }
  @media (prefers-color-scheme: light) { body { background: #f5f6f8; color: #1a1a1a; } }
  .wrap { max-width: 860px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  h1 { font-size: 1.5rem; margin-bottom: .25rem; }
  .sub { color: #9aa0a6; margin-top: 0; margin-bottom: 1.5rem; font-size: .9rem; }
  form { display: flex; gap: .5rem; margin-bottom: 2rem; }
  input[type=url] { flex: 1; padding: .6rem .75rem; border-radius: 8px; border: 1px solid #333; background: #1a1d23; color: inherit; font-size: .95rem; }
  @media (prefers-color-scheme: light) { input[type=url] { background: #fff; border-color: #ccc; } }
  button { padding: .6rem 1rem; border-radius: 8px; border: none; background: #4f7cff; color: #fff; font-weight: 600; cursor: pointer; font-size: .9rem; }
  button.secondary { background: #2a2d35; color: #e6e6e6; }
  button.danger { background: #b23a3a; color: #fff; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .msg { font-size: .85rem; margin: -.5rem 0 1.5rem; min-height: 1.2em; }
  .msg.error { color: #ff6b6b; }
  .msg.ok { color: #51cf66; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  th, td { text-align: left; padding: .55rem .5rem; border-bottom: 1px solid #262a33; vertical-align: top; }
  @media (prefers-color-scheme: light) { th, td { border-bottom: 1px solid #e0e0e0; } }
  th { color: #9aa0a6; font-weight: 600; font-size: .75rem; text-transform: uppercase; letter-spacing: .03em; }
  .url-cell { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .short { font-family: ui-monospace, Menlo, Consolas, monospace; }
  .badge { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: .7rem; font-weight: 600; }
  .badge.active { background: #16351f; color: #51cf66; }
  .badge.inactive { background: #3a1f1f; color: #ff6b6b; }
  .row-actions { display: flex; gap: .35rem; flex-wrap: wrap; }
  .row-actions button { padding: .3rem .55rem; font-size: .78rem; }
  .section-title { display: flex; align-items: center; justify-content: space-between; margin-top: 2.5rem; }
  .section-title h2 { font-size: 1.05rem; margin: 0; }
  .toplist { list-style: none; padding: 0; margin: .5rem 0 0; font-size: .85rem; }
  .toplist li { display: flex; justify-content: space-between; padding: .4rem 0; border-bottom: 1px solid #262a33; }
  .empty { color: #777; font-size: .85rem; padding: 1rem 0; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Mini URL Shortener</h1>
  <p class="sub">Puzzle #145 &mdash; open admin tool, no login. Paste a long URL to create a short link.</p>

  <form id="create-form">
    <input id="url-input" type="url" placeholder="https://example.com/some/very/long/path" required />
    <button type="submit">Shorten</button>
  </form>
  <p class="msg" id="create-msg"></p>

  <div class="section-title">
    <h2>All links</h2>
    <button class="secondary" id="refresh-btn" type="button">Refresh</button>
  </div>
  <div id="links-table"></div>

  <div class="section-title"><h2>Top clicked links</h2></div>
  <div id="top-list"></div>
</div>

<script>
const tableHost = document.getElementById('links-table');
const topHost = document.getElementById('top-list');
const createForm = document.getElementById('create-form');
const urlInput = document.getElementById('url-input');
const createMsg = document.getElementById('create-msg');

function fmt(dt) {
  if (!dt) return '&mdash;';
  const d = new Date(dt);
  return d.toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortUrlFor(code) {
  return window.location.origin + '/' + code;
}

async function loadLinks() {
  const res = await fetch('/api/links');
  const data = await res.json();
  if (!res.ok) { tableHost.innerHTML = '<p class="empty">Failed to load links.</p>'; return; }
  renderTable(data.links);
  renderTop(data.links);
}

function renderTable(links) {
  if (!links.length) { tableHost.innerHTML = '<p class="empty">No links yet. Create one above.</p>'; return; }
  const rows = links.map(l => {
    const code = escapeHtml(l.short_code);
    const url = escapeHtml(l.original_url);
    const shortUrl = escapeHtml(shortUrlFor(l.short_code));
    return \`
    <tr data-id="\${l.id}">
      <td class="short">
        <a href="/\${code}" target="_blank" rel="noopener">\${code}</a>
        <div><button class="secondary copy-btn" data-url="\${shortUrl}" type="button">Copy</button></div>
      </td>
      <td class="url-cell" title="\${url}">\${url}</td>
      <td>\${l.click_count}</td>
      <td>\${fmt(l.created_at)}</td>
      <td>\${fmt(l.last_clicked_at)}</td>
      <td><span class="badge \${l.is_active ? 'active' : 'inactive'}">\${l.is_active ? 'active' : 'disabled'}</span></td>
      <td class="row-actions">
        <button class="secondary toggle-btn" data-id="\${l.id}" data-active="\${l.is_active}" type="button">\${l.is_active ? 'Deactivate' : 'Activate'}</button>
        <button class="danger delete-btn" data-id="\${l.id}" type="button">Delete</button>
      </td>
    </tr>\`;
  }).join('');
  tableHost.innerHTML = \`<table>
    <thead><tr><th>Short code</th><th>Destination</th><th>Clicks</th><th>Created</th><th>Last clicked</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>\${rows}</tbody></table>\`;
}

function renderTop(links) {
  const top = [...links].filter(l => l.click_count > 0).sort((a, b) => b.click_count - a.click_count).slice(0, 5);
  if (!top.length) { topHost.innerHTML = '<p class="empty">No clicks recorded yet.</p>'; return; }
  topHost.innerHTML = '<ul class="toplist">' + top.map(l =>
    \`<li><span>\${escapeHtml(l.short_code)} &rarr; \${escapeHtml(l.original_url)}</span><strong>\${l.click_count}</strong></li>\`
  ).join('') + '</ul>';
}

createForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  createMsg.textContent = '';
  createMsg.className = 'msg';
  const original_url = urlInput.value.trim();
  const res = await fetch('/api/links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ original_url }),
  });
  const data = await res.json();
  if (!res.ok) {
    createMsg.textContent = data.error || 'Failed to create link.';
    createMsg.className = 'msg error';
    return;
  }
  createMsg.textContent = 'Created: ' + shortUrlFor(data.link.short_code);
  createMsg.className = 'msg ok';
  urlInput.value = '';
  loadLinks();
});

document.getElementById('refresh-btn').addEventListener('click', loadLinks);

tableHost.addEventListener('click', async (e) => {
  const target = e.target;
  if (target.classList.contains('copy-btn')) {
    const url = target.getAttribute('data-url');
    try {
      await navigator.clipboard.writeText(url);
      target.textContent = 'Copied!';
      setTimeout(() => (target.textContent = 'Copy'), 1200);
    } catch {
      target.textContent = 'Copy failed';
    }
  }
  if (target.classList.contains('toggle-btn')) {
    const id = target.getAttribute('data-id');
    const active = target.getAttribute('data-active') === 'true';
    await fetch('/api/links/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !active }),
    });
    loadLinks();
  }
  if (target.classList.contains('delete-btn')) {
    const id = target.getAttribute('data-id');
    if (!confirm('Permanently delete this short link?')) return;
    await fetch('/api/links/' + id, { method: 'DELETE' });
    loadLinks();
  }
});

loadLinks();
</script>
</body>
</html>`;

export default app;
