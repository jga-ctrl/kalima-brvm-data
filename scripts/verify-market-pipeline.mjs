import { readFile } from "node:fs/promises";

const EXPECTED_QUOTE_COUNT = 47;
const collectorPath = "scripts/update-brvm-market.mjs";
const bocGatePath = "scripts/require-official-boc.mjs";
const workflowPath = ".github/workflows/update-brvm-market.yml";
const guardWorkflowPath = ".github/workflows/guard-brvm-market-freshness.yml";
const calendarPath = "scripts/market-calendar.mjs";
const feedPath = "latest.json";

function assert(condition, message) {
  if (!condition) throw new Error(`Verrou pipeline BRVM rompu : ${message}`);
}

const [collector, bocGate, workflow, guardWorkflow, calendar, feedRaw] = await Promise.all([
  readFile(collectorPath, "utf8"),
  readFile(bocGatePath, "utf8"),
  readFile(workflowPath, "utf8"),
  readFile(guardWorkflowPath, "utf8"),
  readFile(calendarPath, "utf8"),
  readFile(feedPath, "utf8"),
]);

assert(collector.includes("EXPECTED_QUOTE_COUNT = 47"), "contrôle 47/47 absent");
assert(collector.includes("marketFingerprint"), "détection de séance recyclée absente");
assert(collector.includes("isClosedSession"), "contrôle Séance fermée absent");
assert(collector.includes("previousWeekday"), "gestion des séances manquantes absente");
assert(collector.includes("previousDate === expectedPreviousSession"), "continuité conditionnelle absente");
assert(collector.includes("validateContinuity"), "contrôle de continuité absent");
assert(collector.includes("official-brvm-session-closed"), "certification de clôture officielle absente");

assert(bocGate.includes("BOC_BASE_URL"), "source BOC officielle absente");
assert(bocGate.includes("bocUrlForDate"), "liaison BOC/date de séance absente");
assert(bocGate.includes("signature !== \"%PDF\""), "validation PDF du BOC absente");
assert(bocGate.includes("isClosedSession"), "BOC non conditionné à une séance fermée");

assert(workflow.includes("node scripts/require-official-boc.mjs"), "verrou BOC absent du workflow principal");
assert(workflow.indexOf("node scripts/require-official-boc.mjs") < workflow.indexOf("node scripts/update-brvm-market.mjs"), "verrou BOC exécuté après le collecteur principal");
assert(workflow.includes("if: success()"), "publication principale non conditionnée au succès");
assert(workflow.includes("git diff --cached --quiet"), "protection anti-commit no-op absente");
assert(/cron:\s*"[^"]*1-5"/.test(workflow), "planification principale limitée aux jours ouvrés absente");

assert(guardWorkflow.includes("node scripts/require-official-boc.mjs"), "verrou BOC absent du workflow de réparation");
assert(guardWorkflow.indexOf("node scripts/require-official-boc.mjs") < guardWorkflow.indexOf("node scripts/update-brvm-market.mjs"), "verrou BOC exécuté après le collecteur de réparation");
assert(guardWorkflow.includes("feedNeedsRefresh"), "garde-fou encore basé sur fetchedAt/75 min");
assert(!guardWorkflow.includes("ageMinutes > 75"), "ancienne règle 75 minutes encore active");
assert(/cron:\s*"[^"]*1-5"/.test(guardWorkflow), "garde-fou non limité aux jours ouvrés");
assert(guardWorkflow.includes("if: success()"), "publication de réparation non conditionnée au succès");
assert(calendar.includes("Africa/Abidjan"), "calendrier non aligné sur Abidjan");

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

console.log(`Pipeline BRVM verrouillé : ${symbols.size}/47, séance ${feed.sessionDate}, BOC obligatoire.`);
