import { readFile } from "node:fs/promises";

const EXPECTED_QUOTE_COUNT = 47;
const collectorPath = "scripts/update-brvm-market.mjs";
const workflowPath = ".github/workflows/update-brvm-market.yml";
const feedPath = "latest.json";

function assert(condition, message) {
  if (!condition) throw new Error(`Verrou pipeline BRVM rompu : ${message}`);
}

const [collector, workflow, feedRaw] = await Promise.all([
  readFile(collectorPath, "utf8"),
  readFile(workflowPath, "utf8"),
  readFile(feedPath, "utf8"),
]);

// Contrat de non-régression du collecteur.
assert(collector.includes("EXPECTED_QUOTE_COUNT = 47"), "contrôle 47/47 absent");
assert(collector.includes("marketFingerprint"), "détection de séance recyclée absente");
assert(collector.includes("validateContinuity"), "contrôle de continuité absent");
assert(collector.includes("MIN_CONTINUITY_RATE"), "seuil de continuité absent");
assert(/BOC|Bulletin Officiel|bulletin/i.test(collector), "certification BOC absente");
assert(collector.includes("session.date > previousDate"), "contrôle de nouvelle séance absent");

// Contrat de non-régression du workflow.
assert(workflow.includes("if: success()"), "publication non conditionnée au succès des validations");
assert(workflow.includes("git diff --cached --quiet"), "protection anti-commit no-op absente");
assert(/cron:\s*"[^"]*1-5"/.test(workflow), "planification limitée aux jours ouvrés absente");

// Intégrité du dernier flux publié.
const feed = JSON.parse(feedRaw);
assert(feed.quoteCount === EXPECTED_QUOTE_COUNT, `quoteCount=${feed.quoteCount}`);
assert(Array.isArray(feed.quotes) && feed.quotes.length === EXPECTED_QUOTE_COUNT, "47 cotations non présentes");
assert(/^\d{4}-\d{2}-\d{2}$/.test(feed.sessionDate ?? ""), "sessionDate invalide");

const symbols = new Set();
for (const quote of feed.quotes) {
  assert(quote && /^[A-Z]{3,6}$/.test(quote.symbol ?? ""), "ticker invalide");
  assert(!symbols.has(quote.symbol), `ticker dupliqué ${quote.symbol}`);
  symbols.add(quote.symbol);
  assert(Number.isFinite(quote.lastPrice) && quote.lastPrice > 0, `cours invalide ${quote.symbol}`);
  assert(quote.sessionDate === feed.sessionDate, `date incohérente ${quote.symbol}`);
}
assert(symbols.size === EXPECTED_QUOTE_COUNT, `univers=${symbols.size}/47`);

console.log(`Pipeline BRVM verrouillé : ${symbols.size}/47, séance ${feed.sessionDate}.`);
