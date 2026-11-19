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
const DRAMA_GENERATION_ENABLED = process.env.DRAMA_GENERATION_ENABLED === "true";

function calculateDramaReferenceCredits(model, resolution, duration) {
  const seconds = Number(duration);
  let costUsd = null;
  if (model === "bytedance/seedance-2.5/flash/reference-to-video") {
    const pixels = resolution === "480p" ? 864 * 496 : resolution === "720p" ? 1280 * 720 : null;
    if (!pixels) return null;
    const outputTokens = Math.ceil((pixels * seconds * 24) / 1024);
    costUsd = (outputTokens / 1000) * 0.014;
  } else if (model === "alibaba/wan-3.0/reference-to-video") {
    costUsd = ({ "480p": 0.05, "720p": 0.10, "1080p": 0.20 })[resolution] * seconds;
  } else if (model === "alibaba/wan-3.0-prime/reference-to-video") {
    costUsd = ({ "480p": 0.068, "720p": 0.14, "1080p": 0.28 })[resolution] * seconds;
  } else if (model === "google/gemini-omni-flash/v1.1/reference-to-video") {
    costUsd = ({ "360p": 0.03, "720p": 0.10, "1080p": 0.15 })[resolution] * seconds;
  }
  if (!Number.isFinite(costUsd) || costUsd <= 0) return null;
  return Math.ceil((costUsd * 130) - 1e-9);
}

const DRAMA_REFERENCE_MODELS = new Set([
  "bytedance/seedance-2.5/flash/reference-to-video",
  "alibaba/wan-3.0/reference-to-video",
  "alibaba/wan-3.0-prime/reference-to-video",
  "google/gemini-omni-flash/v1.1/reference-to-video"
]);

const ALLOWED_MODELS = new Set([
  "alibaba/wan-3.0-prime/image-to-video",
  "alibaba/wan-3.0/image-to-video",
  "wan/v2.6/image-to-video",
  "wan/v2.6/reference-to-video/flash",
  "fal-ai/wan/v2.2-a14b/video-to-video",
  "minimax/h3-max-turbo/image-to-video",
  "minimax/h3-max/reference-to-video",
  "minimax/h3-max/reframe-video",
  "google/gemini-omni-flash/v1.1/image-to-video",
  "google/gemini-omni-flash/v1.1/reference-to-video",
  "google/gemini-omni-flash/v1.1/edit",
  "bytedance/seedance-2.5/flash/reference-to-video",
  "alibaba/wan-3.0/reference-to-video",
  "alibaba/wan-3.0-prime/reference-to-video",
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


// ===== Drama AI batch generation =====
// This endpoint uses a single credit debit for the selected batch. The SQL migration
// shipped with this update creates the durable batch/scene status tables.
const dramaBatchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 3,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Terlalu banyak permintaan Drama AI. Coba lagi sebentar." }
});

const DRAMA_BATCH_MODELS = Object.freeze({
  "bytedance/seedance-2.5/flash/reference-to-video": {
    resolutions: ["480p", "720p"], durations: [10, 15, 30], maxImages: 10, pricing: "seedance"
  },
  "alibaba/wan-3.0/reference-to-video": {
    resolutions: ["480p", "720p", "1080p"], durations: [10, 15, 30], maxImages: 10,
    pricing: { "480p": 0.05, "720p": 0.10, "1080p": 0.20 }
  },
  "alibaba/wan-3.0-prime/reference-to-video": {
    resolutions: ["480p", "720p", "1080p"], durations: [10, 15, 30], maxImages: 10,
    pricing: { "480p": 0.068, "720p": 0.14, "1080p": 0.28 }
  },
  "google/gemini-omni-flash/v1.1/reference-to-video": {
    resolutions: ["360p", "720p", "1080p"], durations: [10], maxImages: 10,
    pricing: { "360p": 0.03, "720p": 0.10, "1080p": 0.15 }
  }
});

function dramaCreditsFromUsd(totalUsd) {
  // Avoid a one-credit overcharge when decimal rates land just above an integer
  // solely because of IEEE-754 floating-point representation.
  return Math.ceil((Number(totalUsd) * 130) - 1e-9);
}

function calculateDramaBatchSceneCostUsd(model, resolution, duration) {
  const config = DRAMA_BATCH_MODELS[model];
  const seconds = Number(duration);
  if (!config || !Number.isInteger(seconds) || !config.durations.includes(seconds) || !config.resolutions.includes(resolution)) return null;
  if (config.pricing === "seedance") {
    const pixels = resolution === "480p" ? 864 * 496 : resolution === "720p" ? 1280 * 720 : null;
    if (!pixels) return null;
    const outputTokens = Math.ceil((pixels * seconds * 24) / 1024);
    const usd = (outputTokens / 1000) * 0.014;
    return Number.isFinite(usd) && usd > 0 ? usd : null;
  }
  const usd = config.pricing[resolution] * seconds;
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

async function authenticateDramaRequest(req) {
  const authHeader = req.headers.authorization || "";
  const accessToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!accessToken) return { error: "Silakan login terlebih dahulu.", status: 401 };
  const { data: { user }, error } = await supabase.auth.getUser(accessToken);
  if (error || !user) return { error: "Sesi login tidak valid.", status: 401 };
  return { user };
}

function parseDramaImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") throw new Error("Data gambar referensi tidak valid.");
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) throw new Error("Format gambar Drama AI harus JPG, PNG, atau WEBP.");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 10 * 1024 * 1024) throw new Error("Ukuran setiap gambar referensi maksimal 10 MB.");
  return { mimeType: match[1].toLowerCase(), buffer };
}

