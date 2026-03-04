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

function isYearMonth(s) {
  return typeof s === "string" && /^\d{4}-\d{2}$/.test(s);
}

// Google Sheets serial date (days since 1899-12-30)
function serialToDate(serial) {
  const ms = Math.round(serial * 86400000);
  const epoch = Date.UTC(1899, 11, 30);
  return new Date(epoch + ms);
}

function parseTanggalToDayjs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return dayjs(serialToDate(value)).tz(TZ);
  }

  const s = String(value || "").trim();
  if (!s) return null;

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

  const fallback = dayjs(s);
  if (fallback.isValid()) return fallback.tz(TZ);

  return null;
}

function monthKeyFromTanggal(value) {
  const d = parseTanggalToDayjs(value);
  if (!d) return null;
  return d.format("YYYY-MM");
}

function tanggalDisplay(value) {
  const d = parseTanggalToDayjs(value);
  return d ? d.format("YYYY-MM-DD HH:mm:ss") : String(value ?? "-");
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

function mapToSortedList(map) {
  const list = [];
  for (const [cat, total] of map.entries()) list.push({ cat, total });
  list.sort((a, b) => b.total - a.total);
  return list;
}

function buildSeparateCategorySummary(inRows, outRows) {
  const inMap = aggregateByCategory(inRows);
  const outMap = aggregateByCategory(outRows);
  return {
    inList: mapToSortedList(inMap),
    outList: mapToSortedList(outMap),
  };
}

// telegram max 4096 chars, chunk biar aman
async function replyChunked(ctx, text) {
  const MAX = 3800;
  if (text.length <= MAX) return ctx.reply(text);

  let i = 0;
  while (i < text.length) {
    const chunk = text.slice(i, i + MAX);
    const cut = chunk.lastIndexOf("\n");
    if (cut > 500 && i + MAX < text.length) {
      await ctx.reply(chunk.slice(0, cut));
      i += cut + 1;
    } else {
      await ctx.reply(chunk);
      i += MAX;
    }
  }
}

function getIdentity(ctx) {
  const userId = String(ctx.from?.id ?? "");
  const chatId = String(ctx.chat?.id ?? "");
  return { userId, chatId };
}

function filterByUser(rows, userId) {
  // pakai userId saja supaya konsisten (chatId bisa berubah kalau user pindah group/dll)
  return rows.filter((r) => String(r.userId ?? "") === String(userId));
}

function filterByMonth(rows, ym) {
  return rows.filter((x) => monthKeyFromTanggal(x.tanggal) === ym);
}

// ================= Sheets Ops =================

// PERUBAHAN #1: append nulis sampai kolom F (A:F)
async function appendRow(sheetName, { tanggal, kategori, nominal, keterangan, userId, chatId }) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:F`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[tanggal, kategori, nominal, keterangan, userId, chatId]],
    },
  });
}

// PERUBAHAN #2: getRows baca A2:F
async function getRows(sheetName) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A2:F`,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "SERIAL_NUMBER",
  });

  const values = res.data.values || [];

  return values.map((r) => ({
    tanggal: r[0],
    kategori: r[1] ?? "",
    nominal:
      typeof r[2] === "number"
        ? r[2]
        : Number(String(r[2] ?? "0").replace(/[^\d-]/g, "")) || 0,
    keterangan: r[3] ?? "",
    userId: r[4] ?? "",
    chatId: r[5] ?? "",
  }));
}

async function showDetailsMonth(ctx, sheetName, ym) {
  const { userId } = getIdentity(ctx);

  const all = await getRows(sheetName);

  // PERUBAHAN #3: filter per user dulu baru per bulan
  const mine = filterByUser(all, userId);
  const rows = filterByMonth(mine, ym);

  if (rows.length === 0) {
    return ctx.reply(`Tidak ada data ${sheetName.toUpperCase()} untuk ${ym}.`);
  }

  rows.sort((a, b) => {
    const da = parseTanggalToDayjs(a.tanggal);
    const db = parseTanggalToDayjs(b.tanggal);
    if (!da || !db) return 0;
    return da.valueOf() - db.valueOf();
  });

  const total = rows.reduce((s, r) => s + (r.nominal || 0), 0);

  const lines = rows.map((r, idx) => {
    return `${idx + 1}. ${tanggalDisplay(r.tanggal)} | ${r.kategori || "-"} | ${money(
      r.nominal || 0
    )} | ${r.keterangan || "-"}`;
  });

  const header = `📋 Detail ${sheetName.toUpperCase()} ${ym}\nTotal: ${money(total)} (${rows.length} data)\n`;
  await replyChunked(ctx, header + "\n" + lines.join("\n"));
}

