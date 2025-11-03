// printer-server.js
import express from "express";
import puppeteer from "puppeteer";
import fs from "fs";
import sharp from "sharp";

// --------------------------
// Config & App
// --------------------------
const app = express();
app.use(express.json({ limit: "256kb" }));

/** Map restaurants to printers */
const PRINTER_CONFIG = [
  { restaurantId: "local", serial: "2581021060600835" },
  { restaurantId: "worldfamous-skyler1", serial: "2581018070600248" },
  { restaurantId: "worldfamous-skyler2", serial: "2581019070600037" },
  { restaurantId: "worldfamous-printer1", serial: "2581018070600248" },
  { restaurantId: "worldfamous-printer2", serial: "2581019070600037" },
  { restaurantId: "worldfamous-downey-printer1", serial: "2581018080600059" },
  { restaurantId: "worldfamous-downey-printer2", serial: "2581018070600306" },
  { restaurantId: "worldfamous-bell-printer1", serial: "2581019090600209" },
  { restaurantId: "worldfamous-bell-printer2", serial: "2581018080600564" },
  { restaurantId: "worldfamous-market-printer", serial: "2581018070600273" },
  { restaurantId: "arth-printer-1", serial: "2581019070600083" },
  { restaurantId: "arth-printer-2", serial: "2581019090600186" },
  { restaurantId: "arth-printer-3", serial: "2581019070600090" },
];

const serialToRestaurant = new Map(
  PRINTER_CONFIG.map((p) => [p.serial, p.restaurantId])
);

// --------------------------
// In-memory Job Store
// --------------------------
function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
const jobsByRestaurant = new Map(); // restaurantId -> Job[]
const jobIndex = new Map(); // token -> { restaurantId, job }

function queueFor(restaurantId) {
  if (!jobsByRestaurant.has(restaurantId))
    jobsByRestaurant.set(restaurantId, []);
  return jobsByRestaurant.get(restaurantId);
}
function nextQueuedJob(serial) {
  const id = serialToRestaurant.get(String(serial).trim());
  if (!id) return null;
  const q = queueFor(id);
  // Only offer jobs with content ready
  return q.find((j) => j.status === "queued" && j.content);
}
function removeJob(token) {
  const ref = jobIndex.get(token);
  if (!ref) return;
  const { restaurantId, job } = ref;
  const q = queueFor(restaurantId);
  const idx = q.findIndex((j) => j.id === job.id);
  if (idx >= 0) q.splice(idx, 1);
  jobIndex.delete(token);
}
function requeueJob(token) {
  const ref = jobIndex.get(token);
  if (ref) ref.job.status = "queued";
}

// --------------------------
// Assets
// --------------------------
const base64 = fs.readFileSync("./logo-backup.png", "base64");

