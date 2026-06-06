import Docker from "dockerode";
import { Writable } from "stream";
import { docker } from "./dockerClient";

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

async function runContainerCommand(
  containerId: string,
  command: string[],
  workingDir: string = BASE_PATH
): Promise<string> {
  assertSafeContainerId(containerId);

  const container = docker.getContainer(containerId);
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
  const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
  const stderrText = Buffer.concat(stderrChunks).toString("utf8");

  if (result.ExitCode !== 0) {
    throw new Error(
      stderrText.trim() ||
        stdoutText.trim() ||
        `Container command failed with exit code ${result.ExitCode}`
    );
  }

  return stdoutText || stderrText;
}

export async function addDependency(
  containerId: string,
  packageName: string,
  isDev: boolean = false
): Promise<string> {
  assertSafeContainerId(containerId);
  const packageSpec = normalizePackageSpec(packageName);
  const args = ["bun", "add", packageSpec];

  if (isDev) {
    args.push("--dev");
  }

  return runContainerCommand(containerId, args, BASE_PATH);
}
