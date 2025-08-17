import express from "express";
const app = express();
app.use(express.json());

let jobQueue = []; // [{id, content, status:'queued'|'offered'}]

app.post("/api/print", (req, res) => {
  jobQueue.push({
    id: Date.now().toString(),
    content: "Hello from CloudPRNT!\n\n",
    status: "queued",
  });
  res.json({ ok: true, size: jobQueue.length });
});

// PRINTER POLL: POST /cloudprnt
app.post("/cloudprnt", (req, res) => {
  // Find first job not yet offered
  const job = jobQueue.find(j => j.status === "queued");
  if (!job) return res.json({ jobReady: false });

  // Mark as offered so we don't hand it out again until confirmation
  job.status = "offered";

  res.json({
    jobReady: true,
    jobToken: job.id,
    mediaTypes: ["text/plain"], // must match what we serve below
    deleteMethod: "DELETE",     // printer will DELETE this same URL to confirm
  });
});

// PRINTER GETS JOB: GET /cloudprnt?uid=&type=text/plain&mac=&token=
app.get("/cloudprnt", (req, res) => {
  const { token, type } = req.query;
  if (!token) return res.status(400).send("Missing token");
  if (type && type !== "text/plain") return res.status(415).send("Unsupported media type");

  const job = jobQueue.find(j => j.id === token);
  if (!job) return res.sendStatus(404);

  res.setHeader("Content-Type", "text/plain");
  res.send(job.content);
});

// PRINTER CONFIRMS: DELETE /cloudprnt?code=OK&uid=&mac=&token=
app.delete("/cloudprnt", (req, res) => {
  const { token, code } = req.query;
  if (!token) return res.status(400).send("Missing token");
  // On success, remove the job. On failure, requeue it.
  if (code === "OK") {
    jobQueue = jobQueue.filter(j => j.id !== token);
  } else {
    const job = jobQueue.find(j => j.id === token);
    if (job) job.status = "queued";
  }
  res.sendStatus(200);
});

app.listen(8080, () => console.log("CloudPRNT server running on :8080"));
