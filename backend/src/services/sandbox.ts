import { Sandbox, type SandboxInfo } from "e2b";
import crypto from "crypto";

export const PROJECT_WORKSPACE_PATH =
  process.env.E2B_WORKDIR || "/app/my-nextjs-app";
export const PROJECT_PREVIEW_PORT = Number(
  process.env.E2B_PREVIEW_PORT || "3000"
);

const PROJECT_LABEL = "klawpen";
const RUNTIME_LABEL = "e2b";
const E2B_TEMPLATE = process.env.E2B_TEMPLATE || "base";
const E2B_SANDBOX_TIMEOUT_MS = Number(
  process.env.E2B_SANDBOX_TIMEOUT_MS || "3600000"
);
const E2B_COMMAND_TIMEOUT_MS = Number(
  process.env.E2B_COMMAND_TIMEOUT_MS || "120000"
);
const E2B_INSTALL_TIMEOUT_MS = Number(
  process.env.E2B_INSTALL_TIMEOUT_MS || "240000"
);
const E2B_START_TIMEOUT_MS = Number(
  process.env.E2B_START_TIMEOUT_MS || "120000"
);
const E2B_DOMAIN = process.env.E2B_DOMAIN || "e2b.app";
const DEV_RUNTIME_DIR = `${PROJECT_WORKSPACE_PATH}/.klawpen`;
const DEV_SERVER_LOG_PATH = `${DEV_RUNTIME_DIR}/dev-server.log`;
const DEV_SERVER_PID_PATH = `${DEV_RUNTIME_DIR}/dev-server.pid`;
const DEV_SERVER_EXIT_PATH = `${DEV_RUNTIME_DIR}/dev-server.exit`;
const DEV_SERVER_START_SCRIPT_PATH = `${DEV_RUNTIME_DIR}/start-dev-server.sh`;
const DEV_SERVER_LOG_TAIL_BYTES = Number(
  process.env.E2B_DEV_SERVER_LOG_TAIL_BYTES || "12000"
);
const DEFAULT_PUBLIC_API_ORIGIN =
  process.env.NODE_ENV === "production"
    ? "https://api.builder.klawpen.com"
    : "http://localhost:4000";
const PUBLIC_PREVIEW_PROXY_ORIGIN = (
  process.env.PREVIEW_PROXY_PUBLIC_ORIGIN ||
  process.env.PUBLIC_API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  DEFAULT_PUBLIC_API_ORIGIN
).replace(/\/$/, "");
const PREVIEW_PROXY_SECRET =
  process.env.PREVIEW_PROXY_SECRET || process.env.BACKEND_API_TOKEN || "";
const SESSION_RECONNECT_ENABLED =
  process.env.E2B_RECONNECT_BY_METADATA !== "false";

export interface ProjectOwner {
  teamId: number;
  localUserId?: number | null;
  projectId?: string | null;
}

export interface CreateSandboxOptions {
  restoreSnapshot?: boolean;
}

interface ProjectSandboxSession {
  containerId: string;
  sandboxId: string;
  sandbox: Sandbox;
  owner: ProjectOwner;
  projectId?: string | null;
  previewUrl: string;
  createdAt: string;
  status: "running" | "stopped";
  devServerStarted: boolean;
  devServerPid?: number;
  devServerCommand?: string;
  devServerFramework?: "next" | "vite" | "generic";
  labels: Record<string, string>;
}

interface ProjectShape {
  hasNextAppRouter: boolean;
  hasNextPagesRouter: boolean;
  hasViteHtml: boolean;
  hasViteEntry: boolean;
}

interface PackageManifest {
  name?: string;
  version?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface DevServerPlan {
  framework: "next" | "vite" | "generic";
  commandText: string;
  displayCommand: string;
  manifestChanged: boolean;
  devScript: string;
  shape: ProjectShape;
}

const sessions = new Map<string, ProjectSandboxSession>();
const createLocks = new Map<string, Promise<ProjectSandboxSession>>();

function requireE2bApiKey() {
  if (!process.env.E2B_API_KEY) {
    throw new Error("E2B_API_KEY is required for Klawpen E2B sandboxes");
  }
}

function assertSafeContainerId(containerId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerId)) {
    throw new Error("Invalid container id");
  }
}

function ownerLabels(owner: ProjectOwner) {
  return {
    teamId: String(owner.teamId),
    userId: owner.localUserId ? String(owner.localUserId) : "",
    projectId: owner.projectId || "",
  };
}

function buildLabels(containerId: string, owner: ProjectOwner, sandboxId = "") {
  return {
    project: PROJECT_LABEL,
    runtime: RUNTIME_LABEL,
    type: "klawpen-workspace",
    klawpenContainerId: containerId,
    containerId,
    sandboxId,
    assignedPort: String(PROJECT_PREVIEW_PORT),
    workspacePath: PROJECT_WORKSPACE_PATH,
    template: E2B_TEMPLATE,
    ...ownerLabels(owner),
  };
}

function isOwnedByAccount(
  labels: Record<string, string>,
  owner?: ProjectOwner | null
): boolean {
  if (!owner) return true;
  return labels.teamId === String(owner.teamId);
}

function toPreviewUrl(sandbox: Sandbox, port = PROJECT_PREVIEW_PORT) {
  const host = sandbox.getHost(port);
  return host.startsWith("http://") || host.startsWith("https://")
    ? host
    : `https://${host}`;
}

function buildPreviewUrlFromSandboxId(sandboxId: string, port = PROJECT_PREVIEW_PORT) {
  return `https://${port}-${sandboxId}.${E2B_DOMAIN}`;
}

