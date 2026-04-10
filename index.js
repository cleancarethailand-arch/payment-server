const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");
const omise = require("omise")({
  secretKey: "skey_test_679dqby6nwdoefchvos", // 🔴 ใส่ Secret Key ของคุณ
  omiseVersion: "2019-05-29"
});

const app = express();
app.use(express.json());
app.use(cors());

let payments = {};

// ================= สร้าง QR Code ผ่าน Omise =================
app.post("/api/create-qr", async (req, res) => {
  try {
    const { amount, currency = "THB", reference = "" } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid amount" 
      });
    }

    console.log(`📱 Creating Omise QR for amount: ${amount} THB`);

    const transactionId = `TXN${Date.now()}${Math.floor(Math.random() * 10000)}`;
    
    // สร้าง Charge ผ่าน Omise
    const charge = await omise.charges.create({
      amount: amount * 100, // Omise ใช้หน่วยสตางค์
      currency: "thb",
      source: { type: "promptpay" },
      metadata: {
        transaction_id: transactionId,
        reference: reference
      }
    });

    console.log("✅ Charge created:", charge.id);
    
    // ดึง QR Code URL จาก Omise
    const qrCodeUrl = charge.source.scannable_code.image.download_uri;
    
    // ดาวน์โหลด QR Code image
    const axios = require("axios");
    const qrImageResponse = await axios.get(qrCodeUrl, { responseType: "arraybuffer" });
    const qrBase64 = Buffer.from(qrImageResponse.data).toString("base64");

    // เก็บข้อมูล transaction
    payments[transactionId] = {
      status: "pending",
      amount: amount,
      currency: currency,
      createdAt: Date.now(),
      chargeId: charge.id,
      reference: reference,
      dispensed: false
    };

    console.log(`🆕 Created transaction: ${transactionId} (${amount}฿)`);

    res.json({
      success: true,
      transaction_id: transactionId,
      qr_image: qrBase64,
      charge_id: charge.id,
      amount: amount
    });

  } catch (error) {
    console.error("❌ Create QR error:", error.message);
    res.status(500).json({ 
      success: false, 
      message: "Failed to create QR code",
      error: error.message
    });
  }
});

