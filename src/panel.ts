/**
 * Local control panel served by the proxy.
 *
 * Answers, on one page: how many Claude accounts are connected, how much each
 * one has been used, which one every session is running on — and lets you
 * connect another without touching a config file or a terminal.
 *
 * Self-contained by design: no external CSS, fonts or scripts. The page is
 * served from 127.0.0.1 by a process that holds subscription tokens, so it
 * must not reach out to anything.
 */

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfaf9; --fg: #1c1b19; --muted: #6b6862; --line: #e3e0da;
  --card: #ffffff; --accent: #b8552b; --ok: #2f7d4f; --warn: #a8791a; --bad: #b3372c;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131211; --fg: #e8e5df; --muted: #918d85; --line: #2c2a27;
    --card: #1b1a18; --accent: #e08757; --ok: #6bbb8a; --warn: #d6a94a; --bad: #e0705f;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--fg);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size: 1.35rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
h2 { font-size: 1rem; margin: 2.25rem 0 .75rem; letter-spacing: -.01em; }
.sub { color: var(--muted); margin: 0 0 1.5rem; font-size: .9rem; }
.cards { display: grid; gap: .875rem; grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr)); }
.card {
  background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  padding: 1rem 1.1rem;
}
.card.is-default { border-color: var(--accent); }
.card-head { display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
.card-head strong { font-size: 1.05rem; }
.tag {
  font-size: .7rem; text-transform: uppercase; letter-spacing: .06em;
  padding: .12rem .4rem; border-radius: 4px; border: 1px solid var(--line);
  color: var(--muted);
}
.tag.default { color: var(--accent); border-color: var(--accent); }
.tag.on { color: var(--ok); border-color: var(--ok); }
.tag.off { color: var(--bad); border-color: var(--bad); }
.tag.limited { color: var(--warn); border-color: var(--warn); }
.tag.shared { color: var(--bad); border-color: var(--bad); }
.who { font-size: .8rem; margin: .3rem 0 .1rem; }
.who b { font-weight: 600; }
.who span { color: var(--muted); }
.who-org { font-size: .75rem; color: var(--muted); margin-top: .1rem; }
.path { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); word-break: break-all; margin: .4rem 0 .75rem; }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: .5rem; margin: .75rem 0; }
.stat { border-top: 1px solid var(--line); padding-top: .4rem; }
.stat b { display: block; font-size: 1.05rem; font-variant-numeric: tabular-nums; font-weight: 600; }
.stat span { font-size: .73rem; color: var(--muted); white-space: nowrap; }
.bar { height: 4px; background: var(--line); border-radius: 2px; overflow: hidden; margin: .3rem 0 .2rem; }
.bar i { display: block; height: 100%; background: var(--ok); }
.bar.warn i { background: var(--warn); }
.bar.bad i { background: var(--bad); }
.quota { margin: .85rem 0 .25rem; }
.quota-row { margin-bottom: .55rem; }
.quota-row .lede { display: flex; justify-content: space-between; align-items: baseline; gap: .5rem; font-size: .8rem; }
.quota-row .lede b { font-variant-numeric: tabular-nums; font-weight: 600; }
.quota-row .lede em { font-style: normal; color: var(--muted); font-size: .75rem; }
.quota-row.binding .lede b { color: var(--accent); }
.quota-note { font-size: .75rem; color: var(--muted); }
.stale { font-size: .72rem; color: var(--muted); }
.actions { display: flex; gap: .4rem; flex-wrap: wrap; margin-top: .85rem; }
button {
  font: inherit; font-size: .82rem; padding: .3rem .7rem; border-radius: 6px;
  border: 1px solid var(--line); background: transparent; color: var(--fg); cursor: pointer;
}
button:hover { border-color: var(--accent); color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.primary:hover { color: #fff; opacity: .9; }
button:disabled { opacity: .45; cursor: default; }
table { width: 100%; border-collapse: collapse; font-size: .85rem; }
th, td { text-align: left; padding: .45rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: .72rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 500; }
td.mono { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
form.add { display: grid; gap: .5rem; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); align-items: end; }
label { display: block; font-size: .75rem; color: var(--muted); margin-bottom: .2rem; }
input {
  font: inherit; font-size: .85rem; width: 100%; padding: .35rem .5rem;
  border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg);
}
dialog {
  border: 1px solid var(--line); border-radius: 10px; background: var(--card); color: var(--fg);
  max-width: 34rem; padding: 1.25rem;
}
dialog::backdrop { background: rgba(0,0,0,.45); }
dialog p { font-size: .88rem; }
dialog a { color: var(--accent); word-break: break-all; }
.msg { margin: 1rem 0 0; padding: .6rem .8rem; border-radius: 6px; font-size: .85rem; border: 1px solid var(--line); }
.msg.err { color: var(--bad); border-color: var(--bad); }
.msg.ok { color: var(--ok); border-color: var(--ok); }
.empty { color: var(--muted); font-size: .88rem; }
.hint { font-size: .72rem; color: var(--muted); margin: .25rem 0 0; }
input[readonly] { opacity: .7; }
`;

const SCRIPT = String.raw`
const $ = (sel) => document.querySelector(sel);
const fmt = new Intl.NumberFormat();

function compact(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return fmt.format(n);
}

function ago(ts) {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

function countdown(sec) {
  if (sec === undefined || sec === null) return "";
  if (sec <= 0) return "now";
  if (sec < 90) return sec + "s";
  const m = Math.round(sec / 60);
  if (m < 90) return m + "m";
  const h = Math.floor(m / 60);
  const rm = m % 60;
  // The weekly window resets days out; "108h 20m" is not a readable answer.
  if (h >= 48) {
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh ? d + "d " + rh + "h" : d + "d";
  }
  return rm ? h + "h " + rm + "m" : h + "h";
}

function resetTime(ts) {
  if (!ts) return "";
  const absolute = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(ts));
  return absolute + " · in " + countdown(Math.round((ts - Date.now()) / 1000));
}

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(body?.error?.message || res.statusText);
    if (body?.error?.code === "duplicate_login") {
      error.duplicate = true;
      error.duplicateOf = body.duplicateOf || [];
    }
    throw error;
  }
  return body;
}

