const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
const QRCode = require("qrcode");

const app = express();
app.use(express.json());
app.use(cors());

// ================= SCB Configuration =================
const SCB_CONFIG = {
  apiKey: "l766762dcf740d445b8392b0379b368d39",
  apiSecret: "7779eeb12f6b4fd7bfeb5a809103b8ef",
  merchantId: "249209341376854",      // จาก Merchant Information
  terminalId: "476454428917361",      // จาก Terminal ID
  walletId: "014033139550354",        // จาก Mae Manee Merchant Profile
  citizenId: "7694554531712",         // จาก Citizen ID
  baseURL: "https://api-sandbox.partners.scb/partners/sandbox/v1"
};

let payments = {};
let scb_access_token = null;
let token_expiry = 0;

// ================= Helper Functions =================
function getLocalIP() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

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

// ================= สร้าง QR Code ผ่าน SCB Mae Manee API =================
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
    
    // 1. ขอ Access Token ก่อน
    const token = await getSCBAccessToken();
    
    // 2. สร้าง QR Code ผ่าน Mae Manee API
    const qrPayload = {
      merchantId: SCB_CONFIG.merchantId,
      terminalId: SCB_CONFIG.terminalId,
      walletId: SCB_CONFIG.walletId,
      amount: amount.toString(),
      transactionId: transactionId,
      qrType: "PP",  // PromptPay QR
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
    console.log("✅ QR Raw Data received, length:", qrRawData?.length);
    
    // 3. สร้าง QR Image จาก qrRawData
    const qrDataUrl = await QRCode.toDataURL(qrRawData, {
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#FFFFFF' }
    });
    
    const qrBase64 = qrDataUrl.split(',')[1];
    
    // 4. เก็บข้อมูล transaction
    payments[transactionId] = {
      status: "pending",
      amount: amount,
      currency: currency,
      createdAt: Date.now(),
      reference: reference,
      dispensed: false,
      qrRawData: qrRawData,
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

// ================= Webhook สำหรับ SCB Callback =================
app.post("/webhook/scb", (req, res) => {
  try {
    const webhookData = req.body;
    console.log("📞 SCB Webhook received:", JSON.stringify(webhookData, null, 2));

    const transactionId = webhookData.transactionId || webhookData.data?.transactionId;
    const paymentStatus = webhookData.status || webhookData.data?.status;
    
    if (transactionId && payments[transactionId]) {
      if (paymentStatus === "SUCCESS" || paymentStatus === "PAID") {
        payments[transactionId].status = "paid";
        payments[transactionId].paidAt = Date.now();
        console.log(`💰 PAID (webhook): ${transactionId}`);
      }
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Webhook error:", error);
    res.status(200).send("OK");
  }
});

// ================= ตรวจสอบสถานะการชำระเงิน =================
app.get("/api/check-payment", async (req, res) => {
  const transactionId = req.query.transaction_id;

  if (!transactionId) {
    return res.status(400).json({ 
      success: false, 
      message: "Missing transaction_id" 
    });
  }

  console.log(`🔍 Checking payment: ${transactionId}`);

  if (!payments[transactionId]) {
    return res.json({
      success: true,
      status: "pending",
      transaction_id: transactionId,
      amount: 0
    });
  }

  const payment = payments[transactionId];

  if (payment.status === "paid") {
    return res.json({
      success: true,
      status: "paid",
      transaction_id: transactionId,
      amount: payment.amount
    });
  }

  // ตรวจสอบกับ SCB API
  try {
    const token = await getSCBAccessToken();
    
    const response = await axios.get(
      `${SCB_CONFIG.baseURL}/payment/${payment.scbTransactionId}`,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "requestUId": crypto.randomUUID()
        }
      }
    );

    const scbStatus = response.data.data.status;
    
    if (scbStatus === "SUCCESS" || scbStatus === "PAID") {
      payment.status = "paid";
      payment.paidAt = Date.now();
      console.log(`💰 PAID (check): ${transactionId}`);
    }
  } catch (error) {
    console.error("❌ Check payment error:", error.response?.data || error.message);
  }

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
    return res.status(404).send(`
      <html><body style="text-align:center;padding:50px;">
        <h1>❌ Transaction Not Found</h1>
        <p>ID: ${id}</p>
        <button onclick="window.close()">Close</button>
      </body></html>
    `);
  }

  payments[id].status = "paid";
  payments[id].paidAt = Date.now();

  console.log(`💰 MOCK PAID: ${id} (${payments[id].amount} THB)`);

  res.send(`
    <html>
      <head>
        <style>
          body {
            font-family: Arial, sans-serif;
            text-align: center;
            padding: 50px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
          }
          .success-box {
            background: rgba(255,255,255,0.2);
            padding: 30px;
            border-radius: 20px;
            display: inline-block;
          }
          button {
            background: white;
            border: none;
            padding: 10px 30px;
            font-size: 18px;
            border-radius: 25px;
            margin-top: 20px;
            cursor: pointer;
            color: #667eea;
            font-weight: bold;
          }
        </style>
      </head>
      <body>
        <div class="success-box">
          <h1>✅ Payment Success (Mock)</h1>
          <p>Transaction ID: ${id}</p>
          <p>Amount: ${payments[id].amount} THB</p>
          <button onclick="window.close()">Close Window</button>
        </div>
        <script>setTimeout(() => window.close(), 3000);</script>
      </body>
    </html>
  `);
});