async function uploadDramaImage(dataUrl, cache) {
  if (cache.has(dataUrl)) return cache.get(dataUrl);
  const { mimeType, buffer } = parseDramaImageDataUrl(dataUrl);
  const extension = mimeType.split("/")[1].replace("jpeg", "jpg");
  const file = new File([buffer], `movira-drama-reference.${extension}`, { type: mimeType });
  const url = await fal.storage.upload(file);
  cache.set(dataUrl, url);
  return url;
}

function makeDramaFalInput(model, scene, imageUrls, userId) {
  const basePrompt = String(scene.prompt || "").trim();
  if (model === "bytedance/seedance-2.5/flash/reference-to-video") {
    const prompt = `${basePrompt}\n\nGunakan gambar referensi sesuai urutan: @Image1, @Image2, dan seterusnya. Jaga konsistensi karakter, pakaian, dan lokasi.`;
    return {
      prompt, task: "reference", image_urls: imageUrls,
      resolution: scene.resolution, aspect_ratio: scene.ratio,
      duration: String(scene.duration), generate_audio: true, end_user_id: userId
    };
  }
  if (model === "alibaba/wan-3.0/reference-to-video" || model === "alibaba/wan-3.0-prime/reference-to-video") {
    const prompt = `${basePrompt}\n\nGunakan gambar referensi sesuai urutan: Image 1, Image 2, dan seterusnya. Jaga konsistensi karakter, pakaian, dan lokasi.`;
    return {
      prompt, reference_image_urls: imageUrls, reference_video_urls: [], reference_audio_urls: [],
      resolution: scene.resolution, aspect_ratio: scene.ratio, duration: scene.duration,
      audio: true, enable_prompt_expansion: true, enable_thinking: false, enable_safety_checker: true
    };
  }
  if (model === "google/gemini-omni-flash/v1.1/reference-to-video") {
    const prompt = `${basePrompt}\n\nGunakan gambar referensi sesuai urutan: <IMAGE_REF_0>, <IMAGE_REF_1>, dan seterusnya. Jaga konsistensi karakter, pakaian, dan lokasi.`;
    // This endpoint schema does not expose a generate_audio boolean; audio is model-generated from prompt/context.
    return { prompt, image_urls: imageUrls, aspect_ratio: scene.ratio, resolution: scene.resolution, duration: scene.duration };
  }
  throw new Error("Model Drama AI tidak dikenal.");
}

function batchIsTerminal(status) {
  return ["succeeded", "failed_confirmed", "not_submitted", "unknown"].includes(status);
}

