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

// One way to FIND a patient, for every station's list.
//
// Staff search with whatever is in front of them: a name said out loud, a
// phone number read off a form, a date of birth off an ID. Every word typed
// must appear somewhere, in any order, so "ruiz car" finds Carmen Ruiz.
//
// Two things the Arrivals search used to get wrong, fixed here for everyone:
// - Dates of birth are STORED as 1977-03-04 but TYPED as 03/04/1977 (that is
//   what the date box has asked for since v1.11.0), so a search for the typed
//   form found nobody. Both forms now match.
// - Phones are stored as bare digits, so "(503) 555-9876" or "555-9876" found
//   nobody. A word that is mostly digits is now compared digits-to-digits.
//
// `extra` is any additional text worth matching on a given screen — a visit
// label, a station name — so callers don't each grow their own copy of this.
const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const typedDob = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  return m ? `${m[2]}/${m[3]}/${m[1]}` : '';
};
export function matchesPatient(p, query, extra = []) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return true;
  if (!p) return false;
  const hay = [p.first_name, p.last_name, p.dob, typedDob(p.dob), p.phone, p.complaint, ...(extra || [])]
    .filter(Boolean).join(' ').toLowerCase();
  // Digits-only copies, so punctuation in a phone or a date never decides a match.
  const numHay = [digits(p.phone), digits(p.dob), digits(typedDob(p.dob))].filter(Boolean).join(' ');
  return q.split(/\s+/).filter(Boolean).every((w) => {
    if (hay.includes(w)) return true;
    const d = digits(w);
    // At least three digits, and the word is mostly digits: "555-9876",
    // "(503)", "03/04/1977". A name with a stray digit is not a number.
    return d.length >= 3 && d.length >= w.replace(/[\s()+\-./]/g, '').length * 0.6 && numHay.includes(d);
  });
}
