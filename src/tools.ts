/**
 * Account management from inside a session.
 *
 * The panel is a separate page, which is fine for looking but awkward for
 * doing: it lives on a loopback port, so an operator working from another
 * machine has to tunnel to it just to add or drop an account. These tools put
 * the same operations where the work already happens — "add an account called
 * client", "which accounts do I have", "drop personal" — with no second UI to
 * reach.
 *
 * Read and write are separate tools on purpose: listing is harmless and gets a
 * plain description, while the mutating one carries the warnings (a login is
 * one browser approval, a duplicate shares a quota pool).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import {
  accountConfigDir,
  accountIcon,
  addAccount,
  findAccount,
  getAccounts,
  getDefaultAccount,
  removeAccount,
  renameAccount,
  setAccountIcon,
  setDefaultAccount,
} from "./accounts.js";
import {
  clearAccountCredentials,
  startAccountLogin,
} from "./account-login.js";
import { hasClaudeCliOAuthCredentials } from "./credentials.js";
import {
  accountsSharingLogin,
  clearAccountIdentity,
  fetchAccountIdentity,
  getAccountIdentity,
  labelLoginMismatch,
} from "./identity.js";
import { LOOPBACK_CALLBACK_PATH } from "./constants.js";
import { getProxyPort, migrateAccountStores } from "./proxy.js";
import { refreshHostCatalog } from "./host-refresh.js";
import {
  clearAccountQuota,
  formatQuotaSummary,
  getAccountQuota,
  probeAccountQuota,
} from "./quota.js";
import { getAccountUsage } from "./usage-store.js";
import {
  bindConversationAccount,
  getBoundAccountId,
  listSessionBindings,
} from "./session-store.js";

/** True when this account uses the ambient ~/.claude the CLI itself reads. */
function isAmbientHome(account: { configDir?: string }): boolean {
  const ambient = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  return !account.configDir || account.configDir === ambient;
}

function connected(accountId: string): boolean {
  const account = findAccount(accountId);
  if (!account) return false;
  return hasClaudeCliOAuthCredentials(
    account.configDir ? { configDir: account.configDir } : undefined,
  );
}

