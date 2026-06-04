import express from "express";
import { buildAccountSnapshot } from "../services/account";

const router = express.Router();

router.get("/me", (req, res) => {
  if (!req.account) {
    res.status(401).json({
      success: false,
      error: "Please sign in to continue.",
    });
    return;
  }

  res.json(buildAccountSnapshot(req.account));
});

export default router;
