import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const BRVM_URL = "https://www.brvm.org/fr/cours-actions/0";
const SOURCE_LABEL = "BRVM — Journée de cotation (cours actions)";
const EXPECTED_QUOTE_COUNT = 47;
const EXPECTED_SYMBOLS = new Set([
  "ABJC", "BICB", "BICC", "BNBC", "BOAB", "BOABF", "BOAC", "BOAM", "BOAN", "BOAS",
  "CABC", "CBIBF", "CFAC", "CIEC", "ECOC", "ETIT", "FTSC", "LNBB", "NEIC", "NSBC",
  "NTLC", "ONTBF", "ORAC", "ORGT", "PALC", "PRSC", "SAFC", "SCRC", "SDCC", "SDSC",
  "SEMC", "SGBC", "SHEC", "SIBC", "SICC", "SIVC", "SLBC", "SMBC", "SNTS", "SOGC",
  "SPHC", "STAC", "STBC", "TTLC", "TTLS", "UNLC", "UNXC",
]);
const OUTPUT_PATH = resolve(process.env.OUTPUT_PATH ?? "latest.json");
const CURRENT_FEED_URL =
  process.env.CURRENT_FEED_URL ??
  "https://raw.githubusercontent.com/jga-ctrl/kalima-brvm-data/main/latest.json";

function fail(message) {
  throw new Error(`Alimentation BRVM refusée : ${message}`);
}

function decodeHtml(value) {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .trim();
}