function note(text, kind) {
  const el = $("#note");
  el.textContent = text;
  el.className = "msg " + (kind || "");
  el.hidden = !text;
}

let state = { accounts: [], sessions: [] };
let firstRefresh = true;

function accountCard(account) {
  const rl = account.rateLimit || {};
  const usage = account.usage || {};
  const today = usage.today || {};
  const util = typeof rl.utilization === "number" ? Math.round(rl.utilization * 100) : null;
  const badges = [
    account.default ? '<span class="tag default">default</span>' : "",
    account.authenticated
      ? '<span class="tag on">connected</span>'
      : '<span class="tag off">not connected</span>',
    rl.limited
      ? '<span class="tag limited">limited · back in ' + countdown(rl.resetInSeconds) + "</span>"
      : "",
    // The same Claude login connected twice is not two subscriptions. Say so
    // loudly, or the card reads like capacity that does not exist.
    (account.sharesLoginWith || []).length
      ? '<span class="tag shared" title="the same Claude login — one quota pool">same login as ' +
        esc(account.sharesLoginWith.join(", ")) + "</span>"
        : (account.sharesOrganizationWith || []).length
          ? '<span class="tag" title="different logins, same organization">same org as ' +
            esc(account.sharesOrganizationWith.join(", ")) + "</span>"
          : "",
    // The title of the card naming a login the credential does not belong to.
    // Unflagged this is the most convincing lie the panel can tell, because the
    // label is read first and the true login sits below it.
    account.labelClaimsLogin
      ? '<span class="tag limited" title="' +
        esc(
          "the label says " + account.labelClaimsLogin.claimed +
          " but this credential is " + account.labelClaimsLogin.actual +
          " — rename the slot, the login is resolved on its own",
        ) + '">label says ' + esc(account.labelClaimsLogin.claimed) + ", not this login</span>"
      : "",
  ].join("");

  const id0 = account.identity;
  // Everything the token can tell us about the subscription behind it. A
  // member list is not among it: that needs a claude.ai account session, which
  // an OAuth token is not, so /api/organizations/<uuid>/members answers 403.
  const orgBits = id0
    ? [
        id0.organizationName,
        id0.organizationRole ? "role " + id0.organizationRole : "",
        id0.workspaceName ? "ws " + id0.workspaceName : "",
        id0.rateLimitTier ? id0.rateLimitTier.replace(/^default_/, "") : "",
        id0.subscriptionStatus && id0.subscriptionStatus !== "active"
          ? id0.subscriptionStatus
          : "",
      ].filter(Boolean)
    : [];
  const who = id0
    ? '<div class="who"><b>' + esc(id0.email || id0.displayName || "?") + "</b>" +
      (id0.plan ? ' <span class="tag">' + esc(id0.plan) + "</span>" : "") +
      (orgBits.length ? '<div class="who-org">' + esc(orgBits.join(" · ")) + "</div>" : "") +
      "</div>"
    : account.authenticated
      ? '<div class="who"><span>login not identified yet — hit Check quota</span></div>'
      : "";

  return (
    '<article class="card' + (account.default ? " is-default" : "") + '">' +
      '<div class="card-head"><strong>' + esc(account.label) + "</strong>" +
        '<span class="tag">' + esc(account.id) + "</span>" + badges +
      "</div>" +
      who +
      '<div class="path">' + esc(account.configDir) + "</div>" +
      quotaBlock(account) +
      '<div class="stats">' +
        stat(compact(today.turns || 0), "turns today") +
        stat(compact((usage.last7Days || {}).turns || 0), "turns · 7d") +
        stat(compact(usage.turns || 0), "turns all time") +
        stat(compact(usage.inputTokens || 0), "tokens in") +
        stat(compact(usage.outputTokens || 0), "tokens out") +
        stat(String(account.sessions || 0), "sessions") +
      "</div>" +
      '<div class="path">' +
        (usage.turns
          ? "last used " + ago(usage.lastUsedAt)
          : "no turns recorded yet") +
      "</div>" +
      '<div class="actions">' +
        (account.authenticated
          ? '<button data-act="quota" data-id="' + esc(account.id) + '">Check quota</button>' +
            '<button data-act="reconnect" data-id="' + esc(account.id) + '">Reconnect</button>' +
            '<button data-act="disconnect" data-id="' + esc(account.id) + '">Disconnect</button>'
          : '<button class="primary" data-act="connect" data-id="' + esc(account.id) + '">Connect</button>') +
        '<button data-act="rename" data-id="' + esc(account.id) + '">Rename</button>' +
        (account.default
          ? ""
          : '<button data-act="default" data-id="' + esc(account.id) + '">Make default</button>' +
            '<button data-act="remove" data-id="' + esc(account.id) + '">Remove</button>') +
      "</div>" +
    "</article>"
  );
}

