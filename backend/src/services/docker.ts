import { exec } from "child_process";
import Docker from "dockerode";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);
const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const BASE_PORT = 8000;

const usedPorts = new Set<number>();

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
  try {
    const { stdout } = await execAsync(`lsof -i :${port}`);
    return stdout.trim() === "";
  } catch {
    return true;
  }
}

function releasePort(port: number): void {
  usedPorts.delete(port);
}

export async function getDockerfile(): Promise<string> {
  return await fs.readFile("./src/Dockerfile", "utf-8");
}

export async function buildImage(containerId: string): Promise<string> {
  const tempDir = path.join("/tmp", `docker-app-${containerId}`);
  await fs.mkdir(tempDir, { recursive: true });

  try {
    const dockerfileContent = await getDockerfile();
    await fs.writeFile(path.join(tempDir, "Dockerfile"), dockerfileContent);

    const imageName = `dec-nextjs-${containerId}`;
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
  containerId: string
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
    },
  });

  console.log(`Starting container: ${container.id}`);
  await container.start();

  return { container, port: assignedPort };
}

export async function startContainer(
  containerId: string
): Promise<{ port: number }> {
  try {
    const container = docker.getContainer(containerId);
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

export async function listProjectContainers(): Promise<any[]> {
  const containers = await docker.listContainers({ all: true });

  const projectContainers = containers.filter(
    (container) =>
      container.Labels?.project === "december" ||
      container.Names?.some((name) => name.includes("dec-nextjs-"))
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
      url: assignedPort ? `http://localhost:${assignedPort}` : null,
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

export async function stopContainer(containerId: string): Promise<void> {
  try {
    const container = docker.getContainer(containerId);
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

export async function deleteContainer(containerId: string): Promise<void> {
  try {
    const container = docker.getContainer(containerId);
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
    if (imageName && imageName.includes("dec-nextjs-")) {
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
