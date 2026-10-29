 import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { fal } from "@fal-ai/client";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import "dotenv/config";
import multer from "multer";
const app = express();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

async function consumeFreeVideoTrial(userId) {
  const { data, error } = await supabase.rpc(
    "consume_free_video_trial",
    {
      p_user_id: userId
    }
  );

  if (error) {
    throw error;
  }

  return data === true;
}


function findMp4Box(buffer, start, end, targetType) {
  let offset = start;
  while (offset + 8 <= end) {
    let boxSize = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    let headerSize = 8;
    if (boxSize === 1) {
      if (offset + 16 > end) return null;
      const largeSize = buffer.readBigUInt64BE(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      boxSize = Number(largeSize);
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = end - offset;
    }
    if (boxSize < headerSize || offset + boxSize > end) return null;
    if (type === targetType) {
      return { start: offset + headerSize, end: offset + boxSize };
    }
    offset += boxSize;
  }
  return null;
}

function readMp4DurationSeconds(buffer) {
  const moov = findMp4Box(buffer, 0, buffer.length, "moov");
  if (!moov) return null;
  const mvhd = findMp4Box(buffer, moov.start, moov.end, "mvhd");
  if (!mvhd || mvhd.start >= mvhd.end) return null;
  const version = buffer[mvhd.start];
  try {
    if (version === 1) {
      if (mvhd.start + 32 > mvhd.end) return null;
      const timescale = buffer.readUInt32BE(mvhd.start + 20);
      const duration = Number(buffer.readBigUInt64BE(mvhd.start + 24));
      return timescale > 0 && Number.isFinite(duration) ? duration / timescale : null;
    }
    if (mvhd.start + 20 > mvhd.end) return null;
    const timescale = buffer.readUInt32BE(mvhd.start + 12);
    const duration = buffer.readUInt32BE(mvhd.start + 16);
    return timescale > 0 ? duration / timescale : null;
  } catch {
    return null;
  }
}

function readImageDimensions(buffer, mimeType = "") {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;

  if (mimeType === "image/png" && buffer.toString("ascii", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  if (mimeType === "image/bmp" && buffer.toString("ascii", 0, 2) === "BM" && buffer.length >= 26) {
    return { width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)) };
  }

  if (mimeType === "image/jpeg" && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 4 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      if (offset >= buffer.length) break;
      const marker = buffer[offset++];
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > buffer.length) break;
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
      if (sofMarkers.has(marker) && segmentLength >= 7) {
        const height = buffer.readUInt16BE(offset + 3);
        const width = buffer.readUInt16BE(offset + 5);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      offset += segmentLength;
    }
  }

  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buffer.length >= 30) {
      return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    }
    if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
      const b1 = buffer[21], b2 = buffer[22], b3 = buffer[23], b4 = buffer[24];
      return {
        width: 1 + (((b2 & 0x3f) << 8) | b1),
        height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))
      };
    }
    if (chunk === "VP8 " && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
  }
  return null;
}

const PORT = Number(process.env.PORT || 3000);

app.use(helmet());

app.use((req, res, next) => {
  console.log("REQUEST MASUK:", req.method, req.path, {
    origin: req.headers.origin,
    hasAuth: Boolean(req.headers.authorization)
  });
  next();
});

app.use(cors({
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "15mb" }));
const DEMO_MODE = process.env.DEMO_MODE === "true";
const PAYMENT_SIMULATION_ENABLED = process.env.PAYMENT_SIMULATION_MODE === "true";
const CREDIT_ORDER_PRICES = {
  IDR: { 50: 15000, 120: 35000, 300: 85000, 500: 135000, 1000: 250000 },
  MYR: { 50: 5, 120: 10, 300: 20, 500: 35, 1000: 65 },
  USD: { 50: 1, 120: 2, 300: 5, 500: 8, 1000: 14 }
};
const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: "Terlalu banyak permintaan. Coba lagi sebentar."
  }
});

const DEFAULT_MODEL = "alibaba/wan-3.0-prime/image-to-video";


const ALLOWED_MODELS = new Set([
  "alibaba/wan-3.0-prime/image-to-video",
  "alibaba/wan-3.0/image-to-video",
  "wan/v2.6/image-to-video",
  "fal-ai/veo3.1/lite/image-to-video",
  "wan/v2.6/reference-to-video/flash",
  "fal-ai/wan/v2.2-a14b/video-to-video",
  "minimax/h3-max-turbo/image-to-video",
  "minimax/h3-max/reference-to-video",
  "minimax/h3-max/reframe-video",
  "google/gemini-omni-flash/image-to-video",
  "google/gemini-omni-flash/v1.1/reference-to-video",
  "google/gemini-omni-flash/v1.1/edit",
]);

const allowedRatios = new Set([
  "16:9",
  "9:16",
  "1:1"
]);

const allowedResolutions = new Set([
  "360p",
  "480p",
  "580p",
  "720p",
  "768p",
  "1080p"
]);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Movira backend",
    version: "0.2.0"
  });
});

app.get("/api/video-requests", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const accessToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!accessToken) {
      return res.status(401).json({
        error: "Silakan login terlebih dahulu."
      });
    }

    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser(accessToken);

    if (authError || !user) {
      return res.status(401).json({
        error: "Sesi login tidak valid."
      });
    }

    const { data, error } = await supabase
      .from("video_generation_requests")
      .select(
        "id, model, status, credit_amount, project_id, scene_number, created_at, updated_at"
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) {
      console.error("Gagal membaca antrean video:", error);
      return res.status(500).json({
        error: "Gagal membaca status video."
      });
    }

    return res.json({
      ok: true,
      requests: data || []
    });
  } catch (error) {
    console.error("Video requests error:", error);

    return res.status(500).json({
      error: "Terjadi kesalahan saat membaca antrean video."
    });
  }
});