function quotaWindow(win, label, binding) {
  if (!win) return "";
  const left = Math.round((win.remaining ?? 0) * 100);
  const tone = left <= 10 ? "bad" : left <= 25 ? "warn" : "";
  const resets = win.resetsAt ? "resets " + resetTime(win.resetsAt) : "";
  return (
    '<div class="quota-row' + (binding ? " binding" : "") + '">' +
      '<div class="lede"><span>' + esc(label) + (binding ? " · binding" : "") + "</span>" +
        "<b>" + left + "% left</b></div>" +
      '<div class="bar ' + tone + '"><i style="width:' + Math.max(0, Math.min(100, left)) + '%"></i></div>' +
      '<div class="quota-note">' + esc(resets) +
        (win.status && win.status !== "allowed" ? " · " + esc(win.status.replace(/_/g, " ")) : "") +
      "</div>" +
    "</div>"
  );
}

function quotaBlock(account) {
  const q = account.quota;
  if (!q) {
    // Fall back to whatever the Agent SDK last reported, which covers one
    // window only — that is exactly why the probe exists.
    const rl = account.rateLimit || {};
    if (typeof rl.utilization !== "number") {
      return account.authenticated
        ? '<div class="quota"><div class="quota-note">No quota data yet — hit Check quota.</div></div>'
        : "";
    }
    const left = Math.round((1 - rl.utilization) * 100);
    return '<div class="quota">' + quotaWindow(
      { remaining: 1 - rl.utilization, resetsAt: rl.resetsAt, status: rl.status },
      (rl.rateLimitType || "usage").replace(/_/g, " "), false) + "</div>";
  }
  const w = q.windows || {};
  const rep = q.representative;
  return (
    '<div class="quota">' +
      quotaWindow(w.fiveHour, "5 hours", rep === "five_hour") +
      quotaWindow(w.sevenDay, "7 days", rep === "seven_day") +
      quotaWindow(w.opus, "Opus", rep === "opus") +
      '<div class="stale">quota read ' + ago(q.fetchedAt) +
        (q.source === "probe" ? "" : " (from a live request)") +
        (q.overage && q.overage.status === "rejected" ? " · overage off" : "") +
      "</div>" +
    "</div>"
  );
}

