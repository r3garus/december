import express from "express";
import { v4 as uuidv4 } from "uuid";
import * as dockerService from "../services/docker";
import * as exportService from "../services/export";
import * as fileService from "../services/file";
import * as packageService from "../services/package";

const router = express.Router();
const previewBase = process.env.PREVIEW_BASE_URL || "http://localhost";

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

    res.json({
      success: true,
      containerId: container.id,
      container: {
        id: containerId,
        containerId: container.id,
        status: "running",
        port: port,
        url: `${previewBase}:${port}`,
        createdAt: new Date().toISOString(),
        type: "Next.js App",
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
      url: `${previewBase}:${port}`,
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