function normalizeHeader(value) {
  return decodeHtml(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function parseFrNumber(raw) {
  const cleaned = raw.replace(/\s|\u00a0/g, "").replace(/,/g, ".");
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : Number.NaN;
}

function extractSessionMeta(html) {
  const match = html.match(
    /Derni[eè]re mise [aà] jour\s*:\s*[^<,]+,\s*(\d{1,2})\s+([\p{L}]+),?\s+(\d{4})\s*-\s*(\d{1,2}:\d{2})/iu,
  );
  if (!match) return null;
  const [, dayText, monthText, yearText, time] = match;
  const months = {
    janvier: 0, février: 1, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5,
    juillet: 6, août: 7, aout: 7, septembre: 8, octobre: 9, novembre: 10,
    décembre: 11, decembre: 11,
  };
  const month = months[monthText.toLowerCase()];
  if (month == null) return null;
  const day = Number(dayText);
  const year = Number(yearText);
  const date = new Date(Date.UTC(year, month, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { date: date.toISOString().slice(0, 10), time };
}

function extractColumnMap(html) {
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(html))) {
    const headers = [...rowMatch[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((cell) =>
      normalizeHeader(cell[1]),
    );
    if (!headers.length) continue;
    const find = (predicate) => headers.findIndex(predicate);
    const map = {
      symbol: find((h) => h === "symbole"),
      name: find((h) => h === "nom"),
      volume: find((h) => h === "volume"),
      previousClose: find((h) => h.startsWith("cours veille")),
      openPrice: find((h) => h.startsWith("cours ouverture")),
      lastPrice: find((h) => h.startsWith("cours cloture")),
      dayChangePct: find((h) => h.startsWith("variation")),
    };
    if (Object.values(map).every((index) => index >= 0)) return map;
  }
  return null;
}

function parseRows(html, sessionDate, sessionTime, fetchedAt) {
  const columns = extractColumnMap(html);
  if (!columns) {
    fail("en-têtes BRVM attendus introuvables (Symbole/Nom/Volume/Cours veille/Ouverture/Clôture/Variation)");
  }

  const quotes = [];
  const seen = new Set();
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(html))) {
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(
      (cell) => decodeHtml(cell[1]),
    );
    if (!cells.length) continue;
    const symbol = (cells[columns.symbol] ?? "").toUpperCase();
    if (!/^[A-Z]{3,6}$/.test(symbol) || seen.has(symbol)) continue;

    const lastPrice = parseFrNumber(cells[columns.lastPrice] ?? "");
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) continue;
    const previousClose = parseFrNumber(cells[columns.previousClose] ?? "");
    const openPrice = parseFrNumber(cells[columns.openPrice] ?? "");
    const dayVolume = parseFrNumber(cells[columns.volume] ?? "");
    const dayChangePct = parseFrNumber(cells[columns.dayChangePct] ?? "");

    seen.add(symbol);
    quotes.push({
      symbol,
      name: cells[columns.name] || undefined,
      currency: "XOF",
      lastPrice,
      // BRVM « Cours veille ». Ce champ n'est pas recalculé et n'est pas
      // utilisé comme substitut à la Variation (%) officielle BRVM.
      previousClose: Number.isFinite(previousClose) ? previousClose : undefined,
      openPrice: Number.isFinite(openPrice) ? openPrice : undefined,
      dayChangePct: Number.isFinite(dayChangePct) ? dayChangePct : undefined,
      dailyChangePercent: Number.isFinite(dayChangePct) ? dayChangePct : undefined,
      dayVolume: Number.isFinite(dayVolume) ? dayVolume : undefined,
      sessionDate,
      sessionTime,
      priceSeries: [
        {
          date: sessionDate,
          close: lastPrice,
          volume: Number.isFinite(dayVolume) ? dayVolume : undefined,
        },
      ],
      source: SOURCE_LABEL,
      sourceUrl: BRVM_URL,
      fetchedAt,
    });
  }
  return quotes;
}

async function previousFeed() {
  try {
    return JSON.parse(await readFile(OUTPUT_PATH, "utf8"));
  } catch {
    // The first run has no local feed yet.
  }
  try {
    const response = await fetch(CURRENT_FEED_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function main() {
  const response = await fetch(BRVM_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; KalimaBourse-KME/1.0; +https://github.com/jga-ctrl/kalima-brvm-data)",
      "Accept-Language": "fr-FR,fr;q=0.9",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) fail(`BRVM a répondu ${response.status}`);
  const html = await response.text();
  const session = extractSessionMeta(html);
  if (!session) fail("date officielle de séance introuvable");

  const fetchedAt = new Date().toISOString();
  const quotes = parseRows(html, session.date, session.time, fetchedAt);
  if (quotes.length !== EXPECTED_QUOTE_COUNT) {
    fail(`${quotes.length}/${EXPECTED_QUOTE_COUNT} cours parsés`);
  }

  const expected = EXPECTED_SYMBOLS;
  const actual = new Set(quotes.map((quote) => quote.symbol));
  if (expected.size !== EXPECTED_QUOTE_COUNT || actual.size !== EXPECTED_QUOTE_COUNT) {
    fail("ticker absent ou dupliqué");
  }
  const missing = [...expected].filter((symbol) => !actual.has(symbol));
  const unexpected = [...actual].filter((symbol) => !expected.has(symbol));
  if (missing.length || unexpected.length) {
    fail(
      `univers différent du registre (absents: ${missing.join(", ") || "aucun"}; ` +
        `inattendus: ${unexpected.join(", ") || "aucun"})`,
    );
  }

  const previous = await previousFeed();
  const previousDate =
    previous && /^\d{4}-\d{2}-\d{2}$/.test(previous.sessionDate)
      ? previous.sessionDate
      : null;
  if (previousDate && session.date < previousDate) {
    fail(`séance ${session.date} antérieure à la séance publiée ${previousDate}`);
  }

  const body = {
    schemaVersion: "1.0",
    quoteCount: quotes.length,
    quotes,
    source: SOURCE_LABEL,
    sourceUrl: BRVM_URL,
    sessionDate: session.date,
    sessionTime: session.time,
    fetchedAt,
  };
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  console.log(
    `Alimentation BRVM validée : ${quotes.length}/47 — séance ${session.date} ${session.time ?? ""}.`,
  );
}

await main();