async function refreshDramaBatch(batchId, userId) {
  const { data: batch, error: batchError } = await supabase
    .from("drama_generation_batches").select("*").eq("id", batchId).eq("user_id", userId).maybeSingle();
  if (batchError) throw batchError;
  if (!batch) return null;
  const { data: scenes, error: scenesError } = await supabase
    .from("drama_generation_batch_scenes").select("*").eq("batch_id", batchId).order("scene_number", { ascending: true });
  if (scenesError) throw scenesError;

  for (const scene of scenes || []) {
    if (!scene.fal_request_id || !["submitted", "processing"].includes(scene.status)) continue;
    try {
      const status = await fal.queue.status(scene.model, { requestId: scene.fal_request_id, logs: false });
      const currentStatus = String(status?.status || "").toUpperCase();
      if (currentStatus === "IN_QUEUE" || currentStatus === "IN_PROGRESS") {
        if (scene.status !== "processing") {
          await supabase.from("drama_generation_batch_scenes").update({ status: "processing", updated_at: new Date().toISOString() }).eq("id", scene.id).in("status", ["submitted", "processing"]);
        }
      } else if (currentStatus === "FAILED") {
        await supabase.from("drama_generation_batch_scenes").update({
          status: "failed_confirmed", error_message: String(status?.error || status?.error_type || "fal.ai mengonfirmasi Scene gagal."), updated_at: new Date().toISOString()
        }).eq("id", scene.id).in("status", ["submitted", "processing"]);
      } else if (currentStatus === "COMPLETED") {
        const result = await fal.queue.result(scene.model, { requestId: scene.fal_request_id });
        const videoUrl = result.data?.video?.url || result.data?.video?.video_url || (typeof result.data?.video === "string" ? result.data.video : null);
        if (!videoUrl) {
          await supabase.from("drama_generation_batch_scenes").update({ status: "unknown", error_message: "fal.ai menyatakan selesai tetapi URL video tidak ditemukan; kredit perlu ditinjau." , updated_at: new Date().toISOString() }).eq("id", scene.id).in("status", ["submitted", "processing"]);
          continue;
        }
        const { data: existing, error: existingError } = await supabase
          .from("video_history").select("id").eq("user_id", userId).eq("video_url", videoUrl).limit(1);
        if (existingError) throw existingError;
        if (!existing || existing.length === 0) {
          const { error: historyError } = await supabase.from("video_history").insert({
            user_id: userId, prompt: scene.prompt, video_url: videoUrl,
            source_image_url: Array.isArray(scene.reference_urls) ? (scene.reference_urls[0] || null) : null,
            ratio: scene.ratio, duration: scene.duration, resolution: scene.resolution,
            project_id: batch.project_id, scene_number: scene.scene_number
          });
          if (historyError) console.error("Gagal menyimpan riwayat Drama AI:", historyError);
        }
        await supabase.from("drama_generation_batch_scenes").update({
          status: "succeeded", video_url: videoUrl, actual_prompt: result.data?.actual_prompt || null, updated_at: new Date().toISOString()
        }).eq("id", scene.id).in("status", ["submitted", "processing"]);
      }
    } catch (error) {
      // A polling/network/result error is ambiguous. Keep the charge reserved; never auto-refund it.
      console.error("Drama AI status check failed; charge remains reserved:", { batchId, sceneNumber: scene.scene_number, message: error?.message });
    }
  }

  const { data: latestScenes, error: latestError } = await supabase
    .from("drama_generation_batch_scenes").select("*").eq("batch_id", batchId).order("scene_number", { ascending: true });
  if (latestError) throw latestError;
  const finalScenes = latestScenes || [];
  const allTerminal = finalScenes.length > 0 && finalScenes.every(item => batchIsTerminal(item.status));
  // Refund is safe to retry: refund_credit_for_request uses a unique request/type
  // transaction key and returns true for an already-recorded matching refund.
  // Recover stale "processing" claims after a server restart or transient RPC error.
  const refundProcessingStale = batch.refund_status === "processing" &&
    (!batch.updated_at || Date.now() - new Date(batch.updated_at).getTime() > 60_000);
  if (allTerminal && (batch.refund_status === "pending" || refundProcessingStale)) {
    const successAndUnknownUsd = finalScenes
      .filter(item => item.status === "succeeded" || item.status === "unknown")
      .reduce((sum, item) => sum + Number(item.cost_usd || 0), 0);
    const calculatedRefundCredits = Math.max(0, Number(batch.credit_amount || 0) - dramaCreditsFromUsd(successAndUnknownUsd));
    const refundCredits = refundProcessingStale
      ? Math.max(0, Number(batch.refund_amount || 0))
      : calculatedRefundCredits;
    let claimQuery = supabase.from("drama_generation_batches")
      .update({ refund_status: "processing", refund_amount: refundCredits, updated_at: new Date().toISOString() })
      .eq("id", batchId);
    claimQuery = refundProcessingStale
      ? claimQuery.eq("refund_status", "processing").lt("updated_at", new Date(Date.now() - 60_000).toISOString())
      : claimQuery.eq("refund_status", "pending");
    const { data: claim, error: claimError } = await claimQuery.select("id").maybeSingle();
    if (claimError) throw claimError;
    if (claim) {
      let refundOk = true;
      let retryableRefundError = null;
      if (refundCredits > 0) {
        const { data: refundResult, error: refundError } = await supabase.rpc("refund_credit_for_request", {
          p_user_id: userId, p_amount: refundCredits, p_request_id: batchId
        });
        refundOk = !refundError && refundResult === true;
        if (refundError) {
          retryableRefundError = refundError;
          console.error("Drama AI refund RPC error; retry will be safe:", refundError);
        }
      }
      if (retryableRefundError) {
        // Keep processing and refresh updated_at; a later poll retries the same
        // idempotent RPC instead of permanently stranding the batch in error.
        await supabase.from("drama_generation_batches").update({
          refund_status: "processing", error_message: "Refund sementara gagal; sistem akan mencoba kembali.",
          updated_at: new Date().toISOString()
        }).eq("id", batchId).eq("refund_status", "processing");
      } else {
        await supabase.from("drama_generation_batches").update({
          refund_status: refundOk ? "complete" : "error",
          status: !refundOk ? "unknown" : finalScenes.every(item => item.status === "succeeded") ? "succeeded" : finalScenes.some(item => item.status === "succeeded") ? "partially_succeeded" : finalScenes.some(item => item.status === "unknown") ? "unknown" : "failed_confirmed",
          error_message: !refundOk ? "Refund ditolak oleh fungsi SQL; periksa debit dan jumlah refund." : null,
          updated_at: new Date().toISOString()
        }).eq("id", batchId).eq("refund_status", "processing");
        await supabase.from("video_generation_requests").update({
          status: !refundOk ? "unknown" : finalScenes.some(item => item.status === "succeeded") ? "succeeded" : "failed_confirmed",
          error_message: !refundOk ? "Pengembalian kredit batch perlu pemeriksaan manual." : null,
          updated_at: new Date().toISOString()
        }).eq("credit_request_id", batchId);
      }
    }
  }

  const { data: finalBatch, error: finalBatchError } = await supabase
    .from("drama_generation_batches").select("*").eq("id", batchId).eq("user_id", userId).single();
  if (finalBatchError) throw finalBatchError;
  const done = finalScenes.length > 0 && finalScenes.every(item => batchIsTerminal(item.status)) && ["complete", "error"].includes(finalBatch.refund_status);
  return { batch: finalBatch, scenes: finalScenes, done };
}

