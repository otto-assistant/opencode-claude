/**
 * Control panel — one self-contained HTML page served at the proxy root.
 *
 * Shows every configured Claude account (label, resolved login, remaining
 * quota per window, rate-limit state, usage counters, bound conversations)
 * and offers the account mutations the JSON API exposes: add, rename, set
 * default, remove, refresh quota, move a session to another account.
 *
 * Design constraints, all deliberate:
 * - No external assets: inline CSS + JS only, so the page works on an
 *   air-gapped host and cannot leak anything to a CDN.
 * - The page only calls RELATIVE urls ("accounts", "sessions/..."), which
 *   makes it transparent to reverse-proxy prefixes: the <base> tag is set
 *   from X-Forwarded-Prefix when present.
 * - Mutations go through the same JSON routes the tools use; those routes
 *   enforce the same-origin check server-side (see isLocalOrigin).
 * - Connecting an account is CLI-owned: the panel shows the
 *   `CLAUDE_CONFIG_DIR=<dir> claude auth login` command instead of running
 *   any OAuth flow of its own. (PR #11's loopback OAuth callback is gone by
 *   design — post-#12 the plugin never performs OAuth.)
 *
 * Env:
 * - OPENCODE_CLAUDE_PANEL=0 disables the HTML page (JSON API stays).
 * - OPENCODE_CLAUDE_PANEL_HOST=0.0.0.0 binds the whole proxy beyond
 *   loopback — only do that behind a reverse proxy you trust.
 */

