const express = require("express");
const cors = require("cors");
const QRCode = require("qrcode");

const app = express();
app.use(express.json());
app.use(cors());

// ================= เปิด Mock Mode (ไม่ต้องใช้ Omise หรือ SCB) =================
//const USE_MOCK_QR = true;  // เปลี่ยนเป็น false เมื่อต้องการใช้ Gateway จริง
const USE_MOCK_QR = false;  // เปลี่ยนเป็น true เมื่อต้องการใช้ Gateway จำลอง

let payments = {};

// ================= สร้าง QR Code (Mock Mode) =================
app.post("/api/create-qr", async (req, res) => {
  try {
    const { amount, currency = "THB", reference = "" } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid amount" 
      });
    }

    console.log(`📱 Creating MOCK QR for amount: ${amount} THB`);

    const transactionId = `MOCK_${Date.now()}${Math.floor(Math.random() * 10000)}`;
    
    // สร้าง Mock QR Payload
    const mockPayload = `00020101021129370016A00000067701011101130066${transactionId}53037645804${amount}6304ABCD`;
    
    // สร้าง QR Code Image
    const qrDataUrl = await QRCode.toDataURL(mockPayload, {
      width: 300,
      margin: 2,
      color: { dark: '#000000', light: '#FFFFFF' }
    });
    
    const qrBase64 = qrDataUrl.split(',')[1];

    // เก็บข้อมูล transaction
    payments[transactionId] = {
      status: "pending",
      amount: amount,
      currency: currency,
      createdAt: Date.now(),
      reference: reference,
      dispensed: false
    };

    console.log(`🆕 Created MOCK transaction: ${transactionId} (${amount}฿)`);

    res.json({
      success: true,
      transaction_id: transactionId,
      qr_image: qrBase64,
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
      <title>CleanCare - Mock Payment Server</title>
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
      <h1>💰 CleanCare - Mock Payment Server</h1>
      <p>🔧 Status: ✅ Online | 📡 Mode: <strong>MOCK (Testing Only)</strong></p>
      <p>💡 สำหรับทดสอบ: กด "Mock Pay" เพื่อจำลองการชำระเงิน</p>
      
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

app.get("/health", (req, res) => {
  res.json({ status: "healthy", uptime: process.uptime(), mode: "mock" });
});

app.get("/", (req, res) => {
  res.redirect("/dashboard");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`🚀 CleanCare Mock Payment Server`);
  console.log(`========================================`);
  console.log(`📍 Local: http://localhost:${PORT}`);
  console.log(`📍 Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`📡 Mode: MOCK (Testing Only)`);
  console.log(`========================================\n`);
});
