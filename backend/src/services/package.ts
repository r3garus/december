import { runSandboxCommand, PROJECT_WORKSPACE_PATH } from "./sandbox";

const PACKAGE_SPEC_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[a-z0-9._~^*<>=+-][a-z0-9._~^*<>=+-]*)?$/i;

function assertSafeContainerId(containerId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(containerId)) {
    throw new Error("Invalid container id");
  }
}

function normalizePackageSpec(packageName: string): string {
  const packageSpec = packageName.trim();

  if (
    !packageSpec ||
    packageSpec.length > 214 ||
    !PACKAGE_SPEC_PATTERN.test(packageSpec)
  ) {
    throw new Error("Invalid package name");
  }

  return packageSpec;
}

export async function addDependency(
  containerId: string,
  packageName: string,
  isDev: boolean = false
): Promise<string> {
  assertSafeContainerId(containerId);
  const packageSpec = normalizePackageSpec(packageName);
  const args = ["npm", "install", packageSpec];

  if (isDev) {
    args.push("--save-dev");
  }

  args.push("--prefer-offline", "--no-audit", "--no-fund", "--quiet");

  return runSandboxCommand(containerId, args, {
    cwd: PROJECT_WORKSPACE_PATH,
    timeoutMs: Number(process.env.E2B_INSTALL_TIMEOUT_MS || "240000"),
  });
}