function describe(accountId: string, currentForSession?: string): string {
  const account = findAccount(accountId);
  if (!account) return `${accountId}: unknown`;
  const identity = getAccountIdentity(accountId);
  const usage = getAccountUsage(accountId);
  const quota = formatQuotaSummary(getAccountQuota(accountId));
  const shared = accountsSharingLogin(accountId);
  const sessions = listSessionBindings().filter(
    (b) => (b.accountId ?? getDefaultAccount().id) === accountId,
  ).length;

  const marks = [
    accountId === currentForSession ? "CURRENT for this session" : "",
    account.isDefault ? "default for new sessions" : "",
    // The ambient home is the one a bare `claude` in a terminal uses, which is
    // worth flagging: changing it changes that CLI too.
    isAmbientHome(account) ? "shared with the claude CLI" : "",
  ].filter(Boolean);

  const lines = [
    `${accountIcon(account)} ${account.id} — ${account.label}${marks.length ? `  [${marks.join(" · ")}]` : ""}`,
    `  status: ${connected(accountId) ? "connected" : "NOT connected"}`,
    `  claude home: ${accountConfigDir(account)}`,
  ];
  if (identity?.email) {
    const org = [
      identity.organizationName,
      identity.organizationRole ? `role ${identity.organizationRole}` : "",
      identity.rateLimitTier?.replace(/^default_/, ""),
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(`  login: ${identity.email}${identity.plan ? ` [${identity.plan}]` : ""}`);
    if (org) lines.push(`  org: ${org}`);
  }
  if (quota) lines.push(`  quota left: ${quota}`);
  lines.push(
    `  usage: ${usage.turns} turns (${usage.today.turns} today), ${usage.inputTokens} in / ${usage.outputTokens} out`,
  );
  lines.push(`  sessions bound: ${sessions}`);
  if (shared.length) {
    lines.push(
      `  WARNING: same Claude login as ${shared.join(", ")} — one quota pool, no extra capacity`,
    );
  }
  const claims = labelLoginMismatch(accountId, account.label);
  if (claims) {
    lines.push(
      `  WARNING: the label says ${claims.claimed} but this credential is ${claims.actual}` +
        ` — rename the slot; the login above is the resolved one`,
    );
  }
  return lines.join("\n");
}

function loginUrlHint(url: string): string {
  return [
    `Open this URL to sign in:`,
    url,
    ``,
    `Open it in a PRIVATE window. The consent screen approves whatever session`,
    `the browser already has and never offers an account picker, so otherwise`,
    `it re-authorizes the account you are already signed in as.`,
    ``,
    `Connecting several accounts in a row: all incognito windows share one`,
    `session, so close every one of them before starting the next login (or`,
    `use a separate browser profile per account). A duplicate is refused`,
    `before anything is written, so a mistake costs nothing.`,
  ].join("\n");
}

async function startLogin(accountId: string): Promise<string> {
  const account = findAccount(accountId);
  if (!account) throw new Error(`unknown account "${accountId}"`);
  const port = getProxyPort();
  const pending = await startAccountLogin(
    account,
    port
      ? { redirectUri: `http://127.0.0.1:${port}${LOOPBACK_CALLBACK_PATH}` }
      : undefined,
  );
  return [
    loginUrlHint(pending.url),
    ``,
    pending.manual
      ? `Then paste the redirect URL back into the panel to finish.`
      : `Your browser is redirected straight back and the login completes on its own. (The redirect targets 127.0.0.1, so open it on this machine or through your SSH tunnel.)`,
  ].join("\n");
}

export function buildAccountTools(): Record<string, ToolDefinition> {
  const disabled = (process.env.OPENCODE_CLAUDE_TOOLS ?? "").toLowerCase();
  if (disabled === "0" || disabled === "false" || disabled === "off") return {};

  return {
    claude_accounts: tool({
      description:
        "List the Claude subscriptions this plugin can use: which are connected, which login each one is, how much quota is left, and how many sessions are bound to each.",
      args: {},
      async execute(_args, context) {
        const accounts = getAccounts();
        const current =
          getBoundAccountId(context.sessionID) ?? getDefaultAccount().id;
        const body = accounts
          .map((a) => describe(a.id, current))
          .join("\n\n");
        const port = getProxyPort();
        return {
          title: `${accounts.filter((a) => connected(a.id)).length}/${accounts.length} connected · this session runs on ${current}`,
          output: `${body}\n\nSwitch this session with claude_account_manage {action:"use"}.${
            port ? `\nPanel: http://127.0.0.1:${port}/` : ""
          }`,
        };
      },
    }),

    claude_account_manage: tool({
      description:
        "Switch the current session to another Claude account (action \"use\"), or add, connect, rename, remove, disconnect an account, set the default for new sessions, change its icon, or refresh quota. To add, just give a label — the id and Claude home are derived from it. Adding returns a sign-in URL — each account needs its own browser approval, so several accounts cannot be connected in one go.",
      args: {
        action: tool.schema
          .enum([
            "use",
            "add",
            "connect",
            "rename",
            "remove",
            "disconnect",
            "set-default",
            "set-icon",
            "refresh-quota",
          ])
          .describe("What to do."),
        id: tool.schema
          .string()
          .optional()
          .describe(
            "Existing account id. Omit when adding — the id is derived from the label (\"Work Shared\" → work-shared) and the Claude home becomes ~/.claude-<id>.",
          ),
        label: tool.schema
          .string()
          .optional()
          .describe("Display name, for add and rename."),
        icon: tool.schema
          .string()
          .optional()
          .describe(
            "One glyph standing in for the label in the model picker and session header, for add and set-icon. Derived from the label when unset (shared/personal/work); pass an empty string to go back to the derived one.",
          ),
        newId: tool.schema
          .string()
          .optional()
          .describe(
            "New id, for rename. Changes the model ids (opus@<id>); quota, usage and session bindings move with it.",
          ),
        configDir: tool.schema
          .string()
          .optional()
          .describe(
            "CLAUDE_CONFIG_DIR for a new account. Defaults to ~/.claude-<id>; leave unset unless you have a reason.",
          ),
      },
      async execute(args, context) {
        const id = (args.id ?? "").trim().toLowerCase();
        if (!id && args.action !== "add") {
          throw new Error(`"${args.action}" needs an account id`);
        }
        switch (args.action) {
          case "use": {
            const account = findAccount(id);
            if (!account) throw new Error(`unknown account "${id}"`);
            if (!connected(id)) {
              throw new Error(
                `"${id}" is not connected — connect it first, or turns on it will fail.`,
              );
            }
            const previous = getBoundAccountId(context.sessionID);
            bindConversationAccount(context.sessionID, account.id, account.label);
            return previous && previous !== account.id
              ? `This session now runs on ${account.label} (${account.id}), moved from ${previous}. The Claude transcript does not follow across accounts, so the conversation is carried over as context on the next turn.`
              : `This session now runs on ${account.label} (${account.id}).`;
          }
          case "add": {
            const created = addAccount({
              ...(id ? { id } : {}),
              label: args.label,
              icon: args.icon,
              configDir: args.configDir,
            });
            await refreshHostCatalog();
            return {
              title: `Added ${created.id}`,
              output: `Added "${created.label}" (${created.id}) at ${created.configDir}.\n\n${await startLogin(created.id)}`,
            };
          }
          case "connect":
            return {
              title: `Sign in to ${id}`,
              output: await startLogin(id),
            };
          case "rename": {
            if (!args.label?.trim() && !args.newId?.trim()) {
              throw new Error("give a new label, a new id, or both");
            }
            const renamed = renameAccount(id, args.label, {
              newId: args.newId,
              migrate: migrateAccountStores,
            });
            await refreshHostCatalog();
            return renamed.id !== id
              ? `Renamed ${id} to ${renamed.id} ("${renamed.label}"). Models are now e.g. opus@${renamed.id}; quota, usage and session bindings moved with it.`
              : `Renamed ${id} to "${renamed.label}".`;
          }
          case "remove":
            removeAccount(id);
            clearAccountIdentity(id);
            clearAccountQuota(id);
            await refreshHostCatalog();
            return `Removed ${id}. Its Claude home is left on disk.`;
          case "disconnect": {
            const account = findAccount(id);
            if (!account) throw new Error(`unknown account "${id}"`);
            clearAccountCredentials(account);
            clearAccountIdentity(id);
            clearAccountQuota(id);
            return `Disconnected ${id}. The account is still registered — connect it again whenever.`;
          }
          case "set-icon": {
            const updated = setAccountIcon(id, args.icon ?? "");
            await refreshHostCatalog();
            return updated.icon
              ? `${id} now shows as ${updated.icon} in the model picker.`
              : `${id} is back to its derived icon (${accountIcon(updated)}).`;
          }
          case "set-default": {
            const chosen = setDefaultAccount(id).id;
            await refreshHostCatalog();
            return `${chosen} is now the default account for new sessions.`;
          }
          case "refresh-quota": {
            const account = findAccount(id);
            if (!account) throw new Error(`unknown account "${id}"`);
            const quota = await probeAccountQuota(account);
            await fetchAccountIdentity(account).catch(() => null);
            return {
              title: `Quota for ${id}`,
              output: formatQuotaSummary(quota) ?? "No quota reported.",
            };
          }
        }
      },
    }),
  };
}