app.get("/api/video-history", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const accessToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!accessToken) {
      return res.status(401).json({
        error: "Silakan login terlebih dahulu."
      });
    }

    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser(accessToken);

    if (authError || !user) {
      return res.status(401).json({
        error: "Sesi login tidak valid."
      });
    }

    const { data, error } = await supabase
      .from("video_history")
      .select(
        "id, prompt, video_url, source_image_url, ratio, duration, resolution, project_id, scene_number, created_at"
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      console.error("Gagal membaca riwayat video:", error);
      return res.status(500).json({
        error: "Gagal membaca riwayat video."
      });
    }

    return res.json({
      ok: true,
      history: data || []
    });
  } catch (error) {
    console.error("Video history error:", error);
    return res.status(500).json({
      error: "Terjadi kesalahan saat membaca riwayat video."
    });
  }
});

app.get("/api/credits", async (req, res) => {
 console.log("KODE KREDIT TERBARU V1");
  try {
    const authHeader = req.headers.authorization || "";

    const accessToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;
console.log("GET /api/credits", {
  origin: req.headers.origin,
  hasAuth: Boolean(accessToken)
});
    if (!accessToken) {
      return res.status(401).json({
        error: "Silakan login terlebih dahulu."
      });
    }

    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser(accessToken);
console.log("SELESAI GET USER", {
  hasUser: Boolean(user),
  hasAuthError: Boolean(authError)
});
   
console.log("SUPABASE AUTH DETAIL:", JSON.stringify(authError));
   
   if (authError) {
  console.error("SUPABASE AUTH ERROR:", authError.message);
   }
   
    if (authError || !user) {
      return res.status(401).json({
        error: "Sesi login tidak valid."
      });
    }

    const { data, error } = await supabase
      .from("user_credits")
      .select("credits")
      .eq("user_id", user.id)
      .single();
console.log("HASIL KREDIT:", {
  credits: data?.credits,
  hasError: Boolean(error)
});
    if (error) {
      console.error("Gagal membaca kredit:", error);

      return res.status(500).json({
        error: "Gagal membaca kredit."
      });
    }

    return res.json({
      ok: true,
      credits: data.credits
    });
  } catch (error) {
    console.error("Credit test error:", error);

    return res.status(500).json({
      error: "Terjadi kesalahan server."
    });
  }
});
app.post("/api/generate", generateLimiter, async (req, res) => {
let creditWasConsumed = false;
let creditUserId = null;
let creditRequestId = null;
let falRequestId = null;
let falModel = null;
let recoveryData = null;
try {
   const authHeader = req.headers.authorization || "";

const accessToken = authHeader.startsWith("Bearer ")
  ? authHeader.slice(7)
  : null;

if (!accessToken) {
  return res.status(401).json({
    error: "Silakan login terlebih dahulu."
  });
}

 const {
  data: { user },
  error: authError
} = await supabase.auth.getUser(accessToken);

if (authError || !user) {
  console.error(
    "SUPABASE AUTH ERROR:",
    authError?.message || "user tidak ditemukan"
  );

  return res.status(401).json({
    error: "Sesi login tidak valid."
  });
}

creditUserId = user.id;

const {
  prompt,
  ratio,
  duration,
  resolution = "720p",
  imageUrl,
  imageData,
  referenceImages = [],
  referenceVideos = [],
  sourceVideo = null,
  audio = true,
  model = DEFAULT_MODEL,
  project_id: projectId = null,
  scene_number: sceneNumber = null
} = req.body || {};
const isVeoModel = model === "fal-ai/veo3.1/lite/image-to-video";
const isH3Model = model === "minimax/h3-max-turbo/image-to-video";
const isMiniMaxReferenceModel = model === "minimax/h3-max/reference-to-video";
const isMiniMaxReframeModel = model === "minimax/h3-max/reframe-video";
const isGeminiImageModel = model === "google/gemini-omni-flash/image-to-video";
const isWanReferenceModel = model === "wan/v2.6/reference-to-video/flash";
const isGeminiReferenceModel = model === "google/gemini-omni-flash/v1.1/reference-to-video";
const isReferenceModel = isWanReferenceModel || isGeminiReferenceModel || isMiniMaxReferenceModel;
const isWanVideoToVideoModel = model === "fal-ai/wan/v2.2-a14b/video-to-video";
const isGeminiEditModel = model === "google/gemini-omni-flash/v1.1/edit";
const isVideoToVideoModel = isWanVideoToVideoModel || isGeminiEditModel || isMiniMaxReframeModel;
let projectIdForDb = null;
let sceneNumberForDb = null;

if (projectId !== null && projectId !== "") {
  if (
    typeof projectId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)
  ) {
    return res.status(400).json({
      error: "ID proyek tidak valid."
    });
  }

  const parsedSceneNumber = Number(sceneNumber);

  if (
    !Number.isInteger(parsedSceneNumber) ||
    parsedSceneNumber < 1
  ) {
    return res.status(400).json({
      error: "Nomor scene tidak valid."
    });
  }

  const {
    data: linkedProject,
    error: linkedProjectError
  } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (linkedProjectError) {
    console.error(
      "Gagal memverifikasi proyek:",
      linkedProjectError
    );

    return res.status(500).json({
      error: "Gagal memverifikasi proyek."
    });
  }

  if (!linkedProject) {
    return res.status(404).json({
      error: "Proyek tidak ditemukan pada akun ini."
    });
  }

  projectIdForDb = projectId;
  sceneNumberForDb = parsedSceneNumber;
}

const videoDuration = isVeoModel
  ? Number(String(duration).replace(/s$/, ""))
  : Number(duration);

const invalidDuration = !isMiniMaxReframeModel && (
  !Number.isInteger(videoDuration) ||
  (isVeoModel && ![4, 6, 8].includes(videoDuration)) ||
  (isH3Model && ![5, 10, 15].includes(videoDuration)) ||
  (isGeminiImageModel && ![5, 10].includes(videoDuration)) ||
  (isMiniMaxReferenceModel && ![5, 10, 15].includes(videoDuration)) ||
  (isReferenceModel && !isMiniMaxReferenceModel && ![5, 10].includes(videoDuration)) ||
  (isGeminiEditModel && ![5, 10].includes(videoDuration)) ||
  (isWanVideoToVideoModel && ![5, 10].includes(videoDuration)) ||
  (!isVeoModel && !isH3Model && !isGeminiImageModel && !isReferenceModel && !isVideoToVideoModel && (videoDuration < 2 || videoDuration > 30))
);

if (invalidDuration) {
  return res.status(400).json({
    error: isVeoModel
      ? "Durasi Veo harus 4, 6, atau 8 detik."
      : isH3Model
      ? "Durasi MiniMax H3 Max Turbo harus 5, 10, atau 15 detik."
      : isMiniMaxReferenceModel
      ? "Durasi MiniMax H3 Max Reference to Video harus 5, 10, atau 15 detik."
      : (isGeminiImageModel || (isReferenceModel && !isMiniMaxReferenceModel) || isVideoToVideoModel)
      ? "Durasi model ini harus 5 atau 10 detik."
      : "Durasi harus antara 2 dan 30 detik."
  });
}

if (
  (isVeoModel || isGeminiImageModel || (isReferenceModel && !isMiniMaxReferenceModel)) &&
  !["16:9", "9:16"].includes(ratio)
) {
  return res.status(400).json({
    error: "Model ini hanya mendukung rasio 16:9 atau 9:16."
  });
}

if (
  isVideoToVideoModel &&
  !["16:9", "9:16", "1:1"].includes(ratio)
) {
  return res.status(400).json({
    error: "Video to Video mendukung rasio 16:9, 9:16, atau 1:1."
  });
}
 
if (
  (isVeoModel || isWanReferenceModel) &&
  !["720p", "1080p"].includes(resolution)
) {
  return res.status(400).json({
    error: "Model ini hanya mendukung resolusi 720p atau 1080p."
  });
}

if (
  (isGeminiReferenceModel || isGeminiEditModel) &&
  !["360p", "720p", "1080p"].includes(resolution)
) {
  return res.status(400).json({
    error: "Gemini Omni Flash 1.1 mendukung resolusi 360p, 720p, atau 1080p."
  });
}

if (isGeminiImageModel && resolution !== "720p") {
  return res.status(400).json({
    error: "Gemini Omni Flash Image to Video saat ini memakai resolusi 720p."
  });
}

if ((isH3Model || isMiniMaxReferenceModel) && !["480p", "768p", "1080p"].includes(resolution)) {
  return res.status(400).json({
    error: "MiniMax H3 Max Turbo/Reference mendukung resolusi 480p, 768p, atau 1080p."
  });
}

if (isMiniMaxReframeModel && !["480p", "768p", "1080p"].includes(resolution)) {
  return res.status(400).json({
    error: "MiniMax H3 Max Reframe hanya mendukung resolusi 480p atau 768p."
  });
}

if (
  isWanVideoToVideoModel &&
  !["480p", "580p", "720p"].includes(resolution)
) {
  return res.status(400).json({
    error: "Wan Video to Video mendukung resolusi 480p, 580p, atau 720p."
  });
}

if (!ALLOWED_MODELS.has(model)) {
  return res.status(400).json({
    error: "Model tidak valid."
  });
}

falModel = model;

 const creditCosts = {
  "alibaba/wan-3.0/image-to-video": {
    "480p": { 5: 23, 10: 45, 15: 68 },
    "720p": { 5: 45, 10: 90, 15: 135 },
    "1080p": { 5: 90, 10: 179, 15: 269 }
  },

  "alibaba/wan-3.0-prime/image-to-video": {
    "480p": { 5: 31, 10: 61, 15: 92 },
    "720p": { 5: 63, 10: 126, 15: 188 },
    "1080p": { 5: 126, 10: 251, 15: 376 }
  },

  "wan/v2.6/image-to-video": {
    "720p": { 5: 45, 10: 90, 15: 135 },
    "1080p": { 5: 68, 10: 135, 15: 202 }
  },
"fal-ai/veo3.1/lite/image-to-video": {
  "720p": { 4: 20, 6: 30, 8: 40 },
  "1080p": { 4: 32, 6: 48, 8: 64 }
},
  "wan/v2.6/reference-to-video/flash": {
  "720p": { 5: 50, 10: 100 },
  "1080p": { 5: 75, 10: 150 }
},
  "fal-ai/wan/v2.2-a14b/video-to-video": {
  "480p": { 5: 20, 10: 40 },
  "580p": { 5: 25, 10: 50 },
  "720p": { 5: 35, 10: 70 }
},
  "minimax/h3-max-turbo/image-to-video": {
    "480p": { 5: 12, 10: 22, 15: 32 },
    "768p": { 5: 19, 10: 34, 15: 50 },
    "1080p": { 5: 37, 10: 68, 15: 100 }
  },
  "minimax/h3-max/reference-to-video": {
    "480p": { 5: 25, 10: 50, 15: 75 },
    "768p": { 5: 40, 10: 80, 15: 120 },
    "1080p": { 5: 80, 10: 160, 15: 240 }
  },
  "google/gemini-omni-flash/image-to-video": {
    "720p": { 5: 60, 10: 120 }
  },
  "google/gemini-omni-flash/v1.1/reference-to-video": {
    "360p": { 5: 13, 10: 26 },
    "720p": { 5: 42, 10: 84 },
    "1080p": { 5: 63, 10: 125 }
  },
  "google/gemini-omni-flash/v1.1/edit": {
    "360p": { 5: 13, 10: 26 },
    "720p": { 5: 42, 10: 84 },
    "1080p": { 5: 63, 10: 125 }
  }
};

let creditAmount = isMiniMaxReframeModel
  ? null
  : creditCosts[model]?.[resolution]?.[videoDuration];

if (!creditAmount && !isMiniMaxReframeModel) {
  return res.status(400).json({
    error: "Kombinasi model, resolusi, dan durasi tidak tersedia."
  });
}
 
let freeTrial = false;
let demoCreditConsumed = false;

if (
  DEMO_MODE &&
  !isReferenceModel &&
  !isVideoToVideoModel
) {
  freeTrial = await consumeFreeVideoTrial(user.id);

  if (!freeTrial) {
    return res.status(403).json({
      error: "Free Trial sudah habis."
    });
  }

  demoCreditConsumed = true;

  const demoVideoUrl =
    "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";

  const { error: demoHistoryError } = await supabase
    .from("video_history")
    .insert({
      user_id: user.id,
      prompt: prompt.trim(),
      video_url: demoVideoUrl,
      source_image_url: null,
      ratio,
      duration: videoDuration,
      resolution,
     project_id: projectIdForDb,
     scene_number: sceneNumberForDb
    });

  if (demoHistoryError) {
    console.error(
      "Gagal menyimpan riwayat demo:",
      demoHistoryError
    );
  }

  return res.json({
    ok: true,
    requestId: `demo-${Date.now()}`,
    video: {
      url: demoVideoUrl
    },
    duration: videoDuration,
    actualPrompt: prompt.trim(),
    freeTrial,
    creditConsumed: demoCreditConsumed
  });
}
 
   let startImageUrl = imageUrl;
let referenceImageUrls = [];
let referenceVideoUrls = [];
let sourceVideoUrl = null;
let actualVideoDuration = videoDuration;
 
if (isReferenceModel) {
  if (
    !Array.isArray(referenceImages) ||
    !Array.isArray(referenceVideos) ||
    referenceImages.length > 5 ||
    referenceVideos.length > 3 ||
    referenceImages.length + referenceVideos.length > 5
  ) {
    return res.status(400).json({
      error: "Maksimal 5 referensi total, termasuk maksimal 3 video."
    });
  }

  if (referenceImages.length + referenceVideos.length === 0) {
    return res.status(400).json({
      error: "Unggah minimal satu gambar atau video referensi."
    });
  }

  if (isMiniMaxReferenceModel) {
    let referenceTokens = 0;
    let totalReferenceVideoSeconds = 0;

    for (const dataUrl of referenceImages) {
      if (typeof dataUrl !== "string") {
        return res.status(400).json({ error: "Data gambar referensi MiniMax tidak valid." });
      }
      const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp|bmp));base64,(.+)$/i);
      if (!match) {
        return res.status(400).json({ error: "Format gambar referensi MiniMax tidak didukung." });
      }
      const imageBuffer = Buffer.from(match[2], "base64");
      if (imageBuffer.length === 0 || imageBuffer.length > 10 * 1024 * 1024) {
        return res.status(400).json({ error: "Ukuran setiap gambar referensi maksimal 10 MB." });
      }
      const dimensions = readImageDimensions(imageBuffer, match[1].toLowerCase());
      if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
        return res.status(400).json({
          error: "Ukuran gambar referensi MiniMax tidak dapat dibaca. Ekspor ulang sebagai JPG, PNG, atau WEBP lalu coba lagi."
        });
      }
      referenceTokens += Math.ceil((dimensions.width * dimensions.height) / 1024);
    }

    for (const dataUrl of referenceVideos) {
      if (typeof dataUrl !== "string") {
        return res.status(400).json({ error: "Data video referensi MiniMax tidak valid." });
      }
      const match = dataUrl.match(/^data:video\/(?:mp4|quicktime);base64,(.+)$/i);
      if (!match) {
        return res.status(400).json({ error: "Format video referensi MiniMax tidak didukung." });
      }
      const videoBuffer = Buffer.from(match[1], "base64");
      if (videoBuffer.length === 0 || videoBuffer.length > 100 * 1024 * 1024) {
        return res.status(400).json({ error: "Ukuran setiap video referensi maksimal 100 MB." });
      }
      const seconds = readMp4DurationSeconds(videoBuffer);
      if (!Number.isFinite(seconds) || seconds < 2 || seconds > 15) {
        return res.status(400).json({ error: "Setiap video referensi MiniMax harus berdurasi 2–15 detik dan dapat dibaca." });
      }
      totalReferenceVideoSeconds += seconds;
      const tokensPerSecond = resolution === "480p" ? 2886 : 7459;
      referenceTokens += Math.ceil(seconds * tokensPerSecond);
    }

    if (totalReferenceVideoSeconds > 15) {
      return res.status(400).json({ error: "Total durasi video referensi MiniMax maksimal 15 detik." });
    }

    const extraTokens = Math.max(0, referenceTokens - 4096);
    // fal.ai bills $0.02 per 1,000 reference tokens after a 4,096-token allowance.
    // Movira's existing MiniMax price uses a 2x output-cost factor; apply it to this surcharge too.
    const referenceInputCredits = Math.ceil((extraTokens / 1000) * 2);
    creditAmount += referenceInputCredits;
  }

  const uploadReference = async (dataUrl, allowedTypes) => {
    if (typeof dataUrl !== "string") {
      throw new Error("Data referensi tidak valid.");
    }

    const match = dataUrl.match(
      /^data:(image\/[a-zA-Z0-9.+-]+|video\/[a-zA-Z0-9.+-]+);base64,(.+)$/
    );

    if (!match || !allowedTypes.includes(match[1])) {
      throw new Error("Format file referensi tidak didukung.");
    }

    const buffer = Buffer.from(match[2], "base64");
    const isVideo = match[1].startsWith("video/");
    const maxBytes = isVideo ? 100 * 1024 * 1024 : 10 * 1024 * 1024;

    if (buffer.length === 0 || buffer.length > maxBytes) {
      throw new Error(
        isVideo
          ? "Ukuran video referensi maksimal 100 MB."
          : "Ukuran gambar referensi maksimal 10 MB."
      );
    }

    const subtype = match[1].split("/")[1].replace("jpeg", "jpg");
    const file = new File(
      [buffer],
      `movira-reference.${subtype}`,
      { type: match[1] }
    );

    return await fal.storage.upload(file);
  };

  try {
    referenceImageUrls = await Promise.all(
      referenceImages.map(data =>
        uploadReference(data, [
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/bmp"
        ])
      )
    );

    referenceVideoUrls = await Promise.all(
      referenceVideos.map(data =>
        uploadReference(data, ["video/mp4", "video/quicktime"])
      )
    );
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
} else if (isVideoToVideoModel) {
  if (typeof sourceVideo !== "string") {
    return res.status(400).json({
      error: "Unggah video sumber terlebih dahulu."
    });
  }

  const videoMatch = sourceVideo.match(
    /^data:(video\/mp4);base64,(.+)$/
  );

  if (!videoMatch) {
    return res.status(400).json({
      error: "Format video harus MP4."
    });
  }

  const videoBuffer = Buffer.from(videoMatch[2], "base64");

  if (
    videoBuffer.length === 0 ||
    videoBuffer.length > 100 * 1024 * 1024
  ) {
    return res.status(400).json({
      error: "Ukuran video maksimal 100 MB."
    });
  }

  const sourceDurationSeconds = (isGeminiEditModel || isMiniMaxReframeModel)
    ? readMp4DurationSeconds(videoBuffer)
    : null;
  if (isGeminiEditModel) {
    if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) {
      return res.status(400).json({
        error: "Durasi video MP4 tidak dapat dibaca. Coba ekspor ulang video sebagai MP4 standar."
      });
    }
    if (sourceDurationSeconds > videoDuration + 0.01) {
      return res.status(400).json({
        error: `Video sumber berdurasi ${sourceDurationSeconds.toFixed(1)} detik, lebih lama dari paket ${videoDuration} detik. Pilih durasi yang mencukupi. Maksimum 10 detik.`
      });
    }
  }
  if (isMiniMaxReframeModel) {
    if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) {
      return res.status(400).json({
        error: "Durasi video MP4 tidak dapat dibaca. Coba ekspor ulang video sebagai MP4 standar."
      });
    }
    if (sourceDurationSeconds > 15) {
      return res.status(400).json({
        error: "MiniMax H3 Max Reframe dibatasi pada video sumber maksimal 15 detik untuk menghindari biaya pemrosesan tambahan yang tidak terduga."
      });
    }
    actualVideoDuration = Math.ceil(sourceDurationSeconds);
    const creditsPerSecond = { "480p": 5, "768p": 8, "1080p": 16 }[resolution];
    creditAmount = actualVideoDuration * creditsPerSecond;
    if (!Number.isInteger(creditAmount) || creditAmount < 1) {
      return res.status(400).json({
        error: "Kombinasi resolusi dan durasi sumber tidak tersedia."
      });
    }
  }

  const videoFile = new File(
    [videoBuffer],
    "movira-source.mp4",
    { type: "video/mp4" }
  );

  try {
    sourceVideoUrl = await fal.storage.upload(videoFile);
  } catch (error) {
    return res.status(400).json({
      error: "Gagal mengunggah video sumber."
    });
  }

} else {
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
    const buffer = Buffer.from(match[2], "base64");

    if (buffer.length === 0 || buffer.length > 10 * 1024 * 1024) {
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
     }  

creditRequestId = randomUUID();

const { error: requestInsertError } = await supabase
  .from("video_generation_requests")
  .insert({
  user_id: user.id,
  credit_request_id: creditRequestId,
  model,
  status: "submitted",
  credit_amount: creditAmount,
  project_id: projectIdForDb,
  scene_number: sceneNumberForDb
});

if (requestInsertError) {
  console.error(
    "Gagal mencatat permintaan video:",
    requestInsertError
  );

  return res.status(500).json({
    error: "Gagal mencatat permintaan video."
  });
}

const { data: creditConsumed, error: creditError } =
  await supabase.rpc("consume_credit_for_request", {
    p_user_id: user.id,
    p_amount: creditAmount,
    p_request_id: creditRequestId
  });

if (creditError) {
  console.error("Gagal memproses kredit:", creditError);

  await supabase
    .from("video_generation_requests")
    .update({
      status: "unknown",
      error_message: "Status pemotongan kredit belum dapat dipastikan."
    })
    .eq("credit_request_id", creditRequestId);

  return res.status(500).json({
    error: "Status pemotongan kredit belum dapat dipastikan."
  });
}

if (!creditConsumed) {
  await supabase
    .from("video_generation_requests")
    .update({
      status: "failed_confirmed",
      error_message: "Kredit tidak cukup."
    })
    .eq("credit_request_id", creditRequestId);

  return res.status(402).json({
    error: "Kredit tidak cukup."
  });
}

creditWasConsumed = true;
 
const falInput = isMiniMaxReframeModel
  ? {
      prompt: prompt.trim(),
      video_url: sourceVideoUrl,
      aspect_ratio: ratio,
      resolution,
      enable_safety_checker: true
    }
  : isGeminiEditModel
  ? {
      prompt: prompt.trim(),
      video_url: sourceVideoUrl,
      resolution
    }
  : isWanVideoToVideoModel
  ? {
      video_url: sourceVideoUrl,
      prompt: prompt.trim(),
      resolution,
      aspect_ratio: ratio,
      num_inference_steps: 27,
      enable_safety_checker: true
    }
  : isMiniMaxReferenceModel
  ? {
      prompt: prompt.trim(),
      reference_image_urls: referenceImageUrls,
      reference_video_urls: referenceVideoUrls,
      resolution: resolution.toUpperCase(),
      aspect_ratio: ratio,
      duration: videoDuration,
      prompt_expansion_mode: "balanced",
      enable_safety_checker: true
    }
  : isGeminiReferenceModel
  ? {
      prompt: prompt.trim(),
      image_urls: referenceImageUrls,
      reference_video_urls: referenceVideoUrls,
      resolution,
      aspect_ratio: ratio,
      duration: videoDuration
    }
  : isWanReferenceModel
  ? {
      prompt: prompt.trim(),
      image_urls: referenceImageUrls,
      video_urls: referenceVideoUrls,
      resolution,
      aspect_ratio: ratio,
      duration: String(videoDuration),
      generate_audio: Boolean(audio),
      enable_prompt_expansion: true,
      enable_safety_checker: true
    }
  : isH3Model
  ? {
      prompt: prompt.trim(),
      image_url: startImageUrl,
      duration: videoDuration,
      resolution: resolution.toUpperCase(),
      prompt_expansion_mode: "balanced",
      enable_safety_checker: true
    }
  : isGeminiImageModel
  ? {
      prompt: prompt.trim(),
      image_url: startImageUrl,
      aspect_ratio: ratio,
      duration: videoDuration
    }
  : isVeoModel
  ? {
      prompt: prompt.trim(),
      image_url: startImageUrl,
      resolution,
      aspect_ratio: ratio,
      duration: `${videoDuration}s`,
      generate_audio: Boolean(audio)
    }
  : {
      prompt: prompt.trim(),
      start_image_url: startImageUrl,
      resolution,
      aspect_ratio: ratio,
      duration: videoDuration,
      audio: Boolean(audio),
      enable_prompt_expansion: true,
      enable_safety_checker: true
    };
 recoveryData = {
  userId: user.id,
  creditRequestId,
  prompt: prompt.trim(),
  sourceImageUrl: isReferenceModel
    ? (referenceImageUrls[0] || referenceVideoUrls[0] || null)
    : startImageUrl,
  ratio,
  duration: actualVideoDuration,
  resolution,
  projectId: projectIdForDb,
  sceneNumber: sceneNumberForDb
};
 
const result = await fal.subscribe(model, {
  input: falInput,
  logs: true,
 onEnqueue: (requestId) => {
  falRequestId = requestId;
  console.log("Fal request ID:", falRequestId);

  void supabase
    .from("video_generation_requests")
    .update({
      fal_request_id: requestId,
      status: "processing"
    })
    .eq("credit_request_id", creditRequestId)
.in("status", ["submitted", "processing"])
    .then(({ error }) => {
      if (error) {
        console.error(
          "Gagal memperbarui status permintaan video:",
          error
        );
      }
    });
 } 
 });
    const videoUrl =
  result.data?.video?.url ||
  result.data?.video?.video_url ||
  (typeof result.data?.video === "string"
    ? result.data.video
    : null);
 
if (!videoUrl) {
  throw new Error("Layanan video tidak mengembalikan URL video.");
}
 
const { error: historyError } = await supabase
  .from("video_history")
    .insert({
      user_id: user.id,
      prompt: prompt.trim(),
      video_url: videoUrl,
      source_image_url: isReferenceModel
        ? (referenceImageUrls[0] || referenceVideoUrls[0] || null)
        : startImageUrl,
      ratio,
      duration: actualVideoDuration,
      resolution,
      project_id: projectIdForDb,
      scene_number: sceneNumberForDb
    });

if (historyError) {
  console.error("Gagal menyimpan riwayat video:", historyError);
}
const { error: requestUpdateError } = await supabase
  .from("video_generation_requests")
  .update({
    status: "succeeded",
    error_message: null
  })
  .eq("credit_request_id", creditRequestId);

if (requestUpdateError) {
  console.error(
    "Gagal memperbarui status permintaan video:",
    requestUpdateError
  );
}
return res.json({
  ok: true,
  requestId: result.requestId,
  video: result.data?.video || null,
  seed: result.data?.seed ?? null,
  duration: result.data?.duration ?? actualVideoDuration,
  actualPrompt: result.data?.actual_prompt ?? null
});

  } catch (error) {
    console.error("Movira generation error:", error);
 
if (creditRequestId) {
  const { error: statusUpdateError } = await supabase
    .from("video_generation_requests")
    .update({
      status: "unknown",
      error_message: String(
        error?.message || "Status hasil video belum dapat dipastikan."
      )
    })
    .eq("credit_request_id", creditRequestId);

  if (statusUpdateError) {
    console.error(
      "Gagal mencatat status error permintaan video:",
      statusUpdateError
    );
  }
}
    if (creditWasConsumed && creditUserId && creditRequestId) {
      if (falRequestId) {
        try {
          const falStatus = await fal.queue.status(falModel, {
            requestId: falRequestId,
            logs: true
          });
          
if (falStatus.status === "COMPLETED") {
  try {
    const falResult = await fal.queue.result(falModel, {
      requestId: falRequestId
    });

    const recoveredVideoUrl =
      falResult.data?.video?.url ||
      falResult.data?.video?.video_url ||
      (typeof falResult.data?.video === "string"
        ? falResult.data.video
        : null);

    if (!recoveredVideoUrl || !recoveryData) {
      console.error(
        "Hasil fal.ai belum memiliki URL video yang bisa dipulihkan.",
        { requestId: falRequestId }
      );
    } else {
      const { data: existingHistory, error: historyCheckError } =
        await supabase
          .from("video_history")
          .select("id")
          .eq("user_id", recoveryData.userId)
          .eq("video_url", recoveredVideoUrl)
          .limit(1);

      if (historyCheckError) {
        throw historyCheckError;
      }

      if (!existingHistory || existingHistory.length === 0) {
        const { error: recoveryHistoryError } = await supabase
          .from("video_history")
          .insert({
  user_id: recoveryData.userId,
  prompt: recoveryData.prompt,
  video_url: recoveredVideoUrl,
  source_image_url: recoveryData.sourceImageUrl,
  ratio: recoveryData.ratio,
  duration: recoveryData.duration,
  resolution: recoveryData.resolution,
  project_id: recoveryData.projectId,
  scene_number: recoveryData.sceneNumber
});
        if (recoveryHistoryError) {
          throw recoveryHistoryError;
        }
      }

      const { error: recoveryStatusError } = await supabase
        .from("video_generation_requests")
        .update({
          status: "succeeded",
          error_message: null
        })
        .eq("credit_request_id", creditRequestId);

      if (recoveryStatusError) {
        throw recoveryStatusError;
      }

      console.log("Hasil fal.ai berhasil dipulihkan.", {
        requestId: falRequestId
      });
    }
  } catch (resultError) {
    console.error(
      "Pemulihan hasil fal.ai gagal; kredit tidak dikembalikan.",
      resultError
    );
         }
 
          } else {
            console.error("Fal.ai masih memproses permintaan:", {
              requestId: falRequestId,
              status: falStatus.status
            });
          }
        } catch (statusError) {
          console.error(
            "Gagal memeriksa status fal.ai:",
            statusError
          );
        }
      }
    }
    return res.status(500).json({
      error: "Gagal membuat video.",
      message: "Terjadi kesalahan saat menghubungi layanan video."
    });
  }
});