app.post("/api/drama-generate-batch", dramaBatchLimiter, async (req, res) => {
  let userId = null;
  let batchId = null;
  let batchCreditsConsumed = false;
  try {
    const auth = await authenticateDramaRequest(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    const user = auth.user;
    userId = user.id;
    if (DEMO_MODE) return res.status(503).json({ error: "Mode demo masih aktif. Permintaan Drama AI tidak dikirim dan kredit tidak dipotong." });
    if (!DRAMA_GENERATION_ENABLED) return res.status(503).json({ error: "Drama AI belum diaktifkan pada konfigurasi backend." });

    const projectId = req.body?.project_id;
    const mode = req.body?.mode;
    const activeIndex = Number(req.body?.active_scene_index);
    if (typeof projectId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      return res.status(400).json({ error: "ID proyek tidak valid. Simpan proyek terlebih dahulu." });
    }
    if (!["all", "active"].includes(mode)) return res.status(400).json({ error: "Pilihan generasi tidak valid." });
    const clientRequestId = req.body?.client_request_id;
    if (typeof clientRequestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientRequestId)) {
      return res.status(400).json({ error: "ID permintaan tidak valid. Muat ulang editor lalu coba lagi." });
    }
    const { data: priorBatch, error: priorBatchError } = await supabase.from("drama_generation_batches")
      .select("id,credit_amount").eq("user_id", user.id).eq("client_request_id", clientRequestId).maybeSingle();
    if (priorBatchError) throw priorBatchError;
    if (priorBatch) {
      const priorState = await refreshDramaBatch(priorBatch.id, user.id);
      return res.status(200).json({ ok: true, reused: true, batch_id: priorBatch.id, credit_amount: priorBatch.credit_amount, batch: priorState?.batch, scenes: priorState?.scenes, done: priorState?.done || false });
    }
    const { data: project, error: projectError } = await supabase.from("projects")
      .select("id,user_id,settings").eq("id", projectId).eq("user_id", user.id).maybeSingle();
    if (projectError) throw projectError;
    if (!project?.settings?.dramaAI || !Array.isArray(project.settings.dramaAI.scenes)) {
      return res.status(404).json({ error: "Proyek Drama AI tidak ditemukan atau belum tersimpan." });
    }
    const drama = project.settings.dramaAI;
    const allScenes = drama.scenes;
    const selectedScenes = mode === "all" ? allScenes.map((scene, index) => ({ scene, index })) : Number.isInteger(activeIndex) && activeIndex >= 0 && activeIndex < allScenes.length ? [{ scene: allScenes[activeIndex], index: activeIndex }] : [];
    if (!selectedScenes.length || selectedScenes.length > 30) return res.status(400).json({ error: "Jumlah Scene tidak valid. Maksimal 30 Scene per batch." });

    const referenceImages = drama.referenceImages || {};
    const refById = new Map();
    for (const kind of ["character", "location"]) {
      for (const item of Array.isArray(referenceImages[kind]) ? referenceImages[kind] : []) {
        if (item?.id && item?.dataUrl) refById.set(String(item.id), item.dataUrl);
      }
    }
    const prepared = [];
    for (const entry of selectedScenes) {
      const scene = entry.scene || {};
      const model = String(scene.model || "");
      const config = DRAMA_BATCH_MODELS[model];
      const prompt = String(scene.prompt || "").trim();
      const duration = Number(scene.duration);
      const resolution = String(scene.resolution || "");
      const ratio = String(scene.ratio || "");
      if (!config || !prompt || prompt.length > 50000) return res.status(400).json({ error: `Prompt atau model Scene ${entry.index + 1} tidak valid.` });
      if (!config.durations.includes(duration) || !config.resolutions.includes(resolution)) return res.status(400).json({ error: `Durasi atau resolusi Scene ${entry.index + 1} tidak didukung model.` });
      if (!["16:9", "9:16"].includes(ratio)) return res.status(400).json({ error: `Rasio Scene ${entry.index + 1} harus 16:9 atau 9:16.` });
      const ids = [...new Set([...(scene.characterReferenceIds || []), ...(scene.locationReferenceIds || [])].map(String))];
      if (ids.length < 1 || ids.length > config.maxImages) return res.status(400).json({ error: `Scene ${entry.index + 1} harus memiliki 1–${config.maxImages} gambar referensi.` });
      const dataUrls = ids.map(id => refById.get(id)).filter(Boolean);
      if (dataUrls.length !== ids.length) return res.status(400).json({ error: `Ada gambar referensi yang hilang pada Scene ${entry.index + 1}. Buka dan simpan ulang proyek.` });
      const costUsd = calculateDramaBatchSceneCostUsd(model, resolution, duration);
      if (!Number.isFinite(costUsd) || costUsd <= 0) return res.status(400).json({ error: `Estimasi biaya Scene ${entry.index + 1} tidak tersedia.` });
      prepared.push({ sceneNumber: entry.index + 1, model, prompt, duration, resolution, ratio, costUsd, dataUrls });
    }

    const totalCostUsd = prepared.reduce((sum, item) => sum + item.costUsd, 0);
    const totalCredits = dramaCreditsFromUsd(totalCostUsd);
    if (!Number.isInteger(totalCredits) || totalCredits < 1) return res.status(400).json({ error: "Total kredit tidak valid." });

    // Upload all references before reserving credits. A failed upload cannot consume credits.
    const uploadCache = new Map();
    for (const item of prepared) {
      item.referenceUrls = [];
      for (const dataUrl of item.dataUrls) item.referenceUrls.push(await uploadDramaImage(dataUrl, uploadCache));
      item.input = makeDramaFalInput(item.model, item, item.referenceUrls, user.id);
    }

    batchId = randomUUID();
    const { error: batchInsertError } = await supabase.from("drama_generation_batches").insert({
      id: batchId, user_id: user.id, project_id: projectId, mode, client_request_id: clientRequestId,
      status: "submitted", total_cost_usd: totalCostUsd, credit_amount: totalCredits,
      refund_amount: 0, refund_status: "pending"
    });
    if (batchInsertError?.code === "23505") {
      const { data: racedBatch, error: racedBatchError } = await supabase.from("drama_generation_batches")
        .select("id,credit_amount").eq("user_id", user.id).eq("client_request_id", clientRequestId).maybeSingle();
      if (racedBatchError) throw racedBatchError;
      if (racedBatch) {
        const racedState = await refreshDramaBatch(racedBatch.id, user.id);
        return res.status(200).json({ ok: true, reused: true, batch_id: racedBatch.id, credit_amount: racedBatch.credit_amount, batch: racedState?.batch, scenes: racedState?.scenes, done: racedState?.done || false });
      }
    }
    if (batchInsertError) throw batchInsertError;
    const sceneRows = prepared.map(item => ({
      id: randomUUID(), batch_id: batchId, scene_number: item.sceneNumber, model: item.model,
      prompt: item.prompt, resolution: item.resolution, duration: item.duration, ratio: item.ratio,
      cost_usd: item.costUsd, status: "not_submitted", reference_urls: item.referenceUrls
    }));
    const { error: sceneInsertError } = await supabase.from("drama_generation_batch_scenes").insert(sceneRows);
    if (sceneInsertError) {
      await supabase.from("drama_generation_batches").update({ status: "failed_confirmed", refund_status: "complete", error_message: "Gagal menyiapkan daftar Scene sebelum pemotongan kredit." }).eq("id", batchId);
      throw sceneInsertError;
    }

    const { error: requestInsertError } = await supabase.from("video_generation_requests").insert({
      user_id: user.id, credit_request_id: batchId, model: prepared[0].model,
      status: "submitted", credit_amount: totalCredits, project_id: null, scene_number: null
    });
    if (requestInsertError) {
      await supabase.from("drama_generation_batches").update({ status: "failed_confirmed", refund_status: "complete", error_message: "Gagal mencatat permintaan sebelum debit kredit." }).eq("id", batchId);
      return res.status(500).json({ error: "Gagal mencatat permintaan batch. Kredit belum dipotong.", batch_id: batchId });
    }
    const { data: consumed, error: consumeError } = await supabase.rpc("consume_credit_for_request", {
      p_user_id: user.id, p_amount: totalCredits, p_request_id: batchId
    });
    if (consumeError) {
      batchCreditsConsumed = true; // The RPC result is ambiguous; do not auto-refund.
      await supabase.from("drama_generation_batches").update({ status: "unknown", refund_status: "error", error_message: "Status debit kredit perlu diperiksa." }).eq("id", batchId);
      await supabase.from("video_generation_requests").update({ status: "unknown", error_message: "Status debit kredit perlu diperiksa." }).eq("credit_request_id", batchId);
      return res.status(500).json({ error: "Status pemotongan kredit belum dapat dipastikan. Jangan ulangi Generate; periksa riwayat kredit terlebih dahulu.", batch_id: batchId });
    }
    if (!consumed) {
      await supabase.from("drama_generation_batches").update({ status: "failed_confirmed", refund_status: "complete", error_message: "Kredit tidak cukup." }).eq("id", batchId);
      await supabase.from("video_generation_requests").update({ status: "failed_confirmed", error_message: "Kredit tidak cukup." }).eq("credit_request_id", batchId);
      return res.status(402).json({ error: "Kredit tidak cukup.", batch_id: batchId });
    }
    batchCreditsConsumed = true;

    let submitStopped = false;
    for (const item of prepared) {
      const row = sceneRows.find(scene => scene.scene_number === item.sceneNumber);
      if (submitStopped) {
        const { error: notSubmittedError } = await supabase.from("drama_generation_batch_scenes").update({ status: "not_submitted", error_message: "Tidak dikirim karena pengiriman Scene sebelumnya mengalami status tidak pasti." }).eq("id", row.id);
        if (notSubmittedError) {
          await supabase.from("drama_generation_batches").update({ status: "unknown", refund_status: "error", error_message: "Status Scene yang belum dikirim gagal disimpan." }).eq("id", batchId);
          return res.status(500).json({ error: "Status batch tidak dapat dipastikan. Jangan ulangi Generate; periksa kredit.", batch_id: batchId });
        }
        continue;
      }
      try {
        const queued = await fal.queue.submit(item.model, { input: item.input });
        const requestId = queued?.request_id || queued?.requestId;
        if (!requestId) throw new Error("fal.ai tidak mengembalikan request ID.");
        const { error: queueSaveError } = await supabase.from("drama_generation_batch_scenes").update({ status: "submitted", fal_request_id: requestId, updated_at: new Date().toISOString() }).eq("id", row.id);
        if (queueSaveError) {
          await supabase.from("drama_generation_batches").update({ status: "unknown", refund_status: "error", error_message: "fal.ai menerima antrean tetapi ID antrean gagal disimpan." }).eq("id", batchId);
          return res.status(500).json({ error: "fal.ai menerima permintaan, tetapi pencatatan antrean gagal. Jangan Generate ulang; status kredit perlu diperiksa.", batch_id: batchId });
        }
      } catch (submitError) {
        // No request ID means acceptance cannot be proven; retain that Scene's charge.
        const { error: unknownSaveError } = await supabase.from("drama_generation_batch_scenes").update({ status: "unknown", error_message: String(submitError?.message || "Status pengiriman tidak dapat dipastikan."), updated_at: new Date().toISOString() }).eq("id", row.id);
        if (unknownSaveError) {
          await supabase.from("drama_generation_batches").update({ status: "unknown", refund_status: "error", error_message: "Status pengiriman dan pencatatan Scene tidak dapat dipastikan." }).eq("id", batchId);
          return res.status(500).json({ error: "Status pengiriman tidak dapat dipastikan. Jangan ulangi Generate; periksa kredit.", batch_id: batchId });
        }
        submitStopped = true;
      }
    }
    await supabase.from("drama_generation_batches").update({ status: "processing", updated_at: new Date().toISOString() }).eq("id", batchId);
    await supabase.from("video_generation_requests").update({ status: "processing" }).eq("credit_request_id", batchId);
    const initial = await refreshDramaBatch(batchId, user.id);
    return res.status(202).json({ ok: true, batch_id: batchId, credit_amount: totalCredits, scene_count: prepared.length, batch: initial?.batch, scenes: initial?.scenes, done: initial?.done || false });
  } catch (error) {
    console.error("Drama AI batch creation error:", error);
    let persistedBatchId = null;
    if (batchId) {
      const { data: persistedBatch, error: lookupError } = await supabase.from("drama_generation_batches")
        .select("id").eq("id", batchId).eq("user_id", userId).maybeSingle();
      if (!lookupError && persistedBatch) {
        persistedBatchId = persistedBatch.id;
        await supabase.from("drama_generation_batches").update({
          status: batchCreditsConsumed ? "unknown" : "failed_confirmed",
          refund_status: batchCreditsConsumed ? "error" : "complete",
          error_message: String(error?.message || "Kesalahan batch tidak diketahui")
        }).eq("id", batchId);
      }
    }
    return res.status(500).json({ error: "Gagal menyiapkan batch Drama AI. Periksa status proyek dan kredit sebelum mencoba lagi.", ...(persistedBatchId ? { batch_id: persistedBatchId } : {}) });
  }
});

