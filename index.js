import express from "express";

const app = express();
app.use(express.json());

/**
 * CONFIG: map restaurants to specific printers (identified by serial and/or mac).
 */
const PRINTER_CONFIG = [
  { restaurantId: "local", serial: "2581021060600835"},
  { restaurantId: "worldfamous-printer1", serial: "2581018070600248"},
  { restaurantId: "worldfamous-printer2", serial: "2581019070600037"},
];

// quick lookups
const serialToRestaurant = new Map(PRINTER_CONFIG.map(p => [p.serial, p.restaurantId]));
const macToRestaurant = new Map(PRINTER_CONFIG.filter(p => p.mac).map(p => [p.mac, p.restaurantId]));

console.log(serialToRestaurant)

/**
 * Job model:
 * { id, content, status: 'queued'|'offered', restaurantId }
 */
function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Maintain queues per restaurant
const jobsByRestaurant = new Map(); // restaurantId -> Job[]
// Global token index for quick GET/DELETE lookups
const jobIndex = new Map(); // token -> { restaurantId, job }

function queueFor(restaurantId) {
  if (!jobsByRestaurant.has(restaurantId)) jobsByRestaurant.set(restaurantId, []);
  return jobsByRestaurant.get(restaurantId);
}

function nextQueuedJob(serial) {
  console.log('print w/ serial:', serial)
  const id = serialToRestaurant.get(String(serial).trim());

  console.log('printer=>',  id)

  if (!id) {
    console.warn("Unknown printer serial:", serial);
    return null;
  }
  const q = queueFor(id);
  return q.find(j => j.status === "queued");
}

function removeJob(token) {
  const ref = jobIndex.get(token);
  if (!ref) return;
  const { restaurantId, job } = ref;
  const q = queueFor(restaurantId);
  const idx = q.findIndex(j => j.id === job.id);
  if (idx >= 0) q.splice(idx, 1);
  jobIndex.delete(token);
}

function requeueJob(token) {
  const ref = jobIndex.get(token);
  if (!ref) return;
  ref.job.status = "queued";
}

/** 
 * POST /api/print
 * Body: { restaurantId: string | string[], content?: string }
 * Enqueues one job for a single printer OR multiple jobs for multiple printers.
 */
app.post("/api/print", (req, res) => {
  const { restaurantId, content } = req.body || {};
  if (!restaurantId) {
    return res.status(400).json({ ok: false, error: "Missing restaurantId" });
  }

  // Normalize input to array
  const restaurantIds = Array.isArray(restaurantId) ? restaurantId : [restaurantId];

  const tokens = [];

  for (const rid of restaurantIds) {
    const knownRestaurant = PRINTER_CONFIG.some(p => p.restaurantId === rid);
    if (!knownRestaurant) {
      return res.status(404).json({ ok: false, error: `Unknown restaurantId: ${rid}` });
    }

    const id = makeId();
    const job = {
      id,
      content: typeof content === "string" && content.length > 0
        ? content
        : `Hello from CloudPRNT!\n\n ${restaurantIds}`,
      status: "queued",
      restaurantId: rid,
    };

    queueFor(rid).push(job);
    jobIndex.set(id, { restaurantId: rid, job });
    tokens.push(id);
  }

  res.json({ ok: true, tokens, queueSizes: restaurantIds.map(rid => ({ restaurantId: rid, size: queueFor(rid).length })) });
});

/** PRINTER POLL */
app.post("/cloudprnt", (req, res) => {
  const serial = req.headers["x-star-serial-number"];

  console.log('serial', serial)

  let restaurantId = null;
  if (serial && serialToRestaurant.has(String(serial))) {
    restaurantId = serialToRestaurant.get(String(serial));
  } else if (mac && macToRestaurant.has(String(mac))) {
    restaurantId = macToRestaurant.get(String(mac));
  }

  console.log('polling with =>', restaurantId)

  if (!restaurantId) {
    return res.json({ jobReady: false });
  }

  const job = nextQueuedJob(serial);

  console.log('job')

  if (!job) {
    return res.json({ jobReady: false });
  }

  console.log('here')

  job.status = "offered";

  res.json({
    jobReady: true,
    jobToken: job.id,
    mediaTypes: ["text/plain"],
    deleteMethod: "DELETE",
  });
});

/** PRINTER GETS JOB DATA */
app.get("/cloudprnt", (req, res) => {
  const { token, type } = req.query;
  if (!token) return res.status(400).send("Missing token");
  if (type && type !== "text/plain") return res.status(415).send("Unsupported media type");

  const ref = jobIndex.get(String(token));
  if (!ref) return res.sendStatus(404);

  res.setHeader("Content-Type", "text/plain");
  res.send(ref.job.content);
});

/** HEALTHCHECK */
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/** PRINTER CONFIRMATION */
app.delete("/cloudprnt", (req, res) => {
  const { token, code } = req.query;
  if (!token) return res.status(400).send("Missing token");

  const codeStr = String(code || "").toUpperCase();
  const success =
    codeStr === "OK" ||
    codeStr === "200 OK" ||
    codeStr === "200" ||
    codeStr.startsWith("2");

  if (success) {
    removeJob(String(token));
  } else {
    requeueJob(String(token));
  }
  res.sendStatus(200);
});

app.listen(8080, () => console.log("CloudPRNT server running on :8080"));
