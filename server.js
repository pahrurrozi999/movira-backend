import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import "dotenv/config";

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(helmet());

app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "http://localhost:3000",
  methods: ["GET", "POST"],
}));

app.use(express.json({ limit: "1mb" }));

const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Terlalu banyak permintaan. Coba lagi sebentar."
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Movira backend",
    version: "0.1.0"
  });
});

app.post("/api/generate", generateLimiter, (req, res) => {
  const { prompt, ratio, duration } = req.body || {};

  const allowedRatios = new Set([
    "16:9",
    "9:16",
    "1:1"
  ]);

  const allowedDurations = new Set([
    5,
    10,
    15
  ]);

  if (
    typeof prompt !== "string" ||
    prompt.trim().length < 3 ||
    prompt.length > 1000
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

  if (!allowedDurations.has(Number(duration))) {
    return res.status(400).json({
      error: "Durasi tidak valid."
    });
  }

  return res.status(501).json({
    error: "AI video belum dihubungkan.",
    message: "Backend aman sudah menerima dan memvalidasi request."
  });
});

app.use((_req, res) => {
  res.status(404).json({
    error: "Endpoint tidak ditemukan."
  });
});

app.listen(PORT, () => {
  console.log(
    `Movira backend berjalan di port ${PORT}`
  );
});
