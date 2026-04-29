import {
  createChatChannelPlugin,
  buildChannelOutboundSessionRoute,
  DEFAULT_ACCOUNT_ID,
} from "openclaw/plugin-sdk/core";
import type { ChannelPlugin, ChannelSetupWizard, OpenClawConfig } from "openclaw/plugin-sdk/core";
import { outboundSubject } from "./nats/index.js";
import { listNatsAccountIds, resolveNatsAccount } from "./accounts.js";
import { startNatsGateway, stopNatsGateway } from "./gateway.js";
import { getActiveConnection, getActiveAgentName, getActiveOwner } from "./runtime.js";
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
          listNatsAccountIds(cfg).some((id) => Boolean(resolveNatsAccount(cfg, id).agentName)),
      },
      credentials: [],
      textInputs: [
        {
          inputKey: "agentName",
          message: "Agent name (5th subject token — agents.prompt.oc.<owner>.<agentName>)",
          placeholder: "my-agent",
          required: true,
          currentValue: ({ cfg, accountId }: Record<string, unknown>) => {
            try {
              return resolveNatsAccount(cfg as OpenClawConfig, accountId as string).agentName || undefined;
            } catch { return undefined; }
          },
          validate: (input: unknown) => {
            const value = (typeof input === "object" && input !== null ? (input as Record<string, unknown>).value : String(input ?? "")) as string;
            const v = value.trim();
            if (!v) return "Agent name is required";
            if (!/^[a-zA-Z0-9_-]+$/.test(v)) return "Only letters, numbers, dashes, and underscores allowed";
            return null;
          },
        },
        {
          inputKey: "description",
          message: "Description (shown via $SRV.INFO when other agents discover you)",
          placeholder: "My OpenClaw agent",
          required: false,
          currentValue: ({ cfg, accountId }: Record<string, unknown>) => {
            try {
              return resolveNatsAccount(cfg as OpenClawConfig, accountId as string).description || undefined;
            } catch { return undefined; }
          },
        },
        {
          inputKey: "owner",
          message: "Owner (3rd subject token — the operator/account namespace; defaults to \"default\")",
          placeholder: "default",
          required: false,
          currentValue: ({ cfg, accountId }: Record<string, unknown>) => {
            try {
              const acc = resolveNatsAccount(cfg as OpenClawConfig, accountId as string);
              return acc.owner === "default" ? undefined : acc.owner;
            } catch { return undefined; }
          },
          validate: (input: unknown) => {
            const value = (typeof input === "object" && input !== null ? (input as Record<string, unknown>).value : String(input ?? "")) as string;
            const v = value.trim();
            if (!v) return null; // optional
            if (!/^[a-zA-Z0-9_-]+$/.test(v)) return "Only letters, numbers, dashes, and underscores allowed";
            return null;
          },
        },
        {
          inputKey: "url",
          message: "NATS server URL (leave blank when using a context)",
          placeholder: "demo.nats.io",
          required: false,
          initialValue: () => "demo.nats.io",
          // Read the raw config field directly rather than going through
          // `resolveNatsAccount`, which now expands `config.context` into
          // `resolved.url`. If the wizard SDK persists `currentValue` back
          // into the saved config, going via `resolveNatsAccount` would
          // bake the context-derived URL into `config.url` — silently
          // shadowing future context-file updates at precedence 5.
          currentValue: ({ cfg, accountId }: Record<string, unknown>) => {
            try {
              const id = (accountId as string) ?? "";
              const channels = ((cfg as Record<string, unknown>).channels ?? {}) as Record<string, unknown>;
              const nats = (channels.nats ?? {}) as Record<string, unknown>;
              const accounts = (nats.accounts ?? {}) as Record<string, unknown>;
              const acct = (accounts[id] ?? {}) as Record<string, unknown>;
              const v = acct.url;
              return typeof v === "string" && v.length > 0 ? v : undefined;
            } catch { return undefined; }
          },
        },
        {
          inputKey: "context",
          message: "NATS CLI context name (optional — sources url + credentials from ~/.config/nats/context/<name>.json)",
          placeholder: "ngs",
          required: false,
          currentValue: ({ cfg, accountId }: Record<string, unknown>) => {
            try {
              const id = (accountId as string) ?? "";
              const channels = ((cfg as Record<string, unknown>).channels ?? {}) as Record<string, unknown>;
              const nats = (channels.nats ?? {}) as Record<string, unknown>;
              const accounts = (nats.accounts ?? {}) as Record<string, unknown>;
              const acct = (accounts[id] ?? {}) as Record<string, unknown>;
              const v = acct.context;
              return typeof v === "string" && v.length > 0 ? v : undefined;
            } catch { return undefined; }
          },
          validate: (input: unknown) => {
            const value = (typeof input === "object" && input !== null ? (input as Record<string, unknown>).value : String(input ?? "")) as string;
            const v = value.trim();
            if (!v) return null; // optional
            // Same path-traversal guard as loadNatsContextFromFile so the
            // user gets feedback during the wizard rather than at connect.
            if (v.includes("/") || v.includes("\\") || v.includes("\0") || v === ".." || v.startsWith(".")) {
              return "Context name must not contain path separators or start with '.'";
            }
            return null;
          },
        },
        {
          inputKey: "credentials",
          message: "NATS credentials file path (optional — for NKEY/JWT auth, e.g. NGS)",
          placeholder: "/home/user/.config/nats/ngs.creds",
          required: false,
          // Read the raw config field directly — same reason as `url`
          // above. `resolveNatsAccount` would return the context-derived
          // creds path, which the wizard SDK may persist back, baking it
          // into `config.credentials` and shadowing future updates the
          // user makes to the underlying context file.
          currentValue: ({ cfg, accountId }: Record<string, unknown>) => {
            try {
              const id = (accountId as string) ?? "";
              const channels = ((cfg as Record<string, unknown>).channels ?? {}) as Record<string, unknown>;
              const nats = (channels.nats ?? {}) as Record<string, unknown>;
              const accounts = (nats.accounts ?? {}) as Record<string, unknown>;
              const acct = (accounts[id] ?? {}) as Record<string, unknown>;
              const v = acct.credentials;
              return typeof v === "string" && v.length > 0 ? v : undefined;
            } catch { return undefined; }
          },
        },
      ],
      completionNote: {
        title: "NATS Agent Ready",
        lines: [
          "Restart OpenClaw to connect.",
          "Discoverable via `nats req '$SRV.INFO.agents' '' --replies=0 --timeout=2s`.",
          "To silence the `plugins.allow is empty` warning, add \"nats\" to `plugins.allow` in your OpenClaw config — but note that once `plugins.allow` is non-empty every other non-bundled plugin you want enabled must also be listed.",
        ],
      },
    } as ChannelSetupWizard,
    config: {
      listAccountIds: (cfg: OpenClawConfig) => listNatsAccountIds(cfg),
      resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => resolveNatsAccount(cfg, accountId),
      isEnabled: (account: ResolvedNatsAccount) => account.enabled,
      isConfigured: (account: ResolvedNatsAccount) => Boolean(account.agentName),
      describeAccount: (account: ResolvedNatsAccount) => ({
        accountId: account.accountId,
        label: account.agentName,
        summary: `agents.prompt.oc.${account.owner}.${account.agentName} @ ${account.url}`,
      }),
    },
    setup: {
      applyAccountConfig: ({ cfg, accountId, input }: { cfg: OpenClawConfig; accountId?: string; input: Record<string, unknown> }) => {
        const id = accountId ?? DEFAULT_ACCOUNT_ID;
        const raw = cfg as Record<string, unknown>;
        const channels = (raw.channels ?? {}) as Record<string, unknown>;
        const nats = (channels.nats ?? {}) as Record<string, unknown>;
        const accounts = (nats.accounts ?? {}) as Record<string, unknown>;
        accounts[id] = {
          ...(accounts[id] as Record<string, unknown> ?? {}),
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
  // Open security: all NATS senders allowed, no pairing
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
      sendText: async (ctx: Record<string, unknown>) => {
        const nc = getActiveConnection();
        const agentName = getActiveAgentName();
        const owner = getActiveOwner();
        if (!nc || !agentName || !owner) {
          return [{ success: false, error: "NATS not connected" } as Record<string, unknown>];
        }
        const text = typeof ctx.text === "string" ? ctx.text : String(ctx.text);
        nc.publish(outboundSubject(owner, agentName), text);
        return [{ success: true } as Record<string, unknown>];
      },
    },
  },
}) as ChannelPlugin;
