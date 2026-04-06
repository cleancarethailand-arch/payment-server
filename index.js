const express = require("express");
const app = express();

app.use(express.json());

let payments = {};

// ============= Main Endpoints =============

app.get("/", (req, res) => {
  res.send("Payment Server is running");
});

// สร้างคำสั่งซื้อและ QR Code
app.get("/create-payment", (req, res) => {
  const amount = req.query.amount || 0;
  const id = Math.random().toString(36).substring(7);
  
  payments[id] = {
    status: "pending",
    amount: parseInt(amount),
    createdAt: Date.now()
  };

  // สร้าง QR Payload (PromptPay format)
  // สำหรับทดสอบ ให้ใช้เบอร์โทรตัวอย่าง หรือ URL
  const qrPayload = `https://payment-server-jydm.onrender.com/pay?id=${id}`;
  
  res.json({
    id: id,
    amount: amount,
    qr: qrPayload,
    status: "pending"
  });
});

// จำลองการชำระเงิน (ใช้ทดสอบ)
app.get("/pay", (req, res) => {
  const id = req.query.id;
  
  if (payments[id]) {
    payments[id].status = "paid";
    payments[id].paidAt = Date.now();
    res.send(`Payment Success for ${id}`);
  } else {
    res.status(404).send("Transaction not found");
  }
});

// ตรวจสอบสถานะการชำระเงิน
app.get("/check-payment", (req, res) => {
  const id = req.query.id;
  
  if (payments[id]) {
    res.json({
      id: id,
      status: payments[id].status,
      amount: payments[id].amount
    });
  } else {
    res.status(404).json({ status: "notfound" });
  }
});

// ============= Webhook Endpoints =============

// ✅ Webhook สำหรับรับการแจ้งเตือนจาก EasySlip API หรือ n8n
app.post("/webhook/payment", (req, res) => {
  const { transaction_id, status, amount, reference } = req.body;
  
  console.log(`[WEBHOOK] Received:`, req.body);
  
  if (!transaction_id) {
    return res.status(400).json({ error: "Missing transaction_id" });
  }
  
  if (payments[transaction_id]) {
    payments[transaction_id].status = status === "success" ? "paid" : "failed";
    payments[transaction_id].webhookReceivedAt = Date.now();
    payments[transaction_id].reference = reference;
    
    console.log(`[WEBHOOK] Updated transaction ${transaction_id} -> ${status}`);
    
    // ✅ เรียก Webhook ไปที่ ESP32 (ถ้าต้องการ)
    // เรียก ESP32 Controller โดยตรง
    const axios = require('axios');
    const esp32Url = `http://[ESP32_IP]:8080/webhook`; // เปลี่ยนเป็น IP ของ ESP32
    
    axios.post(esp32Url, {
      transaction_id: transaction_id,
      status: "paid",
      amount: amount
    }).catch(err => console.log("[WEBHOOK] ESP32 not reachable:", err.message));
    
    res.json({ 
      received: true, 
      transaction_id: transaction_id,
      status: "updated"
    });
  } else {
    // ถ้ายังไม่มี transaction_id ให้สร้างใหม่
    payments[transaction_id] = {
      status: status === "success" ? "paid" : "failed",
      amount: amount,
      createdAt: Date.now(),
      webhookReceivedAt: Date.now(),
      reference: reference
    };
    
    console.log(`[WEBHOOK] Created new transaction ${transaction_id} -> ${status}`);
    res.json({ received: true, transaction_id: transaction_id, status: "created" });
  }
});

// ✅ Webhook สำหรับรับการแจ้งเตือนจาก PromptPay (Thai QR Payment)
app.post("/webhook/promptpay", (req, res) => {
  const { reference, amount, sender, transactionId, status } = req.body;
  
  console.log(`[PROMPTPAY] Payment received:`, req.body);
  
  // ค้นหา transaction จาก reference หรือ amount + time
  let foundId = null;
  for (const [id, data] of Object.entries(payments)) {
    if (data.amount === amount && data.status === "pending") {
      // ตรวจสอบเวลาด้วย (ภายใน 5 นาที)
      if (Date.now() - data.createdAt < 5 * 60 * 1000) {
        foundId = id;
        break;
      }
    }
  }
  
  if (foundId) {
    payments[foundId].status = "paid";
    payments[foundId].paidAt = Date.now();
    payments[foundId].sender = sender;
    payments[foundId].transactionId = transactionId;
    
    console.log(`[PROMPTPAY] Matched transaction: ${foundId}`);
    
    // ส่งไป ESP32
    const axios = require('axios');
    axios.post(`http://[ESP32_IP]:8080/webhook`, {
      transaction_id: foundId,
      status: "paid",
      amount: amount
    }).catch(err => console.log("[WEBHOOK] ESP32 error:", err.message));
    
    res.json({ received: true, matched: foundId });
  } else {
    console.log(`[PROMPTPAY] No matching transaction found for amount: ${amount}`);
    res.json({ received: true, matched: null });
  }
});

// ✅ Webhook สำหรับทดสอบ (ส่งจาก HMI โดยตรง)
app.post("/webhook/test", (req, res) => {
  const { transaction_id, action } = req.body;
  
  console.log(`[TEST] Webhook received: ${action} for ${transaction_id}`);
  
  if (action === "confirm" && transaction_id && payments[transaction_id]) {
    payments[transaction_id].status = "paid";
    console.log(`[TEST] Transaction ${transaction_id} confirmed`);
    res.json({ success: true, status: "paid" });
  } else {
    res.json({ success: false, message: "Invalid action or transaction" });
  }
});

// ✅ รับ Webhook จาก ESP32 (ส่งสถานะกลับ)
app.post("/webhook/esp32", (req, res) => {
  const { transaction_id, result, motor_id, price } = req.body;
  
  console.log(`[ESP32] Dispense result for ${transaction_id}: ${result}`);
  
  if (payments[transaction_id]) {
    payments[transaction_id].dispenseResult = result;
    payments[transaction_id].dispenseAt = Date.now();
  }
  
  res.json({ received: true });
});

// ============= Admin Endpoints =============

// ดูรายการคำสั่งซื้อทั้งหมด
app.get("/admin/transactions", (req, res) => {
  const list = Object.entries(payments).map(([id, data]) => ({
    id,
    status: data.status,
    amount: data.amount,
    createdAt: data.createdAt,
    paidAt: data.paidAt
  }));
  res.json(list);
});

// ลบคำสั่งซื้อที่ expired (เกิน 10 นาที)
app.post("/admin/cleanup", (req, res) => {
  const now = Date.now();
  let removed = 0;
  
  for (const [id, data] of Object.entries(payments)) {
    if (data.status === "pending" && (now - data.createdAt) > 10 * 60 * 1000) {
      delete payments[id];
      removed++;
    }
  }
  
  res.json({ removed, remaining: Object.keys(payments).length });
});

// ============= Start Server =============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Payment server running on port ${PORT}`);
  console.log(`   Endpoints:`);
  console.log(`   - GET  /create-payment?amount=10`);
  console.log(`   - GET  /pay?id=xxx`);
  console.log(`   - GET  /check-payment?id=xxx`);
  console.log(`   - POST /webhook/payment`);
  console.log(`   - POST /webhook/promptpay`);
  console.log(`   - POST /webhook/test`);
  console.log(`   - GET  /admin/transactions`);
});
