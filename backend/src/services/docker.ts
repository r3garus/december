import Docker from "dockerode";
import crypto from "crypto";
import fs from "fs/promises";
import net from "net";
import os from "os";
import path from "path";
import { Writable } from "stream";
import { docker } from "./dockerClient";

const BASE_PORT = 8100;
const ALLOW_LEGACY_CONTAINERS = process.env.ALLOW_LEGACY_CONTAINERS === "true";
const PROJECT_LABEL = "klawpen";
const LEGACY_PROJECT_LABEL = ["de", "cember"].join("");
const CONTAINER_PREFIX = "klawpen-workspace-";
const LEGACY_CONTAINER_PREFIX = ["dec", "nextjs"].join("-") + "-";
const TEMPLATE_IMAGE_NAME =
  process.env.PROJECT_TEMPLATE_IMAGE || "klawpen-workspace-template";
const TEMPLATE_IMAGE_VERSION = (
  process.env.PROJECT_TEMPLATE_VERSION || "klawpen-workspace-v7"
).replace(/[^a-zA-Z0-9_.-]/g, "-");
const TEMPLATE_VERSION_LABEL = "klawpen.template.version";
const TEMPLATE_SOURCE_SHA_LABEL = "klawpen.template.source_sha";
const TEMPLATE_CMD_LABEL = "klawpen.template.cmd";
const PROJECT_WORKSPACE_PATH = "/app/my-nextjs-app";
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

const usedPorts = new Set<number>();
let detectedProjectNetwork: Promise<string | null> | null = null;

export interface ProjectOwner {
  teamId: number;
  localUserId?: number;
  projectId?: string;
}

export interface CreateContainerOptions {
  restoreSnapshot?: boolean;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const PROJECT_CONTAINER_MEMORY_BYTES = readPositiveIntEnv(
  "PROJECT_CONTAINER_MEMORY_BYTES",
  512 * 1024 * 1024
);
const PROJECT_CONTAINER_NANO_CPUS = readPositiveIntEnv(
  "PROJECT_CONTAINER_NANO_CPUS",
  1_000_000_000
);
const PROJECT_CONTAINER_PIDS_LIMIT = readPositiveIntEnv(
  "PROJECT_CONTAINER_PIDS_LIMIT",
  256
);
const PROJECT_READONLY_ROOTFS = readBooleanEnv("PROJECT_READONLY_ROOTFS", true);
const PROJECT_WORKSPACE_VOLUME_ENABLED = readBooleanEnv(
  "PROJECT_WORKSPACE_VOLUME_ENABLED",
  true
);
const PROJECT_WORKSPACE_VOLUME_PREFIX =
  process.env.PROJECT_WORKSPACE_VOLUME_PREFIX || "klawpen-workspace-data-";
const PROJECT_TEMPLATE_DYNAMIC_TAG = readBooleanEnv(
  "PROJECT_TEMPLATE_DYNAMIC_TAG",
  true
);
const PROJECT_TEMPLATE_NO_CACHE = readBooleanEnv(
  "PROJECT_TEMPLATE_NO_CACHE",
  false
);
const PROJECT_TEMPLATE_REBUILD_ALWAYS = readBooleanEnv(
  "PROJECT_TEMPLATE_REBUILD_ALWAYS",
  false
);
const PROJECT_CONTAINER_RESUME_TIMEOUT_MS = readPositiveIntEnv(
  "PROJECT_CONTAINER_RESUME_TIMEOUT_MS",
  30_000
);
const containerResumeLocks = new Map<string, Promise<void>>();

async function getAllAssignedPorts(): Promise<number[]> {
  const containers = await docker.listContainers({ all: true });
  const projectContainers = containers.filter(
    (container) =>
      container.Labels?.project === PROJECT_LABEL ||
      container.Labels?.project === LEGACY_PROJECT_LABEL ||
      container.Names?.some(
        (name) =>
          name.includes(CONTAINER_PREFIX) ||
          name.includes(LEGACY_CONTAINER_PREFIX)
      )
  );

  return projectContainers
    .map((container) => {
      const assignedPort = container.Labels?.assignedPort
        ? parseInt(container.Labels.assignedPort)
        : container.Ports?.find((p) => p.PrivatePort === 3000)?.PublicPort;
      return assignedPort || null;
    })
    .filter((port): port is number => port !== null);
}

async function findAvailablePort(
  startPort: number = BASE_PORT
): Promise<number> {
  const assignedPorts = await getAllAssignedPorts();
  const allUsedPorts = new Set([...usedPorts, ...assignedPorts]);

  for (let port = startPort; port < startPort + 1000; port++) {
    if (!allUsedPorts.has(port) && (await isPortAvailable(port))) {
      usedPorts.add(port);
      return port;
    }
  }
  throw new Error("No available ports found");
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "0.0.0.0");
  });
}

