import express from "express";
const app = express();
app.use(express.json());

let jobQueue = [];

app.post("/api/print", (req, res) => {
  jobQueue.push({ id: Date.now().toString(), content: "Hello from CloudPRNT!\n\n" });
  res.json({ ok: true, size: jobQueue.length });
});

// POLL: printer POSTs here regularly
app.post("/cloudprnt", (req, res) => {
  console.log("POLL", req.body); // shows status, printerMAC, etc.
  const job = jobQueue[0];
  if (!job) return res.json({ jobReady: false });

  // Offer only types you can actually return on GET
  res.json({
    jobReady: true,
    jobToken: job.id,
    mediaTypes: ["text/plain"],  // printer will request type=text/plain
    deleteMethod: "DELETE"
  });
});

// GET JOB: printer GETs same URL with ?uid=&type=&mac=&token=
app.get("/cloudprnt", (req, res) => {
  const { token, type } = req.query;
  const job = jobQueue.find(j => j.id === token) || jobQueue[0];
  if (!job) return res.sendStatus(404);

  if (type && type !== "text/plain") return res.status(415).send("Unsupported media type");
  res.setHeader("Content-Type", "text/plain");
  res.send(job.content);
});

// CONFIRM: printer DELETEs same URL with ?code=OK&uid=&mac=&token=
app.delete("/cloudprnt", (req, res) => {
  const { token, code } = req.query;
  if (code === "OK" && token) jobQueue = jobQueue.filter(j => j.id !== token);
  res.sendStatus(200);
});

app.listen(8080, () => console.log("CloudPRNT server running on :8080"));
