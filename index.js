// printer-server.js
import http from "http";
import https from "https";
import express from "express";
import puppeteer from "puppeteer";
import fs from "fs";
import sharp from "sharp";
import { performance } from "perf_hooks"; // ← timing
import cors from "cors";

// allow your local dev origins
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://www.orderthevessale.com",
  "https://orderthevessale.com",
  "http://orderthevessale.com",
  "https://orderthevessale.com"
];

// --------------------------
// Config & App
// --------------------------
const app = express();
app.use(express.json({ limit: "256kb" }));
app.set("trust proxy", true); // so req.ip works behind a proxy/ELB

/** Map restaurants to printers (note: some serials repeat on purpose) */
const PRINTER_CONFIG = [
  { restaurantId: "local", serial: "2581021060600835" },
  { restaurantId: "worldfamous-skyler1", serial: "2581018070600248" },
  { restaurantId: "worldfamous-skyler2", serial: "2581019070600037" },
  // { restaurantId: "worldfamous-printer1", serial: "2581018070600248" },
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

app.use(cors({
  origin: (origin, cb) => {
    // allow same-origin or non-browser requests (no Origin header)
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    // Reject with false instead of Error - sends proper CORS headers
    console.warn(`CORS rejected origin: ${origin}`);
    return cb(null, false);
  },
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-Requested-With", "X-Star-Serial-Number"],
  credentials: false, // set true only if you actually send cookies/auth
}));

// handle preflight
app.options(/.*/, cors());

/** serial -> array of restaurantIds (preserve all, not last one) */
const serialToRestaurantList = new Map();
for (const { serial, restaurantId } of PRINTER_CONFIG) {
  const s = String(serial).trim();
  const arr = serialToRestaurantList.get(s) || [];
  arr.push(restaurantId);
  serialToRestaurantList.set(s, arr);
}
/** round-robin pointer per serial */
const serialRR = new Map();

// --------------------------
// In-memory Job Store
// --------------------------
function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
const jobsByRestaurant = new Map(); // restaurantId -> Job[]
const jobIndex = new Map(); // token -> { restaurantId, job }

function queueFor(restaurantId) {
  if (!jobsByRestaurant.has(restaurantId)) jobsByRestaurant.set(restaurantId, []);
  return jobsByRestaurant.get(restaurantId);
}

function nextJobForSerial(serial) {
  const s = String(serial).trim();
  const lists = serialToRestaurantList.get(s);
  if (!lists || lists.length === 0) return null;

  // advance RR pointer
  const start = serialRR.get(s) ?? 0;
  for (let i = 0; i < lists.length; i++) {
    const idx = (start + i) % lists.length;
    const rid = lists[idx];
    const q = queueFor(rid);

    // pick first job that is ready to offer: queued + has content
    const job = q.find(j => j.status === "queued" && j.content);
    if (job) {
      serialRR.set(s, (idx + 1) % lists.length);
      return job;
    }
  }
  // no ready job found; keep pointer
  return null;
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

function requeueToken(token) {
  const ref = jobIndex.get(token);
  if (!ref) return;
  ref.job.status = "queued";
  ref.job.offeredAt = null;
  ref.job.sentAt = null;
}

// --------------------------
// Presence tracking (who's polling)
// --------------------------
const seenBySerial = new Map(); // serial -> { serial, restaurants[], lastSeen, ip, ua, path }
const POLL_ONLINE_WINDOW_MS = 15_000; // printers poll every 5s → 15s is a safe online window

function markSeen(serial, req) {
  const s = String(serial).trim();
  if (!s) return;
  const restaurants = serialToRestaurantList.get(s) || [];
  seenBySerial.set(s, {
    serial: s,
    restaurants,
    lastSeen: Date.now(),
    ip: req.ip,
    userAgent: req.get("user-agent") || "",
    path: req.originalUrl || req.url || "",
  });
}
function isOnline(rec) {
  return Date.now() - rec.lastSeen <= POLL_ONLINE_WINDOW_MS;
}
function toPublicPresence(rec) {
  const ago = Date.now() - rec.lastSeen;
  return {
    serial: rec.serial,
    restaurants: rec.restaurants,
    lastSeen: new Date(rec.lastSeen).toISOString(),
    msAgo: ago,
    ip: rec.ip,
  };
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
  const isPickup = !!order.pickup;

  const customerName = order.customerDetails?.name || "";
  const customerAddress = order.customerDetails?.address || "";
  const customerCity = order.customerDetails?.city || "";
  const customerState = order.customerDetails?.state || "";
  const customerZip = order.customerDetails?.zip || "";
  const items = Array.isArray(order.items) ? order.items : [];

  const deliveryFee = typeof order.deliveryFee === "number" ? order.deliveryFee : null;
  const serviceFee = typeof order.serviceFee === "number" ? order.serviceFee : null;
  const processingFee = typeof order.processingFee === "number" ? order.processingFee : null;
  const total = typeof order.total === "number" ? order.total : 0;
  const deliveryInstructions = order.deliveryInstructions || "";

  return `
  <html>
  <head>
    <meta charset="utf-8" />
    <style>
      * { box-sizing: border-box; }
      body { font-family: monospace; width: 576px; margin: 0; padding: 10px 10px 100px 0px; font-size: 42px; }
      .center { text-align: center; }
      .bold { font-weight: bold; font-size: 49px; }
      .line { border-top: 1px dashed #000; margin: 6px 0; }
      .item { display: flex; justify-content: space-between; font-size: 38px; }
      .logo { display: block; margin: 0 auto 15px auto; max-width: 200px; }
      .subinfo { font-size: 34px; margin-top: 10px; margin-bottom: 10px; }
      .specialInstructions { font-size: 31px; font-style: italic; margin-top: 8px; border: 1px solid #000; padding: 4px; }
      .modifiers { font-size: 31px; margin-left: 20px; margin-top: 4px; color: #333; }
      .modifier-item { display: flex; justify-content: space-between; margin-top: 2px; }
    </style>
  </head>
  <body>
    <div class="center">
      <img class="logo" src="data:image/png;base64,${base64}" alt="Logo" />
    </div>

    <div class="center bold">${restaurantName}</div>

    <div class="center subinfo">
      ${!isPickup ? `<span>Pickup Driver: <span style="font-weight:bold;">${driverName} - ${driverPhone}</span></span><br/>` : ``}
      ${isPickup ? `<span>Pickup <span style="font-weight:bold;">${customerName}</span></span><br/>` : ``}
      ${providerName ? `Provider: <span style="font-weight:bold;">${providerName}</span><br/>` : ``}
      ${!isPickup ? `Pickup Time: ${estimatePickupTime}` : ``}
    </div>

    <div class="line"></div>

    ${!isPickup ? `
      <div class="center subinfo">
        Delivery Address:
        <span style="font-weight:bold;">
          ${customerName} — ${customerAddress}${customerCity ? ", " + customerCity : ""}, ${customerState}, ${customerZip}
        </span>
      </div>
      <div class="line"></div>
    ` : ``}

    ${items.map((item) => {
      const name = item?.name || "Item";
      const quantity = item?.quantity || 1;
      const price = typeof item?.price === "number" ? item.price : 0;
      const modifierTotal = (typeof item?.modifierTotal === "number" && !isNaN(item.modifierTotal)) ? item.modifierTotal : 0;
      const itemTotal = (price + modifierTotal) * quantity;
      const special = item?.specialInstructions || "";
      const modifiers = Array.isArray(item?.selectedModifiers) ? item.selectedModifiers : [];
      
      return `
        <div class="item">
          <span style="font-weight: bold;">${quantity}x ${name}</span>
          <span style="font-weight: bold;">$${itemTotal.toFixed(2)}</span>
        </div>
        ${modifiers.length > 0 ? `
          <div class="modifiers">
            ${modifiers.map(mod => {
              const modPrice = (typeof mod?.modifierPrice === "number" && !isNaN(mod.modifierPrice)) ? mod.modifierPrice : 0;
              const modName = mod?.modifierName || "Modifier";
              return `
              <div class="modifier-item">
                <span>+ ${modName}</span>
                ${modPrice > 0 ? `<span>+$${modPrice.toFixed(2)}</span>` : ''}
              </div>
              `;
            }).join('')}
          </div>
        ` : ""}
        ${special ? `<div class="specialInstructions">special instructions: ${special}</div>` : ""}
      `;
    }).join("")}

    <div class="line"></div>

    ${(!isPickup && deliveryFee !== null) ? `<div class="item"><span>Delivery Fee</span><span>$${deliveryFee.toFixed(2)}</span></div>` : ""}
    ${serviceFee !== null ? `<div class="item"><span>Service Fee</span><span>$${serviceFee.toFixed(2)}</span></div>` : ""}
    ${processingFee !== null ? `<div class="item"><span>Processing Fee</span><span>$${processingFee.toFixed(2)}</span></div>` : ""}

    <div class="line"></div>
    <div class="item bold"><span>TOTAL</span><span>$${total.toFixed(2)}</span></div>

    ${(!isPickup && deliveryInstructions) ? `<div class="specialInstructions">special delivery instructions: ${deliveryInstructions}</div>` : ""}

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

// Tiny concurrency limiter
class Limit {
  constructor(max = 2) { this.max = max; this.running = 0; this.q = []; }
  async run(fn) {
    if (this.running >= this.max) await new Promise(r => this.q.push(r));
    this.running++;
    try { return await fn(); }
    finally { this.running--; const n=this.q.shift(); if (n) n(); }
  }
}
const renderLimit = new Limit(2);

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      executablePath: getChromiumPath() || process.env.PUPPETEER_EXECUTABLE_PATH,
      args: [
        "--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage",
        "--disable-gpu","--media-cache-size=52428800",
        "--single-process","--no-zygote","--mute-audio","--font-render-hinting=none",
        "--disable-background-timer-throttling","--disable-backgrounding-occluded-windows",
        "--disk-cache-size=0" // keep temp small
      ],
    });
  }
  return browserPromise;
}

async function renderHtmlToPngFast(html) {
  const browser = await getBrowser();
  return renderLimit.run(async () => {
    const t0 = Date.now();
    const page = await browser.newPage();
    try {
      // Static HTML: JS off = faster layout/paint
      await page.setJavaScriptEnabled(false);

      // Stable layout width, no scaling
      await page.setViewport({ width: 576, height: 800, deviceScaleFactor: 1 });

      // Block all external resources; allow only data: URLs
      await page.setRequestInterception(true);
      page.on('request', req => {
        const url = req.url();
        if (url.startsWith('data:')) return req.continue();
        const type = req.resourceType();
        if (type === 'image' || type === 'font' || type === 'media' || type === 'stylesheet' || type === 'xhr' || type === 'fetch') {
          return req.abort();
        }
        return req.abort();
      });

      const tSetContent0 = Date.now();
      await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      const tSetContent1 = Date.now();

      // Compute exact content height (no cap) and take a single clipped shot
      const height = await page.evaluate(() => {
        const h = Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight
        );
        return Math.min(h, 30_000); // guardrail
      });

      const tShot0 = Date.now();
      const buf = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: 576, height },
        captureBeyondViewport: false,
        optimizeForSpeed: true,
      });
      const tShot1 = Date.now();

      console.log(
        `[render] newPage=${tSetContent0 - t0}ms setContent=${tSetContent1 - tSetContent0}ms ` +
        `measure=${tShot0 - tSetContent1}ms screenshot=${tShot1 - tShot0}ms total=${Date.now() - t0}ms`
      );

      return buf;
    } finally {
      await page.close().catch(() => {});
    }
  });
}

// Raster -> Star
function rasterForStar(raw) {
  const PNG_OPTS = { palette: true, colors: 2, compressionLevel: 2, effort: 1 };
  return sharp(raw, { failOn: "none" })
    .resize({ width: 565, kernel: "nearest" })
    .extend({ bottom: 700, background: { r: 255, g: 255, b: 255 } })
    .grayscale()
    .threshold(160)
    .png(PNG_OPTS)
    .toBuffer();
}

function appendFeedAndCut(buffer) {
  const FEED_AND_CUT = Buffer.from([0x1b, 0x64, 0x02]);
  return Buffer.concat([buffer, FEED_AND_CUT]);
}

// --------------------------
// Render pipeline with timing
// --------------------------
async function renderPipelineWithTiming(html, meta = {}) {
  const t0 = performance.now();
  const raw = await renderHtmlToPngFast(html);
  const t1 = performance.now();
  const optimized = await rasterForStar(raw);
  const t2 = performance.now();
  const finalBuffer = appendFeedAndCut(optimized);
  const t3 = performance.now();

  const sRaw = raw.length;
  const sOpt = optimized.length;
  const sFinal = finalBuffer.length;

  const ms = (n) => Math.round(n);
  console.log(
    `[render] ${meta.tag || ""} html→png=${ms(t1 - t0)}ms, raster=${ms(t2 - t1)}ms, cut=${ms(t3 - t2)}ms, total=${ms(t3 - t0)}ms; ` +
    `sizes raw=${sRaw}B, raster=${sOpt}B, final=${sFinal}B`
  );

  return finalBuffer;
}

// --------------------------
// Stale-offer/sent sweeper
// --------------------------
const OFFER_TIMEOUT_MS = 10_000; // re-offer after 10s
const SENT_TIMEOUT_MS  = 20_000; // consider sent stale after 20s
setInterval(() => {
  const now = Date.now();
  for (const [rid, q] of jobsByRestaurant.entries()) {
    for (const j of q) {
      if (j.status === "offered" && j.offeredAt && now - j.offeredAt > OFFER_TIMEOUT_MS) {
        console.warn("[sweep->requeue offered]", { rid, token: j.id });
        j.status = "queued"; j.offeredAt = null;
      }
      if (j.status === "sent" && j.sentAt && now - j.sentAt > SENT_TIMEOUT_MS) {
        console.warn("[sweep->requeue sent]", { rid, token: j.id });
        j.status = "queued"; j.sentAt = null;
      }
    }
  }
}, 3_000);

// --------------------------
// Routes
// --------------------------

// Create jobs; render async
app.post("/api/print", async (req, res) => {
  const { restaurantId, order } = req.body || {};
  if (!restaurantId) return res.status(400).json({ ok: false, error: "Missing restaurantId" });

  const restaurantIds = Array.isArray(restaurantId) ? restaurantId : [restaurantId];

  // validate all ids first
  const validIds = new Set(PRINTER_CONFIG.map(p => p.restaurantId));
  const bad = restaurantIds.filter(r => !validIds.has(r));
  if (bad.length) return res.status(404).json({ ok: false, error: `Unknown restaurantId(s): ${bad.join(", ")}` });

  const tokens = [];
  for (const rid of restaurantIds) {
    const id = makeId();
    const job = { id, content: null, status: "queued", offeredAt: null, sentAt: null, restaurantId: rid };
    queueFor(rid).push(job);
    jobIndex.set(id, { restaurantId: rid, job });
    tokens.push(id);
  }

  res.status(202).json({ ok: true, tokens });

  console.log('PRINTER RECEIVED ORDER:', JSON.stringify(order, null, 2));
  console.log('FIRST ITEM MODIFIERS:', order?.items?.[0]?.selectedModifiers);

  (async () => {
    try {
      const html = generateReceiptHTML(order || {});
      const tag = tokens.length ? `${tokens[0]}:${restaurantIds[0]}` : "batch";
      const finalBuffer = await renderPipelineWithTiming(html, { tag });

      for (const t of tokens) {
        const ref = jobIndex.get(t);
        if (ref?.job) { ref.job.content = finalBuffer; ref.job.status = "queued"; console.log("[render ready]", t); }
      }
    } catch (e) {
      console.error("background render failed", e);
      for (const t of tokens) {
        const ref = jobIndex.get(t);
        if (ref?.job) ref.job.status = "failed";
      }
    }
  })();
});

// Poll: offer next job for this serial (round-robin across its restaurant queues)
app.post("/cloudprnt", (req, res) => {
  const serial = String(req.headers["x-star-serial-number"] || "").trim();

  // record presence (printers poll every ~5s)
  if (serial) {
    markSeen(serial, req);
  }

  const rids = serialToRestaurantList.get(serial);
  if (!rids) return res.json({ jobReady: false });

  // Before offering, aggressively unstick stale jobs in those queues
  const now = Date.now();
  for (const rid of rids) {
    const q = queueFor(rid);
    for (const j of q) {
      if (j.status === "offered" && j.offeredAt && now - j.offeredAt > OFFER_TIMEOUT_MS) { j.status = "queued"; j.offeredAt = null; }
      if (j.status === "sent"    && j.sentAt    && now - j.sentAt    > SENT_TIMEOUT_MS)  { j.status = "queued"; j.sentAt = null; }
    }
  }

  const job = nextJobForSerial(serial);
  if (!job) return res.json({ jobReady: false });

  job.status = "offered";
  job.offeredAt = Date.now();
  console.log("[offer]", { serial, rid: job.restaurantId, token: job.id });

  res.json({
    jobReady: true,
    jobToken: job.id,
    mediaTypes: ["image/png"],
    deleteMethod: "DELETE",
  });
});

// Printer fetches job content -> mark as 'sent'
app.get("/cloudprnt", (req, res) => {
  const { token, type } = req.query;
  if (!token) return res.status(400).send("Missing token");
  if (type !== "image/png") return res.status(415).send("Unsupported media type");

  const ref = jobIndex.get(String(token));
  if (!ref) return res.sendStatus(404);

  const job = ref.job;
  if (!job.content) {
    console.log("[get not-ready]", { token: job.id, rid: ref.restaurantId });
    return res.json({ jobReady: false });
  }

  // Mark sent (printer has fetched data)
  job.status = "sent";
  job.sentAt = Date.now();

  console.log("[serve]", { token: job.id, rid: ref.restaurantId });
  const buf = job.content;
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Content-Length", String(buf.length));
  res.send(buf);
});

// Printer confirms -> done or requeue
app.delete("/cloudprnt", (req, res) => {
  const { token, code } = req.query;
  if (!token) return res.status(400).send("Missing token");
  const codeStr = String(code || "").toUpperCase();

  const ref = jobIndex.get(String(token));
  if (!ref) { console.warn("[delete-missing]", { token }); return res.sendStatus(200); }

  if (codeStr === "OK" || codeStr.startsWith("2")) {
    ref.job.status = "done";
    console.log("[done]", { token: ref.job.id, rid: ref.restaurantId, code: codeStr });
    removeJob(String(token));
  } else {
    console.warn("[requeue on delete]", { token: ref.job.id, code: codeStr });
    requeueToken(String(token));
  }
  res.sendStatus(200);
});

// Debug helpers
app.get("/debug/queue/:rid", (req, res) => {
  const q = queueFor(req.params.rid);
  res.json(q.map(j => ({ id: j.id, status: j.status, hasContent: !!j.content, offeredAt: j.offeredAt, sentAt: j.sentAt })));
});
app.get("/debug/serial/:serial", (req, res) => {
  res.json({ restaurants: serialToRestaurantList.get(String(req.params.serial).trim()) || [] });
});

// --------------------------
// Presence endpoints
// --------------------------

/**
 * GET /api/printers/online
 * Returns all printers that have polled within POLL_ONLINE_WINDOW_MS.
 * Each item: { serial, restaurants[], lastSeen, msAgo, ip }
 */
app.get("/api/printers/online", (req, res) => {
  const printers = Array.from(seenBySerial.values())
    .filter(isOnline)
    .map(toPublicPresence)
    .sort((a, b) => a.msAgo - b.msAgo); // newest first
  res.json({ ok: true, windowMs: POLL_ONLINE_WINDOW_MS, count: printers.length, printers });
});

/**
 * GET /api/printers
 * Returns every configured printer with status online/offline and last seen info if known.
 */
app.get("/api/printers", (req, res) => {
  const uniqueSerials = new Set(PRINTER_CONFIG.map(p => String(p.serial).trim()));
  const out = Array.from(uniqueSerials).map((serial) => {
    const rec = seenBySerial.get(serial);
    const restaurants = serialToRestaurantList.get(serial) || [];
    if (!rec) {
      return { serial, restaurants, status: "offline", lastSeen: null, msAgo: null, ip: null };
    }
    const base = toPublicPresence(rec);
    return { ...base, status: isOnline(rec) ? "online" : "offline" };
  });

  // include any currently seen serials that aren't in config (safety)
  for (const [serial, rec] of seenBySerial) {
    if (!uniqueSerials.has(serial)) {
      const base = toPublicPresence(rec);
      out.push({ ...base, status: isOnline(rec) ? "online" : "offline" });
    }
  }

  out.sort((a, b) => {
    if (a.status !== b.status) return a.status === "online" ? -1 : 1;
    const aAgo = a.msAgo ?? Number.POSITIVE_INFINITY;
    const bAgo = b.msAgo ?? Number.POSITIVE_INFINITY;
    return aAgo - bAgo;
  });

  res.json({ ok: true, count: out.length, printers: out });
});

// Optional: raw presence dump for debugging
app.get("/debug/seen", (req, res) => {
  const all = Array.from(seenBySerial.values()).map(toPublicPresence);
  res.json({ windowMs: POLL_ONLINE_WINDOW_MS, printers: all });
});

// --------------------------
// Startup & Shutdown (HTTP + HTTPS)
// --------------------------
const HTTP_PORT = Number(process.env.PORT || 8080);          // plain HTTP port (and redirect listener)
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);   // HTTPS port if certs provided

const SSL_KEY = '/home/ubuntu/key.pem';   // e.g. /etc/letsencrypt/live/your.domain/privkey.pem
const SSL_CERT = '/home/ubuntu/cert.pem'; // e.g. /etc/letsencrypt/live/your.domain/fullchain.pem
const SSL_CA = '/home/ubuntu/bundle.crt'    // optional bundle/chain
const FORCE_REDIRECT = (process.env.FORCE_HTTP_TO_HTTPS ?? "true").toLowerCase() !== "false";

let httpServer = null;
let httpsServer = null;

// Warm Chromium at boot (non-blocking)
(async () => {
  try { await getBrowser(); console.log("Chromium warmed"); } 
  catch (e) { console.warn("Chromium warm-up failed:", e?.message || e); }
})();

function startHttpRedirect() {
  // Lightweight redirect server → always to HTTPS (preserves host + path)
  httpServer = http.createServer((req, res) => {
    const host = req.headers.host || `localhost:${HTTPS_PORT}`;
    const location = `https://${host}${req.url || "/"}`;
    res.statusCode = 301;
    res.setHeader("Location", location);
    res.end();
  }).listen(HTTP_PORT, () => {
    console.log(`HTTP redirect server listening on :${HTTP_PORT} → https://…`);
  });
}