function releasePort(port: number): void {
  usedPorts.delete(port);
}

function sanitizeDockerName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120);
}

function getWorkspaceVolumeName(containerId: string, owner: ProjectOwner): string {
  return `${PROJECT_WORKSPACE_VOLUME_PREFIX}${sanitizeDockerName(
    owner.projectId || containerId
  )}`;
}

function getProjectHostConfig(
  assignedPort: number,
  networkMode: string | null,
  containerId: string,
  owner: ProjectOwner
): Record<string, unknown> {
  const binds = PROJECT_WORKSPACE_VOLUME_ENABLED
    ? [`${getWorkspaceVolumeName(containerId, owner)}:${PROJECT_WORKSPACE_PATH}:rw`]
    : [];

  return {
    PortBindings: { "3000/tcp": [{ HostPort: assignedPort.toString() }] },
    Memory: PROJECT_CONTAINER_MEMORY_BYTES,
    NanoCpus: PROJECT_CONTAINER_NANO_CPUS,
    PidsLimit: PROJECT_CONTAINER_PIDS_LIMIT,
    ReadonlyRootfs: PROJECT_READONLY_ROOTFS,
    SecurityOpt: ["no-new-privileges:true"],
    Tmpfs: {
      "/tmp": "rw,noexec,nosuid,size=128m,uid=1000,gid=1000,mode=1777",
      [`${PROJECT_WORKSPACE_PATH}/.next`]:
        "rw,nosuid,size=256m,uid=1000,gid=1000,mode=1777",
      [`${PROJECT_WORKSPACE_PATH}/node_modules/.cache`]:
        "rw,nosuid,size=128m,uid=1000,gid=1000,mode=1777",
      "/home/node/.cache": "rw,nosuid,size=128m,uid=1000,gid=1000,mode=1777",
      "/home/node/.bun/install/cache":
        "rw,nosuid,size=256m,uid=1000,gid=1000,mode=1777",
    },
    ...(binds.length > 0 ? { Binds: binds } : {}),
    ...(networkMode ? { NetworkMode: networkMode } : {}),
  };
}

async function runContainerDiagnosticCommand(
  container: Docker.Container,
  command: string[],
  workingDir: string = PROJECT_WORKSPACE_PATH
): Promise<string> {
  const exec = await container.exec({
    Cmd: command,
    WorkingDir: workingDir,
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ Detach: false, Tty: false });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      stdoutChunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      stderrChunks.push(Buffer.from(chunk));
      callback();
    },
  });

  docker.modem.demuxStream(stream, stdout, stderr);

  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });

  const result = await exec.inspect();
  const output = Buffer.concat(stdoutChunks).toString("utf8");
  const errorOutput = Buffer.concat(stderrChunks).toString("utf8");

  if (result.ExitCode !== 0) {
    throw new Error(
      errorOutput.trim() ||
        output.trim() ||
        `Container diagnostic failed with exit code ${result.ExitCode}`
    );
  }

  return output || errorOutput;
}

async function logContainerRuntimeDiagnostics(params: {
  container: Docker.Container;
  containerId: string;
  imageName: string;
  assignedPort: number;
  networkMode: string | null;
  owner: ProjectOwner;
}) {
  try {
    const containerInfo = await params.container.inspect();
    const workspaceVolume = PROJECT_WORKSPACE_VOLUME_ENABLED
      ? getWorkspaceVolumeName(params.containerId, params.owner)
      : "(disabled)";
    const workspaceState = await runContainerDiagnosticCommand(
      params.container,
      [
        "sh",
        "-lc",
        [
          'printf "pid1="',
          'tr "\\0" " " < /proc/1/cmdline || true',
          "echo",
          'printf "package_json="',
          'test -f package.json && echo present || echo missing',
          'printf "page_tsx_bytes="',
          'test -f src/app/page.tsx && wc -c < src/app/page.tsx || echo missing',
          'printf "workspace_file_count="',
          'find . \\( -name node_modules -o -name .next \\) -prune -o -type f -print | wc -l',
        ].join("; "),
      ],
      PROJECT_WORKSPACE_PATH
    );

    console.log("preview_container_runtime_diagnostics", {
      trace: "preview_container_runtime_diagnostics",
      containerId: params.containerId,
      dockerContainerId: params.container.id,
      imageName: params.imageName,
      assignedPort: params.assignedPort,
      networkMode: params.networkMode || "(default)",
      workspaceVolume,
      readonlyRootfs: containerInfo.HostConfig?.ReadonlyRootfs,
      cmd: containerInfo.Config?.Cmd,
      entrypoint: containerInfo.Config?.Entrypoint,
      binds: containerInfo.HostConfig?.Binds || [],
      tmpfs: Object.keys(containerInfo.HostConfig?.Tmpfs || {}),
      state: containerInfo.State?.Status,
      workspaceState,
    });
  } catch (error) {
    console.warn("preview_container_runtime_diagnostics_failed", {
      trace: "preview_container_runtime_diagnostics_failed",
      containerId: params.containerId,
      imageName: params.imageName,
      error: error instanceof Error ? error.message : error,
    });
  }
}

