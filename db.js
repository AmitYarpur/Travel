// Firebase config and data-access layer, kept separate from index.html.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  doc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  query,
  where,
  orderBy,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDCiI7HBLt9OhokRrz-_t6n0CQLADgJhC0",
  authDomain: "amit-travel.firebaseapp.com",
  projectId: "amit-travel",
  storageBucket: "amit-travel.firebasestorage.app",
  messagingSenderId: "442700606563",
  appId: "1:442700606563:web:7c067eb4becad682819c56"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Registers the static-shell cache once per page load (see sw.js). Firestore
// traffic, map tiles and geocoding requests are untouched by the service
// worker - this only speeds up and adds resilience to loading the app's own
// HTML/CSS/JS.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// Built-in Hebrew category list for places, shown in the add-place form and
// filters. Users can add more of their own via addCategory/getCategories
// below (stored in Firestore so they're shared and persist), which the UI
// merges in alongside these defaults.
export const PLACE_CATEGORIES = ["מסעדה", "אתר תיירות", "תצפית", "קניות", "מלון", "אחר"];

// A hung request (flaky mobile connection, or a socket a suspended PWA
// silently lost) never rejects on its own - it just leaves the caller
// awaiting forever. Every Firestore/network call here is wrapped with this
// so a stuck request fails after REQUEST_TIMEOUT_MS with a clear error
// instead of leaving the screen stuck on a spinner forever.
const REQUEST_TIMEOUT_MS = 10000;

function withTimeout(promise, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || "הבקשה נכשלה. בדקו את החיבור לאינטרנט ונסו שוב.")), REQUEST_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).then(
    result => { clearTimeout(timer); return result; },
    err => { clearTimeout(timer); throw err; }
  );
}

// --- Geocoding: turn a typed place name into coordinates ------------------
// Uses OpenStreetMap's free Nominatim search - no API key needed. Best
// effort only: if it can't resolve a name (offline, typo, rate-limited) the
// caller falls back to asking for manual coordinates.
export async function geocode(searchText) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=he&q=${encodeURIComponent(searchText)}`,
      { signal: controller.signal, headers: { "Accept": "application/json" } }
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const results = await res.json();
    if (!results || results.length === 0) return null;
    return {
      lat: parseFloat(results[0].lat),
      lng: parseFloat(results[0].lon),
      displayName: results[0].display_name
    };
  } catch (e) {
    return null; // offline / blocked / endpoint changed - caller falls back to manual entry
  }
}

// Live autosuggest while typing a destination (e.g. "Ro" -> "Rome, Italy").
// Returns up to 6 [{ name, country, lat, lng, label }], ranked by
// Nominatim's own importance/population ordering. `signal` lets the caller
// abort a stale in-flight request when the user keeps typing; an abort
// rejects with AbortError so the caller can tell "cancelled" apart from
// "no results" instead of it silently returning [].
export async function searchLocationSuggestions(queryText, signal) {
  const trimmed = queryText.trim();
  if (trimmed.length < 3) return []; // shorter prefixes mostly surface a country, not a city

  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&accept-language=he&q=${encodeURIComponent(trimmed)}`,
    { signal, headers: { "Accept": "application/json" } }
  );
  if (!res.ok) return [];
  const results = await res.json();

  const suggestions = results.map(r => {
    const addr = r.address || {};
    const nameParts = r.display_name.split(",");
    const name = addr.city || addr.town || addr.village || addr.municipality || addr.county || nameParts[0].trim();
    const country = addr.country || nameParts[nameParts.length - 1].trim();
    return {
      name,
      country,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      label: country && country !== name ? `${name}, ${country}` : name
    };
  });

  // De-dupe same city/country appearing more than once in the raw results.
  return suggestions.filter((s, i) =>
    suggestions.findIndex(other => other.name === s.name && other.country === s.country) === i
  );
}

