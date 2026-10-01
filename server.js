 import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { fal } from "@fal-ai/client";
import { createClient } from "@supabase/supabase-js";
import "dotenv/config";
const app = express();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);
async function applyPaidCreditOrder(orderId) {
  const { data, error } = await supabase.rpc(
    "apply_credit_order_paid",
    {
      p_order_id: orderId
    }
  );

  if (error) {
    throw error;
  }

  return data;
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
   
   console.error(
  "SUPABASE AUTH ERROR:",
  authError?.message || "user tidak ditemukan"
);
   
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
if (DEMO_MODE) {
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
      resolution
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
    actualPrompt: prompt.trim()
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
const { data: creditConsumed, error: creditError } =
  await supabase.rpc("consume_credit", {
    p_user_id: user.id
  });

if (creditError) {
  console.error("Gagal memproses kredit:", creditError);

  return res.status(500).json({
    error: "Gagal memproses kredit."
  });
}

if (!creditConsumed) { 
  return res.status(402).json({
    error: "Kredit tidak cukup."
  });
}
   creditWasConsumed = true;
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

    const videoUrl =
  result.data?.video?.url ||
  result.data?.video?.video_url ||
  (typeof result.data?.video === "string"
    ? result.data.video
    : null);

const { error: historyError } = await supabase
  .from("video_history")
  .insert({
    user_id: user.id,
    prompt: prompt.trim(),
    video_url: videoUrl,
    source_image_url: startImageUrl,
    ratio,
    duration: videoDuration,
    resolution
  });

if (historyError) {
  console.error("Gagal menyimpan riwayat video:", historyError);
}

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
if (creditWasConsumed && creditUserId) {
  const { error: refundError } = await supabase.rpc("refund_credit", {
    p_user_id: creditUserId
  });

  if (refundError) {
    console.error("Gagal mengembalikan kredit:", refundError);
  }
}
    return res.status(500).json({
      error: "Gagal membuat video.",
      message: "Terjadi kesalahan saat menghubungi layanan video."
    });
  }
});

app.post("/api/credit-orders", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";

    const accessToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!accessToken) {
      return res.status(401).json({
        error: "Belum login."
      });
    }

    const {
      data: { user },
      error: userError
    } = await supabase.auth.getUser(accessToken);

    if (userError || !user) {
      return res.status(401).json({
        error: "Sesi login tidak valid."
      });
    }

    const credits = Number(req.body?.credits);
    const currency = String(
      req.body?.currency || "IDR"
    ).toUpperCase();

    const prices = {
      IDR: {
        50: 5000,
        120: 10000,
        300: 20000
      },
      MYR: {
        50: 5,
        120: 10,
        300: 20
      },
      USD: {
        50: 2,
        120: 5,
        300: 10
      }
    };

    if (!prices[currency]) {
      return res.status(400).json({
        error: "Mata uang belum didukung."
      });
    }

    if (![50, 120, 300].includes(credits)) {
      return res.status(400).json({
        error: "Paket kredit tidak valid."
      });
    }

    const amount = prices[currency][credits];

    const { data: order, error: orderError } = await supabase
      .from("credit_orders")
      .insert({
        user_id: user.id,
        credits,
        amount,
        currency,
        status: "pending"
      })
      .select("id,credits,amount,currency,status,created_at")
      .single();

    if (orderError) {
      console.error("Gagal membuat order kredit:", orderError);

      return res.status(500).json({
        error: "Gagal membuat pesanan kredit."
      });
    }

    return res.json({
      ok: true,
      order
    });

  } catch (error) {
    console.error("Credit order error:", error);

    return res.status(500).json({
      error: "Terjadi kesalahan saat membuat pesanan."
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