// ================= Dashboard =================
app.get("/dashboard", (req, res) => {
  const stats = {
    total: Object.keys(payments).length,
    paid: Object.values(payments).filter(p => p.status === "paid").length,
    pending: Object.values(payments).filter(p => p.status === "pending").length,
    dispensed: Object.values(payments).filter(p => p.dispensed).length,
    totalAmount: Object.values(payments).reduce((sum, p) => sum + p.amount, 0)
  };
  
  const transactions = Object.entries(payments)
    .sort((a, b) => b[1].createdAt - a[1].createdAt)
    .map(([id, data]) => `
      <tr>
        <td>${id}</td>
        <td>${data.amount} THB</td>
        <td style="color:${data.status === 'paid' ? 'green' : 'orange'}">${data.status}</td>
        <td>${new Date(data.createdAt).toLocaleString('th-TH')}</td>
        <td>${data.paidAt ? new Date(data.paidAt).toLocaleString('th-TH') : '-'}</td>
        <td>${data.status === 'pending' ? `<a href="/mock-pay/${id}" style="background:#4CAF50;color:white;padding:5px 10px;text-decoration:none;border-radius:5px;">💰 Mock Pay</a>` : (data.dispensed ? '✓' : '-')}</td>
      </tr>
    `).join('');
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>CleanCare - SCB Mae Manee Payment</title>
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
      </style>
    </head>
    <body>
      <h1>💰 CleanCare - SCB Mae Manee Payment</h1>
      <p>🔧 Status: ✅ Online | 🏦 Mode: <strong>SCB Mae Manee (Sandbox)</strong></p>
      <p>📱 PromptPay ID: ${SCB_CONFIG.citizenId}</p>
      
      <div class="stats">
        <div class="stat-card"><div>Total</div><div class="stat-value">${stats.total}</div></div>
        <div class="stat-card"><div>Paid</div><div class="stat-value" style="color:#4CAF50;">${stats.paid}</div></div>
        <div class="stat-card"><div>Pending</div><div class="stat-value" style="color:#FF9800;">${stats.pending}</div></div>
        <div class="stat-card"><div>Revenue</div><div class="stat-value">${stats.totalAmount} ฿</div></div>
      </div>
      
      <h3>📋 Transactions</h3>
      <table>
        <thead><tr><th>ID</th><th>Amount</th><th>Status</th><th>Created</th><th>Paid At</th><th>Action</th></tr></thead>
        <tbody>${transactions || '<tr><td colspan="6">No transactions yet</td></tr>'}</tbody>
      </table>
    </body>
    </html>
  `);
});

// ================= Health Check =================
app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    uptime: process.uptime(), 
    mode: "SCB Mae Manee",
    token_valid: scb_access_token ? Date.now() < token_expiry : false
  });
});

// ================= Root Redirect =================
app.get("/", (req, res) => {
  res.redirect("/dashboard");
});

// ================= Start Server =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`🚀 CleanCare - SCB Mae Manee Server`);
  console.log(`========================================`);
  console.log(`📍 Local: http://localhost:${PORT}`);
  console.log(`📍 Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`🏦 Mode: SCB Mae Manee (Sandbox)`);
  console.log(`📱 PromptPay ID: ${SCB_CONFIG.citizenId}`);
  console.log(`🆔 Merchant ID: ${SCB_CONFIG.merchantId}`);
  console.log(`========================================\n`);
});

// ================= Auto Cleanup (every 10 minutes) =================
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [id, data] of Object.entries(payments)) {
    if (data.status === "pending" && now - data.createdAt > 10 * 60 * 1000) {
      delete payments[id];
      removed++;
    }
    if (data.status === "paid" && data.dispensed && now - data.dispensedAt > 60 * 60 * 1000) {
      delete payments[id];
      removed++;
    }
  }
  if (removed > 0) console.log(`🧹 Cleaned up ${removed} old transactions`);
}, 10 * 60 * 1000);
