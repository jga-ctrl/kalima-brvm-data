import { appendFile } from "node:fs/promises";

const BRVM_URL = "https://www.brvm.org/fr/cours-actions/0";
const BFIN_URL = "https://bfin.brvm.org/Activites_marche.aspx";
const BOC_BASE_URL = "https://bfin.brvm.org/boc/BOC_JOUR";
const EXPECTED_QUOTE_COUNT = 47;

function fail(message) {
  throw new Error(`Verrou BOC BRVM refusé : ${message}`);
}

async function setReady(value) {
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `ready=${value}\n`, "utf8");
  }
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

function extractSessionDate(html) {
  const match = html.match(
    /Derni[eè]re mise [aà] jour\s*:\s*[^<,]+,\s*(\d{1,2})\s+([\p{L}]+),?\s+(\d{4})\s*-\s*(\d{1,2}:\d{2})/iu,
  );
  if (!match) return null;
  const [, dayText, monthText, yearText] = match;
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
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function extractColumnMap(html, kind) {
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(html))) {
    const headers = [...rowMatch[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((cell) =>
      normalizeHeader(cell[1]),
    );
    if (!headers.length) continue;
    const find = (predicate) => headers.findIndex(predicate);
    if (kind === "cours-actions") {
      const map = {
        symbol: find((h) => h === "symbole"),
        close: find((h) => h.startsWith("cours cloture")),
      };
      if (map.symbol >= 0 && map.close >= 0) return map;
    }
    const map = {
      symbol: find((h) => h === "code"),
      close: find((h) => h === "cours jour" || h === "current close" || h === "cours actuel"),
    };
    if (map.symbol >= 0 && map.close >= 0) return map;
  }
  return null;
}

function extractCloseMap(html, kind) {
  const columns = extractColumnMap(html, kind);
  if (!columns) fail(`en-têtes ${kind} introuvables`);
  const quotes = new Map();
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowPattern.exec(html))) {
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => decodeHtml(cell[1]));
    if (!cells.length) continue;
    const symbol = (cells[columns.symbol] ?? "").toUpperCase();
    if (!/^[A-Z]{3,6}$/.test(symbol) || quotes.has(symbol)) continue;
    const close = parseFrNumber(cells[columns.close] ?? "");
    if (!Number.isFinite(close) || close <= 0) continue;
    quotes.set(symbol, close);
  }
  return quotes;
}

function compareOfficialCloseTables(coursActions, bfin) {
  if (coursActions.size !== EXPECTED_QUOTE_COUNT) fail(`page cours actions incomplète : ${coursActions.size}/${EXPECTED_QUOTE_COUNT}`);
  if (bfin.size !== EXPECTED_QUOTE_COUNT) fail(`base financière BRVM incomplète : ${bfin.size}/${EXPECTED_QUOTE_COUNT}`);
  const mismatches = [];
  for (const [symbol, price] of coursActions) {
    const official = bfin.get(symbol);
    if (!Number.isFinite(official)) mismatches.push(`${symbol}:absent BFIN`);
    else if (official !== price) mismatches.push(`${symbol}:${price}!=${official}`);
  }
  if (mismatches.length) {
    fail(`écart entre les 2 sources officielles BRVM (${mismatches.length}/47). Exemples: ${mismatches.slice(0, 8).join(", ")}`);
  }
}

function bocUrlForDate(date) {
  return `${BOC_BASE_URL}/BOC_${date.replaceAll("-", "")}.pdf`;
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; KalimaBourse-BOC-Gate/2.2)",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) fail(`${url} inaccessible (HTTP ${response.status})`);
  return await response.text();
}

async function main() {
  await setReady("false");
  const marketHtml = await fetchHtml(BRVM_URL);

  if (!isClosedSession(marketHtml)) {
    console.log("BOC gate : séance encore ouverte. Nouvelle tentative au prochain passage planifié.");
    return;
  }

  const sessionDate = extractSessionDate(marketHtml);
  if (!sessionDate) fail("date officielle de séance introuvable sur la page BRVM");

  const bfinHtml = await fetchHtml(BFIN_URL);
  compareOfficialCloseTables(
    extractCloseMap(marketHtml, "cours-actions"),
    extractCloseMap(bfinHtml, "bfin"),
  );

  const bocUrl = bocUrlForDate(sessionDate);
  let response;
  try {
    response = await fetch(bocUrl, {
      headers: {
        Accept: "application/pdf,*/*;q=0.8",
        Range: "bytes=0-15",
        "User-Agent": "KalimaBourse-BOC-Gate/2.2",
      },
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
    });
  } catch (error) {
    console.log(`BOC gate : BOC ${sessionDate} temporairement inaccessible (${error instanceof Error ? error.message : String(error)}). Pas de publication; nouvelle tentative plus tard.`);
    return;
  }

  if (!response.ok && response.status !== 206) {
    console.log(`BOC gate : BOC officiel ${sessionDate} pas encore disponible (HTTP ${response.status}). Pas de publication; nouvelle tentative plus tard.`);
    return;
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const signature = String.fromCharCode(...bytes.slice(0, 4));
  const contentType = response.headers.get("content-type") ?? "";
  if (signature !== "%PDF" && !contentType.toLowerCase().includes("application/pdf")) {
    fail(`BOC officiel ${sessionDate} invalide : la ressource BRVM n'est pas un PDF`);
  }

  await setReady("true");
  console.log(`BOC gate validé : 47/47 concordants, séance ${sessionDate}, BOC officiel présent.`);
}

await main();