// --------------------------
// HTML Template
// --------------------------
function generateReceiptHTML(order = {}) {
  const restaurantName = order.restaurantName || "";
  const driverName = order.driverName || "";
  const driverPhone = order.driverPhone || "";
  const providerName = order.providerName || "";
  const estimatePickupTime = order.estimatePickupTime || "";
  const isPickup = !!order.pickup; // <— key

  const customerName = order.customerDetails?.name || "";
  const customerAddress = order.customerDetails?.address || "";
  const customerCity = order.customerDetails?.city || "";
  const customerState = order.customerDetails?.state || "";
  const customerZip = order.customerDetails?.zip || "";

  const items = Array.isArray(order.items) ? order.items : [];

  const deliveryFee =
    typeof order.deliveryFee === "number" ? order.deliveryFee : null;
  const serviceFee =
    typeof order.serviceFee === "number" ? order.serviceFee : null;
  const processingFee =
    typeof order.processingFee === "number" ? order.processingFee : null;
  const total = typeof order.total === "number" ? order.total : 0;

  const deliveryInstructions = order.deliveryInstructions || "";

  return `
  <html>
  <head>
    <meta charset="utf-8" />
    <style>
      * { box-sizing: border-box; }
      body {
        font-family: monospace;
        width: 576px;
        margin: 0;
        padding: 10px 10px 10px 0px;
        font-size: 30px;
      }
      .center { text-align: center; }
      .bold { font-weight: bold; font-size: 35px; }
      .line { border-top: 1px dashed #000; margin: 6px 0; }
      .item { display: flex; justify-content: space-between; font-size: 27px; }
      .logo { display: block; margin: 0 auto 15px auto; max-width: 200px; }
      .subinfo { font-size: 24px; margin-top: 10px; margin-bottom: 10px; }
      .specialInstructions { font-size: 22px; font-style: italic; margin-top: 8px; border: 1px solid #000; padding: 4px; }
    </style>
  </head>
  <body>
    <div class="center">
      <img class="logo" src="data:image/png;base64,${base64}" alt="Logo" />
    </div>

    <div class="center bold">${restaurantName}</div>

    <!-- Top info: show Provider always; hide Driver + Pickup Time when pickup -->
    <div class="center subinfo">
      ${!isPickup ? `<span>Pickup Driver: <span style="font-weight:bold;">${driverName} - ${driverPhone}</span></span><br/>` : ``}
      ${isPickup ? `<span>Pickup <span style="font-weight:bold;">${customerName}</span></span><br/>` : ``}
      ${providerName ? `Provider: <span style="font-weight:bold;">${providerName}</span><br/>` : ``}
      ${!isPickup ? `Pickup Time: ${estimatePickupTime}` : ``}
    </div>

    <div class="line"></div>

    <!-- Delivery address: hide entirely on pickup -->
    ${!isPickup ? `
      <div class="center subinfo">
        Delivery Address:
        <span style="font-weight:bold;">
          ${customerName} — ${customerAddress}${customerCity ? ", " + customerCity : ""}, ${customerState}, ${customerZip}
        </span>
      </div>
      <div class="line"></div>
    ` : ``}

    ${items.map(item => {
      const name = item?.name || "Item";
      const quantity = item?.quantity || 1;
      const price = typeof item?.price === "number" ? item.price : 0;
      const special = item?.specialInstructions || "";
      return `
        <div class="item">
          <span>${quantity}x ${name}</span>
          <span>$${(quantity * price).toFixed(2)}</span>
        </div>
        ${special ? `<div class="specialInstructions">special instructions: ${special}</div>` : ""}
      `;
    }).join("")}

    <div class="line"></div>

    <!-- Fees: hide delivery fee on pickup -->
    ${(!isPickup && deliveryFee !== null) ? `<div class="item"><span>Delivery Fee</span><span>$${deliveryFee.toFixed(2)}</span></div>` : ""}
    ${serviceFee !== null ? `<div class="item"><span>Service Fee</span><span>$${serviceFee.toFixed(2)}</span></div>` : ""}
    ${processingFee !== null ? `<div class="item"><span>Processing Fee</span><span>$${processingFee.toFixed(2)}</span></div>` : ""}

    <div class="line"></div>
    <div class="item bold"><span>TOTAL</span><span>$${total.toFixed(2)}</span></div>

    <!-- Special delivery instructions: hide on pickup -->
    ${(!isPickup && deliveryInstructions)
      ? `<div class="specialInstructions">special delivery instructions: ${deliveryInstructions}</div>`
      : ""}

    <div class="center">Thank you!</div>
  </body>
  </html>`;
}

// --------------------------
// Puppeteer Fast Path
// --------------------------
function getChromiumPath() {
  const candidates = ["/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

// Simple concurrency limiter (no deps)
class Limit {
  constructor(max = 2) {
    this.max = max;
    this.running = 0;
    this.queue = [];
  }
  async run(fn) {
    if (this.running >= this.max)
      await new Promise((res) => this.queue.push(res));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}
const renderLimit = new Limit(2); // tune for your box

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      executablePath:
        getChromiumPath() || process.env.PUPPETEER_EXECUTABLE_PATH,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--mute-audio",
        "--font-render-hinting=none",
      ],
    });
  }
  return browserPromise;
}

async function renderHtmlToPngFast(html) {
  const MAX_RETRIES = 3;
  const RETRYABLE = [
    "Session closed",
    "Target closed",
    "Protocol error",
    "Execution context was destroyed",
    "Navigating frame was detached",
    "LifecycleWatcher disposed",
  ];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const browser = await getBrowser();
    try {
      return await renderLimit.run(async () => {
        const page = await browser.newPage();
        try {
          // no page.setViewport here – viewport is set at launch

          // Avoid a navigation (less chance of lifecycle races)
          await page.setContent(html, {
            waitUntil: "domcontentloaded",
            timeout: 15000,
          });

          // Full page screenshot, no height math
          const buf = await page.screenshot({
            type: "png",
            fullPage: true,
            // captureBeyondViewport intentionally omitted (not needed for fullPage)
            optimizeForSpeed: true,
          });
          return buf;
        } finally {
          try { await page.close(); } catch {}
        }
      });
    } catch (err) {
      const msg = (err && (err.message || String(err))) || "";
      const retry = RETRYABLE.some(s => msg.includes(s));
      const last = attempt === MAX_RETRIES;

      // If the target/browser died, force relaunch next loop
      if (msg.includes("Target closed") || msg.includes("Session closed")) {
        try { const b = await browserPromise; await b.close().catch(() => {}); } catch {}
        browserPromise = null;
      }
      if (!retry || last) throw err;

      // small backoff
      await new Promise(r => setTimeout(r, 200 * attempt));
    }
  }
}