export function panelEnabled(): boolean {
  const flag = (process.env.OPENCODE_CLAUDE_PANEL ?? "").trim().toLowerCase();
  return !(flag === "0" || flag === "false" || flag === "off");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Sanitized base path from X-Forwarded-Prefix (must look like a path). */
export function basePathFromPrefix(prefix: string | null): string {
  const raw = (prefix ?? "").split(",")[0]?.trim() ?? "";
  if (!raw || !raw.startsWith("/") || /[<>"'\s\\]/.test(raw)) return "/";
  return raw.endsWith("/") ? raw : `${raw}/`;
}

export function renderPanelHtml(forwardedPrefix: string | null): string {
  const base = escapeHtml(basePathFromPrefix(forwardedPrefix));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<base href="${base}">
<title>opencode-claude · accounts</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.45 system-ui, sans-serif; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; }
  h1 { font-size: 1.25rem; }
  h1 small { font-weight: normal; opacity: .6; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid rgba(127,127,127,.25); vertical-align: top; }
  th { font-weight: 600; opacity: .75; }
  code { font-size: .85em; background: rgba(127,127,127,.12); padding: .1em .35em; border-radius: 4px; }
  .muted { opacity: .55; }
  .warn { color: #b45309; }
  .bad { color: #dc2626; }
  .pill { display: inline-block; border: 1px solid rgba(127,127,127,.4); border-radius: 999px; padding: 0 .5em; font-size: .8em; }
  button { font: inherit; padding: .2rem .6rem; border-radius: 6px; border: 1px solid rgba(127,127,127,.4); background: transparent; cursor: pointer; }
  button:hover { background: rgba(127,127,127,.12); }
  form.add { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin: 1rem 0; }
  input { font: inherit; padding: .25rem .5rem; border-radius: 6px; border: 1px solid rgba(127,127,127,.4); background: transparent; }
  #msg { min-height: 1.4em; }
  #msg.err { color: #dc2626; }
  details { margin: 1rem 0; }
  .actions { display: flex; gap: .3rem; flex-wrap: wrap; }
</style>
</head>
<body>
<h1>opencode-claude <small>accounts &amp; quota</small></h1>
<p class="muted">Signing an account in is CLI-owned: run the connect command this page
shows in a terminal. The plugin never reads or stores credentials.</p>
<div id="msg" role="status"></div>
<div id="accounts">loading…</div>
<form class="add" id="addForm">
  <strong>Add account</strong>
  <input name="label" placeholder="Label (e.g. Work)" required>
  <input name="configDir" placeholder="Config dir (default ~/.claude-<id>)">
  <label><input type="checkbox" name="makeDefault"> default</label>
  <button type="submit">Add</button>
</form>
<details id="sessionsBox"><summary>Conversations</summary><div id="sessions"></div></details>
<script>
"use strict";
const msg = document.getElementById("msg");
function note(text, isError) {
  msg.textContent = text || "";
  msg.className = isError ? "err" : "";
}
async function api(path, options) {
  const res = await fetch(path, Object.assign({ headers: { "content-type": "application/json" } }, options));
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body && body.error && body.error.message) || ("HTTP " + res.status));
  return body;
}
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children || []) node.appendChild(child);
  return node;
}
function pct(win) {
  if (!win) return null;
  return Math.round(Math.max(0, Math.min(1, win.remaining)) * 100) + "% left";
}
function renderAccounts(data) {
  const root = document.getElementById("accounts");
  root.textContent = "";
  const table = el("table");
  table.appendChild(el("tr", {}, [
    el("th", { text: "Account" }), el("th", { text: "Login" }),
    el("th", { text: "Quota" }), el("th", { text: "Usage" }),
    el("th", { text: "Sessions" }), el("th", { text: "Actions" }),
  ]));
  for (const account of data.data) {
    const cells = [];
    const name = el("td");
    name.appendChild(el("div", { text: account.label }));
    name.appendChild(el("div", { class: "muted", text: account.id }));
    if (account.default) name.appendChild(el("span", { class: "pill", text: "default" }));
    const dir = el("code", { text: account.configDir });
    name.appendChild(el("div", {}, [dir]));
    cells.push(name);

    const login = el("td");
    const identity = account.identity;
    if (identity && (identity.email || identity.organization)) {
      if (identity.email) login.appendChild(el("div", { text: identity.email }));
      if (identity.organization) login.appendChild(el("div", { class: "muted", text: identity.organization }));
      if (identity.subscriptionType) login.appendChild(el("span", { class: "pill", text: identity.subscriptionType }));
    } else {
      login.appendChild(el("div", { class: "muted", text: "unresolved — connect and run a turn, or refresh quota" }));
      login.appendChild(el("div", {}, [el("code", { text: "CLAUDE_CONFIG_DIR=" + account.configDir + " claude auth login" })]));
    }
    if (account.sharesLoginWith && account.sharesLoginWith.length) {
      login.appendChild(el("div", { class: "bad", text: "same login as: " + account.sharesLoginWith.join(", ") + " (one quota pool)" }));
    }
    if (account.labelClaimsLogin) {
      login.appendChild(el("div", { class: "warn", text: "label claims " + account.labelClaimsLogin.claimed + " but CLI resolved " + account.labelClaimsLogin.actual }));
    }
    cells.push(login);

    const quota = el("td");
    if (account.rateLimit && account.rateLimit.limited) {
      quota.appendChild(el("div", { class: "bad", text: "LIMITED" + (account.rateLimit.resetInSeconds ? " · resets in " + Math.round(account.rateLimit.resetInSeconds / 60) + "m" : "") }));
    }
    if (account.quotaSummary) {
      quota.appendChild(el("div", { text: account.quotaSummary }));
    } else if (account.quota && account.quota.windows) {
      const parts = [pct(account.quota.windows.fiveHour), pct(account.quota.windows.sevenDay)].filter(Boolean);
      quota.appendChild(el("div", { text: parts.join(" · ") || "unknown" }));
    } else {
      quota.appendChild(el("div", { class: "muted", text: "unknown" }));
    }
    cells.push(quota);

    const usage = el("td");
    if (account.usage) {
      usage.appendChild(el("div", { text: account.usage.turns + " turns total" }));
      usage.appendChild(el("div", { class: "muted", text: "today: " + account.usage.today.turns + " turns · 7d: " + account.usage.last7Days.turns }));
    }
    cells.push(usage);
    cells.push(el("td", { text: String(account.sessions || 0) }));

    const actions = el("td", { class: "actions" });
    actions.appendChild(el("button", { text: "Refresh quota", onclick: () => mutate("accounts/" + encodeURIComponent(account.id) + "/quota/refresh", {}) }));
    if (!account.default) {
      actions.appendChild(el("button", { text: "Make default", onclick: () => mutate("accounts/" + encodeURIComponent(account.id) + "/default", {}) }));
    }
    actions.appendChild(el("button", { text: "Rename", onclick: () => {
      const label = prompt("New label for " + account.id, account.label);
      if (label) mutate("accounts/" + encodeURIComponent(account.id) + "/rename", { label });
    }}));
    actions.appendChild(el("button", { text: "Remove", onclick: () => {
      const suffix = account.sessions ? " It still owns " + account.sessions + " conversation(s); they move to the default account and lose their Claude transcript." : "";
      if (!confirm("Remove account " + account.id + "?" + suffix)) return;
      mutate("accounts/" + encodeURIComponent(account.id) + (account.sessions ? "?force=1" : ""), null, "DELETE");
    }}));
    cells.push(actions);
    table.appendChild(el("tr", {}, cells));
  }
  root.appendChild(table);
  root.appendChild(el("p", { class: "muted", text: "Registry: " + data.registryPath }));
}
function renderSessions(data, accounts) {
  const root = document.getElementById("sessions");
  root.textContent = "";
  if (!data.data.length) { root.appendChild(el("p", { class: "muted", text: "none recorded" })); return; }
  const table = el("table");
  table.appendChild(el("tr", {}, [
    el("th", { text: "Conversation" }), el("th", { text: "Account" }),
    el("th", { text: "Model" }), el("th", { text: "Move to" }),
  ]));
  for (const session of data.data) {
    const move = el("td", { class: "actions" });
    for (const account of accounts) {
      if (account.id === session.account) continue;
      move.appendChild(el("button", { text: account.id, onclick: () =>
        mutate("sessions/" + encodeURIComponent(session.conversationKey) + "/account", { account: account.id }) }));
    }
    table.appendChild(el("tr", {}, [
      el("td", {}, [el("code", { text: session.conversationKey })]),
      el("td", { text: session.accountLabel + " (" + session.account + ")" }),
      el("td", { text: session.modelId || "" }),
      move,
    ]));
  }
  root.appendChild(table);
}
async function refresh() {
  try {
    const accounts = await api("accounts");
    renderAccounts(accounts);
    const sessions = await api("sessions");
    renderSessions(sessions, accounts.data);
  } catch (err) {
    note(String(err && err.message || err), true);
  }
}
async function mutate(path, body, method) {
  note("working…");
  try {
    await api(path, { method: method || "POST", body: body === null ? undefined : JSON.stringify(body) });
    note("done");
    await refresh();
  } catch (err) {
    note(String(err && err.message || err), true);
  }
}
document.getElementById("addForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const payload = {
    label: form.label.value.trim(),
    makeDefault: form.makeDefault.checked,
  };
  const dir = form.configDir.value.trim();
  if (dir) payload.configDir = dir;
  note("working…");
  try {
    const created = await api("accounts", { method: "POST", body: JSON.stringify(payload) });
    note("Added. Connect it in a terminal: " + created.connect);
    form.reset();
    await refresh();
  } catch (err) {
    note(String(err && err.message || err), true);
  }
});
refresh();
setInterval(refresh, 30000);
</script>
</body>
</html>
`;
}
