import "dotenv/config";
import fs from "fs";
import path from "path";
import dayjs from "dayjs";
import { Telegraf } from "telegraf";
import { google } from "googleapis";

const BOT_TOKEN = process.env.BOT_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const CREDS_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || "./service-account.json";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN belum di-set di .env");
if (!SPREADSHEET_ID) throw new Error("SPREADSHEET_ID belum di-set di .env");

const absCreds = path.isAbsolute(CREDS_PATH)
  ? CREDS_PATH
  : path.join(process.cwd(), CREDS_PATH);

if (!fs.existsSync(absCreds)) {
  throw new Error(`service-account.json tidak ketemu di path: ${absCreds}`);
}

const auth = new google.auth.GoogleAuth({
  keyFile: absCreds,
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
    requestBody: {
      values: [[tanggal, kategori, nominal, keterangan]],
    },
  });
}

async function getRows(sheetName) {
  // Ambil semua baris data (skip header)
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A2:D`,
  });
  return res.data.values || [];
}

function rowsForMonth(rows, ym) {
  // tanggal format: "YYYY-MM-DD HH:mm:ss" atau "YYYY-MM-DD"
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
  const total = rows.reduce((a, b) => a + (b.nominal || 0), 0);
  let biggest = null;
  for (const r of rows) {
    if (!biggest || (r.nominal || 0) > (biggest.nominal || 0)) biggest = r;
  }
  return { total, biggest };
}

// ===== Bot =====
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply(
    [
      "Bot aktif.",
      "",
      "Input:",
      "/in <kategori> <nominal> <keterangan...>",
      "/out <kategori> <nominal> <keterangan...>",
      "",
      "Report:",
      "/report YYYY-MM  (contoh: /report 2026-03)",
    ].join("\n")
  );
});

async function handleInOut(ctx, sheetName) {
  try {
    const parts = (ctx.message.text || "").split(" ").filter(Boolean);
    const kategori = parts[1];
    const nominalRaw = parts[2];
    const keterangan = parts.slice(3).join(" ") || "-";

    if (!kategori || !nominalRaw) {
      return ctx.reply(`Format salah.\n/${sheetName} <kategori> <nominal> <keterangan...>`);
    }

    const nominal = parseNominal(nominalRaw);
    if (nominal === null) {
      return ctx.reply("Nominal tidak valid. Contoh: /in gaji 5000000 keterangan");
    }

    await appendRow(sheetName, {
      tanggal: dayjs().format("YYYY-MM-DD HH:mm:ss"),
      kategori,
      nominal,
      keterangan,
    });

    ctx.reply(`✅ Masuk ke sheet "${sheetName}": ${kategori} | ${money(nominal)} | ${keterangan}`);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    ctx.reply("❌ Gagal nulis ke sheet (cek console).");
  }
}

bot.command("in", (ctx) => handleInOut(ctx, "in"));
bot.command("out", (ctx) => handleInOut(ctx, "out"));

bot.command("report", async (ctx) => {
  try {
    const parts = (ctx.message.text || "").split(" ").filter(Boolean);
    const ym = parts[1];

    if (!ym || !/^\d{4}-\d{2}$/.test(ym)) {
      return ctx.reply("Format salah. Pakai: /report YYYY-MM (contoh: /report 2026-03)");
    }

    const [inRowsAll, outRowsAll] = await Promise.all([getRows("in"), getRows("out")]);

    const inRows = rowsForMonth(inRowsAll, ym);
    const outRows = rowsForMonth(outRowsAll, ym);

    const inSum = summarize(inRows);
    const outSum = summarize(outRows);

    const net = inSum.total - outSum.total;

    const biggestIn = inSum.biggest
      ? `${biggestInLine(inSum.biggest)}`
      : "-";
    const biggestOut = outSum.biggest
      ? `${biggestOutLine(outSum.biggest)}`
      : "-";

    function biggestInLine(r) {
      return `${r.kategori} | ${money(r.nominal)} | ${r.keterangan || "-"}`;
    }
    function biggestOutLine(r) {
      return `${r.kategori} | ${money(r.nominal)} | ${r.keterangan || "-"}`;
    }

    const sign = net >= 0 ? "+" : "-";
    const reply = [
      `📊 Report ${ym}`,
      "",
      `Masuk: ${money(inSum.total)} (${inRows.length} data)`,
      `Keluar: ${money(outSum.total)} (${outRows.length} data)`,
      `Net: ${sign}${money(Math.abs(net))}`,
      "",
      `Pemasukan terbesar: ${biggestIn}`,
      `Pengeluaran terbesar: ${biggestOut}`,
    ].join("\n");

    ctx.reply(reply);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    ctx.reply("❌ Gagal ambil report (cek console).");
  }
});

bot.launch();
console.log("Bot jalan... Ctrl+C untuk stop");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));