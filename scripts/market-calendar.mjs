export function isoDateInAbidjan(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Abidjan",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function localHourInAbidjan(now = new Date()) {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Abidjan",
      hour: "2-digit",
      hour12: false,
    }).format(now),
  );
}

export function isWeekendIso(date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

export function previousWeekday(date) {
  let cursor = new Date(`${date}T12:00:00Z`);
  do {
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
  } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
  return cursor.toISOString().slice(0, 10);
}

export function feedNeedsRefresh(feed, now = new Date()) {
  const today = isoDateInAbidjan(now);
  const hour = localHourInAbidjan(now);
  const sessionDate = typeof feed?.sessionDate === "string" ? feed.sessionDate : null;
  if (!sessionDate) return { refresh: true, reason: "date de séance absente" };

  if (isWeekendIso(today)) {
    const expected = previousWeekday(today);
    return sessionDate < expected
      ? { refresh: true, reason: `dernière séance ${sessionDate}, attendu au moins ${expected}` }
      : { refresh: false, reason: `week-end, dernière séance ${sessionDate}` };
  }

  // Avant la fin de séance, la dernière clôture certifiée peut légitimement être celle du jour ouvré précédent.
  if (hour < 15) {
    const expected = previousWeekday(today);
    return sessionDate < expected
      ? { refresh: true, reason: `séance trop ancienne (${sessionDate} < ${expected})` }
      : { refresh: false, reason: `marché non clôturé, dernière séance ${sessionDate}` };
  }

  // Après 15h Abidjan, on attend la séance du jour. Les contrôles programmés suivants
  // offrent plusieurs tentatives si la BRVM publie avec retard.
  return sessionDate < today
    ? { refresh: true, reason: `clôture du jour ${today} pas encore certifiée (dernière ${sessionDate})` }
    : { refresh: false, reason: `séance du jour ${sessionDate} déjà certifiée` };
}
