const express = require("express");
const app = express();

app.use(express.json());

let payments = {};

app.get("/", (req, res) => {
  res.send("Server is running");
});

app.get("/create-payment", (req, res) => {
  const id = Math.random().toString(36).substring(7);
  payments[id] = "pending";

  res.json({
    id: id,
    qr: `https://payment-server-jydm.onrender.com`
  });
});

app.get("/pay", (req, res) => {
  const id = req.query.id;
  payments[id] = "paid";
  res.send("Payment Success");
});

app.get("/check-payment", (req, res) => {
  const id = req.query.id;
  res.send(payments[id] || "notfound");
});

app.listen(3000, () => {
  console.log("Server running");
});
