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

const DEFAULT_MODEL = "alibaba/wan-3.0-prime/image-to-video";


const ALLOWED_MODELS = new Set([
  "alibaba/wan-3.0-prime/image-to-video",
  "alibaba/wan-3.0/image-to-video",
  "wan/v2.6/image-to-video",
  "fal-ai/veo3.1/lite/image-to-video",
]);

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
  audio = true,
  model = DEFAULT_MODEL
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

    
const isVeoModel = model === "fal-ai/veo3.1/lite/image-to-video";

const videoDuration = isVeoModel
  ? Number(String(duration).replace(/s$/, ""))
  : Number(duration);

if (
  !Number.isInteger(videoDuration) ||
  (isVeoModel && ![4, 6, 8].includes(videoDuration)) ||
  (!isVeoModel && (videoDuration < 2 || videoDuration > 30))
) {
  return res.status(400).json({
    error: isVeoModel
      ? "Durasi Veo harus 4, 6, atau 8 detik."
      : "Durasi harus antara 2 dan 30 detik."
  });
}
 
 if (
  isVeoModel &&
  !["16:9", "9:16"].includes(ratio)
) {
  return res.status(400).json({
    error: "Veo hanya mendukung rasio 16:9 atau 9:16."
  });
 }

if (
  isVeoModel &&
  !["720p", "1080p"].includes(resolution)
) {
  return res.status(400).json({
    error: "Veo hanya mendukung resolusi 720p atau 1080p."
  });
}
 
 
if (!ALLOWED_MODELS.has(model)) {
  return res.status(400).json({
    error: "Model tidak valid."
  });
}

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
};

const creditAmount =
  creditCosts[model]?.[resolution]?.[videoDuration];

if (!creditAmount) {
  return res.status(400).json({
    error: "Kombinasi model, resolusi, dan durasi tidak tersedia."
  });
}
 
let freeTrial = false;
let demoCreditConsumed = false;

if (DEMO_MODE) {
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
    actualPrompt: prompt.trim(),
    freeTrial,
    creditConsumed: demoCreditConsumed
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
    p_user_id: user.id,
    p_amount: creditAmount
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
    
const isVeoModel = model === "fal-ai/veo3.1/lite/image-to-video";

const falInput = isVeoModel
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

const result = await fal.subscribe(model, {
  input: falInput,
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
  p_user_id: creditUserId,
  p_amount: creditAmount
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
    50: 15000,
    120: 35000,
    300: 85000,
    500: 135000,
    1000: 250000
  },
  MYR: {
    50: 5,
    120: 10,
    300: 20,
    500: 35,
    1000: 65
  },
  USD: {
    50: 1,
    120: 2,
    300: 5,
    500: 8,
    1000: 14
  }
};

    if (!prices[currency]) {
      return res.status(400).json({
        error: "Mata uang belum didukung."
      });
    }

    if (![50, 120, 300, 500, 1000].includes(credits)) {
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

app.post("/api/payment-webhook", async (req, res) => {
  try {
    const webhookSecret =
  req.headers["x-callback-token"];
    if (
      !webhookSecret ||
      webhookSecret !== process.env.PAYMENT_WEBHOOK_SECRET
    ) {
      return res.status(401).json({
        error: "Webhook tidak sah."
      });
    }

    const orderId = String(
      req.body?.order_id || ""
    ).trim();

    const status = String(
      req.body?.status || ""
    ).toLowerCase();

    if (!orderId) {
      return res.status(400).json({
        error: "order_id wajib diisi."
      });
    }

    if (status !== "paid") {
      return res.json({
        ok: true,
        ignored: true,
        status
      });
    }

    const order = await applyPaidCreditOrder(orderId);

    return res.json({
      ok: true,
      order
    });

  } catch (error) {
    console.error("Payment webhook error:", error);

    return res.status(500).json({
      error: "Gagal memproses pembayaran."
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