app.get("/api/drama-generate-batch/:batchId", async (req, res) => {
  try {
    const auth = await authenticateDramaRequest(req);
    if (auth.error) return res.status(auth.status).json({ error: auth.error });
    const batchId = req.params.batchId;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(batchId)) return res.status(400).json({ error: "ID batch tidak valid." });
    const result = await refreshDramaBatch(batchId, auth.user.id);
    if (!result) return res.status(404).json({ error: "Batch Drama AI tidak ditemukan." });
    return res.json({ ok: true, batch_id: batchId, batch: result.batch, scenes: result.scenes, done: result.done });
  } catch (error) {
    console.error("Drama AI batch status error:", error);
    return res.status(500).json({ error: "Gagal memeriksa status Drama AI." });
  }
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
let creditAmountToRefund = null;
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

// Emergency switch: DEMO_MODE blocks every generation request before project lookup,
// file uploads, credit deduction, or fal.ai calls. Demo sample videos are disabled.
if (DEMO_MODE) {
  return res.status(503).json({
    error: "Generasi video sedang dinonaktifkan sementara (DEMO_MODE). Tidak ada file yang diunggah atau kredit yang dipotong."
  });
}

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
const isGeminiImageModel = model === "google/gemini-omni-flash/v1.1/image-to-video";
const isWanReferenceModel = model === "wan/v2.6/reference-to-video/flash";
const isGeminiReferenceModel = model === "google/gemini-omni-flash/v1.1/reference-to-video";
const isWanVideoToVideoModel = model === "fal-ai/wan/v2.2-a14b/video-to-video";
const isGeminiEditModel = model === "google/gemini-omni-flash/v1.1/edit";
const isSeedanceReferenceModel = model === "bytedance/seedance-2.5/flash/reference-to-video";
const isWan30ImageModel = model === "alibaba/wan-3.0/image-to-video";
const isWan30PrimeImageModel = model === "alibaba/wan-3.0-prime/image-to-video";
const isWan30ReferenceModel = model === "alibaba/wan-3.0/reference-to-video";
const isWan30PrimeReferenceModel = model === "alibaba/wan-3.0-prime/reference-to-video";
const isDramaRequest = req.body?.drama_ai === true;
const DRAMA_ONLY_MODELS = new Set([
  "bytedance/seedance-2.5/flash/reference-to-video",
  "alibaba/wan-3.0/reference-to-video",
  "alibaba/wan-3.0-prime/reference-to-video"
]);
if (DRAMA_ONLY_MODELS.has(model) && !isDramaRequest) {
  return res.status(400).json({
    error: "Model ini hanya tersedia melalui fitur Drama AI."
  });
}
if (isDramaRequest && !DRAMA_REFERENCE_MODELS.has(model)) {
  return res.status(400).json({ error: "Model Drama AI tidak valid." });
}
if (model === "minimax/h3-max/reframe-video") {
  return res.status(503).json({
    error: "Model ini dinonaktifkan sementara sampai biaya API aktual dapat diverifikasi. Kredit tidak dipotong."
  });
}
const isDramaReferenceModel = DRAMA_REFERENCE_MODELS.has(model);
const isReferenceModel = isWanReferenceModel || isGeminiReferenceModel || isMiniMaxReferenceModel || isDramaReferenceModel;
const isVideoToVideoModel = isWanVideoToVideoModel || isGeminiEditModel || isMiniMaxReframeModel;
if (isDramaRequest && !DRAMA_GENERATION_ENABLED) {
  return res.status(503).json({
    error: "Generasi Drama AI belum diaktifkan. Pilihan model dan proyek bisa disimpan, tetapi permintaan video belum dikirim dan kredit tidak dipotong."
  });
}
let projectIdForDb = null;
let sceneNumberForDb = null;

if (typeof prompt !== "string" || !prompt.trim() || prompt.trim().length > 50000) {
  return res.status(400).json({ error: "Prompt harus berupa teks dan tidak boleh kosong atau lebih dari 50.000 karakter." });
}

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
  (isSeedanceReferenceModel && (videoDuration < 4 || videoDuration > 30)) ||
  ((isWan30ImageModel || isWan30PrimeImageModel || isWan30ReferenceModel || isWan30PrimeReferenceModel) && ![10, 15, 20, 25, 30].includes(videoDuration)) ||
  (isGeminiReferenceModel && videoDuration !== 10) ||
  (isReferenceModel && !isMiniMaxReferenceModel && !isDramaRequest && ![5, 10].includes(videoDuration)) ||
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
      : isSeedanceReferenceModel
      ? "Durasi Seedance 2.5 Flash harus 4–30 detik."
      : (isWan30ReferenceModel || isWan30PrimeReferenceModel)
      ? "Durasi Wan 3.0 Reference harus 2–30 detik."
      : isGeminiReferenceModel
      ? "Durasi Gemini Omni Flash 1.1 di Drama AI saat ini ditetapkan 10 detik."
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
  (isGeminiImageModel || isGeminiReferenceModel || isGeminiEditModel) &&
  !["360p", "720p", "1080p"].includes(resolution)
) {
  return res.status(400).json({
    error: "Gemini Omni Flash 1.1 mendukung resolusi 360p, 720p, atau 1080p."
  });
}