function stat(value, label) {
  return '<div class="stat"><b>' + esc(value) + "</b><span>" + esc(label) + "</span></div>";
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function sessionRow(session) {
  const options = state.accounts
    .map((a) =>
      '<option value="' + esc(a.id) + '"' +
      (a.id === session.account ? " selected" : "") + ">" + esc(a.label) + "</option>")
    .join("");
  return (
    "<tr>" +
      '<td class="mono">' + esc(session.conversationKey) + "</td>" +
      "<td><select data-session=\"" + esc(session.conversationKey) + "\">" + options + "</select></td>" +
      "<td>" + esc(session.modelId || "—") + "</td>" +
      '<td class="mono">' + esc(session.cwd || "—") + "</td>" +
      "<td>" + ago(session.updatedAt) + "</td>" +
    "</tr>"
  );
}

async function refresh() {
  const accountsPath = firstRefresh ? "v1/accounts?refresh=stale" : "v1/accounts";
  firstRefresh = false;
  if (accountsPath.includes("refresh=stale")) {
    note("Refreshing quota samples older than 10 minutes…");
  }
  const [accounts, sessions] = await Promise.all([
    api(accountsPath),
    api("v1/sessions"),
  ]);
  state = { accounts: accounts.data || [], sessions: sessions.data || [] };
  const connected = state.accounts.filter((a) => a.authenticated).length;
  $("#summary").textContent =
    connected + " of " + state.accounts.length + " account" +
    (state.accounts.length === 1 ? "" : "s") + " connected" +
    (accounts.multiAccount ? "" : " · single-account mode");
  $("#cards").innerHTML = state.accounts.map(accountCard).join("");
  $("#sessions").innerHTML = state.sessions.length
    ? state.sessions.map(sessionRow).join("")
    : '<tr><td colspan="5" class="empty">No sessions bound yet.</td></tr>';
  if (accountsPath.includes("refresh=stale")) note("");

}

let loginAccount = null;

let loginPoll = null;

function stopLoginPoll() {
  if (loginPoll) { clearInterval(loginPoll); loginPoll = null; }
}

async function startLogin(id) {
  loginAccount = id;
  const res = await api("v1/accounts/" + encodeURIComponent(id) + "/login/start", {
    method: "POST",
  });
  $("#login-url").href = res.url;
  $("#login-url").textContent = res.url;
  $("#login-account").textContent = id;
  $("#login-code").value = "";
  $("#login-error").textContent = "";
  $("#login-decision").hidden = true;
  $("#login-submit").disabled = false;
  // With a loopback redirect the browser comes back on its own; the paste box
  // is only the fallback for a browser that cannot reach this listener.
  const auto = res.manual === false;
  $("#login-auto").hidden = !auto;
  $("#login-manual").hidden = auto;
  $("#login").showModal();

  stopLoginPoll();
  if (!auto) return;
  loginPoll = setInterval(async () => {
    try {
      const accounts = await api("v1/accounts");
      const me = (accounts.data || []).find((a) => a.id === id);
      if (me && me.authenticated) {
        stopLoginPoll();
        $("#login").close();
        const email = me.identity && me.identity.email;
        note("Connected " + id + (email ? " as " + email : "") + ".", "ok");
        await refresh();
      } else if (me && me.heldDuplicateLogin) {
        // The callback refused it: nothing written, decision still open.
        stopLoginPoll();
        $("#login-error").textContent =
          "That is the same Claude login as an account already connected. Nothing was saved.";
        $("#login-decision").hidden = false;
        $("#login-submit").disabled = true;
        $("#login-auto").hidden = true;
      }
    } catch { /* keep waiting */ }
  }, 2000);
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-act]");
  if (!button) return;
  const { act, id } = button.dataset;
  button.disabled = true;
  try {
    if (act === "connect" || act === "reconnect") {
      await startLogin(id);
    } else if (act === "quota") {
      const q = await api("v1/accounts/" + encodeURIComponent(id) + "/quota/refresh", {
        method: "POST",
      });
      const w = q.windows || {};
      note(
        id + ": " +
        (w.fiveHour ? Math.round(w.fiveHour.remaining * 100) + "% left of 5h" : "") +
        (w.fiveHour && w.sevenDay ? " · " : "") +
        (w.sevenDay ? Math.round(w.sevenDay.remaining * 100) + "% left of 7d" : ""),
        "ok",
      );
      await refresh();
    } else if (act === "disconnect") {
      await api("v1/accounts/" + encodeURIComponent(id) + "/disconnect", { method: "POST" });
      note("Disconnected " + id + ".", "ok");
      await refresh();
    } else if (act === "rename") {
      const current = (state.accounts.find((a) => a.id === id) || {}).label || id;
      const label = prompt("New label for " + id, current);
      if (label && label.trim() && label.trim() !== current) {
        await api("v1/accounts/" + encodeURIComponent(id) + "/rename", {
          method: "POST",
          body: JSON.stringify({ label: label.trim() }),
        });
        note("Renamed " + id + " to " + label.trim() + ".", "ok");
        await refresh();
      }
    } else if (act === "default") {
      await api("v1/accounts/" + encodeURIComponent(id) + "/default", { method: "POST" });
      note(id + " is now the default account.", "ok");
      await refresh();
    } else if (act === "remove") {
      if (confirm("Remove " + id + "? Its Claude home stays on disk.")) {
        await api("v1/accounts/" + encodeURIComponent(id), { method: "DELETE" });
        note("Removed " + id + ".", "ok");
        await refresh();
      }
    }
  } catch (err) {
    note(err.message, "err");
  } finally {
    button.disabled = false;
  }
});

