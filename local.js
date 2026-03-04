import "dotenv/config";
import express from "express";
import handler from "./api/telegram.js";

const app = express();
app.use(express.json());

app.post("/api/telegram", async (req, res) => {
  console.log("INCOMING UPDATE:", JSON.stringify(req.body).slice(0, 300));
  await handler(req, res);
});

app.listen(3000, () => console.log("Local bot server http://localhost:3000"));