if (isSeedanceReferenceModel && !["480p", "720p"].includes(resolution)) {
  return res.status(400).json({ error: "Seedance 2.5 Flash Reference mendukung resolusi 480p atau 720p." });
}
if ((isWan30ReferenceModel || isWan30PrimeReferenceModel) && !["480p", "720p", "1080p"].includes(resolution)) {
  return res.status(400).json({ error: "Wan 3.0 Reference mendukung resolusi 480p, 720p, atau 1080p." });
}

if ((isH3Model || isMiniMaxReferenceModel) && !["480p", "768p", "1080p"].includes(resolution)) {
  return res.status(400).json({
    error: "MiniMax H3 Max Turbo/Reference mendukung resolusi 480p, 768p, atau 1080p."
  });
}

if (isMiniMaxReframeModel && !["480p", "768p"].includes(resolution)) {
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
    "480p": {10:65,15:98,20:130,25:163,30:195},
    "720p": {10:130,15:195,20:260,25:325,30:390},
    "1080p": {10:260,15:390,20:520,25:650,30:780}
  },
  "alibaba/wan-3.0-prime/image-to-video": {
    "480p": {10:89,15:133,20:177,25:221,30:266},
    "720p": {10:182,15:273,20:364,25:455,30:546},
    "1080p": {10:364,15:546,20:728,25:910,30:1092}
  },
  "wan/v2.6/image-to-video": {
    "720p": {5:65,10:130,15:195},
    "1080p": {5:98,10:195,15:293}
  },
  "wan/v2.6/reference-to-video/flash": {
    "720p": {5:65,10:130},
    "1080p": {5:98,10:195}
  },
  "fal-ai/wan/v2.2-a14b/video-to-video": {
    "480p": {5:26,10:52},
    "580p": {5:39,10:78},
    "720p": {5:52,10:104}
  },
  "minimax/h3-max-turbo/image-to-video": {
    "480p": {5:17,10:33,15:49},
    "768p": {5:26,10:52,15:78},
    "1080p": {5:52,10:104,15:156}
  },
  "minimax/h3-max/reference-to-video": {
    "480p": {5:33,10:65,15:98},
    "768p": {5:52,10:104,15:156},
    "1080p": {5:104,10:208,15:312}
  },
  "google/gemini-omni-flash/v1.1/image-to-video": {
    "360p": {5:20,10:39},
    "720p": {5:65,10:130},
    "1080p": {5:98,10:195}
  },
  "google/gemini-omni-flash/v1.1/reference-to-video": {
    "360p": {10:39}, "720p": {10:130}, "1080p": {10:195}
  },
  "google/gemini-omni-flash/v1.1/edit": {
    "360p": {5:20,10:39},
    "720p": {5:65,10:130},
    "1080p": {5:98,10:195}
  }
};

