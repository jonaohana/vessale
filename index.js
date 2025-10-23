import express from "express";
import puppeteer from "puppeteer";
import fs from "fs";
import sharp from "sharp";

const app = express();
app.use(express.json());

/**
 * CONFIG: map restaurants to specific printers (identified by serial and/or mac).
 */
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

// quick lookups
const serialToRestaurant = new Map(
  PRINTER_CONFIG.map((p) => [p.serial, p.restaurantId])
);

/** Job storage */
function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
const jobsByRestaurant = new Map(); // restaurantId -> Job[]
const jobIndex = new Map(); // token -> { restaurantId, job }

/** Queue helpers */
function queueFor(restaurantId) {
  if (!jobsByRestaurant.has(restaurantId))
    jobsByRestaurant.set(restaurantId, []);
  return jobsByRestaurant.get(restaurantId);
}
function nextQueuedJob(serial) {
  const id = serialToRestaurant.get(String(serial).trim());
  if (!id) return null;
  const q = queueFor(id);
  return q.find((j) => j.status === "queued");
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

const base64 = fs.readFileSync("./logo.png", "base64");

/** --- Receipt HTML generator --- */
function generateReceiptHTML(order) {
  return `
  <html>
  <head>
    <style>
      body {
        font-family: monospace;
        width: 576px; /* exact printer width */
        margin: 0;
        padding: 10px 10px 10px 0px;
        margin-right: 20px;
        font-size: 30px; 
        margin-top: 200px;
        margin-bottom: 300px;
      }
      .center { text-align: center; }
      .bold { font-weight: bold; font-size: 35px; }
      .line { border-top: 1px dashed #000; margin: 6px 0; }
      .item { display: flex; justify-content: space-between; font-size: 27px; }
      .logo { display: block; margin: 0 auto 15px auto; max-width: 200px; }
      .subinfo { font-size: 24px; margin-top: 10px; margin-bottom: 10px; }
    </style>
  </head>
  <body>
    <!-- Logo at top -->
    <div class="center">
      <img class="logo" src="data:image/png;base64,${base64}" alt="Logo" />
    </div>

    <!-- Restaurant name -->
    <div class="center bold">${order.restaurantName}</div>

    <!-- Pickup info -->
    <div class="center subinfo">
      Pickup Driver: <span style="font-weight:bold;">${order.driverName} - ${
    order.driverPhone
  }</span><br/>
      Provider: <span style="font-weight:bold;">${
        order.providerName
      }</span><br/>
      Pickup Time: ${order.estimatePickupTime}
    </div>

    <div class="line"></div>

      <!-- Pickup info -->
    <div class="center subinfo">
      Delivery Address: <span style="font-weight:bold;">${
        order.customerDetails.name
      } - ${order.customerDetails.address},  ${order.customerDetails.state},  ${
    order.customerDetails.zip
  }
  }</span><br/>
    </div>

    <div class="line"></div>

    <!-- Items -->
    ${order.items
      .map(
        (item) => `
      <div class="item">
       <div>
         <span>${item.quantity}x ${item.name}</span>
          <span>$${(item.quantity * item.price).toFixed(2)}</span>
       </div>
       <div>${item.specialInstructions || ""}</div>
      </div>
    `
      )
      .join("")}

    <div class="line"></div>

    <!-- Fees -->
    ${
      order.deliveryFee
        ? `<div class="item"><span>Delivery Fee</span><span>$${order.deliveryFee.toFixed(
            2
          )}</span></div>`
        : ""
    }
    ${
      order.serviceFee
        ? `<div class="item"><span>Service Fee</span><span>$${order.serviceFee.toFixed(
            2
          )}</span></div>`
        : ""
    }
    ${
      order.processingFee
        ? `<div class="item"><span>Processing Fee</span><span>$${order.processingFee.toFixed(
            2
          )}</span></div>`
        : ""
    }

    <div class="line"></div>
    <div class="item bold"><span>TOTAL</span><span>$${order.total.toFixed(
      2
    )}</span></div>

    <div class="center">Thank you!</div>
  </body>
  </html>
  `;
}

function getChromiumPath() {
  const candidates = ["/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const path of candidates) {
    if (fs.existsSync(path)) return path;
  }
  return null;
}

async function htmlToOptimizedPng(html) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: getChromiumPath() || process.env.PUPPETEER_EXECUTABLE_PATH,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
    ],
  });

  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });

  const height = await page.evaluate(() => document.body.scrollHeight);
  const rawBuffer = await page.screenshot({
    type: "png",
    clip: { x: 0, y: 0, width: 576, height },
  });
  await browser.close();

  // Optimize PNG: grayscale, 2-color palette, compressed
  return await sharp(rawBuffer)
    .resize({ width: 565 })
    .grayscale()
    .threshold(128)
    .png({ compressionLevel: 3, palette: true })
    .toBuffer();
}

/** --- Append StarPRNT feed + cut command --- */
function appendFeedAndCut(buffer) {
  const FEED_AND_CUT = Buffer.from([0x1b, 0x64, 0x02]); // ESC d 2
  return Buffer.concat([buffer, FEED_AND_CUT]);
}

/** --- API Routes --- */
app.post("/api/print", async (req, res) => {
  const { restaurantId, order } = req.body || {};
  if (!restaurantId)
    return res.status(400).json({ ok: false, error: "Missing restaurantId" });

  const restaurantIds = Array.isArray(restaurantId)
    ? restaurantId
    : [restaurantId];

  const html = generateReceiptHTML(order || {});
  const optimizedBuffer = await htmlToOptimizedPng(html);
  const finalBuffer = appendFeedAndCut(optimizedBuffer);

  const tokens = [];

  for (const rid of restaurantIds) {
    const knownRestaurant = PRINTER_CONFIG.some((p) => p.restaurantId === rid);
    if (!knownRestaurant) {
      return res
        .status(404)
        .json({ ok: false, error: `Unknown restaurantId: ${rid}` });
    }

    const id = makeId();
    const job = {
      id,
      content: finalBuffer,
      status: "queued",
      restaurantId: rid,
    };
    queueFor(rid).push(job);
    jobIndex.set(id, { restaurantId: rid, job });
    tokens.push(id);
  }

  res.json({ ok: true, tokens });
});

/** PRINTER POLL */
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

/** PRINTER GETS JOB DATA */
app.get("/cloudprnt", (req, res) => {
  const { token, type } = req.query;
  if (!token) return res.status(400).send("Missing token");
  if (type !== "image/png")
    return res.status(415).send("Unsupported media type");

  const ref = jobIndex.get(String(token));
  if (!ref) return res.sendStatus(404);

  res.setHeader("Content-Type", "image/png");
  res.send(ref.job.content);
});

/** HEALTHCHECK */
app.get("/health", (_req, res) => res.json({ ok: true }));

/** CONFIRMATION */
app.delete("/cloudprnt", (req, res) => {
  const { token, code } = req.query;
  if (!token) return res.status(400).send("Missing token");

  const codeStr = String(code || "").toUpperCase();
  const success = codeStr === "OK" || codeStr.startsWith("2");
  if (success) removeJob(String(token));
  else requeueJob(String(token));

  res.sendStatus(200);
});

app.listen(8080, () =>
  console.log("CloudPRNT server running with optimized PNG + feed/cut on :8080")
);
