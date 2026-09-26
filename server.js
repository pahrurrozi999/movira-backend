 import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { fal } from "@fal-ai/client";
import "dotenv/config";

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(helmet());

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "http://localhost:3000",
  methods: ["GET", "POST"],
}));

app.use(express.json({ limit: "15mb" }));

const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Terlalu banyak permintaan. Coba lagi sebentar."
  }
});

const MODEL = "alibaba/wan-3.0-prime/image-to-video";

const allowedRatios = new Set([
  "16:9",
  "9:16",
  "1:1"
]);

const allowedResolutions = new Set([
  "480p",
  "720p",
  "1080p"
]);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Movira backend",
    version: "0.2.0"
  });
});

app.post("/api/generate", generateLimiter, async (req, res) => {
  try {
    const {
      prompt,
      ratio,
      duration,
      resolution = "720p",
      imageUrl,
      imageData,
      audio = true
    } = req.body || {};

    if (
      typeof prompt !== "string" ||
      prompt.trim().length < 3 ||
      prompt.length > 5000
    ) {
      return res.status(400).json({
        error: "Prompt tidak valid."
      });
    }

    if (!allowedRatios.has(ratio)) {
      return res.status(400).json({
        error: "Rasio tidak valid."
      });
    }

    if (!allowedResolutions.has(resolution)) {
      return res.status(400).json({
        error: "Resolusi tidak valid."
      });
    }

    const videoDuration = Number(duration);

    if (
      !Number.isInteger(videoDuration) ||
      videoDuration < 2 ||
      videoDuration > 30
    ) {
      return res.status(400).json({
        error: "Durasi harus antara 2 dan 30 detik."
      });
    }

    let startImageUrl = imageUrl;

    // Mendukung gambar dalam bentuk data URI dari frontend.
    if (!startImageUrl && typeof imageData === "string") {
      if (!imageData.startsWith("data:image/")) {
        return res.status(400).json({
          error: "Format imageData tidak valid."
        });
      }

      const match = imageData.match(
        /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/
      );

      if (!match) {
        return res.status(400).json({
          error: "Data gambar tidak valid."
        });
      }

      const mimeType = match[1];
      const base64Data = match[2];
      const buffer = Buffer.from(base64Data, "base64");

      if (buffer.length > 10 * 1024 * 1024) {
        return res.status(400).json({
          error: "Ukuran gambar maksimal 10 MB."
        });
      }

      const extension = mimeType.split("/")[1].replace("jpeg", "jpg");

      const file = new File(
        [buffer],
        `movira-input.${extension}`,
        { type: mimeType }
      );

      startImageUrl = await fal.storage.upload(file);
    }

    if (!startImageUrl || typeof startImageUrl !== "string") {
      return res.status(400).json({
        error: "Gambar wajib diberikan."
      });
    }

    const result = await fal.subscribe(MODEL, {
      input: {
        prompt: prompt.trim(),
        start_image_url: startImageUrl,
        resolution,
        aspect_ratio: ratio,
        duration: videoDuration,
        audio: Boolean(audio),
        enable_prompt_expansion: true,
        enable_safety_checker: true
      },
      logs: true
    });

    return res.json({
      ok: true,
      requestId: result.requestId,
      video: result.data?.video || null,
      seed: result.data?.seed ?? null,
      duration: result.data?.duration ?? null,
      actualPrompt: result.data?.actual_prompt ?? null
    });

  } catch (error) {
    console.error("Movira generation error:", error);

    return res.status(500).json({
      error: "Gagal membuat video.",
      message: "Terjadi kesalahan saat menghubungi layanan video."
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({
    error: "Endpoint tidak ditemukan."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Movira backend berjalan di port ${PORT}`);
});