// Live autosuggest while typing a place's name, biased to a ~130km box
// around `near` (the selected destination's coordinates) via Nominatim's
// viewbox+bounded params - without that bias, a common name like "מגדל דוד"
// or "פארק העיר" would just match whichever same-named place is most
// globally important, usually nowhere near the trip. Returns up to 6
// [{ name, lat, lng, label }].
export async function searchPlaceSuggestions(queryText, near, signal) {
  const trimmed = queryText.trim();
  if (trimmed.length < 3) return [];

  const delta = 0.6; // roughly +/-65km of latitude
  const viewbox = [
    near.lng - delta, near.lat + delta,
    near.lng + delta, near.lat - delta
  ].join(",");

  async function runQuery(q) {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&accept-language=he` +
      `&viewbox=${viewbox}&bounded=1&q=${encodeURIComponent(q)}`,
      { signal, headers: { "Accept": "application/json" } }
    );
    return res.ok ? res.json() : [];
  }

  let results = await runQuery(trimmed);

  // The search is already scoped to the selected destination, but users
  // naturally still type it (e.g. "M1 krakaw") - and unlike a single bad
  // word, Nominatim finds nothing for the whole phrase if any one word
  // doesn't match anything at all (a typo'd city name, most often). Retrying
  // with the last word dropped recovers exactly that case.
  const words = trimmed.split(/\s+/);
  if (results.length === 0 && words.length > 1) {
    results = await runQuery(words.slice(0, -1).join(" "));
  }

  return results.map(r => {
    const addr = r.address || {};
    const nameParts = r.display_name.split(",");
    const name = nameParts[0].trim();
    const area = addr.city || addr.town || addr.village || addr.suburb || nameParts[1]?.trim();
    return {
      name,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      label: area && area !== name ? `${name}, ${area}` : name
    };
  });
}

// Parses a pasted Google Maps link straight from its URL text - no network
// request, so it works offline and needs no API key. Handles the common
// share-link shapes:
//   .../maps/place/<name>/@<lat>,<lng>,<zoom>z...   (name + viewport center)
//   .../maps/place/<name>/data=...!3d<lat>!4d<lng>  (name + the exact pin,
//                                                     preferred over @lat,lng
//                                                     which is just where the
//                                                     map happened to be
//                                                     centered)
//   .../maps/@<lat>,<lng>,<zoom>z                    (dropped pin, no name)
//   .../maps?q=<lat>,<lng>  or  ?q=<free text name>
// Returns null if the text isn't a Google Maps URL at all, { shortLink: true
// } for goo.gl links (these redirect server-side, which can't be resolved
// from a plain client-side fetch without a backend), or { name, lat, lng }
// with whichever of those three this particular link actually contained.
export function parseGoogleMapsLink(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch (e) {
    return null;
  }
  const host = url.hostname.toLowerCase();

  if (host.endsWith("goo.gl")) {
    return { shortLink: true, name: null, lat: null, lng: null };
  }
  if (!host.includes("google.")) {
    return null;
  }

  let lat = null, lng = null, name = null;

  const pin = rawUrl.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (pin) {
    lat = parseFloat(pin[1]);
    lng = parseFloat(pin[2]);
  } else {
    const view = rawUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+),/);
    if (view) {
      lat = parseFloat(view[1]);
      lng = parseFloat(view[2]);
    }
  }

  const placeMatch = url.pathname.match(/\/maps\/place\/([^/]+)/);
  if (placeMatch) {
    name = decodeURIComponent(placeMatch[1].replace(/\+/g, " "));
  } else {
    const q = url.searchParams.get("q");
    if (q) {
      const coordMatch = q.match(/^(-?\d+\.\d+),\s*(-?\d+\.\d+)$/);
      if (coordMatch && lat == null) {
        lat = parseFloat(coordMatch[1]);
        lng = parseFloat(coordMatch[2]);
      } else if (!coordMatch) {
        name = q;
      }
    }
  }

  return { shortLink: false, name, lat, lng };
}

// --- Locations --------------------------------------------------------------

function locationsCollection() {
  return collection(db, "locations");
}

// values: { name, country, lat, lng }
export async function addLocation(values) {
  const name = values.name.trim();
  const country = values.country.trim();
  if (!name) throw new Error("נא להזין שם למיקום.");
  if (!country) throw new Error("נא להזין מדינה.");
  if (typeof values.lat !== "number" || typeof values.lng !== "number") {
    throw new Error("לא הצלחנו לאתר את המיקום על המפה. נסו שם מדויק יותר.");
  }

  const ref = await withTimeout(addDoc(locationsCollection(), {
    name,
    country,
    lat: values.lat,
    lng: values.lng,
    createdAt: serverTimestamp(),
    createdAtLocal: new Date().toString()
  }), "location:add");
  return ref.id;
}

// Returns [{ id, name, country, lat, lng, createdAt }], in the order they
// were added.
export async function getLocations() {
  const q = query(locationsCollection(), orderBy("createdAt", "asc"));
  const snap = await withTimeout(getDocs(q), "location:list");
  return snap.docs.map(docSnap => {
    const data = docSnap.data();
    return {
      id: docSnap.id,
      name: data.name,
      country: data.country,
      lat: data.lat,
      lng: data.lng,
      createdAt: data.createdAt ? data.createdAt.toDate() : new Date(data.createdAtLocal)
    };
  });
}

export async function deleteLocation(id) {
  await withTimeout(deleteDoc(doc(db, "locations", id)), "location:delete");
}

// --- Places -------------------------------------------------------------

function placesCollection() {
  return collection(db, "places");
}

// values: { locationId, name, category, lat, lng, notes }
// Shared by add and update - keeps their validation from drifting apart.
function buildPlaceFields(values) {
  const name = values.name.trim();
  const notes = (values.notes || "").trim();
  if (!values.locationId) throw new Error("נא לבחור מיקום קודם.");
  if (!name) throw new Error("נא להזין שם למקום.");
  if (!PLACE_CATEGORIES.includes(values.category)) throw new Error("נא לבחור קטגוריה.");
  if (typeof values.lat !== "number" || typeof values.lng !== "number") {
    throw new Error("לא הצלחנו לאתר את המקום על המפה. נסו שם מדויק יותר.");
  }
  return {
    locationId: values.locationId,
    name,
    category: values.category,
    lat: values.lat,
    lng: values.lng,
    notes
  };
}

export async function addPlace(values) {
  const fields = buildPlaceFields(values);
  const ref = await withTimeout(addDoc(placesCollection(), {
    ...fields,
    createdAt: serverTimestamp(),
    createdAtLocal: new Date().toString()
  }), "place:add");
  return ref.id;
}

// Overwrites an existing place's editable fields (name, category, notes,
// and its coordinates if the edit picked a new suggestion/link).
export async function updatePlace(id, values) {
  const fields = buildPlaceFields(values);
  await withTimeout(updateDoc(doc(db, "places", id), fields), "place:update");
}

// Returns [{ id, locationId, name, category, lat, lng, notes, createdAt }]
// for one location, newest first. Sorted client-side after a plain equality
// query (no orderBy) so this never needs a Firestore composite index.
export async function getPlacesByLocation(locationId) {
  const q = query(placesCollection(), where("locationId", "==", locationId));
  const snap = await withTimeout(getDocs(q), "place:list");
  const places = snap.docs.map(docSnap => {
    const data = docSnap.data();
    return {
      id: docSnap.id,
      locationId: data.locationId,
      name: data.name,
      category: data.category,
      lat: data.lat,
      lng: data.lng,
      notes: data.notes || "",
      createdAt: data.createdAt ? data.createdAt.toDate() : new Date(data.createdAtLocal)
    };
  });
  places.sort((a, b) => b.createdAt - a.createdAt);
  return places;
}

export async function deletePlace(id) {
  await withTimeout(deleteDoc(doc(db, "places", id)), "place:delete");
}

// --- Trip plans -----------------------------------------------------------
// Each trip is one plan (e.g. "טיול משפחתי - 4 ימים") tied to a location,
// holding a table of days: { date, dayLabel, morning, afternoon, evening,
// logistics }. The whole `days` array is overwritten together on update -
// simpler than per-row Firestore writes, and trips are small (a handful of
// days) so this stays cheap.

function tripsCollection() {
  return collection(db, "trips");
}

function cleanDay(d) {
  return {
    date: (d.date || "").trim(),
    dayLabel: (d.dayLabel || "").trim(),
    morning: (d.morning || "").trim(),
    afternoon: (d.afternoon || "").trim(),
    evening: (d.evening || "").trim(),
    logistics: (d.logistics || "").trim()
  };
}

// values: { locationId, name, days: [] }
export async function addTrip(values) {
  const name = values.name.trim();
  if (!values.locationId) throw new Error("נא לבחור מיקום קודם.");
  if (!name) throw new Error("נא להזין שם/סוג לטיול.");

  const days = (values.days || []).map(cleanDay);

  const ref = await withTimeout(addDoc(tripsCollection(), {
    locationId: values.locationId,
    name,
    days,
    createdAt: serverTimestamp(),
    createdAtLocal: new Date().toString()
  }), "trip:add");
  return ref.id;
}

// Returns [{ id, locationId, name, days, createdAt }] for one location,
// newest first. Sorted client-side after a plain equality query (no
// orderBy) so this never needs a Firestore composite index.
export async function getTripsByLocation(locationId) {
  const q = query(tripsCollection(), where("locationId", "==", locationId));
  const snap = await withTimeout(getDocs(q), "trip:list");
  const trips = snap.docs.map(docSnap => {
    const data = docSnap.data();
    return {
      id: docSnap.id,
      locationId: data.locationId,
      name: data.name,
      days: data.days || [],
      createdAt: data.createdAt ? data.createdAt.toDate() : new Date(data.createdAtLocal)
    };
  });
  trips.sort((a, b) => b.createdAt - a.createdAt);
  return trips;
}

// Overwrites a trip's name and/or full day table.
export async function updateTrip(id, values) {
  const fields = {};
  if (typeof values.name === "string") {
    const name = values.name.trim();
    if (!name) throw new Error("נא להזין שם/סוג לטיול.");
    fields.name = name;
  }
  if (Array.isArray(values.days)) {
    fields.days = values.days.map(cleanDay);
  }
  await withTimeout(updateDoc(doc(db, "trips", id), fields), "trip:update");
}

export async function deleteTrip(id) {
  await withTimeout(deleteDoc(doc(db, "trips", id)), "trip:delete");
}

// --- Custom place categories -----------------------------------------------
// User-added categories on top of the PLACE_CATEGORIES built-ins, shared
// across everyone using the app (same no-login model as everything else).

function categoriesCollection() {
  return collection(db, "categories");
}

export async function addCategory(name) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("נא להזין שם לקטגוריה.");
  await withTimeout(addDoc(categoriesCollection(), {
    name: trimmed,
    createdAt: serverTimestamp(),
    createdAtLocal: new Date().toString()
  }), "category:add");
}

// Returns custom category names as a plain string array, in the order they
// were added. Sorted client-side after a plain fetch (no orderBy) so this
// never needs a Firestore composite index.
export async function getCategories() {
  const snap = await withTimeout(getDocs(categoriesCollection()), "category:list");
  const docs = snap.docs.map(d => ({
    name: d.data().name,
    createdAt: d.data().createdAt ? d.data().createdAt.toDate() : new Date(d.data().createdAtLocal)
  }));
  docs.sort((a, b) => a.createdAt - b.createdAt);
  return docs.map(d => d.name);
}