async function resolveProjectNetwork(): Promise<string | null> {
  if (process.env.PROJECT_CONTAINER_NETWORK) {
    const network = process.env.PROJECT_CONTAINER_NETWORK.trim();
    return network && network !== "default" ? network : null;
  }

  if (process.env.AUTO_ATTACH_PROJECT_NETWORK === "false") {
    return null;
  }

  if (!detectedProjectNetwork) {
    detectedProjectNetwork = (async () => {
      try {
        const selfContainer = docker.getContainer(os.hostname());
        const info = await selfContainer.inspect();
        const networks = Object.keys(info.NetworkSettings?.Networks || {});
        return networks[0] || null;
      } catch {
        return null;
      }
    })();
  }

  return detectedProjectNetwork;
}

function getPreviewSecret(): string {
  return process.env.PREVIEW_PROXY_SECRET || process.env.BACKEND_API_TOKEN || "";
}

export function signPreviewToken(containerId: string): string | null {
  const secret = getPreviewSecret();
  if (!secret) return null;

  return crypto
    .createHmac("sha256", secret)
    .update(containerId)
    .digest("hex")
    .slice(0, 48);
}

export function isValidPreviewToken(
  containerId: string,
  token?: string
): boolean {
  const expectedToken = signPreviewToken(containerId);
  if (!expectedToken) return true;
  if (!token) return false;

  const expected = Buffer.from(expectedToken);
  const received = Buffer.from(token);

  return (
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received)
  );
}

