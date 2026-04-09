const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

// ================= SCB Configuration =================
const SCB_CONFIG = {
  apiKey: "l7fedbc78c5bc7425580e5195c4428dde4",
  apiSecret: "0f0f63bc64e342fa960cfa15afdec0b0",
  merchantID: "SANDBOX_MERCHANT_ID",
  terminalID: "SANDBOX_TERMINAL_ID",
  baseURL: "https://api-sandbox.partners.scb/partners/sandbox/v1"
};

// ================= Global Variables =================
let payments = {};
let scb_access_token = null;
let token_expiry = 0;
const useMockQR = true; // เปลี่ยนเป็น false เมื่อเชื่อมต่อ SCB จริง
//const useMockQR = false; // เปลี่ยนเป็น false เมื่อเชื่อมต่อ SCB จริง

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

// ================= Create QR Code API =================
app.post("/api/create-qr", async (req, res) => {
  try {
    const { amount, currency = "THB", reference = "" } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid amount" 
      });
    }

    console.log(`📱 Creating QR for amount: ${amount} THB`);

    const transactionId = `TXN${Date.now()}${Math.floor(Math.random() * 10000)}`;
    let qrRawData;
    
    if (useMockQR) {
      // Mock QR Data (สำหรับทดสอบ)
      qrRawData = `00020101021129370016A00000067701011101130066${transactionId}53037645804${amount}6304${Math.floor(Math.random() * 10000)}`;
    } else {
      // สร้าง QR จริงผ่าน SCB API
      const token = await getSCBAccessToken();
      
      const qrPayload = {
        qrType: "PP",
        amount: amount.toString(),
        transactionId: transactionId,
        merchantId: SCB_CONFIG.merchantID,
        terminalId: SCB_CONFIG.terminalID,
        callbackUrl: `https://payment-server-jydm.onrender.com/webhook/payment`
      };

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
      
      qrRawData = response.data.data.qrRawData;
    }

    payments[transactionId] = {
      status: "pending",
      amount: amount,
      currency: currency,
      createdAt: Date.now(),
      reference: reference,
      dispensed: false,
      qrRawData: qrRawData
    };

    console.log(`🆕 Created transaction: ${transactionId} (${amount}฿)`);

    res.json({
      success: true,
      transaction_id: transactionId,
      qr_code: qrRawData,
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

// ================= Check Payment Status API =================
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

  // ถ้าใช้ SCB จริง ให้ตรวจสอบกับ SCB API
  if (payment.status === "pending" && !useMockQR) {
    try {
      const token = await getSCBAccessToken();
      
      const response = await axios.get(
        `${SCB_CONFIG.baseURL}/payment/${transactionId}`,
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
        console.log(`💰 PAID: ${transactionId}`);
      }
    } catch (error) {
      console.error("❌ Check payment error:", error.response?.data || error.message);
    }
  }

  res.json({
    success: true,
    status: payment.status,
    transaction_id: transactionId,
    amount: payment.amount
  });
});

// ================= Confirm Dispense API =================
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