function startHttpPlain() {
  httpServer = http.createServer(app).listen(HTTP_PORT, () => {
    console.log(`CloudPRNT server (HTTP) running on :${HTTP_PORT}`);
  });
}

function startHttps() {
  const tlsOptions = {
    key: fs.readFileSync(SSL_KEY),
    cert: fs.readFileSync(SSL_CERT),
    ca: (SSL_CA && fs.existsSync(SSL_CA)) ? fs.readFileSync(SSL_CA) : undefined,
    minVersion: "TLSv1.2",
    // honorForwarded: with Express trust proxy, req.protocol reflects X-Forwarded-Proto when proxied
  };
  httpsServer = https.createServer(tlsOptions, app).listen(HTTPS_PORT, () => {
    console.log(`CloudPRNT server (HTTPS) running on :${HTTPS_PORT}`);
  });

  if (FORCE_REDIRECT) {
    startHttpRedirect(); // keep port :PORT to redirect browsers/devs to HTTPS
  } else {
    console.log("HTTP→HTTPS redirect disabled (FORCE_HTTP_TO_HTTPS=false).");
  }
}

// Decide which servers to start
if (SSL_KEY && SSL_CERT && fs.existsSync(SSL_KEY) && fs.existsSync(SSL_CERT)) {
  startHttps();
} else {
  console.warn("HTTPS certs not found. Starting HTTP only. (Set SSL_KEY_PATH & SSL_CERT_PATH to enable TLS)");
  startHttpPlain();
}

// Graceful shutdown
async function closeBrowser() {
  try { if (browserPromise) (await browserPromise).close(); } catch {}
}
async function shutdown() {
  try { await closeBrowser(); } catch {}
  try { if (httpsServer) await new Promise(r => httpsServer.close(r)); } catch {}
  try { if (httpServer) await new Promise(r => httpServer.close(r)); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);