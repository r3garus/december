import express from "express";
import { v4 as uuidv4 } from "uuid";
import * as dockerService from "../services/docker";
import * as exportService from "../services/export";
import * as fileService from "../services/file";
import * as packageService from "../services/package";

const router = express.Router();

const KLAWPEN_STARTER_PAGE = `import type { Metadata } from "next";

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
        <div className="relative w-full max-w-3xl rounded-[2rem] border border-white/80 bg-white/82 p-8 text-center shadow-[0_30px_90px_rgba(15,23,42,0.12)] backdrop-blur-xl sm:p-12">
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
          <div className="mx-auto mt-8 grid max-w-xl gap-3 text-left sm:grid-cols-3">
            {["Brief", "Code", "Preview"].map((item) => (
              <div key={item} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="mb-3 h-2 w-10 rounded-full bg-[#1689ff]" />
                <p className="text-sm font-bold text-slate-800">{item}</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">Preparing</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
`;

router.param("containerId", async (req, res, next, containerId: string) => {
  try {
    await dockerService.assertProjectContainer(containerId, req.account);
    next();
  } catch (error) {
    res.status(404).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Project container not found",
    });
  }
});

router.get("/", async (req, res) => {
  try {
    const containers = await dockerService.listProjectContainers(req.account);

    res.json({
      success: true,
      containers,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.post("/create", async (req, res) => {
  const containerId = uuidv4();

  try {
    const imageName = await dockerService.buildImage(containerId);
    const { container, port } = await dockerService.createContainer(
      imageName,
      containerId,
      {
        teamId: req.account!.teamId,
        localUserId: req.account!.localUserId,
      }
    );
    await fileService.writeFile(container.id, "src/app/page.tsx", KLAWPEN_STARTER_PAGE);

    res.json({
      success: true,
      containerId: container.id,
      container: {
        id: containerId,
        containerId: container.id,
        status: "running",
        port: port,
        url: dockerService.buildPreviewUrl(container.id),
        rawUrl: dockerService.buildRawPreviewUrl(port),
        createdAt: new Date().toISOString(),
        type: "Klawpen Workspace",
      },
    });
  } catch (error) {
    await dockerService.cleanupImage(containerId);

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.post("/:containerId/start", async (req, res) => {
  const { containerId } = req.params;

  try {
    const { port } = await dockerService.startContainer(containerId, req.account);

    res.json({
      success: true,
      containerId,
      port,
      url: dockerService.buildPreviewUrl(containerId),
      rawUrl: dockerService.buildRawPreviewUrl(port),
      status: "running",
      message: "Container started successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.post("/:containerId/stop", async (req, res) => {
  const { containerId } = req.params;

  try {
    await dockerService.stopContainer(containerId, req.account);

    res.json({
      success: true,
      containerId,
      status: "stopped",
      message: "Container stopped successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.delete("/:containerId", async (req, res) => {
  const { containerId } = req.params;

  try {
    await dockerService.deleteContainer(containerId, req.account);

    res.json({
      success: true,
      containerId,
      message: "Container deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.get("/:containerId/files", async (req, res) => {
  const { containerId } = req.params;
  const { path: containerPath = "/app/my-nextjs-app" } = req.query;

  try {
    const files = await fileService.listFiles(
      dockerService.docker,
      containerId,
      containerPath as string
    );

    res.json({
      success: true,
      path: containerPath,
      files,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.get("/:containerId/file-tree", async (req, res) => {
  const { containerId } = req.params;

  try {
    const fileTree = await fileService.getFileTree(
      dockerService.docker,
      containerId
    );

    res.json({
      success: true,
      fileTree,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.get("/:containerId/file-content-tree", async (req, res) => {
  const { containerId } = req.params;

  try {
    const fileContentTree = await fileService.getFileContentTree(
      dockerService.docker,
      containerId
    );

    res.json({
      success: true,
      fileContentTree,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

//@ts-ignore
router.get("/:containerId/file", async (req, res) => {
  const { containerId } = req.params;
  const { path: filePath } = req.query;

  if (!filePath) {
    return res.status(400).json({
      success: false,
      error: "File path is required",
    });
  }

  try {
    const content = await fileService.readFile(
      dockerService.docker,
      containerId,
      filePath as string
    );

    res.json({
      success: true,
      content,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.put("/:containerId/files", async (req, res) => {
  const { containerId } = req.params;
  const { path: filePath, content } = req.body;

  try {
    await fileService.writeFile(containerId, filePath, content);

    res.json({
      success: true,
      message: "File updated successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.put("/:containerId/files/rename", async (req, res) => {
  const { containerId } = req.params;
  const { oldPath, newPath } = req.body;

  try {
    await fileService.renameFile(containerId, oldPath, newPath);

    res.json({
      success: true,
      message: "File renamed successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.delete("/:containerId/files", async (req, res) => {
  const { containerId } = req.params;
  const { path: filePath } = req.body;

  try {
    await fileService.removeFile(containerId, filePath);

    res.json({
      success: true,
      message: "File removed successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

router.post("/:containerId/dependencies", async (req, res) => {
  const { containerId } = req.params;
  const { packageName, isDev = false } = req.body;

  try {
    const output = await packageService.addDependency(
      containerId,
      packageName,
      isDev
    );

    res.json({
      success: true,
      message: "Dependency added successfully",
      output,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

//@ts-ignore
router.get("/:containerId/export", async (req, res) => {
  const { containerId } = req.params;

  try {
    const zipBuffer = await exportService.exportContainerCode(containerId);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="nextjs-project-${containerId.slice(0, 8)}.zip"`
    );
    res.setHeader("Content-Length", zipBuffer.length);

    res.send(zipBuffer);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
