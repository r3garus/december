import Docker from "dockerode";

function readDockerClientOptions(): Docker.DockerOptions {
  const proxyUrl =
    process.env.DOCKER_SOCKET_PROXY_URL ||
    process.env.DOCKER_HOST_PROXY_URL ||
    "";

  if (proxyUrl.trim()) {
    try {
      const url = new URL(proxyUrl);
      return {
        protocol: url.protocol.replace(":", "") as "http" | "https",
        host: url.hostname,
        port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      };
    } catch {
      throw new Error("DOCKER_SOCKET_PROXY_URL must be a valid URL");
    }
  }

  const proxyHost =
    process.env.DOCKER_SOCKET_PROXY_HOST ||
    process.env.DOCKER_HOST_PROXY_HOST ||
    "";

  if (proxyHost.trim()) {
    return {
      protocol: (process.env.DOCKER_SOCKET_PROXY_PROTOCOL || "http") as
        | "http"
        | "https",
      host: proxyHost.trim(),
      port: Number(
        process.env.DOCKER_SOCKET_PROXY_PORT ||
          process.env.DOCKER_HOST_PROXY_PORT ||
          "2375"
      ),
    };
  }

  return {
    socketPath: process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock",
  };
}

export const docker = new Docker(readDockerClientOptions());

