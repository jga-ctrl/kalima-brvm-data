const BRVM_URL = "https://www.brvm.org/fr/cours-actions/0";
const BOC_BASE_URL = "https://bfin.brvm.org/boc/boc_jour.aspx/BOC_JOUR";

function fail(message) {
  throw new Error(`Verrou BOC BRVM refusé : ${message}`);
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

function bocUrlForDate(date) {
  return `${BOC_BASE_URL}/BOC_${date.replaceAll("-", "")}.pdf`;
}

async function main() {
  const marketResponse = await fetch(BRVM_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; KalimaBourse-BOC-Gate/2.0)",
      "Accept-Language": "fr-FR,fr;q=0.9",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!marketResponse.ok) fail(`page cours actions inaccessible (HTTP ${marketResponse.status})`);
  const html = await marketResponse.text();

  // Si la séance n'est pas fermée, le collecteur fera un no-op. Aucun BOC n'est exigé.
  if (!isClosedSession(html)) {
    console.log("BOC gate : séance encore ouverte, aucune publication de clôture autorisée.");
    return;
  }

  const sessionDate = extractSessionDate(html);
  if (!sessionDate) fail("date officielle de séance introuvable sur la page BRVM");

  const bocUrl = bocUrlForDate(sessionDate);
  let response;
  try {
    response = await fetch(bocUrl, {
      headers: {
        Accept: "application/pdf,*/*;q=0.8",
        Range: "bytes=0-15",
        "User-Agent": "KalimaBourse-BOC-Gate/2.0",
      },
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
    });
  } catch (error) {
    fail(`BOC officiel ${sessionDate} inaccessible (${error instanceof Error ? error.message : String(error)})`);
  }

  if (!response.ok && response.status !== 206) {
    fail(`BOC officiel ${sessionDate} non disponible (HTTP ${response.status})`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const signature = String.fromCharCode(...bytes.slice(0, 4));
  const contentType = response.headers.get("content-type") ?? "";
  if (signature !== "%PDF" && !contentType.toLowerCase().includes("application/pdf")) {
    fail(`BOC officiel ${sessionDate} invalide : la ressource BRVM n'est pas un PDF`);
  }

  console.log(`BOC gate validé : séance ${sessionDate} — ${bocUrl}`);
}

await main();
