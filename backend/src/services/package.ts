import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const BASE_PATH = "/app/my-nextjs-app";
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
  const args = ["exec", "-w", BASE_PATH, containerId, "bun", "add", packageSpec];

  if (isDev) {
    args.push("--dev");
  }

  const { stdout, stderr } = await execFileAsync("docker", args);
  return stdout || stderr;
}
