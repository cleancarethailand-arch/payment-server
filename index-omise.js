const express = require("express");
const cors = require("cors");
const axios = require("axios");
const omise = require("omise")({
  secretKey: "skey_test_679dqby6nwdoefchvos",
  omiseVersion: "2019-05-29"
});

const app = express();
app.use(express.json());
app.use(cors());

let payments = {};

// ================= สร้าง QR Code =================
app.post("/api/create-qr", async (req, res) => {
  try {
    const { amount } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount" });
    }

    console.log(`📱 Creating QR for: ${amount} THB`);

    const transactionId = `TXN${Date.now()}${Math.floor(Math.random() * 10000)}`;
    
    const charge = await omise.charges.create({
      amount: amount * 100,
      currency: "thb",
      source: { type: "promptpay" },
      metadata: { transaction_id: transactionId }
    });

    const qrCodeUrl = charge.source.scannable_code.image.download_uri;
    const qrImageResponse = await axios.get(qrCodeUrl, { responseType: "arraybuffer" });
    const qrBase64 = Buffer.from(qrImageResponse.data).toString("base64");

    payments[transactionId] = {
      status: "pending",
      amount: amount,
      createdAt: Date.now(),
      chargeId: charge.id,
      dispensed: false
    };

    res.json({
      success: true,
      transaction_id: transactionId,
      qr_image: qrBase64,
      amount: amount
    });

  } catch (error) {
    console.error("❌ Error:", error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ================= Webhook =================
app.post("/webhook/omise", (req, res) => {
  try {
    const chargeId = req.body.data?.id;
    const status = req.body.data?.status;
    
    if (status === "successful" && chargeId) {
      for (const [txId, data] of Object.entries(payments)) {
        if (data.chargeId === chargeId) {
          payments[txId].status = "paid";
          payments[txId].paidAt = Date.now();
          console.log(`💰 PAID: ${txId}`);
          break;
        }
      }
    }
    res.status(200).send("OK");
  } catch (error) {
    res.status(200).send("OK");
  }
});

// ================= ตรวจสอบสถานะ =================
app.get("/api/check-payment", (req, res) => {
  const transactionId = req.query.transaction_id;
  if (!transactionId || !payments[transactionId]) {
    return res.json({ status: "pending", amount: 0 });
  }
  res.json({
    status: payments[transactionId].status,
    amount: payments[transactionId].amount
  });
});

// ================= ยืนยันจ่ายน้ำยา =================
app.post("/api/confirm-dispense", (req, res) => {
  const { transaction_id } = req.body;
  if (transaction_id && payments[transaction_id]) {
    payments[transaction_id].dispensed = true;
    console.log(`✅ Dispensed: ${transaction_id}`);
  }
  res.json({ success: true });
});

// ================= Mock Pay (ทดสอบ) =================
app.get("/mock-pay/:id", (req, res) => {
  const id = req.params.id;
  if (payments[id]) {
    payments[id].status = "paid";
    payments[id].paidAt = Date.now();
    console.log(`💰 MOCK PAID: ${id}`);
  }
  res.send(`<h1>✅ Paid: ${id}</h1><script>setTimeout(()=>window.close(),2000);</script>`);
});

// ================= Dashboard =================
app.get("/dashboard", (req, res) => {
  const stats = {
    total: Object.keys(payments).length,
    paid: Object.values(payments).filter(p => p.status === "paid").length,
    pending: Object.values(payments).filter(p => p.status === "pending").length,
    totalAmount: Object.values(payments).reduce((sum, p) => sum + p.amount, 0)
  };
  
  const rows = Object.entries(payments)
    .sort((a, b) => b[1].createdAt - a[1].createdAt)
    .map(([id, data]) => `
      <tr>
        <td>${id}</td>
        <td>${data.amount} ฿</td>
        <td style="color:${data.status === 'paid' ? 'green' : 'orange'}">${data.status}</td>
        <td>${new Date(data.createdAt).toLocaleString('th-TH')}</td>
        <td>${data.status === 'pending' ? `<a href="/mock-pay/${id}" style="background:#4CAF50;color:white;padding:5px 10px;text-decoration:none;border-radius:5px;">💰 Mock Pay</a>` : '✓'}</td>
      </tr>
    `).join('');
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>CleanCare Payment Server</title>
      <style>
        body { font-family: Arial; margin: 20px; background: #f5f5f5; }
        h1 { color: #333; }
        .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: white; padding: 20px; border-radius: 10px; text-align: center; }
        .stat-value { font-size: 32px; font-weight: bold; color: #667eea; }
        table { width: 100%; background: white; border-collapse: collapse; border-radius: 10px; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background: #667eea; color: white; }
      </style>
    </head>
    <body>
      <h1>💰 CleanCare Payment Server (Omise + PromptPay)</h1>
      <p>🔧 Status: ✅ Online | 🔑 Mode: Omise</p>
      <div class="stats">
        <div class="stat-card"><div>Total</div><div class="stat-value">${stats.total}</div></div>
        <div class="stat-card"><div>Paid</div><div class="stat-value" style="color:#4CAF50;">${stats.paid}</div></div>
        <div class="stat-card"><div>Pending</div><div class="stat-value" style="color:#FF9800;">${stats.pending}</div></div>
        <div class="stat-card"><div>Revenue</div><div class="stat-value">${stats.totalAmount} ฿</div></div>
      </div>
      <h3>📋 Transactions</h3>
      <table><thead><tr><th>ID</th><th>Amount</th><th>Status</th><th>Created</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No transactions</td></tr>'}</tbody></table>
    </body>
    </html>
  `);
});

app.get("/", (req, res) => res.redirect("/dashboard"));
app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`🚀 CleanCare Payment Server (Omise)`);
  console.log(`📍 http://localhost:${PORT}`);
  console.log(`========================================\n`);
});