// ================= Bot =================

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
      "Detail bulanan:",
      "/in YYYY-MM",
      "/out YYYY-MM",
      "",
      "Report:",
      "/report YYYY-MM",
    ].join("\n")
  );
});

async function handleInOut(ctx, sheetName) {
  try {
    const parts = (ctx.message?.text || "").split(" ").filter(Boolean);

    // Mode detail: /in 2026-03 atau /out 2026-03
    const maybeYm = parts[1];
    if (isYearMonth(maybeYm) && parts.length === 2) {
      return showDetailsMonth(ctx, sheetName, maybeYm);
    }

    // Mode input: /in kategori nominal keterangan...
    const kategori = parts[1];
    const nominalRaw = parts[2];
    const keterangan = parts.slice(3).join(" ") || "-";

    if (!kategori || !nominalRaw) {
      return ctx.reply(
        [
          `Format input: /${sheetName} <kategori> <nominal> <keterangan...>`,
          `Format detail: /${sheetName} YYYY-MM`,
        ].join("\n")
      );
    }

    const nominal = parseNominal(nominalRaw);
    if (nominal === null) return ctx.reply("Nominal tidak valid.");

    const tanggal = dayjs().tz(TZ).format("YYYY-MM-DD HH:mm:ss"); // WIB

    const { userId, chatId } = getIdentity(ctx);

    await appendRow(sheetName, { tanggal, kategori, nominal, keterangan, userId, chatId });

    ctx.reply(`✅ ${sheetName.toUpperCase()} masuk: ${kategori} | ${money(nominal)}`);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    ctx.reply("❌ Gagal proses (cek logs).");
  }
}

bot.command("in", (ctx) => handleInOut(ctx, "in"));
bot.command("out", (ctx) => handleInOut(ctx, "out"));

bot.command("report", async (ctx) => {
  try {
    const parts = (ctx.message?.text || "").split(" ").filter(Boolean);
    const ym = parts[1];

    if (!isYearMonth(ym)) {
      return ctx.reply("Format: /report YYYY-MM (contoh: /report 2026-03)");
    }

    const { userId } = getIdentity(ctx);

    const [inAll, outAll] = await Promise.all([getRows("in"), getRows("out")]);

    // filter per user dulu
    const inMine = filterByUser(inAll, userId);
    const outMine = filterByUser(outAll, userId);

    // lalu filter per bulan
    const inRows = filterByMonth(inMine, ym);
    const outRows = filterByMonth(outMine, ym);

    const totalIn = inRows.reduce((a, b) => a + (b.nominal || 0), 0);
    const totalOut = outRows.reduce((a, b) => a + (b.nominal || 0), 0);
    const net = totalIn - totalOut;

    const biggestIn = biggestCategory(aggregateByCategory(inRows));
    const biggestOut = biggestCategory(aggregateByCategory(outRows));

    const sign = net >= 0 ? "+" : "-";

    // Summary dipisah
    const { inList, outList } = buildSeparateCategorySummary(inRows, outRows);
    const maxCats = 20;

    const inLines = inList.slice(0, maxCats).map((x) => `- ${x.cat}: ${money(x.total)}`);
    const outLines = outList.slice(0, maxCats).map((x) => `- ${x.cat}: ${money(x.total)}`);

    const inSection = [
      "",
      `📌 Summary IN (${inList.length} kategori):`,
      ...(inLines.length ? inLines : ["-"]),
      inList.length > maxCats ? `…(${inList.length - maxCats} kategori lainnya disembunyikan)` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const outSection = [
      "",
      `📌 Summary OUT (${outList.length} kategori):`,
      ...(outLines.length ? outLines : ["-"]),
      outList.length > maxCats ? `…(${outList.length - maxCats} kategori lainnya disembunyikan)` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const text = [
      `📊 Report ${ym}`,
      "",
      `Masuk: ${money(totalIn)} (${inRows.length} data)`,
      `Keluar: ${money(totalOut)} (${outRows.length} data)`,
      `Net: ${sign}${money(Math.abs(net))}`,
      "",
      `Kategori pemasukan terbesar: ${biggestIn ? `${biggestIn.kategori} | ${money(biggestIn.total)}` : "-"}`,
      `Kategori pengeluaran terbesar: ${biggestOut ? `${biggestOut.kategori} | ${money(biggestOut.total)}` : "-"}`,
      inSection,
      outSection,
    ].join("\n");

    await replyChunked(ctx, text);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    ctx.reply("❌ Gagal ambil report (cek logs).");
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