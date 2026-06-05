import express from "express";
import { consumeAiRequestCredit } from "../services/account";
import { estimateAiWorkload } from "../services/aiProvider";
import * as dockerService from "../services/docker";
import * as llmService from "../services/llm";

const router = express.Router();
const MAX_MESSAGE_CHARS = 20_000;
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 8_000_000;
const MAX_TOTAL_ATTACHMENT_BYTES = 12_000_000;
const CREDIT_UNIT_CENTS = Number(process.env.KLAWPEN_CORE_CREDIT_CENTS || "100");

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

function estimateBase64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

function validateAttachments(value: unknown): llmService.Attachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Attachments must be an array");
  }
  if (value.length > MAX_ATTACHMENTS) {
    throw new Error(`Only ${MAX_ATTACHMENTS} attachments are allowed`);
  }

  let totalBytes = 0;

  return value.map((attachment) => {
    if (!attachment || typeof attachment !== "object") {
      throw new Error("Invalid attachment");
    }

    const item = attachment as Record<string, unknown>;
    const type = item.type;
    const data = item.data;
    const name = item.name;
    const mimeType = item.mimeType;
    const declaredSize = item.size;

    if (type !== "image" && type !== "document") {
      throw new Error("Attachment type must be image or document");
    }
    if (
      typeof data !== "string" ||
      !data ||
      data.length > Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
    ) {
      throw new Error("Attachment data is invalid or too large");
    }
    if (typeof name !== "string" || !name.trim() || name.length > 160) {
      throw new Error("Attachment name is invalid");
    }
    if (
      typeof mimeType !== "string" ||
      !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)
    ) {
      throw new Error("Attachment mime type is invalid");
    }
    if (
      typeof declaredSize !== "number" ||
      !Number.isFinite(declaredSize) ||
      declaredSize < 0 ||
      declaredSize > MAX_ATTACHMENT_BYTES
    ) {
      throw new Error("Attachment size is invalid");
    }

    const estimatedBytes = estimateBase64Bytes(data);
    if (estimatedBytes > MAX_ATTACHMENT_BYTES) {
      throw new Error("Attachment exceeds the per-file size limit");
    }

    totalBytes += estimatedBytes;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error("Attachments exceed the total size limit");
    }

    return {
      type,
      data,
      name: name.trim(),
      mimeType,
      size: declaredSize,
    };
  });
}

function getTotalAttachmentBytes(attachments: llmService.Attachment[]) {
  return attachments.reduce(
    (total, attachment) => total + estimateBase64Bytes(attachment.data),
    0
  );
}

//@ts-ignore
router.post("/:containerId/messages", async (req, res) => {
  const { containerId } = req.params;
  const { message, attachments = [], stream = false } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({
      success: false,
      error: "Message is required",
    });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return res.status(400).json({
      success: false,
      error: `Message must be ${MAX_MESSAGE_CHARS} characters or fewer`,
    });
  }

  let safeAttachments: llmService.Attachment[];
  try {
    safeAttachments = validateAttachments(attachments);
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : "Invalid attachments",
    });
  }

  const shouldStream = stream === true;

  try {
    const account = req.account;

    if (!account) {
      return res.status(401).json({
        success: false,
        error: "Please sign in to continue.",
      });
    }

    const shortcutReply = llmService.getConversationalShortcutReply(
      message,
      safeAttachments.length
    );

    if (shortcutReply) {
      const { userMessage, assistantMessage } =
        llmService.addConversationalMessage(containerId, message, shortcutReply);

      if (shouldStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.write(`data: ${JSON.stringify({ type: "user", data: userMessage })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            type: "assistant",
            data: assistantMessage,
          })}\n\n`
        );
        res.write(`data: ${JSON.stringify({ type: "done", data: assistantMessage })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      return res.json({
        success: true,
        userMessage,
        assistantMessage,
      });
    }

    const clarificationReply = llmService.getBuildClarificationReply(message);

    if (clarificationReply) {
      const { userMessage, assistantMessage } =
        llmService.addConversationalMessage(
          containerId,
          message,
          clarificationReply
        );

      if (shouldStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.write(`data: ${JSON.stringify({ type: "user", data: userMessage })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            type: "assistant",
            data: assistantMessage,
          })}\n\n`
        );
        res.write(`data: ${JSON.stringify({ type: "done", data: assistantMessage })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      return res.json({
        success: true,
        userMessage,
        assistantMessage,
      });
    }

    const workload = estimateAiWorkload({
      message,
      attachmentCount: safeAttachments.length,
      totalAttachmentBytes: getTotalAttachmentBytes(safeAttachments),
    });
    const requestCreditCents = workload.coreCredits * CREDIT_UNIT_CENTS;

    const usage = await consumeAiRequestCredit({
      account,
      requestCreditCents,
      model: "klawpen-core",
      metadata: {
        containerId,
        coreCredits: workload.coreCredits,
        workloadTier: workload.tier,
        inputScore: workload.inputScore,
        attachmentCount: safeAttachments.length,
        streaming: shouldStream,
      },
    });

    if (!usage.allowed) {
      const error =
        usage.reason === "free_limit_reached"
          ? "Free plan limit reached. Upgrade your plan to continue building."
          : "Your Klawpen Core credit is not enough. Add credit or upgrade your plan.";

      return res.status(402).json({
        success: false,
        error,
        usage,
      });
    }

    if (llmService.shouldUseConversationOnlyMode(message, safeAttachments.length)) {
      const { userMessage, assistantMessage } =
        await llmService.answerConversationOnlyMessage(
          containerId,
          message,
          workload
        );

      if (shouldStream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.write(`data: ${JSON.stringify({ type: "user", data: userMessage })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            type: "assistant",
            data: assistantMessage,
          })}\n\n`
        );
        res.write(`data: ${JSON.stringify({ type: "done", data: assistantMessage })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      return res.json({
        success: true,
        userMessage,
        assistantMessage,
      });
    }

    if (shouldStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const messageStream = llmService.sendMessageStream(
        containerId,
        message,
        safeAttachments,
        workload
      );

      for await (const chunk of messageStream) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      const { userMessage, assistantMessage } = await llmService.sendMessage(
        containerId,
        message,
        safeAttachments,
        workload
      );

      res.json({
        success: true,
        userMessage,
        assistantMessage,
      });
    }
  } catch (error) {
    console.log(error);
    if (shouldStream) {
      res.write(
        `data: ${JSON.stringify({
          type: "error",
          data: {
            error: error instanceof Error ? error.message : "Unknown error",
          },
        })}\n\n`
      );
      res.end();
    } else {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
});

router.get("/:containerId/messages", async (req, res) => {
  const { containerId } = req.params;

  try {
    const session = llmService.getOrCreateChatSession(containerId);

    res.json({
      success: true,
      messages: session.messages,
      sessionId: session.id,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
