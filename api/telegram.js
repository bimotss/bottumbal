import "dotenv/config";
import fs from "fs";
import path from "path";
import dayjs from "dayjs";
import { Telegraf } from "telegraf";
import { google } from "googleapis";

const BOT_TOKEN = process.env.BOT_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const CREDS_JSON = process.env.GOOGLE_CREDENTIALS_JSON; // kita simpan JSON di env (bukan file)
if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!SPREADSHEET_ID) throw new Error("SPREADSHEET_ID missing");
if (!CREDS_JSON) throw new Error("GOOGLE_CREDENTIALS_JSON missing");

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(CREDS_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

function parseNominal(nominalRaw) {
  const cleaned = String(nominalRaw).replace(/[^\d-]/g, "");
  const nominal = Number(cleaned);
  if (!Number.isFinite(nominal) || nominal === 0) return null;
  return nominal;
}

function money(n) {
  const sign = n < 0 ? "-" : "";
  const x = Math.abs(Math.round(n));
  return sign + x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

async function appendRow(sheetName, { tanggal, kategori, nominal, keterangan }) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:D`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [[tanggal, kategori, nominal, keterangan]] },
  });
}

async function getRows(sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A2:D`,
  });
  return res.data.values || [];
}

function rowsForMonth(rows, ym) {
  return rows
    .map((r) => ({
      tanggal: r[0] || "",
      kategori: r[1] || "",
      nominal: Number(String(r[2] ?? "0").replace(/[^\d-]/g, "")) || 0,
      keterangan: r[3] || "",
    }))
    .filter((x) => x.tanggal.startsWith(ym));
}

function summarize(rows) {
  return { total: rows.reduce((a, b) => a + (b.nominal || 0), 0) };
}

function aggregateByCategory(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = (r.kategori || "-").trim() || "-";
    map.set(key, (map.get(key) || 0) + (r.nominal || 0));
  }
  return map;
}

function biggestCategory(map) {
  let best = null;
  for (const [kategori, total] of map.entries()) {
    if (!best || total > best.total) best = { kategori, total };
  }
  return best;
}

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) =>
  ctx.reply(
    [
      "Bot aktif.",
      "",
      "/in <kategori> <nominal> <keterangan...>",
      "/out <kategori> <nominal> <keterangan...>",
      "/report YYYY-MM",
    ].join("\n")
  )
);

async function handleInOut(ctx, sheetName) {
  const parts = (ctx.message.text || "").split(" ").filter(Boolean);
  const kategori = parts[1];
  const nominalRaw = parts[2];
  const keterangan = parts.slice(3).join(" ") || "-";

  if (!kategori || !nominalRaw) {
    return ctx.reply(`Format: /${sheetName} <kategori> <nominal> <keterangan...>`);
  }

  const nominal = parseNominal(nominalRaw);
  if (nominal === null) return ctx.reply("Nominal tidak valid.");

  await appendRow(sheetName, {
    tanggal: dayjs().format("YYYY-MM-DD HH:mm:ss"),
    kategori,
    nominal,
    keterangan,
  });

  ctx.reply(`✅ ${sheetName.toUpperCase()} masuk: ${kategori} | ${money(nominal)}`);
}

bot.command("in", (ctx) => handleInOut(ctx, "in"));
bot.command("out", (ctx) => handleInOut(ctx, "out"));

bot.command("report", async (ctx) => {
  const parts = (ctx.message.text || "").split(" ").filter(Boolean);
  const ym = parts[1];
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) {
    return ctx.reply("Format: /report YYYY-MM (contoh: /report 2026-03)");
  }

  const [inAll, outAll] = await Promise.all([getRows("in"), getRows("out")]);
  const inRows = rowsForMonth(inAll, ym);
  const outRows = rowsForMonth(outAll, ym);

  const inSum = summarize(inRows);
  const outSum = summarize(outRows);
  const net = inSum.total - outSum.total;

  const biggestIn = biggestCategory(aggregateByCategory(inRows));
  const biggestOut = biggestCategory(aggregateByCategory(outRows));

  const sign = net >= 0 ? "+" : "-";

  ctx.reply(
    [
      `📊 Report ${ym}`,
      "",
      `Masuk: ${money(inSum.total)} (${inRows.length} data)`,
      `Keluar: ${money(outSum.total)} (${outRows.length} data)`,
      `Net: ${sign}${money(Math.abs(net))}`,
      "",
      `Kategori pemasukan terbesar: ${biggestIn ? `${biggestIn.kategori} | ${money(biggestIn.total)}` : "-"}`,
      `Kategori pengeluaran terbesar: ${biggestOut ? `${biggestOut.kategori} | ${money(biggestOut.total)}` : "-"}`,
    ].join("\n")
  );
});

// Vercel handler (webhook endpoint)
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("OK");
  try {
    await bot.handleUpdate(req.body, res);
  } catch (e) {
    console.error(e);
    res.status(200).send("OK");
  }
}