app.post("/api/credit-orders", (_req, res) => {
  // Real-order creation is disabled while no verified payment provider is connected.
  // Keep GET /api/credit-orders available for read-only history of existing orders.
  return res.status(503).json({
    error: "Pembuatan pesanan pembayaran nyata belum tersedia. Gunakan mode simulasi untuk pengujian."
  });
});


// ===== Credit order history (real order records; no payment provider is connected yet) =====
app.get("/api/credit-orders", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";
    const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!accessToken) return res.status(401).json({ error: "Belum login." });
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !user) return res.status(401).json({ error: "Sesi login tidak valid." });
    const { data, error } = await supabase
      .from("credit_orders")
      .select("id,credits,amount,currency,status,payment_method,provider,provider_order_id,created_at,paid_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) throw error;
    return res.json({ ok: true, orders: data || [] });
  } catch (error) {
    console.error("Credit order history error:", error);
    return res.status(500).json({ error: "Gagal membaca riwayat pesanan kredit." });
  }
});

// ===== Isolated payment simulation. It NEVER calls apply_credit_order_paid and NEVER changes balance. =====
app.get("/api/credit-order-simulations", async (req, res) => {
  if (!PAYMENT_SIMULATION_ENABLED) return res.status(503).json({ error: "Mode simulasi pembayaran belum diaktifkan pada backend." });
  try {
    const authHeader = req.headers.authorization || "";
    const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!accessToken) return res.status(401).json({ error: "Belum login." });
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !user) return res.status(401).json({ error: "Sesi login tidak valid." });
    const { data, error } = await supabase
      .from("credit_order_simulations")
      .select("id,credits,amount,currency,status,created_at,updated_at,paid_at,failure_reason")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) throw error;
    return res.json({ ok: true, orders: data || [], simulation: true });
  } catch (error) {
    console.error("Credit simulation history error:", error);
    return res.status(500).json({ error: "Gagal membaca riwayat simulasi. Pastikan migrasi Supabase sudah diterapkan." });
  }
});