export function buildPreviewUrl(containerId: string): string {
  const token = signPreviewToken(containerId);
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${PUBLIC_PREVIEW_PROXY_ORIGIN}/preview/${containerId}/${tokenQuery}`;
}

export function getPreviewProxyOrigin(): string {
  return PUBLIC_PREVIEW_PROXY_ORIGIN;
}

export function getDockerRuntimeDiagnostics() {
  return {
    templateImage: TEMPLATE_IMAGE_NAME,
    templateVersion: TEMPLATE_IMAGE_VERSION,
    dynamicTemplateTag: PROJECT_TEMPLATE_DYNAMIC_TAG,
    templateNoCache: PROJECT_TEMPLATE_NO_CACHE,
    templateRebuildAlways: PROJECT_TEMPLATE_REBUILD_ALWAYS,
    workspacePath: PROJECT_WORKSPACE_PATH,
    workspaceVolumeEnabled: PROJECT_WORKSPACE_VOLUME_ENABLED,
    workspaceVolumePrefix: PROJECT_WORKSPACE_VOLUME_PREFIX,
    readonlyRootfs: PROJECT_READONLY_ROOTFS,
    memoryBytes: PROJECT_CONTAINER_MEMORY_BYTES,
    nanoCpus: PROJECT_CONTAINER_NANO_CPUS,
    pidsLimit: PROJECT_CONTAINER_PIDS_LIMIT,
  };
}

export function buildRawPreviewUrl(port: number): string {
  return `${process.env.PREVIEW_BASE_URL || "http://localhost"}:${port}`;
}

export async function getDockerfile(): Promise<string> {
  return await fs.readFile("./src/Dockerfile", "utf-8");
}

function escapeDockerLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function getTemplateImageName(sourceSha: string): string {
  if (!PROJECT_TEMPLATE_DYNAMIC_TAG) return TEMPLATE_IMAGE_NAME;

  const lastSlash = TEMPLATE_IMAGE_NAME.lastIndexOf("/");
  const lastColon = TEMPLATE_IMAGE_NAME.lastIndexOf(":");
  const baseName =
    lastColon > lastSlash ? TEMPLATE_IMAGE_NAME.slice(0, lastColon) : TEMPLATE_IMAGE_NAME;
  const tag = `${TEMPLATE_IMAGE_VERSION}-${sourceSha.slice(0, 12)}`.replace(
    /[^a-zA-Z0-9_.-]/g,
    "-"
  );

  return `${baseName}:${tag}`;
}

async function listTemplateContextFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return files.sort();
}

async function hashTemplateBuildContext(
  rootDir: string,
  baseDockerfileContent: string
): Promise<string> {
  const hash = crypto.createHash("sha256");
  hash.update(`template-version:${TEMPLATE_IMAGE_VERSION}\n`);
  hash.update(baseDockerfileContent);

  for (const filePath of await listTemplateContextFiles(rootDir)) {
    const relativePath = path.relative(rootDir, filePath).replace(/\\/g, "/");
    if (relativePath === "Dockerfile") continue;

    hash.update(`\n--- ${relativePath} ---\n`);
    hash.update(await fs.readFile(filePath));
  }

  return hash.digest("hex");
}

async function inspectImageLabels(
  imageName: string
): Promise<Record<string, string>> {
  const imageInfo = await docker.getImage(imageName).inspect();
  return imageInfo.Config?.Labels || {};
}

async function canReuseTemplateImage(
  imageName: string,
  sourceSha: string
): Promise<boolean> {
  if (PROJECT_TEMPLATE_REBUILD_ALWAYS) {
    console.warn("template_image_cache_bypass", {
      trace: "template_image_rebuild_forced",
      imageName,
      sourceSha: sourceSha.slice(0, 16),
    });
    return false;
  }

  try {
    const labels = await inspectImageLabels(imageName);
    const imageVersion = labels[TEMPLATE_VERSION_LABEL];
    const imageSourceSha = labels[TEMPLATE_SOURCE_SHA_LABEL];
    const matches =
      imageVersion === TEMPLATE_IMAGE_VERSION && imageSourceSha === sourceSha;

    if (matches && !PROJECT_TEMPLATE_NO_CACHE) {
      console.log("template_image_cache_hit", {
        trace: "template_image_cache_hit",
        imageName,
        imageVersion,
        sourceSha: sourceSha.slice(0, 16),
        command: labels[TEMPLATE_CMD_LABEL] || "(unknown)",
      });
      return true;
    }

    console.warn("template_image_cache_miss", {
      trace: "template_image_cache_miss",
      imageName,
      expectedVersion: TEMPLATE_IMAGE_VERSION,
      actualVersion: imageVersion || "(none)",
      expectedSourceSha: sourceSha.slice(0, 16),
      actualSourceSha: imageSourceSha ? imageSourceSha.slice(0, 16) : "(none)",
      noCache: PROJECT_TEMPLATE_NO_CACHE,
    });

    if (!PROJECT_TEMPLATE_DYNAMIC_TAG || PROJECT_TEMPLATE_NO_CACHE) {
      await docker.getImage(imageName).remove({ force: true });
    }
  } catch (error) {
    console.warn("template_image_cache_lookup_failed", {
      trace: "template_image_cache_lookup_failed",
      imageName,
      error: error instanceof Error ? error.message : error,
    });
  }

  return false;
}

async function writeTemplateFile(
  rootDir: string,
  relativePath: string,
  content: string
) {
  const targetPath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content);
}

async function writeKlawpenWorkspaceTemplate(rootDir: string) {
  await writeTemplateFile(
    rootDir,
    "package.json",
    JSON.stringify(
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
    )
  );

  await writeTemplateFile(
    rootDir,
    "tsconfig.json",
    JSON.stringify(
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
    )
  );

  await writeTemplateFile(
    rootDir,
    "next.config.ts",
    `import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;
`
  );

  await writeTemplateFile(
    rootDir,
    "postcss.config.mjs",
    `const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
`
  );

  await writeTemplateFile(
    rootDir,
    "tailwind.config.ts",
    `import type { Config } from "tailwindcss";

export const klawpenBranding = {
  colors: {
    ink: "#0b0c10",
    coal: "#111217",
    graphite: "#222223",
    panel: "#111827",
    mist: "#f6f8fb",
    paper: "#ffffff",
    steel: "#254260",
    ocean: "#31577d",
    cyan: "#12b5cb",
    ice: "#8bd6e6",
    slate: "#64748b",
  },
  spacing: {
    shell: "clamp(1rem, 3vw, 3rem)",
    section: "clamp(4rem, 8vw, 8rem)",
    compact: "clamp(0.75rem, 1.4vw, 1.25rem)",
  },
  borderRadius: {
    soft: "1rem",
    panel: "1.5rem",
    hero: "2rem",
    pill: "999px",
  },
  fontFamily: {
    sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
    display: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
    mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
  },
};

const config = {
  theme: {
    extend: {
      colors: {
        klawpen: klawpenBranding.colors,
      },
      spacing: {
        "klawpen-shell": klawpenBranding.spacing.shell,
        "klawpen-section": klawpenBranding.spacing.section,
        "klawpen-compact": klawpenBranding.spacing.compact,
      },
      borderRadius: {
        "klawpen-soft": klawpenBranding.borderRadius.soft,
        "klawpen-panel": klawpenBranding.borderRadius.panel,
        "klawpen-hero": klawpenBranding.borderRadius.hero,
        "klawpen-pill": klawpenBranding.borderRadius.pill,
      },
      fontFamily: {
        "klawpen-sans": klawpenBranding.fontFamily.sans,
        "klawpen-display": klawpenBranding.fontFamily.display,
        "klawpen-mono": klawpenBranding.fontFamily.mono,
      },
    },
  },
} satisfies Config;

export default config;
`
  );

  await writeTemplateFile(
    rootDir,
    "src/app/globals.css",
    `@import "tailwindcss";
@config "../../tailwind.config.ts";

:root {
  background: #f6f8fb;
  color: #111827;
}

* {
  box-sizing: border-box;
}

html,
body {
  min-height: 100%;
}

body {
  margin: 0;
}
`
  );

  await writeTemplateFile(
    rootDir,
    "src/app/layout.tsx",
    `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Klawpen Workspace",
  description: "A live Klawpen generated project.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`
  );

  await writeTemplateFile(
    rootDir,
    "src/app/page.tsx",
    `import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Klawpen Workspace",
  description: "Your Klawpen project is being prepared.",
};

export default function Home() {
  return (
    <main className="min-h-screen overflow-hidden bg-[#f6f8fb] text-[#111827]">
      <section className="relative flex min-h-screen items-center justify-center px-6 py-16">
        <div className="absolute left-[-10%] top-[-10%] h-72 w-72 rounded-full bg-[#1689ff]/20 blur-3xl" />
        <div className="absolute bottom-[-12%] right-[-8%] h-80 w-80 rounded-full bg-[#7cc7ff]/20 blur-3xl" />
        <div className="relative w-full max-w-3xl rounded-[2rem] border border-white/80 bg-white/85 p-8 text-center shadow-[0_30px_90px_rgba(15,23,42,0.12)] backdrop-blur-xl sm:p-12">
          <div className="mx-auto mb-7 flex h-16 w-16 items-center justify-center rounded-3xl bg-[#1689ff] text-xl font-black text-white shadow-[0_18px_40px_rgba(22,137,255,0.28)]">
            K
          </div>
          <p className="mb-4 text-xs font-black uppercase tracking-[0.32em] text-[#1689ff]">
            Klawpen Builder
          </p>
          <h1 className="text-4xl font-black tracking-[-0.06em] text-slate-950 sm:text-6xl">
            Your project is being crafted
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-base leading-8 text-slate-500">
            Klawpen Core is preparing the first version of your website. The preview will refresh automatically as files are generated.
          </p>
        </div>
      </section>
    </main>
  );
}
`
  );
}

