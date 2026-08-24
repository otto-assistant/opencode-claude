/**
 * In-session management tools: `claude_accounts` and `claude_account_manage`.
 *
 * They run inside the OpenCode server process — the same process that owns
 * the proxy — so managing accounts from a session needs no HTTP round-trip
 * and works even when the panel is disabled or bound elsewhere.
 *
 * Everything here is registry/store bookkeeping. Credentials stay CLI-owned:
 * "connect" means printing the `CLAUDE_CONFIG_DIR=<dir> claude auth login`
 * command for the operator to run, never touching a token.
 *
 * Disable with OPENCODE_CLAUDE_TOOLS=0.
 */
import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import {
  AccountError,
  accountConfigDir,
  addAccount,
  getDefaultAccount,
  removeAccount,
  renameAccount,
  requireAccount,
  setDefaultAccount,
} from "./accounts.js";
import { formatQuotaSummary } from "./quota.js";
import {
  bindConversationAccount,
  getSessionBinding,
} from "./session-store.js";
import {
  describeAllAccounts,
  migrateAccountStores,
  refreshAccountQuota,
} from "./proxy.js";

const z = tool.schema;

export function claudeToolsEnabled(): boolean {
  const flag = (process.env.OPENCODE_CLAUDE_TOOLS ?? "").trim().toLowerCase();
  return !(flag === "0" || flag === "false" || flag === "off");
}

function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function errorText(err: unknown): string {
  if (err instanceof AccountError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

const accountsTool = tool({
  description:
    "List the configured Claude Code accounts: label, id, default flag, " +
    "resolved login (email/organization/plan as the CLI reported it), " +
    "remaining subscription quota per window, rate-limit state, usage " +
    "counters and how many conversations are bound to each account.",
  args: {},
  async execute() {
    const accounts = describeAllAccounts();
    return {
      title: `${accounts.length} Claude account${accounts.length === 1 ? "" : "s"}`,
      output: asJson({ default: getDefaultAccount().id, accounts }),
    };
  },
});

const manageTool = tool({
  description:
    "Manage Claude Code accounts without leaving the session. Actions: " +
    "'add' (label, optional configDir/id/makeDefault — returns the " +
    "`claude auth login` command the operator must run to connect it), " +
    "'remove' (account, force to also move its conversations to the default " +
    "account), 'rename' (account, label and/or newId), 'set-default' " +
    "(account), 'bind-session' (session conversation key + account — moves a " +
    "conversation to another account; its Claude-side transcript stays with " +
    "the old account, so the next turn starts fresh), 'refresh-quota' " +
    "(account — boots one idle CLI probe; reads quota + identity over the " +
    "SDK control channel, no Messages API call).",
  args: {
    action: z.enum([
      "add",
      "remove",
      "rename",
      "set-default",
      "bind-session",
      "refresh-quota",
    ]),
    account: z
      .string()
      .optional()
      .describe("Target account id (all actions except add)"),
    label: z.string().optional().describe("Display label (add, rename)"),
    id: z.string().optional().describe("Explicit account id (add)"),
    newId: z.string().optional().describe("New account id (rename)"),
    configDir: z
      .string()
      .optional()
      .describe("CLAUDE_CONFIG_DIR for the account (add; default ~/.claude-<id>)"),
    makeDefault: z.boolean().optional().describe("Make it the default (add)"),
    force: z
      .boolean()
      .optional()
      .describe("Remove even when conversations are still bound (remove)"),
    session: z
      .string()
      .optional()
      .describe("Conversation key to move (bind-session)"),
  },
  async execute(args) {
    try {
      switch (args.action) {
        case "add": {
          const account = addAccount({
            id: args.id,
            label: args.label,
            configDir: args.configDir,
            makeDefault: args.makeDefault === true,
          });
          return {
            title: `Added account ${account.id}`,
            output: asJson({
              account: account.id,
              label: account.label,
              configDir: accountConfigDir(account),
              connect: `CLAUDE_CONFIG_DIR=${accountConfigDir(account)} claude auth login`,
              note:
                "Sign the account in by running the connect command in a " +
                "terminal — the plugin never touches credentials.",
            }),
          };
        }
        case "remove": {
          const id = requireAccount(args.account ?? "").id;
          removeAccount(id, args.force === true);
          return {
            title: `Removed account ${id}`,
            output: asJson({ removed: id }),
          };
        }
        case "rename": {
          const id = requireAccount(args.account ?? "").id;
          const renamed = renameAccount(id, args.label, {
            newId: args.newId,
            migrate: migrateAccountStores,
          });
          return {
            title: `Renamed account ${id}`,
            output: asJson({ account: renamed.id, label: renamed.label }),
          };
        }
        case "set-default": {
          const account = setDefaultAccount(
            requireAccount(args.account ?? "").id,
          );
          return {
            title: `Default account is now ${account.id}`,
            output: asJson({ default: account.id }),
          };
        }
        case "bind-session": {
          const target = requireAccount(args.account ?? "");
          const key = (args.session ?? "").trim();
          if (!key) throw new AccountError("give the session conversation key");
          if (!getSessionBinding(key)) {
            throw new AccountError(`unknown session "${key}"`, 404);
          }
          bindConversationAccount(key, target.id, target.label);
          return {
            title: `Session moved to ${target.id}`,
            output: asJson({ conversationKey: key, account: target.id }),
          };
        }
        case "refresh-quota": {
          const account = requireAccount(args.account ?? "");
          const probed = await refreshAccountQuota(account.id);
          return {
            title: `Quota refreshed for ${account.id}`,
            output: asJson({
              account: account.id,
              quota: probed.quota,
              quotaSummary: formatQuotaSummary(probed.quota),
              identity: probed.identity,
            }),
          };
        }
      }
    } catch (err) {
      return {
        title: "Account action failed",
        output: asJson({ error: errorText(err) }),
      };
    }
    return { title: "No action taken", output: asJson({ error: "unknown action" }) };
  },
});

/** Tool map for the plugin Hooks, or empty when disabled. */
export function buildClaudeTools(): Record<string, ToolDefinition> {
  if (!claudeToolsEnabled()) return {};
  return {
    claude_accounts: accountsTool,
    claude_account_manage: manageTool,
  };
}
