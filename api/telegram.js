import "dotenv/config";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import { Telegraf } from "telegraf";
import { google } from "googleapis";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const TZ = "Asia/Jakarta";

const BOT_TOKEN = process.env.BOT_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const CREDS_JSON = process.env.GOOGLE_CREDENTIALS_JSON;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");
if (!SPREADSHEET_ID) throw new Error("SPREADSHEET_ID missing");
if (!CREDS_JSON) throw new Error("GOOGLE_CREDENTIALS_JSON missing");

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(CREDS_JSON),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// ================= Helpers =================

function money(n) {
  const sign = n < 0 ? "-" : "";
  const x = Math.abs(Math.round(n));
  return sign + x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function parseNominal(nominalRaw) {
  const cleaned = String(nominalRaw).replace(/[^\d-]/g, "");
  const nominal = Number(cleaned);
  if (!Number.isFinite(nominal) || nominal === 0) return null;
  return nominal;
}

// Google Sheets serial date (days since 1899-12-30)
function serialToDate(serial) {
  const ms = Math.round(serial * 86400000);
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + ms);
}

function parseTanggalToDayjs(value) {
  // value bisa number (serial) atau string
  if (typeof value === "number" && Number.isFinite(value)) {
    return dayjs(serialToDate(value)).tz(TZ);
  }

  const s = String(value || "").trim();
  if (!s) return null;

  // Coba beberapa format umum
  const formats = [
    "YYYY-MM-DD HH:mm:ss",
    "YYYY-MM-DD H:mm:ss",
    "YYYY-MM-DD",
    "M/D/YYYY H:mm:ss",
    "M/D/YYYY HH:mm:ss",
    "M/D/YYYY",
    "D/M/YYYY H:mm:ss",
    "D/M/YYYY HH:mm:ss",
    "D/M/YYYY",
  ];

  for (const f of formats) {
    const d = dayjs.tz(s, f, TZ);
    if (d.isValid()) return d;
  }

  // Fallback: coba parse biasa
  const fallback = dayjs(s);
  if (fallback.isValid()) return fallback.tz(TZ);

  return null;
}

function monthKeyFromTanggal(value) {
  const d = parseTanggalToDayjs(value);
  if (!d) return null;
  return d.format("YYYY-MM");
}

function aggregateByCategory(rows) {
  const map = new Map(); // kategori -> total
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

// ================= Sheets Ops =================

async function appendRow(sheetName, { tanggal, kategori, nominal, keterangan }) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:D`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[tanggal, kategori, nominal, keterangan]],
    },
  });
}

async function getRows(sheetName) {
  // UNFORMATTED_VALUE + SERIAL_NUMBER bikin tanggal balik jadi angka serial (stabil untuk filter)
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A2:D`,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "SERIAL_NUMBER",
  });

  const values = res.data.values || [];

  return values.map((r) => ({
    tanggal: r[0], // bisa number serial atau string
    kategori: r[1] ?? "",
    nominal: typeof r[2] === "number" ? r[2] : Number(String(r[2] ?? "0").replace(/[^\d-]/g, "")) || 0,
    keterangan: r[3] ?? "",
  }));
}

function filterByMonth(rows, ym) {
  return rows.filter((x) => monthKeyFromTanggal(x.tanggal) === ym);
}

// ================= Bot =================

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply(
    [
      "Bot aktif.",
      "",
      "Format:",
      "/in <kategori> <nominal> <keterangan...>",
      "/out <kategori> <nominal> <keterangan...>",
      "/report YYYY-MM (contoh: /report 2026-03)",
    ].join("\n")
  );
});

async function handleInOut(ctx, sheetName) {
  try {
    const parts = (ctx.message?.text || "").split(" ").filter(Boolean);
    const kategori = parts[1];
    const nominalRaw = parts[2];
    const keterangan = parts.slice(3).join(" ") || "-";

    if (!kategori || !nominalRaw) {
      return ctx.reply(`Format: /${sheetName} <kategori> <nominal> <keterangan...>`);
    }

    const nominal = parseNominal(nominalRaw);
    if (nominal === null) return ctx.reply("Nominal tidak valid.");

    const tanggal = dayjs().tz(TZ).format("YYYY-MM-DD HH:mm:ss"); // WIB

    await appendRow(sheetName, { tanggal, kategori, nominal, keterangan });

    ctx.reply(`✅ ${sheetName.toUpperCase()} masuk: ${kategori} | ${money(nominal)}`);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    ctx.reply("❌ Gagal nulis ke sheet (cek logs Vercel).");
  }
}

bot.command("in", (ctx) => handleInOut(ctx, "in"));
bot.command("out", (ctx) => handleInOut(ctx, "out"));

bot.command("report", async (ctx) => {
  try {
    const parts = (ctx.message?.text || "").split(" ").filter(Boolean);
    const ym = parts[1];

    if (!ym || !/^\d{4}-\d{2}$/.test(ym)) {
      return ctx.reply("Format: /report YYYY-MM (contoh: /report 2026-03)");
    }

    const [inAll, outAll] = await Promise.all([getRows("in"), getRows("out")]);
    const inRows = filterByMonth(inAll, ym);
    const outRows = filterByMonth(outAll, ym);

    const totalIn = inRows.reduce((a, b) => a + (b.nominal || 0), 0);
    const totalOut = outRows.reduce((a, b) => a + (b.nominal || 0), 0);
    const net = totalIn - totalOut;

    const biggestIn = biggestCategory(aggregateByCategory(inRows));
    const biggestOut = biggestCategory(aggregateByCategory(outRows));

    const sign = net >= 0 ? "+" : "-";

    ctx.reply(
      [
        `📊 Report ${ym}`,
        "",
        `Masuk: ${money(totalIn)} (${inRows.length} data)`,
        `Keluar: ${money(totalOut)} (${outRows.length} data)`,
        `Net: ${sign}${money(Math.abs(net))}`,
        "",
        `Kategori pemasukan terbesar: ${biggestIn ? `${biggestIn.kategori} | ${money(biggestIn.total)}` : "-"}`,
        `Kategori pengeluaran terbesar: ${biggestOut ? `${biggestOut.kategori} | ${money(biggestOut.total)}` : "-"}`,
      ].join("\n")
    );
  } catch (err) {
    console.error(err?.response?.data || err.message);
    ctx.reply("❌ Gagal ambil report (cek logs Vercel).");
  }
});

// ================= Vercel Handler =================

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("OK");

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    await bot.handleUpdate(body);
  } catch (e) {
    console.error(e);
  }

  return res.status(200).send("OK");
}