let creditAmount = isDramaRequest
  ? calculateDramaReferenceCredits(model, resolution, videoDuration)
  : creditCosts[model]?.[resolution]?.[videoDuration];

if (!creditAmount) {
  return res.status(400).json({
    error: "Kombinasi model, resolusi, dan durasi tidak tersedia."
  });
}
 
   let startImageUrl = imageUrl;
let referenceImageUrls = [];
let referenceVideoUrls = [];
let sourceVideoUrl = null;
let actualVideoDuration = videoDuration;
 
if (isReferenceModel) {
  const maxReferenceImages = isDramaRequest ? 10 : 5;
  const maxReferenceVideos = isDramaRequest ? 0 : 3;
  const maxReferenceTotal = isDramaRequest ? 10 : 5;
  if (
    !Array.isArray(referenceImages) ||
    !Array.isArray(referenceVideos) ||
    referenceImages.length > maxReferenceImages ||
    referenceVideos.length > maxReferenceVideos ||
    referenceImages.length + referenceVideos.length > maxReferenceTotal
  ) {
    return res.status(400).json({
      error: isDramaRequest
        ? "Drama AI menerima maksimal 10 gambar referensi per Scene. Video/audio referensi belum didukung oleh editor Drama AI."
        : "Maksimal 5 referensi total, termasuk maksimal 3 video."
    });
  }

  if (referenceImages.length + referenceVideos.length === 0) {
    return res.status(400).json({
      error: isDramaRequest
        ? "Pilih minimal satu gambar karakter atau lokasi untuk Scene ini."
        : "Unggah minimal satu gambar atau video referensi."
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
    // Combine output and reference API costs first, then apply the 30% margin and round once.
    const outputRates = { "480p": 0.05, "768p": 0.08, "1080p": 0.16 };
    const outputRate = outputRates[resolution];
    const referenceCostUsd = (extraTokens / 1000) * 0.02;
    const totalCostUsd = outputRate * videoDuration + referenceCostUsd;
    creditAmount = Number.isFinite(outputRate) ? Math.ceil(totalCostUsd * 130) : null;
    if (!creditAmount) {
      return res.status(400).json({ error: "Kombinasi resolusi dan biaya referensi tidak tersedia." });
    }
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
    // Gemini Edit has no duration input: it preserves the source clip length.
    // fal bills per second of output, so estimate/debit against measured source duration.
    actualVideoDuration = sourceDurationSeconds;
    const outputRate = ({ "360p": 0.03, "720p": 0.10, "1080p": 0.15 })[resolution];
    creditAmount = Number.isFinite(outputRate)
      ? Math.ceil(actualVideoDuration * outputRate * 130)
      : null;
    if (!Number.isInteger(creditAmount) || creditAmount < 1) {
      return res.status(400).json({ error: "Durasi atau biaya Gemini Edit tidak valid." });
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
    const creditsPerSecond = { "480p": 5, "768p": 8 }[resolution];
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

creditAmountToRefund = creditAmount;
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
 
const orderedReferencePrompt = isSeedanceReferenceModel
  ? `${prompt.trim()}\n\nGunakan gambar referensi sesuai urutan unggahan: @Image1, @Image2, dan seterusnya. Pertahankan identitas karakter, pakaian, serta ciri lokasi sesuai gambar masing-masing.`
  : (isWan30ReferenceModel || isWan30PrimeReferenceModel)
  ? `${prompt.trim()}\n\nGunakan gambar referensi sesuai urutan unggahan: Image 1, Image 2, dan seterusnya. Pertahankan identitas karakter, pakaian, serta ciri lokasi sesuai gambar masing-masing.`
  : isGeminiReferenceModel
  ? `${prompt.trim()}\n\nGunakan gambar referensi sesuai urutan: <IMAGE_REF_0>, <IMAGE_REF_1>, dan seterusnya. Pertahankan identitas karakter, pakaian, serta ciri lokasi sesuai referensi.`
  : prompt.trim();

const falInput = isSeedanceReferenceModel
  ? {
      prompt: orderedReferencePrompt,
      task: "reference",
      image_urls: referenceImageUrls,
      resolution,
      aspect_ratio: ratio,
      duration: videoDuration,
      generate_audio: Boolean(audio)
    }
  : (isWan30ReferenceModel || isWan30PrimeReferenceModel)
  ? {
      prompt: orderedReferencePrompt,
      reference_image_urls: referenceImageUrls,
      reference_video_urls: [],
      reference_audio_urls: [],
      resolution,
      aspect_ratio: ratio,
      duration: videoDuration,
      audio: Boolean(audio),
      enable_prompt_expansion: true,
      enable_thinking: false,
      enable_safety_checker: true
    }
  : isMiniMaxReframeModel
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
      num_frames: Math.round(videoDuration * 16),
      frames_per_second: 16,
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
      prompt: orderedReferencePrompt,
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
      resolution,
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
  .eq("credit_request_id", creditRequestId)
  .in("status", ["submitted", "processing", "unknown"]);

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
    .eq("credit_request_id", creditRequestId)
    .in("status", ["submitted", "processing"]);

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
          
if (falStatus.status === "COMPLETED" && (falStatus.error || falStatus.error_type)) {
  const failureMessage = String(falStatus.error || falStatus.error_type || "fal.ai mengonfirmasi permintaan gagal.");
  const { error: failedStatusError } = await supabase
    .from("video_generation_requests")
    .update({ status: "failed_confirmed", error_message: failureMessage })
    .eq("credit_request_id", creditRequestId)
    .in("status", ["submitted", "processing", "unknown"]);
  if (failedStatusError) {
    console.error("Gagal mencatat kegagalan yang dikonfirmasi fal.ai:", failedStatusError);
  }

  let refundCreated = false;
  if (Number.isInteger(creditAmountToRefund) && creditAmountToRefund > 0) {
    const { data: refundResult, error: refundError } = await supabase.rpc("refund_credit_for_request", {
      p_user_id: creditUserId,
      p_amount: creditAmountToRefund,
      p_request_id: creditRequestId
    });
    if (refundError) {
      console.error("fal.ai mengonfirmasi kegagalan, tetapi pengembalian kredit perlu diperiksa:", refundError);
    } else {
      refundCreated = refundResult === true;
      if (!refundCreated) {
        console.warn("RPC refund tidak membuat transaksi baru; mungkin sudah diproses atau debit tidak ditemukan.", { creditRequestId });
      }
    }
  }

  return res.status(502).json({
    error: "fal.ai mengonfirmasi permintaan video gagal. Status pengembalian kredit telah diperiksa.",
    creditRefunded: refundCreated
  });
}

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
        .eq("credit_request_id", creditRequestId)
        .in("status", ["submitted", "processing", "unknown"]);

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
