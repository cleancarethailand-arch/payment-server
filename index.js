const express = require("express");

const app = express();
app.use(express.json());

let payments = {};

// ================= ROOT =================
app.get("/", (req, res) => {
  res.send("Payment Server is running 🚀");
});

// ================= CREATE PAYMENT =================
app.get("/create-payment", (req, res) => {
  const amount = parseInt(req.query.amount || 0);

  const id = Date.now().toString();

  payments[id] = {
    status: "pending",
    amount: amount,
    createdAt: Date.now(),
    dispensed: false
  };

  console.log(`🆕 CREATE: ${id} (${amount}฿)`);

  const qrPayload = `https://payment-server-jydm.onrender.com/pay?id=${id}`;

  res.json({
    id,
    amount,
    qr: qrPayload,
    status: "pending"
  });
});

// ================= PAY =================
app.get("/pay", (req, res) => {
  const id = req.query.id;

  if (!id) {
    return res.send("Missing id");
  }

  // 🔥 กันพัง: ถ้าไม่เจอ → สร้างให้เลย
  if (!payments[id]) {
    console.log(`⚠️ AUTO CREATE (pay): ${id}`);

    payments[id] = {
      status: "paid",
      amount: 0,
      createdAt: Date.now(),
      paidAt: Date.now(),
      dispensed: false
    };

    return res.send(`Payment Success (auto-created) ${id}`);
  }

  payments[id].status = "paid";
  payments[id].paidAt = Date.now();

  console.log(`💰 PAID: ${id}`);

  res.send(`Payment Success for ${id}`);
});

// ================= CHECK PAYMENT =================
app.get("/check-payment", (req, res) => {
  const id = req.query.id;

  if (!id) {
    return res.json({
      status: "pending",
      amount: 0,
      dispensed: false
    });
  }

  // 🔥 สำคัญมาก: ห้าม 404
  if (!payments[id]) {
    console.log(`⚠️ CHECK not found: ${id}`);

    return res.json({
      id: id,
      status: "pending",
      amount: 0,
      dispensed: false
    });
  }

  res.json({
    id,
    status: payments[id].status,
    amount: payments[id].amount,
    dispensed: payments[id].dispensed
  });
});

// ================= CONFIRM DISPENSE =================
app.post("/confirm-dispense", (req, res) => {
  const { id } = req.body;

  if (!payments[id]) {
    return res.json({ success: false });
  }

  payments[id].dispensed = true;
  payments[id].dispenseAt = Date.now();

  console.log(`⚙️ DISPENSED: ${id}`);

  res.json({ success: true });
});

// ================= DEBUG =================
app.get("/debug", (req, res) => {
  res.json(payments);
});

// ================= CLEANUP =================
app.post("/cleanup", (req, res) => {
  const now = Date.now();
  let removed = 0;

  for (const [id, data] of Object.entries(payments)) {
    if (
      data.status === "pending" &&
      now - data.createdAt > 10 * 60 * 1000
    ) {
      delete payments[id];
      removed++;
    }
  }

  res.json({
    removed,
    remaining: Object.keys(payments).length
  });
});

// ================= START =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
