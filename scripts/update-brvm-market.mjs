import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { previousWeekday } from "./market-calendar.mjs";

const BRVM_URL = "https://www.brvm.org/fr/cours-actions/0";
const SOURCE_LABEL = "BRVM — séance officielle fermée (cours actions)";
const EXPECTED_QUOTE_COUNT = 47;
const MIN_CONTINUITY_RATE = 0.9;
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

function isClosedSession(html) {
  return /S[ée]ance\s+ferm[ée]e/i.test(decodeHtml(html));
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
  ) return null;
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
  if (!columns) fail("en-têtes BRVM attendus introuvables");

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
    if (!/^[A-Z]{3,6}$/.test(symbol) || seen.has(symbol) || !EXPECTED_SYMBOLS.has(symbol)) continue;

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
      previousClose: Number.isFinite(previousClose) ? previousClose : undefined,
      openPrice: Number.isFinite(openPrice) ? openPrice : undefined,
      dayChangePct: Number.isFinite(dayChangePct) ? dayChangePct : undefined,
      dailyChangePercent: Number.isFinite(dayChangePct) ? dayChangePct : undefined,
      dayVolume: Number.isFinite(dayVolume) ? dayVolume : undefined,
      sessionDate,
      sessionTime,
      priceSeries: [{
        date: sessionDate,
        close: lastPrice,
        volume: Number.isFinite(dayVolume) ? dayVolume : undefined,
      }],
      source: SOURCE_LABEL,
      sourceUrl: BRVM_URL,
      fetchedAt,
    });
  }
  return quotes;
}

function quoteFingerprint(quote) {
  return [
    quote.symbol,
    quote.lastPrice ?? null,
    quote.previousClose ?? null,
    quote.openPrice ?? null,
    quote.dayChangePct ?? null,
    quote.dayVolume ?? null,
  ].join(":");
}

function marketFingerprint(quotes) {
  return [...quotes]
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
    .map(quoteFingerprint)
    .join("|");
}

function validateContinuity(previousQuotes, quotes) {
  const previousBySymbol = new Map(previousQuotes.map((quote) => [quote.symbol, quote]));
  let comparable = 0;
  let matches = 0;
  const mismatches = [];

  for (const quote of quotes) {
    const prior = previousBySymbol.get(quote.symbol);
    if (!prior || !Number.isFinite(prior.lastPrice) || !Number.isFinite(quote.previousClose)) continue;
    comparable += 1;
    if (quote.previousClose === prior.lastPrice) matches += 1;
    else mismatches.push(`${quote.symbol}:${prior.lastPrice}->veille=${quote.previousClose}`);
  }

  if (comparable < Math.floor(EXPECTED_QUOTE_COUNT * 0.8)) {
    fail(`continuité impossible à contrôler : ${comparable}/${EXPECTED_QUOTE_COUNT} titres comparables`);
  }
  const rate = matches / comparable;
  if (rate < MIN_CONTINUITY_RATE) {
    fail(
      `continuité de séance insuffisante (${matches}/${comparable}, ${(rate * 100).toFixed(1)}%). ` +
      `Exemples: ${mismatches.slice(0, 8).join(", ")}`,
    );
  }
}

async function previousFeed() {
  try {
    return JSON.parse(await readFile(OUTPUT_PATH, "utf8"));
  } catch {}
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
      "User-Agent": "Mozilla/5.0 (compatible; KalimaBourse-KME/2.0)",
      "Accept-Language": "fr-FR,fr;q=0.9",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) fail(`BRVM a répondu ${response.status}`);
  const html = await response.text();

  if (!isClosedSession(html)) {
    console.log("BRVM : séance encore ouverte. Aucune clôture publiée.");
    return;
  }

  const session = extractSessionMeta(html);
  if (!session) fail("date officielle de séance introuvable");

  const fetchedAt = new Date().toISOString();
  const quotes = parseRows(html, session.date, session.time, fetchedAt);
  if (quotes.length !== EXPECTED_QUOTE_COUNT) fail(`${quotes.length}/${EXPECTED_QUOTE_COUNT} cours parsés`);

  const actual = new Set(quotes.map((quote) => quote.symbol));
  const missing = [...EXPECTED_SYMBOLS].filter((symbol) => !actual.has(symbol));
  if (missing.length || actual.size !== EXPECTED_QUOTE_COUNT) {
    fail(`univers incomplet : ${actual.size}/47; absents: ${missing.join(", ") || "aucun"}`);
  }

  const previous = await previousFeed();
  const previousDate = /^\d{4}-\d{2}-\d{2}$/.test(previous?.sessionDate ?? "")
    ? previous.sessionDate
    : null;
  const previousQuotes = Array.isArray(previous?.quotes) ? previous.quotes : [];

  if (previousDate && session.date < previousDate) {
    fail(`séance ${session.date} antérieure à la séance publiée ${previousDate}`);
  }

  const sameMarketData =
    previousQuotes.length === EXPECTED_QUOTE_COUNT &&
    marketFingerprint(previousQuotes) === marketFingerprint(quotes);

  if (previousDate === session.date && sameMarketData) {
    console.log(`BRVM : séance ${session.date} déjà publiée, aucun changement.`);
    return;
  }

  if (previousDate && session.date > previousDate && sameMarketData) {
    fail(`nouvelle date ${session.date} mais données de marché recyclées depuis ${previousDate}`);
  }

  // La continuité n'est bloquante que si la dernière séance enregistrée est
  // exactement la veille ouvrée attendue. Si une séance manque dans l'historique
  // local, on ne compare pas artificiellement deux jours non consécutifs.
  const expectedPreviousSession = previousWeekday(session.date);
  const continuityChecked =
    previousDate === expectedPreviousSession && previousQuotes.length === EXPECTED_QUOTE_COUNT;
  if (continuityChecked) validateContinuity(previousQuotes, quotes);

  const body = {
    schemaVersion: "2.0",
    quoteCount: quotes.length,
    quotes,
    source: SOURCE_LABEL,
    sourceUrl: BRVM_URL,
    certification: {
      status: "official-brvm-session-closed",
      sessionDate: session.date,
      sourceUrl: BRVM_URL,
      continuityChecked,
      previousPublishedSession: previousDate,
    },
    sessionDate: session.date,
    sessionTime: session.time,
    fetchedAt,
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  console.log(
    `Alimentation BRVM certifiée : ${quotes.length}/47 — séance fermée ${session.date} ${session.time}.` +
    (continuityChecked ? " Continuité validée." : " Continuité non exigée (séance intermédiaire manquante)."),
  );
}

await main();
