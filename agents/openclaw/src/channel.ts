import {
  createChatChannelPlugin,
  buildChannelOutboundSessionRoute,
  DEFAULT_ACCOUNT_ID,
} from "openclaw/plugin-sdk/core";
import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/channel-setup";
import { outboundSubject } from "./nats/index.js";
import { listNatsAccountIds, resolveNatsAccount } from "./accounts.js";
import { startNatsGateway, stopNatsGateway } from "./gateway.js";
import {
  getActiveConnection,
  getActiveAgentName,
  getActiveOwner,
} from "./runtime.js";
import type { ResolvedNatsAccount } from "./types.js";

export const natsPlugin = createChatChannelPlugin<ResolvedNatsAccount>({
  base: {
    id: "nats",
    meta: {
      id: "nats",
      label: "NATS",
      selectionLabel: "NATS Agent Network",
      docsPath: "/channels/nats",
      blurb: "Connect agents via NATS messaging",
    },
    capabilities: {
      chatTypes: ["direct"],
      media: false,
      reactions: false,
      threads: false,
      polls: false,
      blockStreaming: true,
    },
    streaming: {
      blockStreamingCoalesceDefaults: {
        minChars: 100,
        idleMs: 500,
      },
    },
    setupWizard: {
      channel: "nats",
      status: {
        configuredLabel: "connected",
        unconfiguredLabel: "needs setup",
        configuredScore: 1,
        unconfiguredScore: 10,
        resolveConfigured: ({ cfg }: { cfg: OpenClawConfig }) =>
          listNatsAccountIds(cfg).some((id) =>
            Boolean(resolveNatsAccount(cfg, id).agentName),
          ),
      },
      credentials: [],
      textInputs: [
        {
          inputKey: "agentName",
          message:
            "Agent name (5th subject token — agents.prompt.oc.<owner>.<agentName>)",
          placeholder: "my-agent",
          required: true,
          currentValue: ({ cfg, accountId }: Record<string, unknown>) => {
            try {
              return (
                resolveNatsAccount(cfg as OpenClawConfig, accountId as string)
                  .agentName || undefined
              );
            } catch {
              return undefined;
            }
          },
          validate: (input: unknown) => {
            const value = (
              typeof input === "object" && input !== null
                ? (input as Record<string, unknown>).value
                : String(input ?? "")
            ) as string;
            const v = value.trim();
            if (!v) return "Agent name is required";
            if (!/^[a-zA-Z0-9_-]+$/.test(v))
              return "Only letters, numbers, dashes, and underscores allowed";
            return null;
          },
        },
        {
          inputKey: "description",
          message:
            "Description (shown via $SRV.INFO when other agents discover you)",
          placeholder: "My OpenClaw agent",
          required: false,
          currentValue: ({ cfg, accountId }: Record<string, unknown>) => {
            try {
              return (
                resolveNatsAccount(cfg as OpenClawConfig, accountId as string)
                  .description || undefined
              );
            } catch {
              return undefined;
            }
          },
        },
        {
          inputKey: "owner",
          message:
            'Owner (4th subject token — the operator/account namespace; defaults to "default")',
          placeholder: "default",
          required: false,
          currentValue: ({ cfg, accountId }: Record<string, unknown>) => {
            try {
              const acc = resolveNatsAccount(
                cfg as OpenClawConfig,
                accountId as string,
              );
              return acc.owner === "default" ? undefined : acc.owner;
            } catch {
              return undefined;
            }
          },
          validate: (input: unknown) => {
            const value = (
              typeof input === "object" && input !== null
                ? (input as Record<string, unknown>).value
                : String(input ?? "")
            ) as string;
            const v = value.trim();
            if (!v) return null; // optional
            if (!/^[a-zA-Z0-9_-]+$/.test(v))
              return "Only letters, numbers, dashes, and underscores allowed";
            return null;
          },
        },
        {
          inputKey: "url",
          message: "NATS server URL (leave blank when using a context)",
          placeholder: "demo.nats.io",
          required: false,
          initialValue: () => "demo.nats.io",
          // Read the raw config field so a selected atomic context does not
          // appear as a competing direct URL in the setup wizard.
          currentValue: ({ cfg, accountId }: Record<string, unknown>) => {
            try {
              const id = (accountId as string) ?? "";
              const channels = ((cfg as Record<string, unknown>).channels ??
                {}) as Record<string, unknown>;
              const nats = (channels.nats ?? {}) as Record<string, unknown>;
              const accounts = (nats.accounts ?? {}) as Record<string, unknown>;
              const acct = (accounts[id] ?? {}) as Record<string, unknown>;
              const v = acct.url;
              return typeof v === "string" && v.length > 0 ? v : undefined;
            } catch {
              return undefined;
            }
          },
        },
        {
          inputKey: "context",
          message:
            "NATS CLI context name (optional — one complete connection/auth source)",
          placeholder: "ngs",
          required: false,
          currentValue: ({ cfg, accountId }: Record<string, unknown>) => {
            try {
              const id = (accountId as string) ?? "";
              const channels = ((cfg as Record<string, unknown>).channels ??
                {}) as Record<string, unknown>;
              const nats = (channels.nats ?? {}) as Record<string, unknown>;
              const accounts = (nats.accounts ?? {}) as Record<string, unknown>;
              const acct = (accounts[id] ?? {}) as Record<string, unknown>;
              const v = acct.context;
              return typeof v === "string" && v.length > 0 ? v : undefined;
            } catch {
              return undefined;
            }
          },
          validate: (input: unknown) => {
            const value = (
              typeof input === "object" && input !== null
                ? (input as Record<string, unknown>).value
                : String(input ?? "")
            ) as string;
            const v = value.trim();
            if (!v) return null; // optional
            // Same guard as the shared SDK context resolver, surfaced during
            // the wizard rather than only when the gateway connects.
            if (
              v.includes("/") ||
              v.includes("\\") ||
              v.includes("\0") ||
              v === ".." ||
              v.startsWith(".")
            ) {
              return "Context name must not contain path separators or start with '.'";
            }
            return null;
          },
        },
        {
          inputKey: "credentials",
          message:
            "NATS credentials file path (optional — for NKEY/JWT auth, e.g. NGS)",
          placeholder: "/home/user/.config/nats/ngs.creds",
          required: false,
          // Read the raw config field so a selected atomic context does not
          // appear as a competing direct credentials source in the wizard.
          currentValue: ({ cfg, accountId }: Record<string, unknown>) => {
            try {
              const id = (accountId as string) ?? "";
              const channels = ((cfg as Record<string, unknown>).channels ??
                {}) as Record<string, unknown>;
              const nats = (channels.nats ?? {}) as Record<string, unknown>;
              const accounts = (nats.accounts ?? {}) as Record<string, unknown>;
              const acct = (accounts[id] ?? {}) as Record<string, unknown>;
              const v = acct.credentials;
              return typeof v === "string" && v.length > 0 ? v : undefined;
            } catch {
              return undefined;
            }
          },
        },
        {
          inputKey: "senderIdentity",
          message:
            "Sender identity for this agent (off or signed; default off)",
          placeholder: "off",
          required: false,
          currentValue: ({ cfg, accountId }: Record<string, unknown>) =>
            rawAccountString(cfg, accountId, "senderIdentity"),
          validate: (input: unknown) => {
            const value = inputValue(input).trim();
            return !value || value === "off" || value === "signed"
              ? null
              : 'Sender identity must be "off" or "signed"';
          },
        },
        {
          inputKey: "minSenderTrust",
          message:
            "Minimum trust for incoming prompts (any or signed; default any)",
          placeholder: "any",
          required: false,
          currentValue: ({ cfg, accountId }: Record<string, unknown>) =>
            rawAccountString(cfg, accountId, "minSenderTrust"),
          validate: (input: unknown) => {
            const value = inputValue(input).trim();
            return !value || value === "any" || value === "signed"
              ? null
              : 'Minimum sender trust must be "any" or "signed"';
          },
        },
      ],
      completionNote: {
        title: "NATS Agent Ready",
        lines: [
          "Restart OpenClaw to connect.",
          "Discoverable via `nats req '$SRV.INFO.agents' '' --replies=0 --timeout=2s`.",
          'To silence the `plugins.allow is empty` warning, add "nats" to `plugins.allow` in your OpenClaw config — but note that once `plugins.allow` is non-empty every other non-bundled plugin you want enabled must also be listed.',
        ],
      },
    } as ChannelSetupWizard,
    config: {
      listAccountIds: (cfg: OpenClawConfig) => listNatsAccountIds(cfg),
      resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
        resolveNatsAccount(cfg, accountId),
      isEnabled: (account: ResolvedNatsAccount) => account.enabled,
      isConfigured: (account: ResolvedNatsAccount) =>
        Boolean(account.agentName),
      describeAccount: (account: ResolvedNatsAccount) => ({
        accountId: account.accountId,
        label: account.agentName,
        summary: `agents.prompt.oc.${account.owner}.${account.agentName} @ ${
          "context" in account.connectionSource
            ? `context:${account.connectionSource.context}`
            : account.url || "nats://demo.nats.io"
        }`,
      }),
    },
    setup: {
      applyAccountConfig: ({
        cfg,
        accountId,
        input,
      }: {
        cfg: OpenClawConfig;
        accountId?: string;
        input: Record<string, unknown>;
      }) => {
        const id = accountId ?? DEFAULT_ACCOUNT_ID;
        const raw = cfg as Record<string, unknown>;
        const channels = (raw.channels ?? {}) as Record<string, unknown>;
        const nats = (channels.nats ?? {}) as Record<string, unknown>;
        const accounts = (nats.accounts ?? {}) as Record<string, unknown>;
        accounts[id] = {
          ...((accounts[id] as Record<string, unknown>) ?? {}),
          ...input,
        };
        return {
          ...cfg,
          channels: { ...channels, nats: { ...nats, accounts } },
        };
      },
    },
    gateway: {
      startAccount: startNatsGateway,
      stopAccount: stopNatsGateway,
    },
    messaging: {
      normalizeTarget: (raw: string) => raw.replace(/^nats:/i, ""),
      inferTargetChatType: () => "direct",
      resolveOutboundSessionRoute: (params: Record<string, unknown>) =>
        buildChannelOutboundSessionRoute({
          cfg: params.cfg as OpenClawConfig,
          agentId: (params.agentId as string) ?? "main",
          channel: "nats",
          accountId: params.accountId as string | undefined,
          peer: { kind: "direct", id: (params.to as string) ?? "unknown" },
          chatType: "direct",
          from: `nats:${(params.to as string) ?? "unknown"}`,
          to: `nats:${(params.to as string) ?? "unknown"}`,
        }),
    },
    agentTools: () => [],
  },
  // OpenClaw's own direct-message policy remains open/no-pairing. Protocol
  // sender admission is independently enforced by AgentService.
  security: {
    dm: {
      channelKey: "nats",
      resolvePolicy: () => "allow",
      resolveAllowFrom: () => undefined,
    },
  },
  outbound: {
    base: {
      deliveryMode: "direct",
      textChunkLimit: 1024 * 1024,
    },
    attachedResults: {
      channel: "nats",
      sendText: async (ctx: Record<string, unknown>) => {
        const nc = getActiveConnection();
        const agentName = getActiveAgentName();
        const owner = getActiveOwner();
        if (!nc || !agentName || !owner) {
          throw new Error("NATS not connected");
        }
        const text = typeof ctx.text === "string" ? ctx.text : String(ctx.text);
        nc.publish(outboundSubject(owner, agentName), text);
        return {
          messageId: `nats-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        };
      },
    },
  },
}) as ChannelPlugin;

function inputValue(input: unknown): string {
  return typeof input === "object" && input !== null
    ? String((input as Record<string, unknown>).value ?? "")
    : String(input ?? "");
}

function rawAccountString(
  cfg: unknown,
  accountId: unknown,
  field: string,
): string | undefined {
  try {
    const id = typeof accountId === "string" ? accountId : DEFAULT_ACCOUNT_ID;
    const channels = ((cfg as Record<string, unknown>).channels ??
      {}) as Record<string, unknown>;
    const nats = (channels.nats ?? {}) as Record<string, unknown>;
    const accounts = (nats.accounts ?? {}) as Record<string, unknown>;
    const account = (accounts[id] ?? {}) as Record<string, unknown>;
    const value = account[field];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}
