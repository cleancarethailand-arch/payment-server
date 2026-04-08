const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors()); // เพิ่ม CORS สำหรับให้ ESP32 เข้าถึง

// ================= SCB Configuration =================
const SCB_CONFIG = {
  apiKey: "l73301f1cc935f4dfebb5486fa686e14a0",     
  apiSecret: "20cdfa2512814a90b5b53ff59f103820", 
  merchantID: "SANDBOX_MERCHANT_ID",   
  terminalID: "SANDBOX_TERMINAL_ID",   
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

// ================= Endpoint สำหรับ HMI (ESP32) =================
// สร้าง QR Code สำหรับการชำระเงิน
app.post("/api/create-qr", async (req, res) => {
  try {
    const { amount, currency = "THB", reference } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid amount" 
      });
    }

    console.log(`📱 Creating QR for amount: ${amount} THB`);

    // Generate unique transaction ID
    const transactionId = `TXN${Date.now()}${Math.floor(Math.random() * 10000)}`;
    
    // ใช้ Mock QR สำหรับทดสอบ (ถ้า SCB API ยังไม่พร้อม)
    const useMockQR = true; // เปลี่ยนเป็น false เมื่อเชื่อมต่อ SCB จริง
    
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
        callbackUrl: `${process.env.SERVER_URL || 'https://your-server.com'}/webhook/payment`
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

    // Store payment info
    payments[transactionId] = {
      status: "pending",
      amount: amount,
      createdAt: Date.now(),
      reference: reference || "",
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

// ตรวจสอบสถานะการชำระเงิน
app.get("/api/check-payment", async (req, res) => {
  const transactionId = req.query.transaction_id;

  if (!transactionId) {
    return res.status(400).json({ 
      success: false, 
      message: "Missing transaction_id" 
    });
  }

  console.log(`🔍 Checking payment: ${transactionId}`);

  // ถ้ายังไม่มี transaction ในระบบ
  if (!payments[transactionId]) {
    return res.json({
      success: true,
      status: "pending",
      transaction_id: transactionId,
      amount: 0
    });
  }

  const payment = payments[transactionId];

  // ถ้าจ่ายแล้ว
  if (payment.status === "paid") {
    return res.json({
      success: true,
      status: "paid",
      transaction_id: transactionId,
      amount: payment.amount
    });
  }

  // ถ้ายัง pending ให้ตรวจสอบกับ SCB (ถ้าใช้ SCB จริง)
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

// ยืนยันการจ่ายน้ำยาแล้ว
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

// ================= Mock Payment สำหรับทดสอบ =================
// จำลองการจ่ายเงิน (ใช้ใน Browser สำหรับทดสอบ)
app.get("/mock-pay/:id", (req, res) => {
  const id = req.params.id;

  if (!payments[id]) {
    return res.status(404).send(`
      <html>
        <body>
          <h1>❌ Payment Not Found</h1>
          <p>Transaction ID: ${id}</p>
          <button onclick="window.close()">Close</button>
        </body>
      </html>
    `);
  }

  payments[id].status = "paid";
  payments[id].paidAt = Date.now();

  console.log(`💰 MOCK PAID: ${id}`);

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
          .success {
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
          button:hover {
            transform: scale(1.05);
          }
        </style>
      </head>
      <body>
        <div class="success">
          <h1>✅ Payment Success (Mock)</h1>
          <p>Transaction ID: ${id}</p>
          <p>Amount: ${payments[id].amount} ฿</p>
          <button onclick="window.close()">Close Window</button>
        </div>
        <script>
          setTimeout(() => window.close(), 3000);
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
    <html>
      <head>
        <style>
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            margin: 20px;
            background: #f5f5f5;
          }
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
          .stat-value {
            font-size: 32px;
            font-weight: bold;
            color: #667eea;
          }
          table {
            width: 100%;
            background: white;
            border-collapse: collapse;
            border-radius: 10px;
            overflow: hidden;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          th, td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #ddd;
          }
          th {
            background: #667eea;
            color: white;
          }
          .status-paid { color: green; font-weight: bold; }
          .status-pending { color: orange; font-weight: bold; }
          .dispensed-yes { color: green; }
          .dispensed-no { color: red; }
        </style>
      </head>
      <body>
        <h1>💰 Payment Server Dashboard</h1>
        
        <div class="stats">
          <div class="stat-card">
            <div>Total Transactions</div>
            <div class="stat-value">${stats.total}</div>
          </div>
          <div class="stat-card">
            <div>Paid</div>
            <div class="stat-value">${stats.paid}</div>
          </div>
          <div class="stat-card">
            <div>Pending</div>
            <div class="stat-value">${stats.pending}</div>
          </div>
          <div class="stat-card">
            <div>Dispensed</div>
            <div class="stat-value">${stats.dispensed}</div>
          </div>
          <div class="stat-card">
            <div>Total Amount</div>
            <div class="stat-value">${stats.totalAmount} ฿</div>
          </div>
        </div>
        
        <table>
          <thead>
            <tr>
              <th>Transaction ID</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Created</th>
              <th>Paid At</th>
              <th>Dispensed</th>
            </tr>
          </thead>
          <tbody>
            ${transactions.map(t => `
              <tr>
                <td>${t.id}</td>
                <td>${t.amount} ฿</td>
                <td class="status-${t.status}">${t.status}</td>
                <td>${t.createdAt}</td>
                <td>${t.paidAt || '-'}</td>
                <td class="dispensed-${t.dispensed ? 'yes' : 'no'}">${t.dispensed ? '✓' : '✗'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </body>
    </html>
  `);
});

// ================= Cleanup Old Transactions =================
app.post("/api/cleanup", (req, res) => {
  const now = Date.now();
  let removed = 0;

  for (const [id, data] of Object.entries(payments)) {
    // ลบรายการที่ pending นานเกิน 10 นาที
    if (data.status === "pending" && now - data.createdAt > 10 * 60 * 1000) {
      delete payments[id];
      removed++;
    }
    // ลบรายการที่จ่ายแล้วและจ่ายน้ำยาแล้วนานเกิน 1 ชั่วโมง
    if (data.status === "paid" && data.dispensed && now - data.dispensedAt > 60 * 60 * 1000) {
      delete payments[id];
      removed++;
    }
  }

  console.log(`🧹 Cleaned up ${removed} transactions`);
  res.json({ 
    success: true, 
    removed, 
    remaining: Object.keys(payments).length 
  });
});

// ================= Root =================
app.get("/", (req, res) => {
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
          .container {
            background: rgba(255,255,255,0.2);
            padding: 40px;
            border-radius: 20px;
            display: inline-block;
          }
          h1 { margin: 0 0 20px 0; }
          .endpoints {
            text-align: left;
            margin-top: 30px;
          }
          a {
            color: white;
            text-decoration: none;
            display: inline-block;
            margin: 5px;
            padding: 10px 20px;
            background: rgba(255,255,255,0.3);
            border-radius: 10px;
          }
          a:hover {
            background: rgba(255,255,255,0.5);
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🚀 CleanCare Payment Server</h1>
          <p>SCB Payment Gateway Integration</p>
          <p>Status: <strong>${SCB_CONFIG.baseURL.includes("sandbox") ? "SANDBOX MODE" : "PRODUCTION MODE"}</strong></p>
          
          <div class="endpoints">
            <h3>Endpoints for HMI:</h3>
            <ul>
              <li>POST /api/create-qr - Create QR Code</li>
              <li>GET /api/check-payment - Check payment status</li>
              <li>POST /api/confirm-dispense - Confirm dispense</li>
            </ul>
            
            <h3>Management:</h3>
            <ul>
              <li><a href="/dashboard">📊 Dashboard</a></li>
              <li><a href="/mock-pay/TXN_ID">💰 Mock Payment (Test)</a></li>
            </ul>
          </div>
        </div>
      </body>
    </html>
  `);
});

// ================= Start Server =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`🚀 Payment Server Running`);
  console.log(`📍 Local: http://localhost:${PORT}`);
  console.log(`📍 Network: http://0.0.0.0:${PORT}`);
  console.log(`📱 SCB Mode: ${SCB_CONFIG.baseURL.includes("sandbox") ? "SANDBOX" : "PRODUCTION"}`);
  console.log(`========================================\n`);
});

// ตั้ง cleanup ทุก 10 นาที
setInterval(() => {
  fetch(`http://localhost:${PORT}/api/cleanup`, { method: 'POST' });
}, 10 * 60 * 1000);
