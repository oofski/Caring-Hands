// One ordering for every patient list in the app.
//
// Staff read these lists to find a named person — "is Ruiz here yet?" — so
// surname A–Z is the order that matches the job. Each station still shows its
// own state (needs vitals, consents signed, checked out) in its columns, so
// nothing is lost by not sorting by workflow stage.
//
// localeCompare with sensitivity:'base' so accents and case don't split names
// apart: Álvarez sits with Alvarez, not after Zimmerman.
export const byName = (a, b) =>
  String((a && a.last_name) || '').localeCompare(String((b && b.last_name) || ''), undefined, { sensitivity: 'base' })
  || String((a && a.first_name) || '').localeCompare(String((b && b.first_name) || ''), undefined, { sensitivity: 'base' });

// Sort a copy, so a caller's array (often used for counts elsewhere) is untouched.
export const sortedByName = (list) => (list || []).slice().sort(byName);
