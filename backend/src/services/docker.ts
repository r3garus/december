import Docker from "dockerode";
import fs from "fs/promises";
import net from "net";
import path from "path";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const BASE_PORT = 8100;
const ALLOW_LEGACY_CONTAINERS = process.env.ALLOW_LEGACY_CONTAINERS === "true";
const TEMPLATE_IMAGE_NAME =
  process.env.PROJECT_TEMPLATE_IMAGE || "dec-nextjs-template-klawpen";

const usedPorts = new Set<number>();

export interface ProjectOwner {
  teamId: number;
  localUserId?: number;
}

async function getAllAssignedPorts(): Promise<number[]> {
  const containers = await docker.listContainers({ all: true });
  const projectContainers = containers.filter(
    (container) =>
      container.Labels?.project === "december" ||
      container.Names?.some((name) => name.includes("dec-nextjs-"))
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

export async function getDockerfile(): Promise<string> {
  return await fs.readFile("./src/Dockerfile", "utf-8");
}

export async function buildImage(containerId: string): Promise<string> {
  try {
    await docker.getImage(TEMPLATE_IMAGE_NAME).inspect();
    console.log(`Using cached template image: ${TEMPLATE_IMAGE_NAME}`);
    return TEMPLATE_IMAGE_NAME;
  } catch {
    // Image does not exist yet; build it once and reuse it for new projects.
  }

  const tempDir = path.join("/tmp", `docker-app-${containerId}`);
  await fs.mkdir(tempDir, { recursive: true });

  try {
    const dockerfileContent = await getDockerfile();
    await fs.writeFile(path.join(tempDir, "Dockerfile"), dockerfileContent);

    const imageName = TEMPLATE_IMAGE_NAME;
    console.log(`Building image: ${imageName}`);

    const tarStream = await docker.buildImage(
      {
        context: tempDir,
        src: ["Dockerfile"],
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
  const containerName = `dec-nextjs-${containerId}`;
  const assignedPort = await findAvailablePort();

  console.log(`Creating container: ${containerName} on port ${assignedPort}`);

  const container = await docker.createContainer({
    Image: imageName,
    name: containerName,
    ExposedPorts: { "3000/tcp": {} },
    HostConfig: {
      PortBindings: { "3000/tcp": [{ HostPort: assignedPort.toString() }] },
    },
    Labels: {
      project: "december",
      type: "nextjs-app",
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

    const imageName = `dec-nextjs-${containerId}`;
    const image = docker.getImage(imageName);
    await image.remove({ force: true });
    console.log(`Cleaned up failed image: ${imageName}`);
  } catch (cleanupError) {}
}

export function getContainer(containerId: string): Docker.Container {
  return docker.getContainer(containerId);
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
    labels.project === "december" ||
    names.some((name: string) => name.includes("dec-nextjs-")) ||
    imageName.includes("dec-nextjs-")
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
      url: assignedPort
        ? `${process.env.PREVIEW_BASE_URL || "http://localhost"}:${assignedPort}`
        : null,
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