export async function buildImage(containerId: string): Promise<string> {
  const tempDir = path.join("/tmp", `docker-app-${containerId}`);
  await fs.mkdir(tempDir, { recursive: true });

  try {
    const baseDockerfileContent = (await getDockerfile()).trimEnd();
    await writeKlawpenWorkspaceTemplate(tempDir);

    const sourceSha = await hashTemplateBuildContext(
      tempDir,
      baseDockerfileContent
    );
    const imageName = getTemplateImageName(sourceSha);

    if (await canReuseTemplateImage(imageName, sourceSha)) {
      await fs.rm(tempDir, { recursive: true, force: true });
      return imageName;
    }

    const runtimeCmd = "bun run dev --hostname 0.0.0.0 --port 3000";
    const dockerfileContent = [
      baseDockerfileContent,
      "",
      `LABEL ${TEMPLATE_VERSION_LABEL}="${escapeDockerLabel(TEMPLATE_IMAGE_VERSION)}"`,
      `LABEL ${TEMPLATE_SOURCE_SHA_LABEL}="${escapeDockerLabel(sourceSha)}"`,
      `LABEL ${TEMPLATE_CMD_LABEL}="${escapeDockerLabel(runtimeCmd)}"`,
      "",
    ].join("\n");
    await fs.writeFile(path.join(tempDir, "Dockerfile"), dockerfileContent);

    console.log("template_image_build_started", {
      trace: "template_image_build_started",
      imageName,
      version: TEMPLATE_IMAGE_VERSION,
      sourceSha: sourceSha.slice(0, 16),
      dynamicTag: PROJECT_TEMPLATE_DYNAMIC_TAG,
      noCache: PROJECT_TEMPLATE_NO_CACHE,
      rebuildAlways: PROJECT_TEMPLATE_REBUILD_ALWAYS,
      runtimeCmd,
    });

    const tarStream = await docker.buildImage(
      {
        context: tempDir,
        src: [
          "Dockerfile",
          "package.json",
          "tsconfig.json",
          "next.config.ts",
          "postcss.config.mjs",
          "tailwind.config.ts",
          "src",
        ],
      },
      {
        t: imageName,
        rm: true,
        forcerm: true,
        nocache: PROJECT_TEMPLATE_NO_CACHE || PROJECT_TEMPLATE_REBUILD_ALWAYS,
      }
    );

    await new Promise<void>((resolve, reject) => {
      let buildOutput = "";

      docker.modem.followProgress(
        tarStream,
        (err: any, res: any) => {
          if (err) {
            console.error("Build error:", err);
            console.error("Build output:", buildOutput);
            reject(new Error(`Docker build failed: ${err.message}`));
          } else {
            console.log("template_image_build_completed", {
              trace: "template_image_build_completed",
              imageName,
              sourceSha: sourceSha.slice(0, 16),
            });
            resolve();
          }
        },
        (event: any) => {
          if (event.stream) {
            buildOutput += event.stream;
            console.log("Build:", event.stream.trim());
          }
          if (event.error) {
            console.error("Build step error:", event.error);
            buildOutput += `ERROR: ${event.error}\n`;
          }
        }
      );
    });

    const image = docker.getImage(imageName);
    const imageInfo = await image.inspect();
    console.log("template_image_created", {
      trace: "template_image_created",
      imageName,
      imageId: imageInfo.Id,
      version: imageInfo.Config?.Labels?.[TEMPLATE_VERSION_LABEL],
      sourceSha: imageInfo.Config?.Labels?.[TEMPLATE_SOURCE_SHA_LABEL]?.slice(
        0,
        16
      ),
      cmd: imageInfo.Config?.Cmd,
    });

    await fs.rm(tempDir, { recursive: true, force: true });
    return imageName;
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

export async function createContainer(
  imageName: string,
  containerId: string,
  owner: ProjectOwner,
  _options: CreateContainerOptions = {}
): Promise<{ container: Docker.Container; port: number }> {
  const containerName = `${CONTAINER_PREFIX}${containerId}`;
  const assignedPort = await findAvailablePort();
  const networkMode = await resolveProjectNetwork();

  console.log(`Creating container: ${containerName} on port ${assignedPort}`);

  const container = await docker.createContainer({
    Image: imageName,
    name: containerName,
    ExposedPorts: { "3000/tcp": {} },
    HostConfig: getProjectHostConfig(
      assignedPort,
      networkMode,
      containerId,
      owner
    ),
    Labels: {
      project: PROJECT_LABEL,
      type: "klawpen-workspace",
      assignedPort: assignedPort.toString(),
      teamId: String(owner.teamId),
      userId: owner.localUserId ? String(owner.localUserId) : "",
      projectId: owner.projectId || "",
      workspaceVolume: PROJECT_WORKSPACE_VOLUME_ENABLED
        ? getWorkspaceVolumeName(containerId, owner)
        : "",
      templateImage: imageName,
    },
  });

  console.log(`Starting container: ${container.id}`);
  await container.start();
  await logContainerRuntimeDiagnostics({
    container,
    containerId,
    imageName,
    assignedPort,
    networkMode,
    owner,
  });

  return { container, port: assignedPort };
}

export async function startContainer(
  containerId: string,
  owner?: ProjectOwner
): Promise<{ port: number }> {
  try {
    const container = await assertProjectContainer(containerId, owner);
    const containerInfo = await container.inspect();

    if (containerInfo.State.Running && !containerInfo.State.Paused) {
      const port = getPortFromContainer(containerInfo);
      return { port };
    }

    if (containerInfo.State.Paused) {
      await container.unpause();
      await waitForProjectContainerRunning(container, containerId);
      const port = getPortFromContainer(await container.inspect());
      console.log(`Unpaused container: ${containerId} on port ${port}`);
      return { port };
    }

    let assignedPort: number;
    const portLabel = containerInfo.Config.Labels?.assignedPort;

    if (portLabel && (await isPortAvailable(parseInt(portLabel)))) {
      assignedPort = parseInt(portLabel);
      usedPorts.add(assignedPort);
    } else {
      assignedPort = await findAvailablePort();

      if (portLabel && parseInt(portLabel) !== assignedPort) {
        throw new Error(
          `Container port ${portLabel} is no longer available. Please recreate the container.`
        );
      }
    }

    await container.start();
    await waitForProjectContainerRunning(container, containerId);
    console.log(`Started container: ${containerId} on port ${assignedPort}`);

    return { port: assignedPort };
  } catch (error) {
    throw new Error(
      `Failed to start container: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
}

function getPortFromContainer(containerInfo: any): number {
  const portBindings = containerInfo.HostConfig?.PortBindings?.["3000/tcp"];
  if (portBindings && portBindings[0]?.HostPort) {
    const port = parseInt(portBindings[0].HostPort);
    usedPorts.add(port);
    return port;
  }

  const portLabel = containerInfo.Config.Labels?.assignedPort;
  if (portLabel) {
    const port = parseInt(portLabel);
    usedPorts.add(port);
    return port;
  }

  throw new Error("Could not determine container port");
}

export async function cleanupImage(containerId: string): Promise<void> {
  try {
    if (TEMPLATE_IMAGE_NAME) {
      return;
    }

    const imageName = `${CONTAINER_PREFIX}${containerId}`;
    const image = docker.getImage(imageName);
    await image.remove({ force: true });
    console.log(`Cleaned up failed image: ${imageName}`);
  } catch (cleanupError) {}
}

export function getContainer(containerId: string): Docker.Container {
  return docker.getContainer(containerId);
}

export async function getPreviewRuntime(
  containerId: string
): Promise<{ containerInfo: any; port: number; upstreamUrls: string[] }> {
  const container = await ensureProjectContainerRunning(containerId);
  const containerInfo = await container.inspect();
  const port = getPortFromContainer(containerInfo);
  const containerName = containerInfo.Name?.replace(/^\//, "");
  const networkUrls = Object.values(containerInfo.NetworkSettings?.Networks || {})
    .map((network: any) => network?.IPAddress)
    .filter(Boolean)
    .map((ip) => `http://${ip}:3000`);

  const upstreamUrls = [
    process.env.PREVIEW_UPSTREAM_URL_TEMPLATE?.replace("{port}", String(port)),
    process.env.PREVIEW_UPSTREAM_HOST
      ? `http://${process.env.PREVIEW_UPSTREAM_HOST}:${port}`
      : null,
    containerName ? `http://${containerName}:3000` : null,
    ...networkUrls,
    process.env.PREVIEW_BASE_URL ? `${process.env.PREVIEW_BASE_URL}:${port}` : null,
    `http://host.docker.internal:${port}`,
    `http://172.17.0.1:${port}`,
  ].filter((url): url is string => Boolean(url));

  console.log("Resolved preview runtime:", {
    containerId,
    port,
    containerName,
    publicOrigin: PUBLIC_PREVIEW_PROXY_ORIGIN,
    upstreamUrls: Array.from(new Set(upstreamUrls)).slice(0, 5),
  });

  return {
    containerInfo,
    port,
    upstreamUrls: Array.from(new Set(upstreamUrls)),
  };
}

export { docker };

function assertSafeContainerId(containerId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerId)) {
    throw new Error("Invalid container id");
  }
}

function isProjectContainerInfo(containerInfo: any): boolean {
  const labels = containerInfo.Labels || containerInfo.Config?.Labels || {};
  const names = containerInfo.Names || [containerInfo.Name].filter(Boolean);
  const imageName = containerInfo.Image || containerInfo.Config?.Image || "";

  return (
    labels.project === PROJECT_LABEL ||
    labels.project === LEGACY_PROJECT_LABEL ||
    names.some(
      (name: string) =>
        name.includes(CONTAINER_PREFIX) || name.includes(LEGACY_CONTAINER_PREFIX)
    ) ||
    imageName.includes(CONTAINER_PREFIX) ||
    imageName.includes(LEGACY_CONTAINER_PREFIX)
  );
}

function isOwnedByAccount(containerInfo: any, owner?: ProjectOwner): boolean {
  if (!owner) return true;

  const labels = containerInfo.Labels || containerInfo.Config?.Labels || {};

  if (labels.teamId === String(owner.teamId)) {
    return true;
  }

  return ALLOW_LEGACY_CONTAINERS && !labels.teamId;
}

export async function assertProjectContainer(
  containerId: string,
  owner?: ProjectOwner
): Promise<Docker.Container> {
  assertSafeContainerId(containerId);

  const container = docker.getContainer(containerId);
  const containerInfo = await container.inspect();

  if (!isProjectContainerInfo(containerInfo)) {
    throw new Error("Container is not managed by this workspace");
  }

  if (!isOwnedByAccount(containerInfo, owner)) {
    throw new Error("Container does not belong to this account");
  }

  return container;
}

function isProjectContainerRunning(containerInfo: any): boolean {
  const state = containerInfo?.State || {};
  return Boolean(state.Running && !state.Paused && !state.Restarting && !state.Dead);
}

async function ensureProjectContainerResourceLimits(
  container: Docker.Container,
  containerId: string,
  containerInfo: any
): Promise<void> {
  const currentPidsLimit = Number(containerInfo.HostConfig?.PidsLimit || 0);

  if (currentPidsLimit >= PROJECT_CONTAINER_PIDS_LIMIT) {
    return;
  }

  try {
    await container.update({
      PidsLimit: PROJECT_CONTAINER_PIDS_LIMIT,
      Memory: PROJECT_CONTAINER_MEMORY_BYTES,
      NanoCpus: PROJECT_CONTAINER_NANO_CPUS,
    } as any);
    console.log("project_container_limits_updated", {
      trace: "project_container_limits_updated",
      containerId,
      previousPidsLimit: currentPidsLimit,
      nextPidsLimit: PROJECT_CONTAINER_PIDS_LIMIT,
    });
  } catch (error) {
    console.warn("project_container_limits_update_failed", {
      trace: "project_container_limits_update_failed",
      containerId,
      previousPidsLimit: currentPidsLimit,
      nextPidsLimit: PROJECT_CONTAINER_PIDS_LIMIT,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function waitForProjectContainerRunning(
  container: Docker.Container,
  containerId: string
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < PROJECT_CONTAINER_RESUME_TIMEOUT_MS) {
    const info = await container.inspect();

    if (isProjectContainerRunning(info)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const info = await container.inspect().catch(() => null);
  throw new Error(
    `Container ${containerId} did not become running within ${PROJECT_CONTAINER_RESUME_TIMEOUT_MS}ms. Current state: ${
      info?.State?.Status || "unknown"
    }`
  );
}

export async function ensureProjectContainerRunning(
  containerId: string,
  owner?: ProjectOwner
): Promise<Docker.Container> {
  assertSafeContainerId(containerId);

  const existingResume = containerResumeLocks.get(containerId);
  if (existingResume) {
    await existingResume;
    return assertProjectContainer(containerId, owner);
  }

  const resumePromise = (async () => {
    const container = await assertProjectContainer(containerId, owner);
    const containerInfo = await container.inspect();
    await ensureProjectContainerResourceLimits(
      container,
      containerId,
      containerInfo
    );

    if (isProjectContainerRunning(containerInfo)) {
      return;
    }

    console.warn("project_container_auto_resume_required", {
      trace: "project_container_auto_resume_required",
      containerId,
      status: containerInfo.State?.Status,
      running: containerInfo.State?.Running,
      paused: containerInfo.State?.Paused,
      restarting: containerInfo.State?.Restarting,
      dead: containerInfo.State?.Dead,
    });

    if (containerInfo.State?.Paused) {
      await container.unpause();
    } else if (!containerInfo.State?.Running) {
      await container.start();
    }

    await waitForProjectContainerRunning(container, containerId);

    try {
      const resumedInfo = await container.inspect();
      const port = getPortFromContainer(resumedInfo);
      console.log("project_container_auto_resumed", {
        trace: "project_container_auto_resumed",
        containerId,
        port,
        status: resumedInfo.State?.Status,
      });
    } catch (error) {
      console.log("project_container_auto_resumed", {
        trace: "project_container_auto_resumed",
        containerId,
        status: "running",
        port: null,
        warning: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  containerResumeLocks.set(containerId, resumePromise);
  try {
    await resumePromise;
  } finally {
    containerResumeLocks.delete(containerId);
  }

  return assertProjectContainer(containerId, owner);
}

export async function listProjectContainers(owner?: ProjectOwner): Promise<any[]> {
  const containers = await docker.listContainers({ all: true });

  const projectContainers = containers.filter(
    (container) =>
      isProjectContainerInfo(container) && isOwnedByAccount(container, owner)
  );

  return projectContainers.map((container) => {
    const assignedPort = container.Labels?.assignedPort
      ? parseInt(container.Labels.assignedPort)
      : container.Ports?.find((p) => p.PrivatePort === 3000)?.PublicPort ||
        null;

    return {
      id: container.Id,
      name: container.Names?.[0]?.replace("/", ""),
      status: container.State,
      image: container.Image,
      created: new Date(container.Created * 1000).toISOString(),
      assignedPort,
      url: assignedPort ? buildPreviewUrl(container.Id) : null,
      rawUrl: assignedPort ? buildRawPreviewUrl(assignedPort) : null,
      ports:
        container.Ports?.map((port) => ({
          private: port.PrivatePort,
          public: port.PublicPort,
          type: port.Type,
        })) || [],
      labels: container.Labels,
    };
  });
}

export async function stopContainer(
  containerId: string,
  owner?: ProjectOwner
): Promise<void> {
  try {
    const container = await assertProjectContainer(containerId, owner);
    const containerInfo = await container.inspect();

    const port = getPortFromContainer(containerInfo);
    releasePort(port);

    await container.stop();
    console.log(`Stopped container: ${containerId}, released port: ${port}`);
  } catch (error) {
    throw new Error(
      `Failed to stop container: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
}

export async function deleteContainer(
  containerId: string,
  owner?: ProjectOwner
): Promise<void> {
  try {
    const container = await assertProjectContainer(containerId, owner);
    const containerInfo = await container.inspect();

    const port = getPortFromContainer(containerInfo);
    releasePort(port);

    if (containerInfo.State.Running) {
      console.log(`Stopping container before deletion: ${containerId}`);
      await container.stop();
    }

    await container.remove({ force: true });
    console.log(`Deleted container: ${containerId}, freed port: ${port}`);

    const imageName = containerInfo.Config.Image;
    if (
      imageName &&
      imageName.includes("dec-nextjs-") &&
      imageName !== TEMPLATE_IMAGE_NAME
    ) {
      try {
        const image = docker.getImage(imageName);
        await image.remove({ force: true });
        console.log(`Deleted associated image: ${imageName}`);
      } catch (imageError) {
        console.warn(`Could not delete image ${imageName}:`, imageError);
      }
    }
  } catch (error) {
    throw new Error(
      `Failed to delete container: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
}
