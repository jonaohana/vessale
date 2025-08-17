// const fs = require('fs');
// const ipp = require('ipp');

// const pdfBuffer = fs.readFileSync('./dasauto.pdf'); // Use a real PDF file
// const printer = ipp.Printer('http://192.168.6.70:631/ipp');

// const msg = {
//   'operation-attributes-tag': {
//     'requesting-user-name': 'NodeUser',
//     'job-name': 'Test Print PDF',
//     'document-format': 'application/pdf' // important!
//   },
//   data: pdfBuffer
// };

// printer.execute('Print-Job', msg, (err, res) => {
//   if (err) {
//     console.error('Print error:', err);
//   } else {
//     console.log('Print job response:', res);
//   }
// });

import express from "express";
const app = express();
app.use(express.json());

let jobQueue = []; // naive in-memory queue

// Your web app adds jobs here
app.post("/api/print", (req, res) => {
  jobQueue.push({
    id: Date.now().toString(),
    content: "Hello from CloudPRNT!\n\n"
  });
  res.json({ok:true});
});

// Printer polls here
app.post("/cloudprnt", (req, res) => {
  const job = jobQueue[0];
  if (!job) return res.json({ jobReady: false });
  res.json({
    jobReady: true,
    jobToken: job.id,
    mediaTypes: ["text/plain"],
    deleteMethod: "DELETE"
  });
});

// Printer requests the job
app.get("/cloudprnt/job", (req, res) => {
  const { token } = req.query;
  const job = jobQueue.find(j => j.id === token);
  if (!job) return res.sendStatus(404);
  res.setHeader("Content-Type", "text/plain");
  res.send(job.content);
});

// Printer confirms completion
app.delete("/cloudprnt/confirm", (req, res) => {
  const { token } = req.query;
  jobQueue = jobQueue.filter(j => j.id !== token);
  res.sendStatus(200);
});

app.listen(8080, () => console.log("CloudPRNT server running on :8080"));
