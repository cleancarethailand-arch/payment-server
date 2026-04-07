const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// ================= SCB Configuration =================
const SCB_CONFIG = {
  // Credentials ที่ได้จาก SCB Developers Portal
  apiKey: "l73301f1cc935f4dfebb5486fa686e14a0",     
  apiSecret: "20cdfa2512814a90b5b53ff59f103820", 
  
  // ใน Sandbox มักใช้เลขนี้ หรือไม่ต้องใส่ก็ได้ (API บางตัว generate ให้)
  merchantID: "SANDBOX_MERCHANT_ID",   
  terminalID: "SANDBOX_TERMINAL_ID",   
  
  // 🔥 URL สำหรับ Sandbox (เทส)
  baseURL: "https://api-sandbox.partners.scb/partners/sandbox/v1"
};

let payments = {};
let scb_access_token = null;
let token_expiry = 0;

// ================= Get SCB Access Token =================
async function getSCBAccessToken() {
  // Check if token is still valid (expires in 30 minutes)
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

// ================= Create QR30 (SCB PromptPay QR) =================
app.get("/create-payment", async (req, res) => {
  try {
    const amount = parseFloat(req.query.amount || 0);
    
    if (amount <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    // Get SCB access token
    const token = await getSCBAccessToken();
    
    // Generate unique transaction ID
    const transactionId = `TXN${Date.now()}${Math.floor(Math.random() * 1000)}`;
    
    // Create QR30 request to SCB
    const qrPayload = {
      qrType: "PP",
      amount: amount.toString(),
      transactionId: transactionId,
      merchantId: SCB_CONFIG.merchantID,
      terminalId: SCB_CONFIG.terminalID,
      callbackUrl: "https://payment-server-jydm.onrender.com/webhook/payment" // 🔥 Callback URL
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

    // Store payment info
    payments[transactionId] = {
      status: "pending",
      amount: amount,
      createdAt: Date.now(),
      dispensed: false,
      scbTransactionId: response.data.data.transactionId,
      qrRawData: response.data.data.qrRawData
    };

    console.log(`🆕 CREATE: ${transactionId} (${amount}฿)`);

    res.json({
      id: transactionId,
      amount: amount,
      qr: response.data.data.qrRawData, // QR string for display
      status: "pending"
    });

  } catch (error) {
    console.error("❌ Create payment error:", error.response?.data || error.message);
    res.status(500).json({ 
      error: "Failed to create payment",
      details: error.response?.data || error.message
    });
  }
});

// ================= Webhook for SCB Callback =================
app.post("/webhook/payment", (req, res) => {
  try {
    const webhookData = req.body;
    console.log("📞 Webhook received:", webhookData);

    // 🔥 SCB webhook format (adjust based on actual SCB response)
    const transactionId = webhookData.transactionId || webhookData.data?.transactionId;
    const paymentStatus = webhookData.status || webhookData.data?.status;
    
    if (transactionId && payments[transactionId]) {
      if (paymentStatus === "SUCCESS" || paymentStatus === "PAID") {
        payments[transactionId].status = "paid";
        payments[transactionId].paidAt = Date.now();
        console.log(`💰 PAID (webhook): ${transactionId}`);
      }
    }

    // Always return 200 to acknowledge receipt
    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Webhook error:", error);
    res.status(200).send("OK"); // Still return 200 to prevent retry
  }
});

// ================= Check Payment Status =================
app.get("/check-payment", async (req, res) => {
  const id = req.query.id;

  if (!id) {
    return res.json({ status: "pending", amount: 0, dispensed: false });
  }

  // If already confirmed as paid
  if (payments[id] && payments[id].status === "paid") {
    return res.json({
      id: id,
      status: "paid",
      amount: payments[id].amount,
      dispensed: payments[id].dispensed
    });
  }

  // If still pending, check with SCB
  if (payments[id] && payments[id].status === "pending") {
    try {
      const token = await getSCBAccessToken();
      
      const response = await axios.get(
        `${SCB_CONFIG.baseURL}/payment/${payments[id].scbTransactionId}`,
        {
          headers: {
            "Authorization": `Bearer ${token}`,
            "requestUId": crypto.randomUUID()
          }
        }
      );

      const scbStatus = response.data.data.status;
      
      if (scbStatus === "SUCCESS" || scbStatus === "PAID") {
        payments[id].status = "paid";
        payments[id].paidAt = Date.now();
        console.log(`💰 PAID (check): ${id}`);
      }
    } catch (error) {
      console.error("❌ Check payment error:", error.response?.data || error.message);
    }
  }

  // Payment not found
  if (!payments[id]) {
    return res.json({
      id: id,
      status: "pending",
      amount: 0,
      dispensed: false
    });
  }

  res.json({
    id: id,
    status: payments[id].status,
    amount: payments[id].amount,
    dispensed: payments[id].dispensed
  });
});

// ================= Confirm Dispense =================
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

// ================= Mock Payment for Testing (without SCB) =================
app.get("/mock-pay", (req, res) => {
  const id = req.query.id;

  if (!payments[id]) {
    return res.status(404).send("Payment not found");
  }

  payments[id].status = "paid";
  payments[id].paidAt = Date.now();

  console.log(`💰 MOCK PAID: ${id}`);

  res.send(`
    <html>
      <body>
        <h1>✅ Payment Success (Mock)</h1>
        <p>Transaction ID: ${id}</p>
        <p>Amount: ${payments[id].amount} ฿</p>
        <script>
          setTimeout(() => window.close(), 2000);
        </script>
      </body>
    </html>
  `);
});

// ================= Root =================
app.get("/", (req, res) => {
  res.send(`
    <html>
      <body>
        <h1>Payment Server Running 🚀</h1>
        <h3>Endpoints:</h3>
        <ul>
          <li><a href="/debug">/debug</a> - View all payments</li>
          <li><a href="/cleanup">/cleanup</a> - Clean old pending payments</li>
        </ul>
      </body>
    </html>
  `);
});

// ================= Debug =================
app.get("/debug", (req, res) => {
  const summary = {};
  for (const [id, data] of Object.entries(payments)) {
    summary[id] = {
      status: data.status,
      amount: data.amount,
      createdAt: new Date(data.createdAt).toISOString(),
      dispensed: data.dispensed
    };
  }
  res.json(summary);
});

// ================= Cleanup =================
app.post("/cleanup", (req, res) => {
  const now = Date.now();
  let removed = 0;

  for (const [id, data] of Object.entries(payments)) {
    if (data.status === "pending" && now - data.createdAt > 10 * 60 * 1000) {
      delete payments[id];
      removed++;
    }
  }

  res.json({ removed, remaining: Object.keys(payments).length });
});

// ================= Start Server =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 SCB API Mode: ${SCB_CONFIG.baseURL.includes("sandbox") ? "SANDBOX" : "PRODUCTION"}`);
});