function signPreviewToken(containerId: string): string | null {
  if (!PREVIEW_PROXY_SECRET) return null;

  return crypto
    .createHmac("sha256", PREVIEW_PROXY_SECRET)
    .update(containerId)
    .digest("hex");
}

export function signProjectPreviewToken(containerId: string): string | null {
  return signPreviewToken(containerId);
}

export function isValidPreviewToken(
  containerId: string,
  token?: string | null
): boolean {
  if (!PREVIEW_PROXY_SECRET) return true;
  if (!token) return false;
  const expected = signPreviewToken(containerId);
  if (!expected || expected.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

export function getPreviewProxyOrigin() {
  return PUBLIC_PREVIEW_PROXY_ORIGIN;
}

export function buildPreviewProxyUrl(containerId: string): string {
  const token = signPreviewToken(containerId);
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${PUBLIC_PREVIEW_PROXY_ORIGIN}/preview/${containerId}/${tokenQuery}`;
}

export function buildDirectPreviewUrl(containerId: string): string | null {
  return sessions.get(containerId)?.previewUrl || null;
}

function makeContainerInfo(session: ProjectSandboxSession) {
  return {
    Id: session.containerId,
    id: session.containerId,
    Name: `/klawpen-e2b-${session.containerId}`,
    Image: `e2b:${E2B_TEMPLATE}`,
    Created: session.createdAt,
    Config: {
      Image: `e2b:${E2B_TEMPLATE}`,
      Labels: session.labels,
    },
    Labels: session.labels,
    State: {
      Running: session.status === "running",
      Paused: false,
      Restarting: false,
      Dead: false,
      Status: session.status,
    },
    HostConfig: {
      PortBindings: {
        "3000/tcp": [{ HostPort: String(PROJECT_PREVIEW_PORT) }],
      },
    },
    NetworkSettings: {
      Ports: {
        "3000/tcp": [{ HostPort: String(PROJECT_PREVIEW_PORT) }],
      },
    },
  };
}

export class ProjectSandboxContainer {
  id: string;

  constructor(private readonly getSession: () => Promise<ProjectSandboxSession>) {
    this.id = "";
  }

  async inspect() {
    const session = await this.getSession();
    this.id = session.containerId;
    return makeContainerInfo(session);
  }

  async start() {
    const session = await this.getSession();
    await startDevServer(session);
  }

  async stop() {
    const session = await this.getSession();
    await stopSandbox(session.containerId, session.owner);
  }

  async remove() {
    const session = await this.getSession();
    await deleteSandbox(session.containerId, session.owner);
  }
}

function makeContainer(session: ProjectSandboxSession): ProjectSandboxContainer {
  const container = new ProjectSandboxContainer(async () => session);
  container.id = session.containerId;
  return container;
}

async function connectFromInfo(info: SandboxInfo): Promise<ProjectSandboxSession> {
  const containerId = info.metadata.klawpenContainerId || info.metadata.containerId;
  if (!containerId) {
    throw new Error("E2B sandbox metadata does not include a Klawpen container id");
  }

  const sandbox = await Sandbox.connect(info.sandboxId, {
    timeoutMs: E2B_SANDBOX_TIMEOUT_MS,
  });
  const owner: ProjectOwner = {
    teamId: Number(info.metadata.teamId || "0"),
    localUserId: info.metadata.userId ? Number(info.metadata.userId) : null,
    projectId: info.metadata.projectId || null,
  };
  const labels = {
    ...buildLabels(containerId, owner, info.sandboxId),
    ...info.metadata,
    sandboxId: info.sandboxId,
  };
  const session: ProjectSandboxSession = {
    containerId,
    sandboxId: info.sandboxId,
    sandbox,
    owner,
    projectId: owner.projectId,
    previewUrl: buildPreviewUrlFromSandboxId(info.sandboxId),
    createdAt: info.startedAt?.toISOString?.() || new Date().toISOString(),
    status: info.state === "paused" ? "stopped" : "running",
    devServerStarted: info.state === "running",
    labels,
  };
  sessions.set(containerId, session);
  return session;
}

async function findSandboxByContainerId(containerId: string) {
  if (!SESSION_RECONNECT_ENABLED) return null;
  requireE2bApiKey();

  try {
    const paginator = Sandbox.list({
      query: {
        metadata: {
          project: PROJECT_LABEL,
          klawpenContainerId: containerId,
        },
        state: ["running", "paused"],
      },
      limit: 10,
    });
    const matches = await paginator.nextItems();
    const match = matches[0];
    return match ? await connectFromInfo(match) : null;
  } catch (error) {
    console.warn("e2b_sandbox_metadata_lookup_failed", {
      trace: "e2b_sandbox_metadata_lookup_failed",
      containerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function getSession(
  containerId: string,
  owner?: ProjectOwner | null
): Promise<ProjectSandboxSession> {
  assertSafeContainerId(containerId);
  const existing = sessions.get(containerId) || (await findSandboxByContainerId(containerId));

  if (!existing) {
    throw new Error("Project sandbox not found");
  }
  if (!isOwnedByAccount(existing.labels, owner)) {
    throw new Error("Project sandbox does not belong to this account");
  }
  return existing;
}

async function writeWorkspaceTemplate(session: ProjectSandboxSession) {
  const files = createWorkspaceTemplateFiles();
  await session.sandbox.files.write(
    files.map((file) => ({
      path: `${PROJECT_WORKSPACE_PATH}/${file.path}`,
      data: file.content,
    })),
    { requestTimeoutMs: E2B_COMMAND_TIMEOUT_MS }
  );
}

async function prepareWorkspaceDirectory(session: ProjectSandboxSession) {
  await session.sandbox.commands.run(
    `mkdir -p ${shellQuote(PROJECT_WORKSPACE_PATH)} && chown -R user:user ${shellQuote(PROJECT_WORKSPACE_PATH)} /app 2>/dev/null || true`,
    {
      user: "root",
      timeoutMs: E2B_COMMAND_TIMEOUT_MS,
    }
  );
}

async function installDependencies(session: ProjectSandboxSession) {
  console.log("e2b_dependency_install_started", {
    trace: "e2b_dependency_install_started",
    containerId: session.containerId,
    sandboxId: session.sandboxId,
  });

  const result = await session.sandbox.commands.run(
    "npm install --prefer-offline --no-audit --no-fund --quiet",
    {
      cwd: PROJECT_WORKSPACE_PATH,
      timeoutMs: E2B_INSTALL_TIMEOUT_MS,
      onStdout: (data) => logSandboxOutput("stdout", session, data),
      onStderr: (data) => logSandboxOutput("stderr", session, data),
    }
  );

  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr || result.stdout || "E2B dependency install failed"
    );
  }

  console.log("e2b_dependency_install_completed", {
    trace: "e2b_dependency_install_completed",
    containerId: session.containerId,
    sandboxId: session.sandboxId,
  });
}

function logSandboxOutput(
  stream: "stdout" | "stderr",
  session: ProjectSandboxSession,
  data: string
) {
  const trimmed = data.trim();
  if (!trimmed) return;
  console.log("e2b_command_output", {
    trace: "e2b_command_output",
    stream,
    containerId: session.containerId,
    sandboxId: session.sandboxId,
    output: trimmed.slice(0, 500),
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readWorkspaceTextFile(
  session: ProjectSandboxSession,
  relativePath: string
): Promise<string | null> {
  try {
    return await session.sandbox.files.read(
      `${PROJECT_WORKSPACE_PATH}/${relativePath}`,
      { requestTimeoutMs: E2B_COMMAND_TIMEOUT_MS }
    );
  } catch {
    return null;
  }
}

async function writeWorkspaceTextFile(
  session: ProjectSandboxSession,
  relativePath: string,
  content: string
) {
  await session.sandbox.files.write(
    `${PROJECT_WORKSPACE_PATH}/${relativePath}`,
    content,
    { requestTimeoutMs: E2B_COMMAND_TIMEOUT_MS }
  );
}

function parsePackageManifest(raw: string | null): PackageManifest | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    console.error("e2b_package_manifest_parse_failed", {
      trace: "e2b_package_manifest_parse_failed",
      error: error instanceof Error ? error.message : String(error),
      preview: raw.slice(0, 500),
    });
    return null;
  }
}

async function detectProjectShape(
  session: ProjectSandboxSession
): Promise<ProjectShape> {
  const command = [
    `[ -d ${shellQuote(`${PROJECT_WORKSPACE_PATH}/src/app`)} ] && echo hasNextAppRouter=1 || true`,
    `[ -d ${shellQuote(`${PROJECT_WORKSPACE_PATH}/pages`)} ] && echo hasNextPagesRouter=1 || true`,
    `[ -f ${shellQuote(`${PROJECT_WORKSPACE_PATH}/index.html`)} ] && echo hasViteHtml=1 || true`,
    `[ -f ${shellQuote(`${PROJECT_WORKSPACE_PATH}/src/main.tsx`)} -o -f ${shellQuote(`${PROJECT_WORKSPACE_PATH}/src/main.jsx`)} -o -f ${shellQuote(`${PROJECT_WORKSPACE_PATH}/src/main.ts`)} -o -f ${shellQuote(`${PROJECT_WORKSPACE_PATH}/src/main.js`)} ] && echo hasViteEntry=1 || true`,
  ].join("; ");

  const result = await session.sandbox.commands.run(command, {
    cwd: PROJECT_WORKSPACE_PATH,
    timeoutMs: E2B_COMMAND_TIMEOUT_MS,
  });
  const output = result.stdout || "";

  return {
    hasNextAppRouter: output.includes("hasNextAppRouter=1"),
    hasNextPagesRouter: output.includes("hasNextPagesRouter=1"),
    hasViteHtml: output.includes("hasViteHtml=1"),
    hasViteEntry: output.includes("hasViteEntry=1"),
  };
}

function inferDevFramework(
  manifest: PackageManifest,
  shape: ProjectShape
): "next" | "vite" | "generic" {
  const devScript = manifest.scripts?.dev || "";
  const allDependencies = {
    ...(manifest.dependencies || {}),
    ...(manifest.devDependencies || {}),
  };

  const hasNextShape = shape.hasNextAppRouter || shape.hasNextPagesRouter;
  const hasViteShape = shape.hasViteHtml && shape.hasViteEntry;
  if (/\bvite\b/i.test(devScript)) return "vite";
  if (hasViteShape) return "vite";
  if (/\bnext\b/i.test(devScript)) return "next";
  if (hasNextShape && !hasViteShape) return "next";
  if (Boolean(allDependencies.vite) && !Boolean(allDependencies.next)) return "vite";
  if (Boolean(allDependencies.next)) return "next";
  if (hasViteShape) return "vite";

  return "generic";
}

function defaultPackageManifest(): PackageManifest {
  return {
    name: "klawpen-workspace",
    version: "0.1.0",
    private: true,
    scripts: {
      dev: "next dev",
      build: "next build",
      start: "next start",
    },
    dependencies: {
      "@tailwindcss/postcss": "^4.1.7",
      "lucide-react": "^0.511.0",
      next: "15.5.18",
      react: "^19.0.0",
      "react-dom": "^19.0.0",
      tailwindcss: "^4.1.7",
    },
    devDependencies: {
      "@types/node": "^20",
      "@types/react": "^19",
      "@types/react-dom": "^19",
      typescript: "^5",
    },
  };
}

function ensureDependency(
  manifest: PackageManifest,
  section: "dependencies" | "devDependencies",
  name: string,
  version: string
): boolean {
  const dependencies = manifest.dependencies || {};
  const devDependencies = manifest.devDependencies || {};
  if (dependencies[name] || devDependencies[name]) return false;

  manifest[section] = {
    ...(manifest[section] || {}),
    [name]: version,
  };
  return true;
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

async function prepareDevServerPlan(
  session: ProjectSandboxSession
): Promise<DevServerPlan> {
  const rawManifest = await readWorkspaceTextFile(session, "package.json");
  const parsedManifest = parsePackageManifest(rawManifest);
  const manifest = parsedManifest || defaultPackageManifest();
  const shape = await detectProjectShape(session);
  manifest.scripts = asStringRecord(manifest.scripts);
  manifest.dependencies = asStringRecord(manifest.dependencies);
  manifest.devDependencies = asStringRecord(manifest.devDependencies);

  const framework = inferDevFramework(manifest, shape);
  const scripts = manifest.scripts;
  let manifestChanged = !rawManifest || !parsedManifest;

  const expectedDevScript = framework === "vite" ? "vite" : "next dev";
  if (scripts.dev !== expectedDevScript) {
    scripts.dev = expectedDevScript;
    manifestChanged = true;
  }

  manifest.scripts = scripts;

  if (framework === "vite") {
    manifestChanged =
      ensureDependency(manifest, "dependencies", "react", "^19.0.0") ||
      manifestChanged;
    manifestChanged =
      ensureDependency(manifest, "dependencies", "react-dom", "^19.0.0") ||
      manifestChanged;
    manifestChanged =
      ensureDependency(manifest, "devDependencies", "vite", "^6.0.0") ||
      manifestChanged;
    manifestChanged =
      ensureDependency(manifest, "devDependencies", "@vitejs/plugin-react", "^4.3.4") ||
      manifestChanged;
    manifestChanged =
      ensureDependency(manifest, "devDependencies", "typescript", "^5") ||
      manifestChanged;
  } else {
    manifestChanged =
      ensureDependency(manifest, "dependencies", "next", "15.5.18") ||
      manifestChanged;
    manifestChanged =
      ensureDependency(manifest, "dependencies", "react", "^19.0.0") ||
      manifestChanged;
    manifestChanged =
      ensureDependency(manifest, "dependencies", "react-dom", "^19.0.0") ||
      manifestChanged;
    manifestChanged =
      ensureDependency(manifest, "devDependencies", "typescript", "^5") ||
      manifestChanged;
    manifestChanged =
      ensureDependency(manifest, "devDependencies", "@types/node", "^20") ||
      manifestChanged;
    manifestChanged =
      ensureDependency(manifest, "devDependencies", "@types/react", "^19") ||
      manifestChanged;
    manifestChanged =
      ensureDependency(manifest, "devDependencies", "@types/react-dom", "^19") ||
      manifestChanged;
  }

  if (manifestChanged) {
    await writeWorkspaceTextFile(
      session,
      "package.json",
      `${JSON.stringify(manifest, null, 2)}\n`
    );
  }

  const commandText =
    framework === "vite"
      ? `npm run dev -- --host 0.0.0.0 --port ${PROJECT_PREVIEW_PORT}`
      : `npm run dev -- --hostname 0.0.0.0 --port ${PROJECT_PREVIEW_PORT}`;

  return {
    framework,
    commandText,
    displayCommand: commandText,
    manifestChanged,
    devScript: manifest.scripts?.dev || "",
    shape,
  };
}

async function killExistingDevServer(session: ProjectSandboxSession) {
  const pid = await readWorkspaceTextFile(session, ".klawpen/dev-server.pid");
  const trimmedPid = pid?.trim();
  if (trimmedPid && /^\d+$/.test(trimmedPid)) {
    try {
      await session.sandbox.commands.kill(Number(trimmedPid), {
        requestTimeoutMs: E2B_COMMAND_TIMEOUT_MS,
      });
    } catch (error) {
      console.warn("e2b_previous_dev_server_kill_failed", {
        trace: "e2b_previous_dev_server_kill_failed",
        containerId: session.containerId,
        sandboxId: session.sandboxId,
        pid: trimmedPid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    await session.sandbox.commands.run(
      [
        "pkill -f '[n]pm run dev' 2>/dev/null || true",
        "pkill -f '[n]ext dev' 2>/dev/null || true",
        "pkill -f '[v]ite' 2>/dev/null || true",
      ].join("; "),
      { timeoutMs: E2B_COMMAND_TIMEOUT_MS }
    );
  } catch {}

  session.devServerStarted = false;
  session.devServerPid = undefined;
}

async function readDevServerDiagnostics(
  session: ProjectSandboxSession
): Promise<string> {
  const command = [
    `echo "--- klawpen dev server log (${DEV_SERVER_LOG_PATH}) ---"`,
    `tail -c ${Math.max(1000, DEV_SERVER_LOG_TAIL_BYTES)} ${shellQuote(DEV_SERVER_LOG_PATH)} 2>/dev/null || echo "No dev-server.log found."`,
    `echo "--- klawpen dev server pid ---"`,
    `cat ${shellQuote(DEV_SERVER_PID_PATH)} 2>/dev/null || true`,
    `echo "--- klawpen dev server exit ---"`,
    `cat ${shellQuote(DEV_SERVER_EXIT_PATH)} 2>/dev/null || true`,
    `echo "--- process list ---"`,
    `ps -ef | grep -E 'next|vite|npm|node' | grep -v grep || true`,
    `echo "--- package.json scripts ---"`,
    `node -e "const fs=require('fs'); const p='package.json'; try { const pkg=JSON.parse(fs.readFileSync(p,'utf8')); console.log(JSON.stringify(pkg.scripts||{}, null, 2)); } catch (e) { console.log('package.json parse/read failed:', e.message); }"`,
  ].join("; ");

  try {
    const result = await session.sandbox.commands.run(command, {
      cwd: PROJECT_WORKSPACE_PATH,
      timeoutMs: E2B_COMMAND_TIMEOUT_MS,
    });
    return [result.stdout, result.stderr].filter(Boolean).join("\n");
  } catch (error) {
    return `Failed to collect E2B dev server diagnostics: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function writeDevServerLaunchScript(
  session: ProjectSandboxSession,
  plan: DevServerPlan
) {
  await session.sandbox.commands.run(`mkdir -p ${shellQuote(DEV_RUNTIME_DIR)}`, {
    cwd: PROJECT_WORKSPACE_PATH,
    timeoutMs: E2B_COMMAND_TIMEOUT_MS,
  });

  const script = `#!/bin/sh
set -eu
cd ${shellQuote(PROJECT_WORKSPACE_PATH)}
mkdir -p ${shellQuote(DEV_RUNTIME_DIR)}
rm -f ${shellQuote(DEV_SERVER_EXIT_PATH)}
: > ${shellQuote(DEV_SERVER_LOG_PATH)}
{
  trap '' HUP
  echo "[klawpen] starting dev server at $(date -Iseconds)"
  echo "[klawpen] framework=${plan.framework}"
  echo "[klawpen] command=${plan.displayCommand}"
  printf '%s\\n' ${shellQuote(`[klawpen] dev_script=${plan.devScript}`)}
  set +e
  ${plan.commandText}
  code=$?
  set -e
  echo "[klawpen] dev server exited with code $code at $(date -Iseconds)"
  echo "$code" > ${shellQuote(DEV_SERVER_EXIT_PATH)}
  exit "$code"
} >> ${shellQuote(DEV_SERVER_LOG_PATH)} 2>&1
`;

  await session.sandbox.files.write(DEV_SERVER_START_SCRIPT_PATH, script, {
    requestTimeoutMs: E2B_COMMAND_TIMEOUT_MS,
  });
  await session.sandbox.commands.run(
    `chmod +x ${shellQuote(DEV_SERVER_START_SCRIPT_PATH)}`,
    { cwd: PROJECT_WORKSPACE_PATH, timeoutMs: E2B_COMMAND_TIMEOUT_MS }
  );
}

async function waitForPreviewPort(
  session: ProjectSandboxSession,
  timeoutMs: number
) {
  const startedAt = Date.now();
  let lastDiagnostics = "";

  while (Date.now() - startedAt < timeoutMs) {
    if (await isPreviewPortListening(session)) {
      return;
    }

    const exitCode = await readWorkspaceTextFile(
      session,
      ".klawpen/dev-server.exit"
    );
    if (exitCode?.trim()) {
      lastDiagnostics = await readDevServerDiagnostics(session);
      break;
    }

    await sleep(2_000);
  }

  if (!lastDiagnostics) {
    lastDiagnostics = await readDevServerDiagnostics(session);
  }

  console.error("e2b_dev_server_port_not_listening", {
    trace: "e2b_dev_server_port_not_listening",
    containerId: session.containerId,
    sandboxId: session.sandboxId,
    port: PROJECT_PREVIEW_PORT,
    timeoutMs,
    diagnostics: lastDiagnostics.slice(-4_000),
  });

  throw new Error(
    `E2B dev server did not open port ${PROJECT_PREVIEW_PORT}. Diagnostics:\n${lastDiagnostics.slice(
      -6_000
    )}`
  );
}

async function isPreviewPortListening(session: ProjectSandboxSession) {
  try {
    const result = await session.sandbox.commands.run(
      `node -e "const net=require('net'); const socket=net.connect(${PROJECT_PREVIEW_PORT}, '127.0.0.1'); socket.on('connect', () => { socket.destroy(); process.exit(0); }); socket.on('error', () => process.exit(1)); setTimeout(() => process.exit(1), 1500);"`,
      {
        timeoutMs: 10_000,
      }
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export async function startDevServer(
  session: ProjectSandboxSession,
  options: { force?: boolean } = {}
) {
  if (
    !options.force &&
    session.devServerStarted &&
    session.status === "running" &&
    (await isPreviewPortListening(session))
  ) {
    return;
  }

  if (options.force || session.devServerStarted) {
    await killExistingDevServer(session);
  }

  console.log("e2b_dev_server_starting", {
    trace: "e2b_dev_server_starting",
    containerId: session.containerId,
    sandboxId: session.sandboxId,
    port: PROJECT_PREVIEW_PORT,
  });

  const plan = await prepareDevServerPlan(session);
  console.log("e2b_dev_server_preflight_completed", {
    trace: "e2b_dev_server_preflight_completed",
    containerId: session.containerId,
    sandboxId: session.sandboxId,
    framework: plan.framework,
    command: plan.displayCommand,
    devScript: plan.devScript,
    manifestChanged: plan.manifestChanged,
    shape: plan.shape,
  });

  if (plan.manifestChanged) {
    await installDependencies(session);
  }

  await writeDevServerLaunchScript(session, plan);

  const handle = await session.sandbox.commands.run(
    DEV_SERVER_START_SCRIPT_PATH,
    {
      cwd: PROJECT_WORKSPACE_PATH,
      background: true,
      timeoutMs: E2B_COMMAND_TIMEOUT_MS,
      onStdout: (data) => logSandboxOutput("stdout", session, data),
      onStderr: (data) => logSandboxOutput("stderr", session, data),
    }
  );

  await session.sandbox.files.write(DEV_SERVER_PID_PATH, String(handle.pid), {
    requestTimeoutMs: E2B_COMMAND_TIMEOUT_MS,
  });
  await waitForPreviewPort(session, E2B_START_TIMEOUT_MS);

  session.devServerStarted = true;
  session.devServerPid = handle.pid;
  session.devServerCommand = plan.displayCommand;
  session.devServerFramework = plan.framework;
  session.status = "running";
  session.previewUrl = toPreviewUrl(session.sandbox, PROJECT_PREVIEW_PORT);

  console.log("e2b_dev_server_started", {
    trace: "e2b_dev_server_started",
    containerId: session.containerId,
    sandboxId: session.sandboxId,
    pid: session.devServerPid,
    framework: session.devServerFramework,
    command: session.devServerCommand,
    previewUrl: session.previewUrl,
  });
}

export async function createSandboxWorkspace(
  containerId: string,
  owner: ProjectOwner,
  _options: CreateSandboxOptions = {}
): Promise<{ container: ProjectSandboxContainer; port: number }> {
  assertSafeContainerId(containerId);
  requireE2bApiKey();

  const existingLock = createLocks.get(containerId);
  if (existingLock) {
    const session = await existingLock;
    return { container: makeContainer(session), port: PROJECT_PREVIEW_PORT };
  }

  const createPromise = (async () => {
    const metadata = buildLabels(containerId, owner);

    console.log("e2b_sandbox_create_started", {
      trace: "e2b_sandbox_create_started",
      containerId,
      projectId: owner.projectId || null,
      template: E2B_TEMPLATE,
      timeoutMs: E2B_SANDBOX_TIMEOUT_MS,
    });

    const sandbox = await Sandbox.create({
      template: E2B_TEMPLATE,
      metadata,
      timeoutMs: E2B_SANDBOX_TIMEOUT_MS,
      secure: false,
      allowInternetAccess: true,
    });

    const labels = { ...metadata, sandboxId: sandbox.sandboxId };
    const session: ProjectSandboxSession = {
      containerId,
      sandboxId: sandbox.sandboxId,
      sandbox,
      owner,
      projectId: owner.projectId,
      previewUrl: toPreviewUrl(sandbox, PROJECT_PREVIEW_PORT),
      createdAt: new Date().toISOString(),
      status: "running",
      devServerStarted: false,
      labels,
    };
    sessions.set(containerId, session);

    try {
      await prepareWorkspaceDirectory(session);
      await writeWorkspaceTemplate(session);
      await installDependencies(session);
      await startDevServer(session);
    } catch (error) {
      console.error("e2b_sandbox_bootstrap_failed", {
        trace: "e2b_sandbox_bootstrap_failed",
        containerId,
        sandboxId: session.sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await sandbox.kill();
      } catch {}
      sessions.delete(containerId);
      throw error;
    }

    console.log("e2b_sandbox_create_completed", {
      trace: "e2b_sandbox_create_completed",
      containerId,
      sandboxId: session.sandboxId,
      previewUrl: session.previewUrl,
    });

    return session;
  })();

  createLocks.set(containerId, createPromise);
  try {
    const session = await createPromise;
    return { container: makeContainer(session), port: PROJECT_PREVIEW_PORT };
  } finally {
    createLocks.delete(containerId);
  }
}

export async function assertProjectSandbox(
  containerId: string,
  owner?: ProjectOwner | null
): Promise<ProjectSandboxContainer> {
  const session = await getSession(containerId, owner);
  return makeContainer(session);
}

export async function ensureProjectSandboxRunning(
  containerId: string,
  owner?: ProjectOwner | null
): Promise<ProjectSandboxContainer> {
  const session = await getSession(containerId, owner);

  try {
    const running = await session.sandbox.isRunning({ requestTimeoutMs: 15_000 });
    if (!running) {
      throw new Error("Sandbox is not running");
    }
  } catch (error) {
    console.warn("e2b_sandbox_resume_required", {
      trace: "e2b_sandbox_resume_required",
      containerId,
      sandboxId: session.sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    session.sandbox = await Sandbox.connect(session.sandboxId, {
      timeoutMs: E2B_SANDBOX_TIMEOUT_MS,
    });
  }

  if (await isPreviewPortListening(session)) {
    session.devServerStarted = true;
    session.status = "running";
    session.previewUrl = toPreviewUrl(session.sandbox, PROJECT_PREVIEW_PORT);
  } else {
    await startDevServer(session);
  }
  return makeContainer(session);
}

export async function startSandbox(
  containerId: string,
  owner?: ProjectOwner | null
): Promise<{ port: number }> {
  await ensureProjectSandboxRunning(containerId, owner);
  return { port: PROJECT_PREVIEW_PORT };
}

export async function restartProjectDevServer(
  containerId: string,
  owner?: ProjectOwner | null
): Promise<{ port: number; previewUrl: string; diagnostics: string }> {
  const session = await getSession(containerId, owner);
  await startDevServer(session, { force: true });
  return {
    port: PROJECT_PREVIEW_PORT,
    previewUrl: session.previewUrl,
    diagnostics: await readDevServerDiagnostics(session),
  };
}

export async function getProjectDevServerDiagnostics(
  containerId: string,
  owner?: ProjectOwner | null
): Promise<string> {
  const session = await getSession(containerId, owner);
  return readDevServerDiagnostics(session);
}

export async function stopSandbox(
  containerId: string,
  owner?: ProjectOwner | null
): Promise<void> {
  const session = await getSession(containerId, owner);

  try {
    await session.sandbox.pause({ requestTimeoutMs: E2B_COMMAND_TIMEOUT_MS });
    session.status = "stopped";
    session.devServerStarted = false;
  } catch (error) {
    console.warn("e2b_sandbox_pause_failed", {
      trace: "e2b_sandbox_pause_failed",
      containerId,
      sandboxId: session.sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    await session.sandbox.kill({ requestTimeoutMs: E2B_COMMAND_TIMEOUT_MS });
    sessions.delete(containerId);
  }
}

export async function deleteSandbox(
  containerId: string,
  owner?: ProjectOwner | null
): Promise<void> {
  const session = await getSession(containerId, owner);
  await session.sandbox.kill({ requestTimeoutMs: E2B_COMMAND_TIMEOUT_MS });
  sessions.delete(containerId);

  console.log("e2b_sandbox_deleted", {
    trace: "e2b_sandbox_deleted",
    containerId,
    sandboxId: session.sandboxId,
  });
}

export async function listProjectSandboxes(owner?: ProjectOwner | null) {
  const inMemory = Array.from(sessions.values()).filter((session) =>
    isOwnedByAccount(session.labels, owner)
  );
  const byContainerId = new Map<string, ProjectSandboxSession>();
  inMemory.forEach((session) => byContainerId.set(session.containerId, session));

  if (SESSION_RECONNECT_ENABLED && process.env.E2B_API_KEY) {
    try {
      const paginator = Sandbox.list({
        query: { metadata: { project: PROJECT_LABEL }, state: ["running"] },
        limit: 100,
      });
      const items = await paginator.nextItems();
      for (const info of items) {
        const containerId = info.metadata.klawpenContainerId || info.metadata.containerId;
        if (!containerId || byContainerId.has(containerId)) continue;
        if (owner && info.metadata.teamId !== String(owner.teamId)) continue;
        const session = await connectFromInfo(info);
        byContainerId.set(containerId, session);
      }
    } catch (error) {
      console.warn("e2b_sandbox_list_failed", {
        trace: "e2b_sandbox_list_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return Array.from(byContainerId.values()).map((session) => ({
    id: session.containerId,
    name: `klawpen-e2b-${session.containerId.slice(0, 8)}`,
    status: session.status,
    image: `e2b:${E2B_TEMPLATE}`,
    created: session.createdAt,
    assignedPort: PROJECT_PREVIEW_PORT,
    url: session.previewUrl || buildPreviewProxyUrl(session.containerId),
    rawUrl: session.previewUrl,
    ports: [
      {
        private: PROJECT_PREVIEW_PORT,
        public: PROJECT_PREVIEW_PORT,
        type: "tcp",
      },
    ],
    labels: session.labels,
  }));
}

export async function getPreviewRuntime(containerId: string): Promise<{
  containerInfo: any;
  port: number;
  upstreamUrls: string[];
}> {
  const session = await getSession(containerId);
  await ensureProjectSandboxRunning(containerId, session.owner);
  const upstreamUrl = session.previewUrl || toPreviewUrl(session.sandbox);

  return {
    containerInfo: makeContainerInfo(session),
    port: PROJECT_PREVIEW_PORT,
    upstreamUrls: [upstreamUrl],
  };
}

export async function getSandbox(containerId: string): Promise<Sandbox> {
  const session = await getSession(containerId);
  return session.sandbox;
}

export async function runSandboxCommand(
  containerId: string,
  command: string | string[],
  opts: { cwd?: string; timeoutMs?: number; background?: false } = {}
): Promise<string> {
  const session = await getSession(containerId);
  const commandText = Array.isArray(command)
    ? command.map(shellQuote).join(" ")
    : command;

  const result = await session.sandbox.commands.run(commandText, {
    cwd: opts.cwd || PROJECT_WORKSPACE_PATH,
    timeoutMs: opts.timeoutMs || E2B_COMMAND_TIMEOUT_MS,
    onStdout: (data) => logSandboxOutput("stdout", session, data),
    onStderr: (data) => logSandboxOutput("stderr", session, data),
  });

  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr || result.stdout || `Sandbox command failed: ${commandText}`
    );
  }

  return result.stdout || result.stderr;
}

export function getSandboxRuntimeDiagnostics() {
  return {
    runtime: "e2b",
    marker: "klawpen-e2b-sandbox-v1",
    template: E2B_TEMPLATE,
    workspacePath: PROJECT_WORKSPACE_PATH,
    previewPort: PROJECT_PREVIEW_PORT,
    timeoutMs: E2B_SANDBOX_TIMEOUT_MS,
    apiKeyConfigured: Boolean(process.env.E2B_API_KEY),
    activeSessions: sessions.size,
    reconnectByMetadata: SESSION_RECONNECT_ENABLED,
    previewProxyOrigin: PUBLIC_PREVIEW_PROXY_ORIGIN,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function createWorkspaceTemplateFiles(): Array<{ path: string; content: string }> {
  return [
    {
      path: "package.json",
      content: JSON.stringify(
        {
          name: "klawpen-workspace",
          version: "0.1.0",
          private: true,
          scripts: {
            dev: "next dev",
            build: "next build",
            start: "next start",
          },
          dependencies: {
            "@tailwindcss/postcss": "^4.1.7",
            "lucide-react": "^0.511.0",
            next: "15.5.18",
            react: "^19.0.0",
            "react-dom": "^19.0.0",
            tailwindcss: "^4.1.7",
          },
          devDependencies: {
            "@types/node": "^20",
            "@types/react": "^19",
            "@types/react-dom": "^19",
            typescript: "^5",
          },
        },
        null,
        2
      ),
    },
    {
      path: "tsconfig.json",
      content: JSON.stringify(
        {
          compilerOptions: {
            target: "ES2017",
            lib: ["dom", "dom.iterable", "esnext"],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "preserve",
            incremental: true,
            plugins: [{ name: "next" }],
            paths: {
              "@/*": ["./src/*"],
            },
          },
          include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
          exclude: ["node_modules"],
        },
        null,
        2
      ),
    },
    {
      path: "next.config.ts",
      content: `import type { NextConfig } from "next";\n\nconst nextConfig: NextConfig = {};\n\nexport default nextConfig;\n`,
    },
    {
      path: "postcss.config.mjs",
      content: `const config = {\n  plugins: {\n    "@tailwindcss/postcss": {},\n  },\n};\n\nexport default config;\n`,
    },
    {
      path: "tailwind.config.ts",
      content: `import type { Config } from "tailwindcss";\n\nexport const klawpenBranding = {\n  colors: {\n    ink: "#0b0c10",\n    coal: "#111217",\n    graphite: "#222223",\n    panel: "#111827",\n    mist: "#f6f8fb",\n    paper: "#ffffff",\n    steel: "#254260",\n    ocean: "#31577d",\n    cyan: "#12b5cb",\n    ice: "#8bd6e6",\n    slate: "#64748b",\n  },\n  spacing: {\n    shell: "clamp(1rem, 3vw, 3rem)",\n    section: "clamp(4rem, 8vw, 8rem)",\n    compact: "clamp(0.75rem, 1.4vw, 1.25rem)",\n  },\n  borderRadius: {\n    soft: "1rem",\n    panel: "1.5rem",\n    hero: "2rem",\n    pill: "999px",\n  },\n  fontFamily: {\n    sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],\n    display: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],\n    mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],\n  },\n};\n\nconst config = {\n  theme: {\n    extend: {\n      colors: {\n        klawpen: klawpenBranding.colors,\n      },\n      spacing: {\n        "klawpen-shell": klawpenBranding.spacing.shell,\n        "klawpen-section": klawpenBranding.spacing.section,\n        "klawpen-compact": klawpenBranding.spacing.compact,\n      },\n      borderRadius: {\n        "klawpen-soft": klawpenBranding.borderRadius.soft,\n        "klawpen-panel": klawpenBranding.borderRadius.panel,\n        "klawpen-hero": klawpenBranding.borderRadius.hero,\n        "klawpen-pill": klawpenBranding.borderRadius.pill,\n      },\n      fontFamily: {\n        "klawpen-sans": klawpenBranding.fontFamily.sans,\n        "klawpen-display": klawpenBranding.fontFamily.display,\n        "klawpen-mono": klawpenBranding.fontFamily.mono,\n      },\n    },\n  },\n} satisfies Config;\n\nexport default config;\n`,
    },
    {
      path: "src/app/globals.css",
      content: `@import "tailwindcss";\n@config "../../tailwind.config.ts";\n\n:root {\n  background: #f6f8fb;\n  color: #111827;\n}\n\n* {\n  box-sizing: border-box;\n}\n\nhtml,\nbody {\n  min-height: 100%;\n}\n\nbody {\n  margin: 0;\n}\n`,
    },
    {
      path: "src/app/layout.tsx",
      content: `import type { Metadata } from "next";\nimport "./globals.css";\n\nexport const metadata: Metadata = {\n  title: "Klawpen Workspace",\n  description: "A live Klawpen generated project.",\n};\n\nexport default function RootLayout({\n  children,\n}: Readonly<{\n  children: React.ReactNode;\n}>) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
    },
    {
      path: "src/app/page.tsx",
      content: `import type { Metadata } from "next";\n\nexport const metadata: Metadata = {\n  title: "Klawpen Workspace",\n  description: "Your Klawpen project is being prepared.",\n};\n\nexport default function Home() {\n  return (\n    <main className="min-h-screen overflow-hidden bg-[#f6f8fb] text-[#111827]">\n      <section className="relative flex min-h-screen items-center justify-center px-6 py-16">\n        <div className="absolute left-[-10%] top-[-10%] h-72 w-72 rounded-full bg-[#1689ff]/20 blur-3xl" />\n        <div className="absolute bottom-[-12%] right-[-8%] h-80 w-80 rounded-full bg-[#7cc7ff]/20 blur-3xl" />\n        <div className="relative w-full max-w-3xl rounded-[2rem] border border-white/80 bg-white/85 p-8 text-center shadow-[0_30px_90px_rgba(15,23,42,0.12)] backdrop-blur-xl sm:p-12">\n          <div className="mx-auto mb-7 flex h-16 w-16 items-center justify-center rounded-3xl bg-[#1689ff] text-xl font-black text-white shadow-[0_18px_40px_rgba(22,137,255,0.28)]">\n            K\n          </div>\n          <p className="mb-4 text-xs font-black uppercase tracking-[0.32em] text-[#1689ff]">\n            Klawpen Builder\n          </p>\n          <h1 className="text-4xl font-black tracking-[-0.06em] text-slate-950 sm:text-6xl">\n            Your project is being crafted\n          </h1>\n          <p className="mx-auto mt-5 max-w-xl text-base leading-8 text-slate-500">\n            Klawpen Core is preparing the first version of your website. The preview will refresh automatically as files are generated.\n          </p>\n        </div>\n      </section>\n    </main>\n  );\n}\n`,
    },
  ];
}
