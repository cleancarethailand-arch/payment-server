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

// ================= TEST PAYMENT =================
app.get("/pay", (req, res) => {
  const id = req.query.id;

  if (!id) {
    return res.status(400).send("Missing id");
  }

  if (payments[id]) {
    payments[id].status = "paid";
    payments[id].paidAt = Date.now();

    console.log(`💰 PAID: ${id}`);

    res.send(`Payment Success for ${id}`);
  } else {
    console.log(`❌ NOT FOUND (pay): ${id}`);
    res.status(404).send("Transaction not found");
  }
});

// ================= CHECK PAYMENT =================
app.get("/check-payment", (req, res) => {
  const id = req.query.id;

  if (!id) {
    return res.status(400).json({ error: "missing id" });
  }

  if (!payments[id]) {
    return res.status(404).json({
      status: "notfound",
      id: id,
      all_ids: Object.keys(payments) // 🔥 debug สำคัญ
    });
  }

  res.json({
    id: id,
    status: payments[id].status,
    amount: payments[id].amount,
    dispensed: payments[id].dispensed
  });
});

// ================= CONFIRM DISPENSE =================
app.post("/confirm-dispense", (req, res) => {
  const { id } = req.body;

  if (payments[id]) {
    payments[id].dispensed = true;
    payments[id].dispenseAt = Date.now();

    console.log(`⚙️ DISPENSED: ${id}`);

    res.json({ success: true });
  } else {
    res.json({ success: false });
  }
});

// ================= WEBHOOK PAYMENT =================
app.post("/webhook/payment", (req, res) => {
  const { transaction_id, status, amount, reference } = req.body;

  console.log("[WEBHOOK] Received:", req.body);

  if (!transaction_id) {
    return res.status(400).json({ error: "Missing transaction_id" });
  }

  if (payments[transaction_id]) {
    payments[transaction_id].status =
      status === "success" ? "paid" : "failed";

    payments[transaction_id].webhookReceivedAt = Date.now();
    payments[transaction_id].reference = reference;

    console.log(`✅ UPDATED: ${transaction_id} -> ${status}`);
  } else {
    payments[transaction_id] = {
      status: status === "success" ? "paid" : "failed",
      amount: amount,
      createdAt: Date.now(),
      webhookReceivedAt: Date.now(),
      reference: reference,
      dispensed: false
    };

    console.log(`🆕 CREATED FROM WEBHOOK: ${transaction_id}`);
  }

  res.json({ received: true });
});

// ================= ADMIN =================
app.get("/admin/transactions", (req, res) => {
  res.json(payments);
});

// ================= CLEANUP =================
app.post("/admin/cleanup", (req, res) => {
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
