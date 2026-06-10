import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pkg from "../../package.json" assert { type: "json" };

export interface PluginInstallOptions {
  readonly directory: string;
  readonly owner?: string;
  readonly session?: string;
  readonly packageVersion?: string;
}

export interface PluginInstallResult {
  readonly pluginPath: string;
  readonly packageJsonPath: string;
  readonly wrotePlugin: boolean;
  readonly wrotePackageJson: boolean;
  readonly env: Record<string, string>;
}

export interface PluginDoctorResult {
  readonly pluginPath: string;
  readonly packageJsonPath: string;
  readonly pluginInstalled: boolean;
  readonly dependencyInstalled: boolean;
}

const PLUGIN_WRAPPER = `import { SynadiaChannelPlugin } from "@synadia-ai/opencode-nats-channel/opencode-plugin";\n\nexport default SynadiaChannelPlugin;\n`;

export function installOpenCodePlugin(options: PluginInstallOptions): PluginInstallResult {
  const directory = resolve(options.directory);
  const opencodeDir = join(directory, ".opencode");
  const pluginsDir = join(opencodeDir, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  const pluginPath = join(pluginsDir, "synadia-channel.ts");
  const previous = existsSync(pluginPath) ? readFileSync(pluginPath, "utf8") : "";
  if (previous !== PLUGIN_WRAPPER) writeFileSync(pluginPath, PLUGIN_WRAPPER);

  const packageJsonPath = join(opencodeDir, "package.json");
  const packageJson = readPackageJson(packageJsonPath);
  packageJson.dependencies ??= {};
  const wanted = options.packageVersion ?? `^${pkg.version}`;
  if (packageJson.dependencies[pkg.name] !== wanted) packageJson.dependencies[pkg.name] = wanted;
  const rendered = `${JSON.stringify(packageJson, null, 2)}\n`;
  const previousPackage = existsSync(packageJsonPath) ? readFileSync(packageJsonPath, "utf8") : "";
  if (previousPackage !== rendered) writeFileSync(packageJsonPath, rendered);

  const env: Record<string, string> = {
    NATS_URL: "nats://127.0.0.1:4222",
    OPENCODE_PERMISSION_POLICY: "query",
  };
  if (options.owner) env.SYNADIA_OPENCODE_OWNER = options.owner;
  if (options.session) env.SYNADIA_OPENCODE_SESSION = options.session;
  return { pluginPath, packageJsonPath, wrotePlugin: previous !== PLUGIN_WRAPPER, wrotePackageJson: previousPackage !== rendered, env };
}

export function uninstallOpenCodePlugin(directory: string): { pluginPath: string; removed: boolean } {
  const pluginPath = join(resolve(directory), ".opencode", "plugins", "synadia-channel.ts");
  const removed = existsSync(pluginPath);
  if (removed) rmSync(pluginPath);
  return { pluginPath, removed };
}

export function checkOpenCodePluginInstallation(directory: string): PluginDoctorResult {
  const root = resolve(directory);
  const pluginPath = join(root, ".opencode", "plugins", "synadia-channel.ts");
  const packageJsonPath = join(root, ".opencode", "package.json");
  const pluginInstalled = existsSync(pluginPath) && readFileSync(pluginPath, "utf8") === PLUGIN_WRAPPER;
  let dependencyInstalled = false;
  if (existsSync(packageJsonPath)) {
    const packageJson = readPackageJson(packageJsonPath);
    dependencyInstalled = Boolean(packageJson.dependencies?.[pkg.name]);
  }
  return { pluginPath, packageJsonPath, pluginInstalled, dependencyInstalled };
}

export function renderPluginEnvTemplate(input: Record<string, string> = {}): string {
  const env = {
    NATS_URL: "nats://127.0.0.1:4222",
    SYNADIA_OPENCODE_OWNER: "team",
    SYNADIA_OPENCODE_SESSION: "main",
    OPENCODE_PERMISSION_POLICY: "query",
    OPENCODE_PERMISSION_TIMEOUT_MS: "300000",
    SYNADIA_OPENCODE_HEARTBEAT_INTERVAL_S: "30",
    SYNADIA_OPENCODE_KEEPALIVE_INTERVAL_S: "30",
    ...input,
  };
  return Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n") + "\n";
}

function readPackageJson(path: string): { dependencies?: Record<string, string>; [key: string]: unknown } {
  if (!existsSync(path)) return { private: true, type: "module", dependencies: {} };
  return JSON.parse(readFileSync(path, "utf8")) as { dependencies?: Record<string, string>; [key: string]: unknown };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