$("#add").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.target);
  try {
    // No id is sent: the server derives it from the name and tells us what it
    // picked, which also settles collisions (work-shared, work-shared-2…).
    const created = await api("v1/accounts", {
      method: "POST",
      body: JSON.stringify({ label: data.get("label") }),
    });
    event.target.reset();
    updateSlugPreview();
    await refresh();
    // Adding an account you do not intend to sign in is not a thing anybody
    // wants, so go straight into the OAuth flow. Cancelling the dialog leaves
    // the account registered and disconnected — its Connect button still works.
    await startLogin(created.id);
  } catch (err) {
    note(err.message, "err");
  }
});

async function finishLogin(res) {
  stopLoginPoll();
  $("#login").close();
  const email = res && res.identity && res.identity.email;
  note("Connected " + loginAccount + (email ? " as " + email : "") + ".", "ok");
  await refresh();
}

$("#login-confirm").addEventListener("click", async () => {
  try {
    await finishLogin(
      await api("v1/accounts/" + encodeURIComponent(loginAccount) + "/login/confirm", {
        method: "POST",
      }),
    );
  } catch (err) {
    $("#login-error").textContent = err.message;
  }
});

$("#login-discard").addEventListener("click", async () => {
  try {
    await api("v1/accounts/" + encodeURIComponent(loginAccount) + "/login/discard", {
      method: "POST",
    });
  } catch (err) { /* nothing held is fine */ }
  $("#login").close();
  note("Login discarded — nothing was saved.", "ok");
  await refresh();
});

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await finishLogin(
      await api("v1/accounts/" + encodeURIComponent(loginAccount) + "/login/complete", {
        method: "POST",
        body: JSON.stringify({ code: $("#login-code").value }),
      }),
    );
  } catch (err) {
    $("#login-error").textContent = err.message;
    // A duplicate is refused BEFORE anything is written, so the choice is
    // still open: commit it knowingly, or throw it away.
    if (err.duplicate) {
      $("#login-decision").hidden = false;
      $("#login-submit").disabled = true;
    }
  }
});