// ================= Webhook for SCB Callback =================
app.post("/webhook/payment", (req, res) => {
  try {
    const webhookData = req.body;
    console.log("📞 Webhook received:", webhookData);

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

// ================= Mock Payment (สำหรับทดสอบ) =================
app.get("/mock-pay/:id", (req, res) => {
  const id = req.params.id;

  if (!payments[id]) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Payment Error</title>
        <style>
          body {
            font-family: 'Segoe UI', Arial, sans-serif;
            text-align: center;
            padding: 50px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
          }
          .error-box {
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
        <div class="error-box">
          <h1>❌ Transaction Not Found</h1>
          <p>Transaction ID: ${id}</p>
          <button onclick="window.close()">Close Window</button>
        </div>
      </body>
      </html>
    `);
  }

  payments[id].status = "paid";
  payments[id].paidAt = Date.now();

  console.log(`💰 MOCK PAID: ${id} (${payments[id].amount} THB)`);

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>Payment Success</title>
      <style>
        body {
          font-family: 'Segoe UI', Arial, sans-serif;
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
          animation: fadeIn 0.5s ease-in;
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: scale(0.9); }
          to { opacity: 1; transform: scale(1); }
        }
        .amount {
          font-size: 36px;
          font-weight: bold;
          margin: 20px 0;
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
        button:hover {
          transform: scale(1.05);
        }
      </style>
    </head>
    <body>
      <div class="success-box">
        <h1>✅ Payment Successful!</h1>
        <p>Transaction ID:</p>
        <div class="amount">${id}</div>
        <p>Amount: ${payments[id].amount} ${payments[id].currency || 'THB'}</p>
        <p>Time: ${new Date().toLocaleString('th-TH')}</p>
        <button onclick="window.close()">Close Window</button>
      </div>
      <script>
        setTimeout(() => window.close(), 5000);
      </script>
    </body>
    </html>
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
      dispensed: data.dispensed
    });
  }
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>CleanCare Payment Server</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background: #f5f5f5;
          padding: 20px;
        }
        .container { max-width: 1400px; margin: 0 auto; }
        h1 { color: #333; margin-bottom: 20px; }
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
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          text-align: center;
        }
        .stat-label { font-size: 14px; color: #666; margin-bottom: 10px; }
        .stat-value { font-size: 32px; font-weight: bold; color: #667eea; }
        .server-status {
          background: white;
          padding: 15px 20px;
          border-radius: 10px;
          margin-bottom: 20px;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        .status-online { color: #4CAF50; font-weight: bold; }
        table {
          width: 100%;
          background: white;
          border-collapse: collapse;
          border-radius: 10px;
          overflow: hidden;
          box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        th { background: #667eea; color: white; padding: 12px; text-align: left; }
        td { padding: 12px; border-bottom: 1px solid #ddd; }
        tr:hover { background: #f9f9f9; }
        .status-paid { color: #4CAF50; font-weight: bold; }
        .status-pending { color: #FF9800; font-weight: bold; }
        .mock-btn {
          background: #4CAF50;
          color: white;
          padding: 5px 10px;
          text-decoration: none;
          border-radius: 5px;
          display: inline-block;
        }
        .mock-btn:hover { background: #45a049; }
        .refresh-btn {
          background: #667eea;
          color: white;
          border: none;
          padding: 8px 16px;
          border-radius: 5px;
          cursor: pointer;
          margin-bottom: 20px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>💰 CleanCare Payment Server</h1>
        
        <div class="server-status">
          <strong>🔧 Server Status:</strong> <span class="status-online">✅ Online</span><br>
          <strong>📡 Mode:</strong> ${useMockQR ? '🔬 MOCK MODE (Testing)' : '🏦 SCB PRODUCTION'}<br>
          <strong>⏰ Current Time:</strong> ${new Date().toLocaleString('th-TH')}
        </div>
        
        <div class="stats">
          <div class="stat-card"><div class="stat-label">Total</div><div class="stat-value">${stats.total}</div></div>
          <div class="stat-card"><div class="stat-label">Paid</div><div class="stat-value" style="color:#4CAF50;">${stats.paid}</div></div>
          <div class="stat-card"><div class="stat-label">Pending</div><div class="stat-value" style="color:#FF9800;">${stats.pending}</div></div>
          <div class="stat-card"><div class="stat-label">Dispensed</div><div class="stat-value">${stats.dispensed}</div></div>
          <div class="stat-card"><div class="stat-label">Revenue</div><div class="stat-value">${stats.totalAmount} ฿</div></div>
        </div>
        
        <button class="refresh-btn" onclick="location.reload()">🔄 Refresh</button>
        
        <h3>📋 Transactions</h3>
        <table>
          <thead><tr><th>ID</th><th>Amount</th><th>Status</th><th>Created</th><th>Paid At</th><th>Action</th></tr></thead>
          <tbody>
            ${transactions.map(t => `
              <tr>
                <td>${t.id}</td>
                <td>${t.amount} ฿</td>
                <td class="status-${t.status}">${t.status}</td>
                <td>${t.createdAt}</td>
                <td>${t.paidAt || '-'}</td>
                <td>${t.status === 'pending' ? `<a href="/mock-pay/${t.id}" class="mock-btn">💰 Mock Pay</a>` : (t.dispensed ? '✓' : '-')}</td>
              </tr>
            `).join('')}
            ${transactions.length === 0 ? '<tr><td colspan="6" style="text-align:center">No transactions yet</td></tr>' : ''}
          </tbody>
        </table>
      </div>
    </body>
    </html>
  `);
});

// ================= Cleanup API =================
app.post("/api/cleanup", (req, res) => {
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

  console.log(`🧹 Cleaned up ${removed} transactions`);
  res.json({ success: true, removed, remaining: Object.keys(payments).length });
});

// ================= Health Check =================
app.get("/health", (req, res) => {
  res.json({ status: "healthy", uptime: process.uptime(), mode: useMockQR ? "mock" : "scb" });
});

// ================= Root =================
app.get("/", (req, res) => {
  res.redirect("/dashboard");
});

// ================= Start Server =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`🚀 CleanCare Payment Server`);
  console.log(`========================================`);
  console.log(`📍 Local: http://localhost:${PORT}`);
  console.log(`📍 Network: http://${getLocalIP()}:${PORT}`);
  console.log(`📍 Dashboard: http://${getLocalIP()}:${PORT}/dashboard`);
  console.log(`📱 Mode: ${useMockQR ? 'MOCK (Testing)' : 'SCB PRODUCTION'}`);
  console.log(`========================================\n`);
});

// Auto cleanup every 10 minutes
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [id, data] of Object.entries(payments)) {
    if (data.status === "pending" && now - data.createdAt > 10 * 60 * 1000) {
      delete payments[id];
      removed++;
    }
  }
  if (removed > 0) console.log(`🧹 Auto cleanup: removed ${removed} expired transactions`);
}, 10 * 60 * 1000);