// Fast Sharp pipeline (monochrome receipt) — version-safe
function rasterForStar(rawBuffer) {
  // effort must be 1..10 on many sharp versions
  const PNG_OPTS = {
    palette: true,
    // 'colors' is the official key; 'colours' was accepted historically.
    colors: 2,
    compressionLevel: 2, // 0..9 (2 is fast)
    effort: 1, // 1..10 (1 is fastest); remove or bump if needed
  };

  return sharp(rawBuffer, { failOn: "none" })
    .resize({ width: 565, kernel: "nearest" })
    .extend({
      bottom: 300,
      background: { r: 255, g: 255, b: 255 }, // white background
    })
    .grayscale()
    .threshold(160)
    .png(PNG_OPTS)
    .toBuffer();
}

// Append StarPRNT feed + cut
function appendFeedAndCut(buffer) {
  const FEED_AND_CUT = Buffer.from([0x1b, 0x64, 0x02]); // ESC d 2
  return Buffer.concat([buffer, FEED_AND_CUT]);
}

// --------------------------
// Routes
// --------------------------

// Create jobs fast; render in background
app.post("/api/print", async (req, res) => {
  const { restaurantId, order } = req.body || {};
  if (!restaurantId)
    return res.status(400).json({ ok: false, error: "Missing restaurantId" });

  const restaurantIds = Array.isArray(restaurantId)
    ? restaurantId
    : [restaurantId];
  const unknown = restaurantIds.filter(
    (rid) => !PRINTER_CONFIG.some((p) => p.restaurantId === rid)
  );
  if (unknown.length)
    return res
      .status(404)
      .json({
        ok: false,
        error: `Unknown restaurantId(s): ${unknown.join(", ")}`,
      });

  // Create queued jobs immediately (no content yet)
  const tokens = [];
  for (const rid of restaurantIds) {
    const id = makeId();
    const job = { id, content: null, status: "queued", restaurantId: rid };
    queueFor(rid).push(job);
    jobIndex.set(id, { restaurantId: rid, job });
    tokens.push(id);
  }

  // Respond ASAP so callers (Lambda) don't block
  res.status(202).json({ ok: true, tokens });

  // Background render
  (async () => {
    try {
      const html = generateReceiptHTML(order || {});
      const raw = await renderHtmlToPngFast(html);
      const optimized = await rasterForStar(raw);
      const finalBuffer = appendFeedAndCut(optimized);

      for (const t of tokens) {
        const ref = jobIndex.get(t);
        if (ref?.job) {
          ref.job.content = finalBuffer;
          ref.job.status = "queued";
        }
      }
      console.log("print jobs ready:", tokens);
    } catch (e) {
      console.error("background print render failed", e);
      for (const t of tokens) {
        const ref = jobIndex.get(t);
        if (ref?.job) ref.job.status = "failed";
      }
    }
  })();
});

// CloudPRNT poll — only offer when content is ready
app.post("/cloudprnt", (req, res) => {
  const serial = req.headers["x-star-serial-number"];
  const restaurantId = serialToRestaurant.get(String(serial).trim());
  if (!restaurantId) return res.json({ jobReady: false });

  const job = nextQueuedJob(serial);
  if (!job) return res.json({ jobReady: false });

  job.status = "offered";
  res.json({
    jobReady: true,
    jobToken: job.id,
    mediaTypes: ["image/png"],
    deleteMethod: "DELETE",
  });
});

// Printer fetches job content
app.get("/cloudprnt", (req, res) => {
  const { token, type } = req.query;
  if (!token) return res.status(400).send("Missing token");
  if (type !== "image/png")
    return res.status(415).send("Unsupported media type");

  const ref = jobIndex.get(String(token));
  if (!ref) return res.sendStatus(404);

  if (!ref.job.content) {
    console.log(
      "Printer requested job",
      token,
      "but content not ready yet → jobReady:false"
    );
    return res.json({ jobReady: false });
  }

  console.log("Serving job", token, "for restaurant", ref.restaurantId);
  res.setHeader("Content-Type", "image/png");
  res.send(ref.job.content);
});

// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// Confirmation (delete / requeue)
app.delete("/cloudprnt", (req, res) => {
  const { token, code } = req.query;
  if (!token) return res.status(400).send("Missing token");

  const codeStr = String(code || "").toUpperCase();
  const success = codeStr === "OK" || codeStr.startsWith("2");
  if (success) removeJob(String(token));
  else requeueJob(String(token));

  res.sendStatus(200);
});

// --------------------------
// Startup & Shutdown
// --------------------------
const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log(`CloudPRNT server running on :${PORT}`);
  // Warm browser for first render (optional, small spin-up)
  try {
    await getBrowser();
    console.log("Chromium warmed");
  } catch (e) {
    console.warn("Chromium warm-up failed:", e?.message || e);
  }
});

// Graceful shutdown closes browser
async function closeBrowser() {
  try {
    if (browserPromise) (await browserPromise).close();
  } catch {}
}
process.on("SIGINT", async () => {
  await closeBrowser();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await closeBrowser();
  process.exit(0);
});