// ================= Webhook สำหรับ Omise Callback =================
app.post("/webhook/omise", (req, res) => {
  try {
    const webhookData = req.body;
    console.log("📞 Omise Webhook received:", JSON.stringify(webhookData, null, 2));

    const chargeId = webhookData.data?.id;
    const status = webhookData.data?.status;
    
    if (status === "successful" && chargeId) {
      // หา transaction จาก chargeId
      let foundTx = null;
      for (const [txId, data] of Object.entries(payments)) {
        if (data.chargeId === chargeId) {
          foundTx = txId;
          break;
        }
      }
      
      if (foundTx && payments[foundTx]) {
        payments[foundTx].status = "paid";
        payments[foundTx].paidAt = Date.now();
        console.log(`💰 PAID (webhook): ${foundTx} (Charge: ${chargeId})`);
      }
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Webhook error:", error);
    res.status(200).send("OK");
  }
});

// ================= ตรวจสอบสถานะ =================
app.get("/api/check-payment", (req, res) => {
  const transactionId = req.query.transaction_id;

  if (!transactionId) {
    return res.status(400).json({ 
      success: false, 
      message: "Missing transaction_id" 
    });
  }

  if (!payments[transactionId]) {
    return res.json({
      success: true,
      status: "pending",
      transaction_id: transactionId,
      amount: 0
    });
  }

  const payment = payments[transactionId];

  res.json({
    success: true,
    status: payment.status,
    transaction_id: transactionId,
    amount: payment.amount
  });
});

// ================= ยืนยันการจ่ายน้ำยา =================
app.post("/api/confirm-dispense", (req, res) => {
  const { transaction_id } = req.body;

  if (!transaction_id || !payments[transaction_id]) {
    return res.json({ 
      success: false, 
      message: "Transaction not found" 
    });
  }

  payments[transaction_id].dispensed = true;
  payments[transaction_id].dispensedAt = Date.now();

  console.log(`✅ Dispensed confirmed: ${transaction_id}`);

  res.json({ 
    success: true, 
    message: "Dispense confirmed" 
  });
});

// ================= Mock Payment (สำหรับทดสอบ) =================
app.get("/mock-pay/:id", (req, res) => {
  const id = req.params.id;

  if (!payments[id]) {
    return res.status(404).send(`<h1>❌ Transaction Not Found</h1><p>ID: ${id}</p>`);
  }

  payments[id].status = "paid";
  payments[id].paidAt = Date.now();

  console.log(`💰 MOCK PAID: ${id} (${payments[id].amount} THB)`);

  res.send(`
    <html><body style="text-align:center;padding:50px;">
      <h1>✅ Payment Success (Mock)</h1>
      <p>Transaction ID: ${id}</p>
      <p>Amount: ${payments[id].amount} THB</p>
      <button onclick="window.close()">Close</button>
      <script>setTimeout(()=>window.close(),3000);</script>
    </body></html>
  `);
});

// ================= Dashboard =================
app.get("/dashboard", (req, res) => {
  const stats = {
    total: Object.keys(payments).length,
    paid: 0,
    pending: 0,
    dispensed: 0,
    totalAmount: 0
  };
  
  const transactions = [];
  
  for (const [id, data] of Object.entries(payments)) {
    if (data.status === "paid") stats.paid++;
    if (data.status === "pending") stats.pending++;
    if (data.dispensed) stats.dispensed++;
    stats.totalAmount += data.amount;
    
    transactions.push({
      id: id,
      status: data.status,
      amount: data.amount,
      createdAt: new Date(data.createdAt).toLocaleString('th-TH'),
      paidAt: data.paidAt ? new Date(data.paidAt).toLocaleString('th-TH') : null,
      chargeId: data.chargeId
    });
  }
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>CleanCare Payment Server (Omise)</title>
      <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        h1 { color: #333; }
        .stats {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 20px;
          margin-bottom: 30px;
        }
        .stat-card {
          background: white;
          padding: 20px;
          border-radius: 10px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          text-align: center;
        }
        .stat-value { font-size: 32px; font-weight: bold; color: #667eea; }
        table {
          width: 100%;
          background: white;
          border-collapse: collapse;
          border-radius: 10px;
          overflow: hidden;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background: #667eea; color: white; }
        .status-paid { color: green; font-weight: bold; }
        .status-pending { color: orange; font-weight: bold; }
        .mock-btn {
          background: #4CAF50;
          color: white;
          padding: 5px 10px;
          text-decoration: none;
          border-radius: 5px;
          display: inline-block;
        }
        .badge {
          background: #e0e0e0;
          padding: 2px 8px;
          border-radius: 10px;
          font-size: 11px;
          font-family: monospace;
        }
      </style>
    </head>
    <body>
      <h1>💰 CleanCare Payment Server (Omise)</h1>
      <p>🔧 Status: ✅ Online | 📡 Mode: <strong>OMISE (Auto Webhook)</strong></p>
      <p>🔑 Secret Key: skey_test_679dqb... | 📱 PromptPay QR</p>
      
      <div class="stats">
        <div class="stat-card"><div class="stat-label">Total</div><div class="stat-value">${stats.total}</div></div>
        <div class="stat-card"><div class="stat-label">Paid</div><div class="stat-value" style="color:#4CAF50;">${stats.paid}</div></div>
        <div class="stat-card"><div class="stat-label">Pending</div><div class="stat-value" style="color:#FF9800;">${stats.pending}</div></div>
        <div class="stat-card"><div class="stat-label">Revenue</div><div class="stat-value">${stats.totalAmount} ฿</div></div>
      </div>
      
      <h3>📋 Transactions</h3>
      <table>
        <thead><tr><th>ID</th><th>Amount</th><th>Status</th><th>Created</th><th>Charge ID</th><th>Action</th></tr></thead>
        <tbody>
          ${transactions.map(t => `
            <tr>
              <td>${t.id}</td><td>${t.amount} ฿</td>
              <td class="status-${t.status}">${t.status}</td>
              <td>${t.createdAt}</td>
              <td><span class="badge">${t.chargeId || '-'}</span></td>
              <td>${t.status === 'pending' ? `<a href="/mock-pay/${t.id}" class="mock-btn">💰 Test Pay</a>` : (t.dispensed ? '✓' : '-')}</td>
            </tr>
          `).join('')}
          ${transactions.length === 0 ? '<tr><td colspan="6" style="text-align:center">No transactions yet</td></tr>' : ''}
        </tbody>
      </table>
      <p style="margin-top:20px; color:#666;">📱 ตั้งค่า Webhook URL ใน Omise Dashboard: <code>https://payment-server-jydm.onrender.com/webhook/omise</code></p>
    </body>
    </html>
  `);
});

// ================= Health Check =================
app.get("/health", (req, res) => {
  res.json({ status: "healthy", uptime: process.uptime(), mode: "omise" });
});

app.get("/", (req, res) => {
  res.redirect("/dashboard");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`🚀 CleanCare Payment Server (Omise Mode)`);
  console.log(`========================================`);
  console.log(`📍 Local: http://localhost:${PORT}`);
  console.log(`📍 Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`🔑 Omise Secret Key: ${omise.secretKey.substring(0, 15)}...`);
  console.log(`========================================\n`);
});