$("#login-cancel").addEventListener("click", () => {
  stopLoginPoll();
  $("#login").close();
});

document.addEventListener("change", async (event) => {
  const select = event.target.closest("select[data-session]");
  if (!select) return;
  try {
    await api("v1/sessions/" + encodeURIComponent(select.dataset.session) + "/account", {
      method: "POST",
      body: JSON.stringify({ account: select.value }),
    });
    note("Session moved to " + select.value + ".", "ok");
    await refresh();
  } catch (err) {
    note(err.message, "err");
    await refresh();
  }
});

// Mirror the server's slug rule so the operator sees the id and folder they
// will get before submitting. The server remains the authority.
function slugify(label) {
  const base = (label || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  return /^[a-z0-9]/.test(base) ? base : (base ? "account-" + base : "");
}

function updateSlugPreview() {
  const slug = slugify($("#f-label").value);
  $("#f-dir").value = slug ? "~/.claude-" + slug : "";
  $("#f-hint").textContent = slug
    ? "id: " + slug + " · models: opus@" + slug
    : "id and folder follow the name";
}

$("#f-label").addEventListener("input", updateSlugPreview);
updateSlugPreview();

refresh().catch((err) => note(err.message, "err"));
setInterval(() => refresh().catch(() => {}), 15000);
`;

export function renderPanel(basePath = "/"): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<base href="${basePath.replace(/"/g, "&quot;")}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude accounts</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <h1>Claude accounts</h1>
  <p class="sub" id="summary">Loading…</p>

  <div class="cards" id="cards"></div>
  <p class="msg" id="note" hidden></p>

  <h2>Add an account</h2>
  <p class="sub">Adding opens the sign-in straight away. Each account needs its own
  Claude login — one authorization per subscription, that is how OAuth works.</p>
  <form class="add" id="add">
    <div>
      <label for="f-label">name</label>
      <input id="f-label" name="label" placeholder="Work Shared" required>
    </div>
    <div>
      <label for="f-dir">Claude home</label>
      <input id="f-dir" name="configDir" placeholder="~/.claude-work-shared" readonly>
      <p class="hint" id="f-hint">id and folder follow the name</p>
    </div>
    <div><button class="primary" type="submit">Add &amp; connect</button></div>
  </form>

  <h2>Sessions</h2>
  <table>
    <thead>
      <tr><th>session</th><th>account</th><th>model</th><th>directory</th><th>last turn</th></tr>
    </thead>
    <tbody id="sessions"></tbody>
  </table>
</main>

<dialog id="login">
  <h2 style="margin-top:0">Connect <span id="login-account"></span></h2>
  <p class="msg">Open the URL in a <strong>private window</strong>. The consent screen approves
  whatever session your browser already has and never offers an account picker, so otherwise you
  connect the same subscription twice. Connecting several in a row: all incognito windows share
  one session — close every one of them between logins, or use a separate browser profile per
  account.</p>
  <p id="login-auto" hidden>Open this URL and approve. Your browser is redirected straight back
  here and this dialog closes on its own — nothing to copy. (The redirect goes to
  <code>127.0.0.1</code>, so open it on this machine or through your SSH tunnel.)</p>
  <p id="login-manual" hidden>Open this URL, approve access, then paste the redirect URL
  (or <code>code#state</code>) below.</p>
  <p><a id="login-url" target="_blank" rel="noreferrer noopener"></a></p>
  <form id="login-form">
    <label for="login-code">redirect URL or code#state</label>
    <input id="login-code" required autocomplete="off">
    <p class="msg err" id="login-error"></p>
    <div class="actions">
      <button class="primary" type="submit" id="login-submit">Complete</button>
      <button type="button" id="login-cancel">Cancel</button>
    </div>
    <div id="login-decision" hidden>
      <p>Nothing has been saved. Connect it anyway — it will share the other
      account's quota — or discard it and retry in a private window.</p>
      <div class="actions">
        <button type="button" id="login-confirm">Connect anyway</button>
        <button type="button" id="login-discard">Discard</button>
      </div>
    </div>
  </form>
</dialog>

<script>${SCRIPT}</script>
</body>
</html>`;
}