app.post("/api/credit-order-simulations", async (req, res) => {
  if (!PAYMENT_SIMULATION_ENABLED) return res.status(503).json({ error: "Mode simulasi pembayaran belum diaktifkan pada backend." });
  try {
    const authHeader = req.headers.authorization || "";
    const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!accessToken) return res.status(401).json({ error: "Belum login." });
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !user) return res.status(401).json({ error: "Sesi login tidak valid." });

    const credits = Number(req.body?.credits);
    const currency = String(req.body?.currency || "IDR").toUpperCase();
    const allowedCredits = [50, 120, 300, 500, 1000];
    if (!allowedCredits.includes(credits)) return res.status(400).json({ error: "Paket kredit tidak valid." });
    if (!Object.prototype.hasOwnProperty.call(CREDIT_ORDER_PRICES, currency)) return res.status(400).json({ error: "Mata uang belum didukung." });
    const amount = CREDIT_ORDER_PRICES[currency][credits];

    const { data: order, error } = await supabase
      .from("credit_order_simulations")
      .insert({ user_id: user.id, credits, amount, currency, status: "pending", payment_mode: "simulation" })
      .select("id,credits,amount,currency,status,created_at,updated_at,paid_at,failure_reason")
      .single();
    if (error) throw error;
    return res.status(201).json({ ok: true, simulation: true, creditsAdded: 0, order });
  } catch (error) {
    console.error("Create credit simulation error:", error);
    return res.status(500).json({ error: "Gagal membuat pesanan simulasi. Pastikan migrasi Supabase sudah diterapkan." });
  }
});

