import Docker from "dockerode";
import crypto from "crypto";
import fs from "fs/promises";
import net from "net";
import os from "os";
import path from "path";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const BASE_PORT = 8100;
const ALLOW_LEGACY_CONTAINERS = process.env.ALLOW_LEGACY_CONTAINERS === "true";
const PROJECT_LABEL = "klawpen";
const LEGACY_PROJECT_LABEL = ["de", "cember"].join("");
const CONTAINER_PREFIX = "klawpen-workspace-";
const LEGACY_CONTAINER_PREFIX = ["dec", "nextjs"].join("-") + "-";
const TEMPLATE_IMAGE_NAME =
  process.env.PROJECT_TEMPLATE_IMAGE || "klawpen-workspace-template";
const TEMPLATE_IMAGE_VERSION = (
  process.env.PROJECT_TEMPLATE_VERSION || "klawpen-workspace-v2"
).replace(/[^a-zA-Z0-9_.-]/g, "-");
const TEMPLATE_VERSION_LABEL = "klawpen.template.version";
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
}

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

export function buildRawPreviewUrl(port: number): string {
  return `${process.env.PREVIEW_BASE_URL || "http://localhost"}:${port}`;
}

export async function getDockerfile(): Promise<string> {
  return await fs.readFile("./src/Dockerfile", "utf-8");
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
    "src/app/globals.css",
    `@import "tailwindcss";

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
  try {
    const existingImage = docker.getImage(TEMPLATE_IMAGE_NAME);
    const imageInfo = await existingImage.inspect();
    const imageVersion = imageInfo.Config?.Labels?.[TEMPLATE_VERSION_LABEL];

    if (imageVersion === TEMPLATE_IMAGE_VERSION) {
      console.log(`Using cached template image: ${TEMPLATE_IMAGE_NAME}`);
      return TEMPLATE_IMAGE_NAME;
    }

    console.log(
      `Template image version changed (${imageVersion || "none"} -> ${TEMPLATE_IMAGE_VERSION}); rebuilding.`
    );
    await existingImage.remove({ force: true });
  } catch {
    // Image does not exist or could not be inspected; build it once and reuse it.
  }

  const tempDir = path.join("/tmp", `docker-app-${containerId}`);
  await fs.mkdir(tempDir, { recursive: true });

  try {
    const dockerfileContent = `${(await getDockerfile()).trimEnd()}\n\nLABEL ${TEMPLATE_VERSION_LABEL}="${TEMPLATE_IMAGE_VERSION}"\n`;
    await fs.writeFile(path.join(tempDir, "Dockerfile"), dockerfileContent);
    await writeKlawpenWorkspaceTemplate(tempDir);

    const imageName = TEMPLATE_IMAGE_NAME;
    console.log(`Building image: ${imageName}`);

    const tarStream = await docker.buildImage(
      {
        context: tempDir,
        src: [
          "Dockerfile",
          "package.json",
          "tsconfig.json",
          "next.config.ts",
          "postcss.config.mjs",
          "src",
        ],
      },
      {
        t: imageName,
        rm: true,
        forcerm: true,
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
            console.log("Build completed successfully");
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
    await image.inspect();
    console.log(`Image ${imageName} created successfully`);

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
  owner: ProjectOwner
): Promise<{ container: Docker.Container; port: number }> {
  const containerName = `${CONTAINER_PREFIX}${containerId}`;
  const assignedPort = await findAvailablePort();
  const networkMode = await resolveProjectNetwork();

  console.log(`Creating container: ${containerName} on port ${assignedPort}`);

  const container = await docker.createContainer({
    Image: imageName,
    name: containerName,
    ExposedPorts: { "3000/tcp": {} },
    HostConfig: {
      PortBindings: { "3000/tcp": [{ HostPort: assignedPort.toString() }] },
      ...(networkMode ? { NetworkMode: networkMode } : {}),
    },
    Labels: {
      project: PROJECT_LABEL,
      type: "klawpen-workspace",
      assignedPort: assignedPort.toString(),
      teamId: String(owner.teamId),
      userId: owner.localUserId ? String(owner.localUserId) : "",
    },
  });

  console.log(`Starting container: ${container.id}`);
  await container.start();

  return { container, port: assignedPort };
}

export async function startContainer(
  containerId: string,
  owner?: ProjectOwner
): Promise<{ port: number }> {
  try {
    const container = await assertProjectContainer(containerId, owner);
    const containerInfo = await container.inspect();

    if (containerInfo.State.Running) {
      const port = getPortFromContainer(containerInfo);
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
  const container = await assertProjectContainer(containerId);
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
