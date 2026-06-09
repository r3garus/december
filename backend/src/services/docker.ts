import {
  PROJECT_PREVIEW_PORT,
  assertProjectSandbox,
  buildDirectPreviewUrl,
  buildPreviewProxyUrl,
  createSandboxWorkspace,
  deleteSandbox,
  ensureProjectSandboxRunning,
  getPreviewProxyOrigin,
  getPreviewRuntime,
  getProjectDevServerDiagnostics,
  getSandboxRuntimeDiagnostics,
  isValidPreviewToken,
  listProjectSandboxes,
  restartProjectDevServer,
  signProjectPreviewToken,
  startSandbox,
  stopSandbox,
  type CreateSandboxOptions,
  type ProjectOwner,
} from "./sandbox";

export type { ProjectOwner };
export interface CreateContainerOptions extends CreateSandboxOptions {}

// Kept as a compatibility token for older call sites. File operations now use E2B.
export const docker = {
  runtime: "e2b",
};

export function signPreviewToken(containerId: string): string | null {
  return signProjectPreviewToken(containerId);
}

export {
  isValidPreviewToken,
  getPreviewProxyOrigin,
  getPreviewRuntime,
  getProjectDevServerDiagnostics,
  restartProjectDevServer,
};

export function buildPreviewUrl(containerId: string): string {
  return buildDirectPreviewUrl(containerId) || buildPreviewProxyUrl(containerId);
}

export function buildRawPreviewUrl(portOrContainerId: number | string): string {
  if (typeof portOrContainerId === "string") {
    return buildDirectPreviewUrl(portOrContainerId) || buildPreviewProxyUrl(portOrContainerId);
  }

  return `e2b-preview-port-${portOrContainerId || PROJECT_PREVIEW_PORT}`;
}

export function buildRawPreviewUrlForContainer(containerId: string): string | null {
  return buildDirectPreviewUrl(containerId);
}

export function getDockerRuntimeDiagnostics() {
  return getSandboxRuntimeDiagnostics();
}

export async function getDockerfile(): Promise<string> {
  return "# Docker runtime has been replaced by E2B Cloud Sandboxes.";
}

export async function buildImage(containerId: string): Promise<string> {
  return `e2b:${containerId}`;
}

export async function createContainer(
  _imageName: string,
  containerId: string,
  owner: ProjectOwner,
  options: CreateContainerOptions = {}
) {
  return createSandboxWorkspace(containerId, owner, options);
}

export async function startContainer(containerId: string, owner?: ProjectOwner) {
  return startSandbox(containerId, owner);
}

export async function stopContainer(
  containerId: string,
  owner?: ProjectOwner
): Promise<void> {
  await stopSandbox(containerId, owner);
}

export async function deleteContainer(
  containerId: string,
  owner?: ProjectOwner
): Promise<void> {
  await deleteSandbox(containerId, owner);
}

export async function cleanupImage(_containerId: string): Promise<void> {
  // No local images are built in the E2B runtime.
}

export function getContainer(containerId: string) {
  return assertProjectSandbox(containerId);
}

export async function assertProjectContainer(
  containerId: string,
  owner?: ProjectOwner
) {
  return assertProjectSandbox(containerId, owner);
}

export async function ensureProjectContainerRunning(
  containerId: string,
  owner?: ProjectOwner
) {
  return ensureProjectSandboxRunning(containerId, owner);
}

export async function listProjectContainers(owner?: ProjectOwner) {
  return listProjectSandboxes(owner);
}