app.post("/api/credit-order-simulations/:id/resolve", async (req, res) => {
  if (!PAYMENT_SIMULATION_ENABLED) return res.status(503).json({ error: "Mode simulasi pembayaran belum diaktifkan pada backend." });
  try {
    const authHeader = req.headers.authorization || "";
    const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!accessToken) return res.status(401).json({ error: "Belum login." });
    const { data: { user }, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !user) return res.status(401).json({ error: "Sesi login tidak valid." });

    const orderId = String(req.params.id || "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
      return res.status(400).json({ error: "ID pesanan simulasi tidak valid." });
    }
    const outcome = String(req.body?.outcome || "").toLowerCase();
    if (! ["paid", "failed"].includes(outcome)) return res.status(400).json({ error: "Hasil simulasi harus paid atau failed." });

    const { data: existing, error: readError } = await supabase
      .from("credit_order_simulations")
      .select("id,user_id,credits,amount,currency,status,created_at,updated_at,paid_at,failure_reason")
      .eq("id", orderId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (readError) throw readError;
    if (!existing) return res.status(404).json({ error: "Pesanan simulasi tidak ditemukan." });
    if (existing.status !== "pending") {
      return res.json({ ok: true, simulation: true, alreadyResolved: true, creditsAdded: 0, order: existing });
    }

    const patch = {
      status: outcome,
      updated_at: new Date().toISOString(),
      paid_at: outcome === "paid" ? new Date().toISOString() : null,
      failure_reason: outcome === "failed" ? "Simulated payment failure (no real transaction)" : null
    };
    const { data: updated, error: updateError } = await supabase
      .from("credit_order_simulations")
      .update(patch)
      .eq("id", orderId)
      .eq("user_id", user.id)
      .eq("status", "pending")
      .select("id,credits,amount,currency,status,created_at,updated_at,paid_at,failure_reason")
      .maybeSingle();
    if (updateError) throw updateError;
    if (!updated) {
      const { data: current, error: currentError } = await supabase
        .from("credit_order_simulations")
        .select("id,credits,amount,currency,status,created_at,updated_at,paid_at,failure_reason")
        .eq("id", orderId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (currentError) throw currentError;
      if (!current) return res.status(404).json({ error: "Pesanan simulasi tidak ditemukan." });
      return res.json({ ok: true, simulation: true, alreadyResolved: true, creditsAdded: 0, order: current });
    }
    // Intentional: do not call applyPaidCreditOrder(orderId) here. Simulation must not affect real credits.
    return res.json({ ok: true, simulation: true, creditsAdded: 0, order: updated });
  } catch (error) {
    console.error("Resolve credit simulation error:", error);
    return res.status(500).json({ error: "Gagal memperbarui status pesanan simulasi." });
  }
});

app.post("/api/payment-webhook", (_req, res) => {
  // Fail closed unconditionally. A client-supplied paid status or shared token
  // is not proof of payment. Add a provider-specific verifier before real use.
  return res.status(503).json({
    error: "Webhook pembayaran nyata belum tersedia. Simulasi tidak memerlukan webhook ini."
  });
});

app.use((_req, res) => {
  res.status(404).json({
    error: "Endpoint tidak ditemukan."
  });
});



app.listen(PORT, "0.0.0.0", () => {
  console.log(`Movira backend berjalan di port ${PORT}`);
});
