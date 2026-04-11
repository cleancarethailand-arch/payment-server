const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
const QRCode = require("qrcode");

const app = express();
app.use(express.json());
app.use(cors());

// ================= SCB Mae Manee Configuration =================
const SCB_CONFIG = {
  apiKey: "l766762dcf740d445b8392b0379b368d39",
  apiSecret: "7779eeb12f6b4fd7bfeb5a809103b8ef",
  billerId: "014000009602327",              // 🔴 รหัสร้านค้าใหม่
  merchantId: "249209341376854",
  terminalId: "476454428917361",
  walletId: "014033139550354",
  citizenId: "7694554531712",
  baseURL: "https://api-sandbox.partners.scb/partners/sandbox/v1"
};

let payments = {};
let scb_access_token = null;
let token_expiry = 0;

// ================= Get SCB Access Token =================
async function getSCBAccessToken() {
  if (scb_access_token && Date.now() < token_expiry) {
    return scb_access_token;
  }

  try {
    const stringToSign = `${SCB_CONFIG.apiKey}|${Date.now()}`;
    const signature = crypto
      .createHmac("sha256", SCB_CONFIG.apiSecret)
      .update(stringToSign)
      .digest("base64");

    const response = await axios.post(
      `${SCB_CONFIG.baseURL}/oauth/token`,
      {
        applicationKey: SCB_CONFIG.apiKey,
        applicationSecret: SCB_CONFIG.apiSecret
      },
      {
        headers: {
          "Content-Type": "application/json",
          "resourceOwnerId": SCB_CONFIG.apiKey,
          "requestUId": crypto.randomUUID(),
          "signature": signature
        }
      }
    );

    scb_access_token = response.data.data.accessToken;
    token_expiry = Date.now() + (response.data.data.expiresIn * 1000);
    
    console.log("✅ SCB Access Token obtained");
    return scb_access_token;
  } catch (error) {
    console.error("❌ Failed to get SCB token:", error.response?.data || error.message);
    throw error;
  }
}

// ================= สร้าง QR Code ผ่าน SCB Mae Manee =================
app.post("/api/create-qr", async (req, res) => {
  try {
    const { amount, currency = "THB", reference = "" } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid amount" 
      });
    }

    console.log(`📱 Creating SCB Mae Manee QR for amount: ${amount} THB`);

    const transactionId = `TXN${Date.now()}${Math.floor(Math.random() * 10000)}`;
    
    const token = await getSCBAccessToken();
    
    // ใช้ Biller ID แทน Merchant ID
    const qrPayload = {
      billerId: SCB_CONFIG.billerId,        // 🔴 ใช้รหัสร้านค้า
      amount: amount.toString(),
      transactionId: transactionId,
      qrType: "PP",
      callbackUrl: "https://payment-server-jydm.onrender.com/webhook/scb",
      reference: reference
    };
    
    console.log("📤 QR Payload:", JSON.stringify(qrPayload, null, 2));
    
    const response = await axios.post(
      `${SCB_CONFIG.baseURL}/payment/qr30/create`,
      qrPayload,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "requestUId": crypto.randomUUID()
        }
      }
    );
    
    const qrRawData = response.data.data.qrRawData;
    console.log("✅ QR Raw Data received");
    
    const qrDataUrl = await QRCode.toDataURL(qrRawData, {
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#FFFFFF' }
    });
    
    const qrBase64 = qrDataUrl.split(',')[1];
    
    payments[transactionId] = {
      status: "pending",
      amount: amount,
      createdAt: Date.now(),
      dispensed: false,
      scbTransactionId: response.data.data.transactionId
    };

    console.log(`🆕 Created transaction: ${transactionId} (${amount}฿)`);

    res.json({
      success: true,
      transaction_id: transactionId,
      qr_image: qrBase64,
      amount: amount
    });

  } catch (error) {
    console.error("❌ Create QR error:", error.response?.data || error.message);
    res.status(500).json({ 
      success: false, 
      message: "Failed to create QR code",
      error: error.response?.data || error.message
    });
  }
});

// ================= Webhook =================
app.post("/webhook/scb", (req, res) => {
  try {
    const webhookData = req.body;
    console.log("📞 SCB Webhook received:", JSON.stringify(webhookData, null, 2));

    const transactionId = webhookData.transactionId || webhookData.data?.transactionId;
    
    if (transactionId && payments[transactionId]) {
      payments[transactionId].status = "paid";
      payments[transactionId].paidAt = Date.now();
      console.log(`💰 PAID: ${transactionId}`);
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

// ================= Mock Pay =================
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
      <title>SCB Mae Manee Payment</title>
      <style>
        body { font-family: Arial; margin: 20px; background: #f5f5f5; }
        .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: white; padding: 20px; border-radius: 10px; text-align: center; }
        .stat-value { font-size: 32px; font-weight: bold; color: #667eea; }
        table { width: 100%; background: white; border-collapse: collapse; border-radius: 10px; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background: #667eea; color: white; }
      </style>
    </head>
    <body>
      <h1>💰 SCB Mae Manee Payment Server</h1>
      <p>🔧 Status: ✅ Online | 🏦 Mode: SCB (Biller ID: ${SCB_CONFIG.billerId})</p>
      <div class="stats">
        <div class="stat-card"><div>Total</div><div class="stat-value">${stats.total}</div></div>
        <div class="stat-card"><div>Paid</div><div class="stat-value" style="color:#4CAF50;">${stats.paid}</div></div>
        <div class="stat-card"><div>Pending</div><div class="stat-value" style="color:#FF9800;">${stats.pending}</div></div>
        <div class="stat-card"><div>Revenue</div><div class="stat-value">${stats.totalAmount} ฿</div></div>
      </div>
      <h3>📋 Transactions</h3>
      <table><thead><tr><th>ID</th><th>Amount</th><th>Status</th><th>Created</th><th>Action</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">No transactions</td></tr>'}</tbody></table>
    </body>
    </html>
  `);
});

app.get("/", (req, res) => res.redirect("/dashboard"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`🚀 SCB Mae Manee Server`);
  console.log(`📍 http://localhost:${PORT}`);
  console.log(`🏦 Biller ID: ${SCB_CONFIG.billerId}`);
  console.log(`========================================\n`);
});
