import {
  PLACE_CATEGORIES,
  geocode, searchLocationSuggestions, searchPlaceSuggestions, parseGoogleMapsLink,
  addLocation, getLocations, deleteLocation,
  addPlace, getPlacesByLocation, updatePlace, deletePlace,
  addTrip, getTripsByLocation, updateTrip, deleteTrip,
  addCategory, getCategories,
  addRouteDay, updateRoutePoints, finishRouteDay, getRouteDays, deleteRouteDay
} from "./db.js";

const $ = sel => document.querySelector(sel);

const CATEGORY_EMOJI = {
  "מסעדה": "🍽️",
  "אתר תיירות": "🏛️",
  "תצפית": "🔭",
  "קניות": "🛍️",
  "מלון": "🏨",
  "אחר": "📍"
};
const CUSTOM_CATEGORY_EMOJI = "🏷️"; // fallback for any user-added category
const WEEKDAYS_HE = ["יום א׳", "יום ב׳", "יום ג׳", "יום ד׳", "יום ה׳", "יום ו׳", "שבת"];

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function toDateInputValue(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDateHe(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function dayLabelForDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  return isNaN(d) ? "" : WEEKDAYS_HE[d.getDay()];
}

// Google's documented universal Maps URL (developers.google.com/maps/documentation/urls) -
// no API key needed, opens the web site on desktop and deep-links straight
// into the native Google Maps app on a phone.
function googleMapsUrl(lat, lng) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

const OPEN_EXTERNAL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>`;

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

const state = {
  locations: [],
  selectedLocationId: localStorage.getItem("travel_selected_location") || null,
  places: [],
  trips: [],
  activePlaceCategory: "all",
  locationFilterQuery: "",
  placeFilterQuery: "",
  customCategories: [], // user-added categories on top of the PLACE_CATEGORIES built-ins
  currentTrip: null, // deep-cloned trip being edited in the detail view
  userPos: null, // { lat, lng } from the most recent geolocation fix
  walkingInfo: {}, // placeId -> { minutes, meters }, from OSRM's foot-routing table
  routeDays: [], // every recorded day, newest first - see "Route recording" below
  selectedRouteDayOrder: [], // ids of route days shown on the map, in selection order (picks each one's color)
  recording: null // { routeId, date, points, startedAtMs, lastSavedCount } while a route is being recorded, else null
};

function allCategories() {
  return PLACE_CATEGORIES.concat(state.customCategories);
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 2400);
}

// ---------------------------------------------------------------------------
// Theme toggle
// ---------------------------------------------------------------------------

$("#theme-toggle-btn").addEventListener("click", () => {
  const isDark = document.documentElement.getAttribute("data-theme") === "dark";
  if (isDark) {
    document.documentElement.removeAttribute("data-theme");
    localStorage.setItem("travel_theme", "light");
  } else {
    document.documentElement.setAttribute("data-theme", "dark");
    localStorage.setItem("travel_theme", "dark");
  }
});

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

const map = L.map("map", { zoomControl: true, attributionControl: true }).setView([46, 10], 4);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

// Leaflet measures its container once, at creation time. On iOS in
// particular that can happen before Safari's chrome (address bar, PWA
// splash) has finished settling into its final size, so the map silently
// renders at the wrong size (often blank) until something tells it to
// re-measure. invalidateSize() is that "re-measure" call - firing it after
// a short delay on load, and again on resize/orientation/tab-foreground,
// covers the cases that actually trigger this on phones.
setTimeout(() => map.invalidateSize(), 300);
window.addEventListener("resize", () => map.invalidateSize());
window.addEventListener("orientationchange", () => setTimeout(() => map.invalidateSize(), 300));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    map.invalidateSize();
    // the page may have been backgrounded/suspended past midnight without
    // the setTimeout/setInterval below ever getting to run - catch that up
    // as soon as we're foregrounded again instead of waiting on them.
    if (state.recording) checkRecordingDateRollover();
  } else if (state.recording) {
    flushRecordingPoints();
  }
});

const placeMarkersLayer = L.layerGroup().addTo(map);
const placeMarkerById = new Map();
const recordedRoutesLayer = L.layerGroup().addTo(map); // finalized/selected route-recording polylines

let userMarker = null;
let locationMarker = null;
let routeLayer = null;
let liveRecordingLayer = null; // the growing polyline while a recording is in progress

function emojiIcon(emoji, size) {
  return L.divIcon({
    html: `<div class="marker-emoji" style="font-size:${size || 26}px">${emoji}</div>`,
    className: "",
    iconSize: [size || 26, size || 26],
    iconAnchor: [(size || 26) / 2, size || 26]
  });
}

function locateMe(fly) {
  if (!("geolocation" in navigator)) return;
  navigator.geolocation.getCurrentPosition(
    pos => {
      const latlng = [pos.coords.latitude, pos.coords.longitude];
      state.userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (!userMarker) {
        userMarker = L.marker(latlng, {
          icon: L.divIcon({ html: '<div class="marker-user"></div>', className: "", iconSize: [18, 18] }),
          zIndexOffset: 500
        }).addTo(map);
      } else {
        userMarker.setLatLng(latlng);
      }
      if (fly) map.flyTo(latlng, 13);
      else if (!state.selectedLocationId) map.setView(latlng, 12);
    },
    () => { if (fly) toast("לא ניתן לאתר את המיקום שלכם"); },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

$("#locate-btn").addEventListener("click", () => locateMe(true));

// A fresh, awaitable GPS fix used before computing walking times - a
// "כבר אותרתם" position from app load could be minutes/km stale by the time
// someone opens the places list, so this always asks again rather than
// reusing state.userPos as-is. Resolves to null (never rejects) on missing
// permission/support/timeout, so callers can just skip the walking-time
// feature silently instead of surfacing a geolocation error for what's a
// nice-to-have.
function getFreshPosition() {
  return new Promise(resolve => {
    if (!("geolocation" in navigator)) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}

// Batch walking time+distance from the user's current position to every
// place in the selected destination, in one request via OSRM's public
// routing demo server (free, no API key - real street routing, not just
// straight-line distance). Best-effort: any failure just leaves
// state.walkingInfo empty rather than surfacing an error, since this is a
// nice-to-have on top of the places list, not core functionality.
async function computeWalkingTimes() {
  if (!state.userPos || state.places.length === 0) {
    state.walkingInfo = {};
    return;
  }
  try {
    const coords = [`${state.userPos.lng},${state.userPos.lat}`]
      .concat(state.places.map(p => `${p.lng},${p.lat}`))
      .join(";");
    const destinations = state.places.map((_, i) => i + 1).join(";");
    const res = await fetch(
      `https://router.project-osrm.org/table/v1/foot/${coords}?sources=0&destinations=${destinations}&annotations=duration,distance`
    );
    if (!res.ok) { state.walkingInfo = {}; return; }
    const data = await res.json();
    const durations = (data.durations && data.durations[0]) || [];
    const distances = (data.distances && data.distances[0]) || [];
    const info = {};
    state.places.forEach((p, i) => {
      if (durations[i] != null && distances[i] != null) {
        info[p.id] = { minutes: Math.round(durations[i] / 60), meters: distances[i] };
      }
    });
    state.walkingInfo = info;
  } catch (e) {
    state.walkingInfo = {};
  }
}

function formatWalkInfo(info) {
  const distLabel = info.meters >= 1000
    ? `${(info.meters / 1000).toFixed(1)} ק"מ`
    : `${Math.round(info.meters / 10) * 10} מ'`;
  const minutesLabel = info.minutes < 1 ? "פחות מדקה" : `${info.minutes} דק׳`;
  return `🚶 ${minutesLabel} הליכה (${distLabel})`;
}

// Draws the actual walking path (not just a straight line) from a fresh GPS
// fix to `place`, via the same free OSRM routing server used for the
// walking-time badges - overview=full+geometries=geojson here asks it for
// the route's full coordinate list instead of just duration/distance.
// Replaces any previously drawn route. Best-effort: shows a toast instead of
// drawing anything if GPS or the routing request fails.
async function drawWalkingRoute(place) {
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }

  const pos = await getFreshPosition();
  if (!pos) { toast("לא ניתן לאתר את המיקום שלכם"); return; }
  state.userPos = pos;

  try {
    const res = await fetch(
      `https://router.project-osrm.org/route/v1/foot/${pos.lng},${pos.lat};${place.lng},${place.lat}?overview=full&geometries=geojson`
    );
    if (!res.ok) throw new Error("routing failed");
    const data = await res.json();
    const route = data.routes && data.routes[0];
    if (!route) throw new Error("no route found");

    const latlngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    routeLayer = L.polyline(latlngs, {
      color: "#1f7a6c",
      weight: 5,
      opacity: 0.85,
      dashArray: "1,9",
      lineCap: "round"
    }).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [60, 60] });
    toast(formatWalkInfo({ minutes: Math.round(route.duration / 60), meters: route.distance }));
  } catch (e) {
    toast("לא ניתן היה לחשב מסלול הליכה למקום הזה");
  }
}

// ---------------------------------------------------------------------------
// Sheets: generic open/close/view-switch plumbing
// ---------------------------------------------------------------------------

const SHEETS = {
  locations: {
    el: $("#locations-sheet"),
    title: $("#locations-title"),
    defaultTitle: "מיקומים",
    backBtn: $("#locations-back-btn"),
    addBtn: $("#locations-add-btn"),
    closeBtn: $("#locations-close-btn"),
    navBtn: $("#nav-locations-btn"),
    views: { list: $("#locations-list-view"), form: $("#location-form-view") },
    currentView: "list"
  },
  places: {
    el: $("#places-sheet"),
    title: $("#places-title"),
    defaultTitle: "מקומות",
    backBtn: $("#places-back-btn"),
    addBtn: $("#places-add-btn"),
    closeBtn: $("#places-close-btn"),
    navBtn: $("#nav-places-btn"),
    views: { list: $("#places-list-view"), form: $("#place-form-view") },
    currentView: "list"
  },
  trips: {
    el: $("#trips-sheet"),
    title: $("#trips-title"),
    defaultTitle: "תכנון טיול",
    backBtn: $("#trips-back-btn"),
    addBtn: $("#trips-add-btn"),
    closeBtn: $("#trips-close-btn"),
    navBtn: $("#nav-trips-btn"),
    views: { list: $("#trips-list-view"), form: $("#trip-form-view"), detail: $("#trip-detail-view") },
    currentView: "list"
  },
  routes: {
    el: $("#routes-sheet"),
    title: $("#routes-title"),
    defaultTitle: "הקלטת מסלול",
    backBtn: null, // single-view sheet - no back/add buttons in its header
    addBtn: null,
    closeBtn: $("#routes-close-btn"),
    navBtn: $("#nav-routes-btn"),
    views: { list: $("#routes-list-view") },
    currentView: "list"
  }
};

function showView(key, viewName, title) {
  const s = SHEETS[key];
  Object.entries(s.views).forEach(([name, el]) => el.classList.toggle("hidden", name !== viewName));
  s.currentView = viewName;
  s.title.textContent = title || s.defaultTitle;
  if (s.backBtn) s.backBtn.classList.toggle("hidden", viewName === "list");
  if (s.addBtn) s.addBtn.classList.toggle("hidden", viewName !== "list");
}

function closeSheet(key) {
  SHEETS[key].el.classList.remove("open");
  SHEETS[key].navBtn.classList.remove("active");
  if (!Object.values(SHEETS).some(s => s.el.classList.contains("open"))) {
    $("#sheet-backdrop").classList.remove("visible");
  }
}

function closeAllSheets() {
  Object.keys(SHEETS).forEach(closeSheet);
}

function openSheet(key) {
  Object.keys(SHEETS).forEach(k => { if (k !== key) closeSheet(k); });
  const s = SHEETS[key];
  s.el.classList.add("open");
  s.navBtn.classList.add("active");
  $("#sheet-backdrop").classList.add("visible");
  showView(key, "list");
  if (key === "locations") renderLocationsList();
  if (key === "places") refreshPlacesView();
  if (key === "trips") refreshTripsView();
  if (key === "routes") { updateRecordUi(); loadRouteDays(); }
}

function toggleSheet(key) {
  if (SHEETS[key].el.classList.contains("open")) closeSheet(key);
  else openSheet(key);
}

Object.entries(SHEETS).forEach(([key, s]) => {
  s.navBtn.addEventListener("click", () => toggleSheet(key));
  s.closeBtn.addEventListener("click", () => closeSheet(key));
});

$("#sheet-backdrop").addEventListener("click", closeAllSheets);

$("#current-location-chip").addEventListener("click", () => openSheet("locations"));

$("#locations-back-btn").addEventListener("click", () => showView("locations", "list"));
$("#places-back-btn").addEventListener("click", () => showView("places", "list"));
$("#trips-back-btn").addEventListener("click", async () => {
  if (SHEETS.trips.currentView === "detail") {
    await saveCurrentTrip(true);
  }
  showView("trips", "list");
  renderTripsList();
});

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

function renderLocationsList() {
  const list = $("#locations-list");
  list.innerHTML = "";
  $("#locations-empty").classList.toggle("hidden", state.locations.length > 0);

  const query = state.locationFilterQuery.trim().toLowerCase();
  const filtered = query
    ? state.locations.filter(loc =>
        loc.name.toLowerCase().includes(query) || loc.country.toLowerCase().includes(query)
      )
    : state.locations;

  $("#locations-search-empty").classList.toggle("hidden", !(state.locations.length > 0 && query && filtered.length === 0));

  filtered.forEach(loc => {
    const card = document.createElement("div");
    card.className = "item-card" + (loc.id === state.selectedLocationId ? " selected" : "");
    card.innerHTML = `
      <div class="item-icon">📍</div>
      <div class="item-text">
        <p class="item-title">${escapeHtml(loc.name)}</p>
        <p class="item-subtitle">${escapeHtml(loc.country)}</p>
      </div>
      <button class="icon-btn-ghost" aria-label="פתיחה ב-Google Maps" data-action="open-maps">
        ${OPEN_EXTERNAL_ICON}
      </button>
      <button class="icon-btn-ghost danger" aria-label="מחיקה" data-action="delete">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>
      </button>
    `;
    card.addEventListener("click", e => {
      if (e.target.closest('[data-action="delete"]') || e.target.closest('[data-action="open-maps"]')) return;
      selectLocation(loc.id);
      closeSheet("locations");
    });
    card.querySelector('[data-action="open-maps"]').addEventListener("click", () => {
      window.open(googleMapsUrl(loc.lat, loc.lng), "_blank", "noopener");
    });
    card.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      if (!confirm(`למחוק את "${loc.name}"?`)) return;
      try {
        await deleteLocation(loc.id);
        if (state.selectedLocationId === loc.id) {
          state.selectedLocationId = null;
          localStorage.removeItem("travel_selected_location");
          $("#current-location-chip").textContent = "בחרו מיקום";
          $("#current-location-chip").classList.remove("is-set");
          if (locationMarker) { map.removeLayer(locationMarker); locationMarker = null; }
          state.places = [];
          state.trips = [];
          renderPlaceMarkers();
        }
        await loadLocations();
      } catch (err) {
        toast(err.message);
      }
    });
    list.appendChild(card);
  });
}

async function loadLocations() {
  state.locations = await getLocations();
  renderLocationsList();
}

async function selectLocation(id, opts) {
  opts = opts || {};
  const loc = state.locations.find(l => l.id === id);
  if (!loc) return;

  state.selectedLocationId = id;
  localStorage.setItem("travel_selected_location", id);

  const chip = $("#current-location-chip");
  chip.textContent = `📍 ${loc.name}, ${loc.country}`;
  chip.classList.add("is-set");

  if (!locationMarker) {
    locationMarker = L.marker([loc.lat, loc.lng], { icon: emojiIcon("📌", 30), zIndexOffset: 400 }).addTo(map);
  } else {
    locationMarker.setLatLng([loc.lat, loc.lng]);
  }
  locationMarker.bindPopup(`<b>${escapeHtml(loc.name)}</b><br>${escapeHtml(loc.country)}`);

  if (!opts.skipFly) map.flyTo([loc.lat, loc.lng], 12);

  renderLocationsList();

  state.walkingInfo = {}; // stale until updateWalkingTimes() recomputes for the new destination
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  try {
    state.places = await getPlacesByLocation(id);
  } catch (err) {
    state.places = [];
    toast(err.message);
  }
  renderPlaceMarkers();
  if (SHEETS.places.el.classList.contains("open")) refreshPlacesView();

  try {
    state.trips = await getTripsByLocation(id);
  } catch (err) {
    state.trips = [];
    toast(err.message);
  }
  if (SHEETS.trips.el.classList.contains("open")) refreshTripsView();
}

$("#locations-filter-input").addEventListener("input", e => {
  state.locationFilterQuery = e.target.value;
  renderLocationsList();
});

$("#locations-add-btn").addEventListener("click", () => {
  $("#location-form-error").classList.add("hidden");
  $("#location-search-input").value = "";
  currentLocationSuggestions = [];
  renderLocationSuggestions([]);
  showView("locations", "form", "מיקום חדש");
  $("#location-search-input").focus({ preventScroll: true });
});

// --- Location autosuggest: search-as-you-type against Nominatim ----------

let currentLocationSuggestions = [];
let locationSearchDebounce;
let locationSearchAbort;

function renderLocationSuggestions(list) {
  const box = $("#location-suggestions");
  box.innerHTML = "";
  box.classList.toggle("hidden", list.length === 0);
  list.forEach(item => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "suggestion-item";
    row.innerHTML = `<span class="suggestion-emoji">📍</span><span>${escapeHtml(item.label)}</span>`;
    row.addEventListener("click", () => addSuggestedLocation(item));
    box.appendChild(row);
  });
}

async function addSuggestedLocation(item) {
  const errorEl = $("#location-form-error");
  errorEl.classList.add("hidden");
  try {
    const id = await addLocation({ name: item.name, country: item.country, lat: item.lat, lng: item.lng });
    await loadLocations();
    await selectLocation(id);
    showView("locations", "list");
    closeSheet("locations");
    toast("המיקום נוסף!");
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
  }
}

$("#location-search-input").addEventListener("input", e => {
  const value = e.target.value;
  clearTimeout(locationSearchDebounce);
  if (value.trim().length < 3) {
    currentLocationSuggestions = [];
    renderLocationSuggestions([]);
    return;
  }
  locationSearchDebounce = setTimeout(async () => {
    if (locationSearchAbort) locationSearchAbort.abort();
    locationSearchAbort = new AbortController();
    try {
      currentLocationSuggestions = await searchLocationSuggestions(value, locationSearchAbort.signal);
      renderLocationSuggestions(currentLocationSuggestions);
    } catch (err) {
      if (err.name !== "AbortError") renderLocationSuggestions([]);
    }
  }, 350);
});

// Enter key (or any implicit form submit): fall back to the top current
// suggestion, or run one last search if the debounce hasn't resolved yet.
$("#location-form-view").addEventListener("submit", async e => {
  e.preventDefault();
  const errorEl = $("#location-form-error");
  errorEl.classList.add("hidden");

  if (currentLocationSuggestions.length > 0) {
    await addSuggestedLocation(currentLocationSuggestions[0]);
    return;
  }
  const value = $("#location-search-input").value.trim();
  if (!value) return;
  try {
    const results = await searchLocationSuggestions(value);
    if (results.length === 0) throw new Error("לא נמצא יעד מתאים. נסו שם מדויק יותר.");
    await addSuggestedLocation(results[0]);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
  }
});

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

function renderPlaceMarkers() {
  placeMarkersLayer.clearLayers();
  placeMarkerById.clear();
  state.places.forEach(p => {
    const marker = L.marker([p.lat, p.lng], { icon: emojiIcon(CATEGORY_EMOJI[p.category] || CUSTOM_CATEGORY_EMOJI) });
    marker.bindPopup(
      `<b>${escapeHtml(p.name)}</b><br>${escapeHtml(p.category)}` +
      (p.notes ? `<br>${escapeHtml(p.notes)}` : "")
    );
    marker.addTo(placeMarkersLayer);
    placeMarkerById.set(p.id, marker);
  });
}

function renderPlaceCategoryFilter() {
  const row = $("#places-category-filter");
  row.innerHTML = "";
  const options = [{ key: "all", label: "הכל", emoji: "🗺️" }].concat(
    allCategories().map(c => ({ key: c, label: c, emoji: CATEGORY_EMOJI[c] || CUSTOM_CATEGORY_EMOJI }))
  );
  options.forEach(opt => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (state.activePlaceCategory === opt.key ? " active" : "");
    chip.textContent = `${opt.emoji} ${opt.label}`;
    chip.addEventListener("click", () => {
      state.activePlaceCategory = opt.key;
      renderPlaceCategoryFilter();
      renderPlacesList();
    });
    row.appendChild(chip);
  });
}

function renderPlacesList() {
  const list = $("#places-list");
  list.innerHTML = "";
  const query = state.placeFilterQuery.trim().toLowerCase();

  const filtered = state.places
    .filter(p => state.activePlaceCategory === "all" || p.category === state.activePlaceCategory)
    .filter(p => !query || p.name.toLowerCase().includes(query) || p.notes.toLowerCase().includes(query));

  $("#places-empty").classList.toggle("hidden", state.places.length > 0);
  $("#places-search-empty").classList.toggle("hidden", !(state.places.length > 0 && filtered.length === 0));

  filtered.forEach(p => {
    const card = document.createElement("div");
    card.className = "item-card";
    card.innerHTML = `
      <div class="item-icon">${CATEGORY_EMOJI[p.category] || CUSTOM_CATEGORY_EMOJI}</div>
      <div class="item-text">
        <p class="item-title">${escapeHtml(p.name)}</p>
        <p class="item-subtitle">${escapeHtml(p.notes || p.category)}</p>
        ${state.walkingInfo[p.id] ? `<p class="item-walk">${escapeHtml(formatWalkInfo(state.walkingInfo[p.id]))}</p>` : ""}
      </div>
      <button class="icon-btn-ghost" aria-label="פתיחה ב-Google Maps" data-action="open-maps">
        ${OPEN_EXTERNAL_ICON}
      </button>
      <button class="icon-btn-ghost" aria-label="עריכה" data-action="edit">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>
      </button>
      <button class="icon-btn-ghost danger" aria-label="מחיקה" data-action="delete">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>
      </button>
    `;
    card.addEventListener("click", e => {
      if (e.target.closest('[data-action="delete"]') || e.target.closest('[data-action="open-maps"]') || e.target.closest('[data-action="edit"]')) return;
      map.flyTo([p.lat, p.lng], 16);
      const marker = placeMarkerById.get(p.id);
      if (marker) setTimeout(() => marker.openPopup(), 400);
      closeSheet("places");
      drawWalkingRoute(p);
    });
    card.querySelector('[data-action="open-maps"]').addEventListener("click", () => {
      window.open(googleMapsUrl(p.lat, p.lng), "_blank", "noopener");
    });
    card.querySelector('[data-action="edit"]').addEventListener("click", () => openEditPlaceForm(p));
    card.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      if (!confirm(`למחוק את "${p.name}"?`)) return;
      try {
        await deletePlace(p.id);
        state.places = state.places.filter(x => x.id !== p.id);
        renderPlaceMarkers();
        renderPlacesList();
      } catch (err) {
        toast(err.message);
      }
    });
    list.appendChild(card);
  });
}

function refreshPlacesView() {
  const hasLocation = !!state.selectedLocationId;
  $("#places-no-location").classList.toggle("hidden", hasLocation);
  $("#places-content").classList.toggle("hidden", !hasLocation);
  $("#places-add-btn").disabled = !hasLocation;
  if (hasLocation) {
    renderPlaceCategoryFilter();
    renderPlacesList();
    updateWalkingTimes();
  }
}

// Refreshes GPS + walking times in the background and re-renders once ready,
// so opening the sheet shows the list immediately and the walk badges pop in
// a moment later rather than blocking on a GPS fix + a network round trip.
let walkingTimesRequestId = 0;
async function updateWalkingTimes() {
  const requestId = ++walkingTimesRequestId;
  const pos = await getFreshPosition();
  if (requestId !== walkingTimesRequestId) return; // a newer refresh superseded this one
  if (pos) state.userPos = pos;
  await computeWalkingTimes();
  if (requestId !== walkingTimesRequestId) return;
  renderPlacesList();
}

$("#places-go-to-locations-btn").addEventListener("click", () => openSheet("locations"));

$("#places-filter-input").addEventListener("input", e => {
  state.placeFilterQuery = e.target.value;
  renderPlacesList();
});

let editingPlaceId = null; // set while place-form-view is editing an existing place instead of adding a new one

$("#places-add-btn").addEventListener("click", () => {
  if (!state.selectedLocationId) return;
  editingPlaceId = null;
  $("#place-form-error").classList.add("hidden");
  $("#place-name-input").value = "";
  $("#place-notes-input").value = "";
  selectedPlaceGeo = null;
  currentPlaceSuggestions = [];
  renderPlaceSuggestions([]);
  buildPlaceCategoryPicker();
  $("#place-form-submit").textContent = "הוספת מקום";
  showView("places", "form", "מקום חדש");
  $("#place-name-input").focus({ preventScroll: true });
});

// Reuses the add-place form to edit an existing one: prefills its fields and
// keeps its current coordinates unless the edit picks a new suggestion/link,
// same as a fresh add would.
function openEditPlaceForm(p) {
  editingPlaceId = p.id;
  $("#place-form-error").classList.add("hidden");
  $("#place-name-input").value = p.name;
  $("#place-notes-input").value = p.notes;
  selectedPlaceGeo = { lat: p.lat, lng: p.lng };
  currentPlaceSuggestions = [];
  renderPlaceSuggestions([]);
  buildPlaceCategoryPicker(p.category);
  $("#place-form-submit").textContent = "שמירת שינויים";
  showView("places", "form", "עריכת מקום");
}

function buildPlaceCategoryPicker(activeCategory) {
  const picker = $("#place-category-picker");
  picker.innerHTML = "";
  allCategories().forEach(cat => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip" + (cat === activeCategory ? " active" : "");
    chip.textContent = `${CATEGORY_EMOJI[cat] || CUSTOM_CATEGORY_EMOJI} ${cat}`;
    chip.dataset.category = cat;
    chip.addEventListener("click", () => {
      picker.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
    });
    picker.appendChild(chip);
  });

  const addChip = document.createElement("button");
  addChip.type = "button";
  addChip.className = "chip chip-add";
  addChip.textContent = "+ קטגוריה חדשה";
  addChip.addEventListener("click", addCustomCategory);
  picker.appendChild(addChip);
}

// Prompts for a new category name, saves it to Firestore (shared with
// everyone, same as the rest of the app's data), and rebuilds the picker
// with it selected - so adding one flows straight into using it.
async function addCustomCategory() {
  const name = (prompt("שם הקטגוריה החדשה:") || "").trim();
  if (!name) return;
  const exists = allCategories().some(c => c.toLowerCase() === name.toLowerCase());
  if (exists) {
    toast("הקטגוריה הזו כבר קיימת.");
    return;
  }
  try {
    await addCategory(name);
    state.customCategories.push(name);
    buildPlaceCategoryPicker(name);
    renderPlaceCategoryFilter();
  } catch (err) {
    toast(err.message);
  }
}

// --- Place autosuggest: search-as-you-type, biased near the selected
// destination so a common name matches locally instead of globally --------

let selectedPlaceGeo = null;
let currentPlaceSuggestions = [];
let placeSearchDebounce;
let placeSearchAbort;

function renderPlaceSuggestions(list) {
  const box = $("#place-suggestions");
  box.innerHTML = "";
  box.classList.toggle("hidden", list.length === 0);
  list.forEach(item => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "suggestion-item";
    row.innerHTML = `<span class="suggestion-emoji">📍</span><span>${escapeHtml(item.label)}</span>`;
    row.addEventListener("click", () => {
      $("#place-name-input").value = item.name;
      selectedPlaceGeo = { lat: item.lat, lng: item.lng };
      currentPlaceSuggestions = [];
      renderPlaceSuggestions([]);
    });
    box.appendChild(row);
  });
}

// Pasting a Google Maps link into the same field is handled separately from
// a normal text search - see handlePastedMapsLink below.
function looksLikeUrl(value) {
  return /^https?:\/\//i.test(value.trim());
}

$("#place-name-input").addEventListener("input", e => {
  const value = e.target.value;
  if (looksLikeUrl(value)) {
    handlePastedMapsLink(value.trim());
    return;
  }
  selectedPlaceGeo = null; // typing again invalidates a previously picked suggestion/link
  clearTimeout(placeSearchDebounce);
  if (value.trim().length < 3) {
    currentPlaceSuggestions = [];
    renderPlaceSuggestions([]);
    return;
  }
  const loc = state.locations.find(l => l.id === state.selectedLocationId);
  if (!loc) return;
  placeSearchDebounce = setTimeout(async () => {
    if (placeSearchAbort) placeSearchAbort.abort();
    placeSearchAbort = new AbortController();
    try {
      currentPlaceSuggestions = await searchPlaceSuggestions(value, { lat: loc.lat, lng: loc.lng }, placeSearchAbort.signal);
      renderPlaceSuggestions(currentPlaceSuggestions);
    } catch (err) {
      if (err.name !== "AbortError") renderPlaceSuggestions([]);
    }
  }, 350);
});

// A pasted Google Maps link is parsed locally (no network call, no API key -
// see parseGoogleMapsLink in db.js). When it carries exact coordinates we
// set them directly and deliberately DON'T dispatch a synthetic "input"
// event when filling in the suggested name, so the field-input listener
// above never re-fires and clear them - the user can freely edit the
// suggested name afterwards without losing the parsed location. When the
// link only carries a name (e.g. a "?q=" text link, no coordinates), we do
// dispatch one so the normal nearby-search runs to help resolve it.
function handlePastedMapsLink(url) {
  clearTimeout(placeSearchDebounce);
  currentPlaceSuggestions = [];
  renderPlaceSuggestions([]);
  const errorEl = $("#place-form-error");
  errorEl.classList.add("hidden");

  const parsed = parseGoogleMapsLink(url);
  if (!parsed) {
    errorEl.textContent = "זה לא נראה כמו קישור Google Maps תקין.";
    errorEl.classList.remove("hidden");
    return;
  }
  if (parsed.shortLink) {
    errorEl.textContent = "קישורים מקוצרים (maps.app.goo.gl) לא נתמכים - פתחו אותו בדפדפן והדביקו את הכתובת המלאה מסרגל הכתובת, או פשוט הקלידו את שם המקום.";
    errorEl.classList.remove("hidden");
    return;
  }

  if (parsed.lat != null && parsed.lng != null) {
    selectedPlaceGeo = { lat: parsed.lat, lng: parsed.lng };
    if (parsed.name) $("#place-name-input").value = parsed.name;
    toast("הקישור זוהה! אפשר לערוך את השם ולבחור קטגוריה.");
  } else if (parsed.name) {
    selectedPlaceGeo = null;
    $("#place-name-input").value = parsed.name;
    $("#place-name-input").dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    errorEl.textContent = "לא הצלחנו לזהות מיקום מהקישור. נסו להעתיק את הקישור המלא מהדפדפן, או הקלידו את שם המקום.";
    errorEl.classList.remove("hidden");
  }
}

$("#place-form-view").addEventListener("submit", async e => {
  e.preventDefault();
  const errorEl = $("#place-form-error");
  errorEl.classList.add("hidden");

  const activeChip = $("#place-category-picker .chip.active");
  const category = activeChip ? activeChip.dataset.category : null;
  const name = $("#place-name-input").value.trim();
  const notes = $("#place-notes-input").value.trim();
  const loc = state.locations.find(l => l.id === state.selectedLocationId);
  const submitBtn = $("#place-form-submit");

  if (!category) {
    errorEl.textContent = "נא לבחור קטגוריה.";
    errorEl.classList.remove("hidden");
    return;
  }

  const isEditing = !!editingPlaceId;
  submitBtn.disabled = true;
  submitBtn.textContent = isEditing ? "שומר..." : "מאתר במפה...";
  try {
    let geo = selectedPlaceGeo;
    if (!geo) {
      geo = await geocode(`${name}, ${loc.name}, ${loc.country}`);
    }
    if (!geo) throw new Error("לא נמצא מקום מתאים. נסו טקסט חיפוש מדויק יותר.");
    if (isEditing) {
      await updatePlace(editingPlaceId, { locationId: loc.id, name, category, lat: geo.lat, lng: geo.lng, notes });
    } else {
      await addPlace({ locationId: loc.id, name, category, lat: geo.lat, lng: geo.lng, notes });
    }
    state.places = await getPlacesByLocation(loc.id);
    renderPlaceMarkers();
    refreshPlacesView();
    showView("places", "list");
    toast(isEditing ? "המקום עודכן!" : "המקום נוסף!");
    editingPlaceId = null;
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = isEditing ? "שמירת שינויים" : "הוספת מקום";
  }
});

// ---------------------------------------------------------------------------
// Trip planning
// ---------------------------------------------------------------------------

function tripDateRangeLabel(trip) {
  if (!trip.days.length) return "אין ימים עדיין";
  const first = formatDateHe(trip.days[0].date);
  const last = formatDateHe(trip.days[trip.days.length - 1].date);
  return `${first} - ${last} · ${trip.days.length} ימים`;
}

function renderTripsList() {
  const list = $("#trips-list");
  list.innerHTML = "";
  $("#trips-empty").classList.toggle("hidden", state.trips.length > 0);

  state.trips.forEach(trip => {
    const card = document.createElement("div");
    card.className = "item-card";
    card.innerHTML = `
      <div class="item-icon">🗓️</div>
      <div class="item-text">
        <p class="item-title">${escapeHtml(trip.name)}</p>
        <p class="item-subtitle">${escapeHtml(tripDateRangeLabel(trip))}</p>
      </div>
      <span class="item-chevron">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
      </span>
    `;
    card.addEventListener("click", () => openTripDetail(trip));
    list.appendChild(card);
  });
}

function refreshTripsView() {
  const hasLocation = !!state.selectedLocationId;
  $("#trips-no-location").classList.toggle("hidden", hasLocation);
  $("#trips-content").classList.toggle("hidden", !hasLocation);
  $("#trips-add-btn").disabled = !hasLocation;
  if (hasLocation) renderTripsList();
}

$("#trips-go-to-locations-btn").addEventListener("click", () => openSheet("locations"));

// --- Import a trip table from a file (CSV / Excel / Word) -----------------
// Parses whichever format into a plain 2D grid of cell text, then maps
// columns to our day fields (תאריך/בוקר/אחה"צ/ערב/לוגיסטיקה) by matching
// header keywords, falling back to that same left-to-right column order
// when no header is recognized. Legacy binary .doc isn't supported - it has
// no practical client-side parser - so users are asked to re-save as
// .docx/.xlsx/.csv instead, which covers every modern export path (Word,
// Google Docs/Sheets, Excel all do this trivially via "Save As").

const IMPORT_FIELD_KEYWORDS = {
  date: ["תאריך", "date"],
  morning: ["בוקר", "morning"],
  afternoon: ["צהריים", "אחה", "afternoon"],
  evening: ["ערב", "evening"],
  logistics: ["לוגיסטיקה", "logistics", "הערות", "notes"]
};
const IMPORT_FIELD_ORDER = ["date", "morning", "afternoon", "evening", "logistics"];

function detectImportColumns(headerRow) {
  const mapping = {};
  const used = new Set();
  Object.entries(IMPORT_FIELD_KEYWORDS).forEach(([field, keywords]) => {
    const idx = headerRow.findIndex((cell, i) =>
      !used.has(i) && keywords.some(kw => String(cell || "").includes(kw))
    );
    if (idx !== -1) { mapping[field] = idx; used.add(idx); }
  });
  return mapping;
}

// Fills in any field the keyword pass didn't find using the next unused
// column in canonical order - covers files with no recognizable header at
// all (or a partial/garbled one), assuming the common authoring convention
// of date/morning/afternoon/evening/logistics stored left-to-right.
function fillImportColumnsFallback(mapping, totalCols) {
  const used = new Set(Object.values(mapping));
  let nextCol = 0;
  IMPORT_FIELD_ORDER.forEach(field => {
    if (mapping[field] != null) return;
    while (used.has(nextCol) && nextCol < totalCols) nextCol++;
    if (nextCol < totalCols) { mapping[field] = nextCol; used.add(nextCol); nextCol++; }
  });
  return mapping;
}

// Best-effort: tries ISO, D.M.Y / D/M/Y / D-M-Y, then falls back to
// whatever the JS Date parser itself can make of it. Returns null (leaving
// the cell blank for manual entry) rather than guessing wrong.
function parseImportedDate(text) {
  const t = (text || "").trim();
  if (!t) return null;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return toDateInputValue(new Date(+m[1], +m[2] - 1, +m[3]));
  m = t.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (m) return toDateInputValue(new Date(+m[3], +m[2] - 1, +m[1]));
  const parsed = new Date(t);
  return isNaN(parsed) ? null : toDateInputValue(parsed);
}

// .xlsx/.xls are binary and self-describing, so reading them as raw bytes
// works fine. .csv is plain text with no encoding metadata of its own -
// reading it as bytes (type:"array") makes SheetJS guess a codepage, which
// mangles anything outside ASCII (Hebrew included). Decoding it as text
// first (browsers do this as UTF-8 by default, matching how the sheet was
// almost certainly saved) and reading with type:"string" avoids that.
function parseSpreadsheetToGrid(content, isCsv) {
  const wb = XLSX.read(content, { type: isCsv ? "string" : "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
}

// Reads the first table in a .docx's main document part. Multiple
// paragraphs/runs within one cell are flattened into a single
// space-joined line - real formatting is lost, but the text survives, and
// the cell zoom editor makes it easy to reformat afterward if needed.
async function parseDocxToGrid(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("קובץ Word לא תקין.");
  const xmlText = await docFile.async("text");
  const xml = new DOMParser().parseFromString(xmlText, "application/xml");
  const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const table = xml.getElementsByTagNameNS(ns, "tbl")[0];
  if (!table) throw new Error("לא נמצאה טבלה בקובץ.");
  return Array.from(table.getElementsByTagNameNS(ns, "tr")).map(tr =>
    Array.from(tr.getElementsByTagNameNS(ns, "tc")).map(tc =>
      Array.from(tc.getElementsByTagNameNS(ns, "t")).map(t => t.textContent).join(" ").trim()
    )
  );
}

async function handleTripImportFile(file) {
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".doc") && !lowerName.endsWith(".docx")) {
    toast("קובצי Word ישנים (.doc) אינם נתמכים. שמרו כ-.docx, .xlsx או .csv ונסו שוב.");
    return;
  }

  let grid;
  try {
    if (lowerName.endsWith(".docx")) {
      grid = await parseDocxToGrid(await file.arrayBuffer());
    } else if (lowerName.endsWith(".csv")) {
      grid = parseSpreadsheetToGrid(await file.text(), true);
    } else {
      grid = parseSpreadsheetToGrid(await file.arrayBuffer(), false);
    }
  } catch (err) {
    toast(err.message || "קריאת הקובץ נכשלה.");
    return;
  }

  grid = grid.filter(row => row.some(cell => String(cell || "").trim() !== ""));
  if (grid.length === 0) { toast("הקובץ ריק."); return; }

  const headerGuess = detectImportColumns(grid[0]);
  const looksLikeHeader = Object.keys(headerGuess).length >= 2;
  const mapping = fillImportColumnsFallback(looksLikeHeader ? headerGuess : {}, grid[0].length);
  const dataRows = looksLikeHeader ? grid.slice(1) : grid;

  const days = dataRows.map(row => {
    const get = field => mapping[field] != null ? String(row[mapping[field]] || "").trim() : "";
    const parsedDate = parseImportedDate(get("date"));
    return {
      date: parsedDate || "",
      dayLabel: parsedDate ? WEEKDAYS_HE[new Date(parsedDate + "T00:00:00").getDay()] : "",
      // escaped, not inserted as-is: these fields are now rich-text HTML,
      // and imported cells are plain text that may itself contain "<"/">"/
      // "&" - escaping keeps it displaying exactly as extracted instead of
      // being misread as markup.
      morning: escapeHtml(get("morning")),
      afternoon: escapeHtml(get("afternoon")),
      evening: escapeHtml(get("evening")),
      logistics: escapeHtml(get("logistics"))
    };
  });

  if (days.length === 0) { toast("לא נמצאו שורות לייבוא."); return; }

  const defaultName = file.name.replace(/\.[^.]+$/, "");
  const tripName = (prompt("שם לתוכנית המיובאת:", defaultName) || "").trim();
  if (!tripName) return;

  try {
    const id = await addTrip({ locationId: state.selectedLocationId, name: tripName, days });
    state.trips = await getTripsByLocation(state.selectedLocationId);
    const trip = state.trips.find(t => t.id === id);
    openTripDetail(trip);
    toast("הטיול יובא! כדאי לבדוק ולערוך את הפרטים.");
  } catch (err) {
    toast(err.message);
  }
}

$("#trip-import-btn").addEventListener("click", () => {
  if (!state.selectedLocationId) return;
  $("#trip-import-file-input").click();
});

$("#trip-import-file-input").addEventListener("change", async e => {
  const file = e.target.files[0];
  e.target.value = ""; // allow re-selecting the same file name later
  if (file) await handleTripImportFile(file);
});

// A quicker alternative to the guided "name + start date + day count" form:
// just a name, and a handful of blank rows with no date filled in - for
// when you want to freely fill in the table yourself rather than have it
// pre-populated from a start date.
const BLANK_TABLE_ROWS = 5;

$("#trip-blank-table-btn").addEventListener("click", async () => {
  if (!state.selectedLocationId) return;
  const name = (prompt("שם לתוכנית הטיול:") || "").trim();
  if (!name) return;

  const days = Array.from({ length: BLANK_TABLE_ROWS }, () => ({
    date: "", dayLabel: "", morning: "", afternoon: "", evening: "", logistics: ""
  }));

  try {
    const id = await addTrip({ locationId: state.selectedLocationId, name, days });
    state.trips = await getTripsByLocation(state.selectedLocationId);
    openTripDetail(state.trips.find(t => t.id === id));
    toast("הטבלה נוצרה - אפשר למלא תאריכים ותוכן");
  } catch (err) {
    toast(err.message);
  }
});

$("#trips-add-btn").addEventListener("click", () => {
  if (!state.selectedLocationId) return;
  $("#trip-form-error").classList.add("hidden");
  $("#trip-name-input").value = "";
  $("#trip-start-date-input").value = toDateInputValue(new Date());
  $("#trip-days-input").value = 3;
  showView("trips", "form", "טיול חדש");
});

$("#trip-form-view").addEventListener("submit", async e => {
  e.preventDefault();
  const errorEl = $("#trip-form-error");
  errorEl.classList.add("hidden");

  const name = $("#trip-name-input").value.trim();
  const startDateStr = $("#trip-start-date-input").value;
  const numDays = parseInt($("#trip-days-input").value, 10);
  const submitBtn = $("#trip-form-submit");

  if (!startDateStr || !numDays || numDays < 1) {
    errorEl.textContent = "נא למלא תאריך התחלה ומספר ימים תקין.";
    errorEl.classList.remove("hidden");
    return;
  }

  const days = [];
  const startDate = new Date(startDateStr + "T00:00:00");
  for (let i = 0; i < numDays; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    days.push({
      date: toDateInputValue(d),
      dayLabel: WEEKDAYS_HE[d.getDay()],
      morning: "",
      afternoon: "",
      evening: "",
      logistics: ""
    });
  }

  submitBtn.disabled = true;
  try {
    const id = await addTrip({ locationId: state.selectedLocationId, name, days });
    state.trips = await getTripsByLocation(state.selectedLocationId);
    const trip = state.trips.find(t => t.id === id);
    openTripDetail(trip);
    toast("התוכנית נוצרה, אפשר למלא פרטים");
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove("hidden");
  } finally {
    submitBtn.disabled = false;
  }
});

const ZOOM_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`;

// Sanitizes rich-text HTML before it's ever inserted into the page - a
// second line of defense on top of db.js's own read-time sanitization
// (getTripsByLocation), in case anything ever reaches the DOM without going
// through that (e.g. content just typed locally, not yet round-tripped
// through Firestore). Fails closed (strips everything) if DOMPurify somehow
// isn't loaded, rather than trusting unsanitized HTML.
function sanitizeRichText(html) {
  return window.DOMPurify ? window.DOMPurify.sanitize(html || "") : "";
}

// value is already-sanitized HTML (from db.js), not plain text - inserted
// directly rather than through escapeHtml, which would show literal "<b>"
// tags instead of rendering them.
function partCell(field, value, label) {
  return `
    <td class="col-part part-cell">
      <button type="button" class="cell-zoom-btn" data-zoom-field="${field}" data-zoom-label="${escapeHtml(label)}" aria-label="הגדלת עריכה">${ZOOM_ICON}</button>
      <div class="cell-content" contenteditable="true" data-field="${field}">${sanitizeRichText(value)}</div>
    </td>`;
}

function renderTripTable(days) {
  const body = $("#trip-table-body");
  body.innerHTML = "";
  days.forEach((day, idx) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td class="col-date">
        <div class="date-cell-stack">
          <p class="date-cell-daylabel" data-role="daylabel">${escapeHtml(day.dayLabel)}</p>
          <input type="date" data-field="date" value="${escapeHtml(day.date)}">
        </div>
      </td>
      ${partCell("morning", day.morning, "בוקר")}
      ${partCell("afternoon", day.afternoon, 'אחה"צ')}
      ${partCell("evening", day.evening, "ערב")}
      <td class="col-logistics part-cell">
        <button type="button" class="cell-zoom-btn" data-zoom-field="logistics" data-zoom-label="לוגיסטיקה" aria-label="הגדלת עריכה">${ZOOM_ICON}</button>
        <div class="cell-content" contenteditable="true" data-field="logistics">${sanitizeRichText(day.logistics)}</div>
      </td>
      <td class="col-remove">
        <button type="button" class="icon-btn-ghost danger" data-action="remove-day" aria-label="הסרת יום">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>
        </button>
      </td>
    `;
    row.querySelector('[data-action="remove-day"]').addEventListener("click", () => {
      syncTableIntoCurrentTrip();
      state.currentTrip.days.splice(idx, 1);
      renderTripTable(state.currentTrip.days);
    });
    // The weekday label is derived from the date, not typed separately -
    // picking a new date updates it immediately instead of leaving a
    // mismatched label the user has to remember to fix by hand.
    row.querySelector('[data-field="date"]').addEventListener("input", e => {
      row.querySelector('[data-role="daylabel"]').textContent = dayLabelForDate(e.target.value);
    });
    row.querySelectorAll("[data-zoom-field]").forEach(btn => {
      const cell = btn.nextElementSibling;
      btn.addEventListener("click", () => openCellEditor(cell, `${btn.dataset.zoomLabel} - ${day.dayLabel || day.date || ""}`));
    });
    body.appendChild(row);
  });
}

// --- Cell "zoom" editor: bigger contenteditable area with a formatting
// toolbar (bold/underline/bullets/color) for comfortably editing a cell --

let cellEditorTarget = null;

function openCellEditor(cell, label) {
  cellEditorTarget = cell;
  $("#cell-editor-title").textContent = label.trim() || "עריכה";
  $("#cell-editor-content").innerHTML = sanitizeRichText(cell.innerHTML);
  $("#cell-editor").classList.add("open");
  $("#cell-editor-backdrop").classList.add("visible");
  // Focusing while the sheet is still mid slide-up transition (rather than
  // settled in its final position) is what was making iOS Safari's own
  // "scroll the focused element into view" logic fight with our fixed
  // layout and reveal whatever sheet sits underneath - waiting past the
  // 0.28s CSS transition, and telling it not to scroll at all regardless,
  // avoids that entirely.
  setTimeout(() => $("#cell-editor-content").focus({ preventScroll: true }), 320);
}

function closeCellEditor() {
  if (cellEditorTarget) {
    cellEditorTarget.innerHTML = sanitizeRichText($("#cell-editor-content").innerHTML);
  }
  cellEditorTarget = null;
  $("#cell-editor").classList.remove("open");
  $("#cell-editor-backdrop").classList.remove("visible");
}

$("#cell-editor-done-btn").addEventListener("click", closeCellEditor);
$("#cell-editor-close-btn").addEventListener("click", closeCellEditor);
$("#cell-editor-backdrop").addEventListener("click", closeCellEditor);

// Force modern CSS-based output (<span style="color:...">) instead of
// legacy <font color> tags, so foreColor's result is consistent and
// unambiguously covered by the sanitizer's allowed tags.
document.execCommand("styleWithCSS", false, true);

// mousedown+preventDefault (not click) keeps the contenteditable's current
// text selection intact - a plain click on the button would first steal
// focus away from the editor, collapsing the selection before the format
// command ever runs.
$("#cell-editor-toolbar").addEventListener("mousedown", e => {
  const btn = e.target.closest("button");
  if (!btn) return;
  e.preventDefault();
  if (btn.dataset.cmd) {
    document.execCommand(btn.dataset.cmd);
  } else if (btn.dataset.color) {
    document.execCommand("foreColor", false, btn.dataset.color);
  }
});

function syncTableIntoCurrentTrip() {
  if (!state.currentTrip) return;
  const rows = $("#trip-table-body").querySelectorAll("tr");
  rows.forEach((row, idx) => {
    const day = state.currentTrip.days[idx];
    if (!day) return;
    row.querySelectorAll("[data-field]").forEach(el => {
      const raw = el.matches("[contenteditable]") ? el.innerHTML : el.value;
      day[el.dataset.field] = el.matches("[contenteditable]") ? sanitizeRichText(raw) : raw;
    });
    day.dayLabel = dayLabelForDate(day.date);
  });
  state.currentTrip.name = $("#trip-detail-name-input").value.trim();
}

function openTripDetail(trip) {
  state.currentTrip = JSON.parse(JSON.stringify(trip));
  $("#trip-detail-name-input").value = trip.name;
  renderTripTable(state.currentTrip.days);
  showView("trips", "detail", "פרטי טיול");
}

$("#trip-add-day-btn").addEventListener("click", () => {
  syncTableIntoCurrentTrip();
  const days = state.currentTrip.days;
  const last = days[days.length - 1];
  const lastDate = last && last.date ? new Date(`${last.date}T00:00:00`) : null;
  // A blank table (see trip-blank-table-btn) has no date to increment from -
  // falls back to today, same as adding the very first day.
  const nextDate = lastDate && !isNaN(lastDate) ? lastDate : new Date();
  if (lastDate && !isNaN(lastDate)) nextDate.setDate(nextDate.getDate() + 1);
  days.push({
    date: toDateInputValue(nextDate),
    dayLabel: WEEKDAYS_HE[nextDate.getDay()],
    morning: "",
    afternoon: "",
    evening: "",
    logistics: ""
  });
  renderTripTable(days);
});

async function saveCurrentTrip(silent) {
  if (!state.currentTrip) return;
  syncTableIntoCurrentTrip();
  try {
    await updateTrip(state.currentTrip.id, { name: state.currentTrip.name, days: state.currentTrip.days });
    state.trips = await getTripsByLocation(state.selectedLocationId);
    if (!silent) toast("נשמר בהצלחה!");
  } catch (err) {
    toast(err.message);
  }
}

$("#trip-save-btn").addEventListener("click", () => saveCurrentTrip(false));

$("#trip-delete-btn").addEventListener("click", async () => {
  if (!state.currentTrip) return;
  if (!confirm(`למחוק את "${state.currentTrip.name}"?`)) return;
  try {
    await deleteTrip(state.currentTrip.id);
    state.trips = state.trips.filter(t => t.id !== state.currentTrip.id);
    state.currentTrip = null;
    showView("trips", "list");
    renderTripsList();
    toast("הטיול נמחק");
  } catch (err) {
    toast(err.message);
  }
});

// ---------------------------------------------------------------------------
// Route recording
// ---------------------------------------------------------------------------
// Records the phone's GPS track for "today" into one Firestore document per
// calendar day (see addRouteDay/updateRoutePoints/finishRouteDay in db.js).
// A recording always ends by local midnight - either the user stops it, the
// scheduled midnight timeout fires, or (if the page was asleep/closed right
// through midnight) the periodic date-rollover check or the resume-on-load
// check below catches it after the fact. Nothing auto-starts a new
// recording for the next day - that always needs a fresh tap.

const ROUTE_COLORS = ["#1f7a6c", "#e0a458", "#c0533f", "#2b7de9", "#8e44ad", "#16a34a", "#d946ef", "#0891b2"];
const MIN_POINT_DISTANCE_M = 10; // skip a new GPS fix closer than this...
const MIN_POINT_INTERVAL_MS = 15000; // ...unless this much time passed anyway (keeps dwell time visible)
const RECORDING_STORAGE_KEY = "travel_recording";

function colorForRouteDay(id) {
  const idx = state.selectedRouteDayOrder.indexOf(id);
  return ROUTE_COLORS[idx % ROUTE_COLORS.length];
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function routeDayStats(day) {
  let meters = 0;
  for (let i = 1; i < day.points.length; i++) meters += haversineMeters(day.points[i - 1], day.points[i]);
  const durationMs = day.points.length >= 2 ? (day.points[day.points.length - 1].t - day.points[0].t) : 0;
  return { meters, durationMs };
}

function formatDistanceKm(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} ק"מ` : `${Math.round(meters)} מ'`;
}

function formatDurationHm(ms) {
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h} שע' ${m} דק'` : `${m} דק'`;
}

function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = n => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function formatRouteDayLabel(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return isNaN(d) ? dateStr : `${formatDateHe(dateStr)} · ${WEEKDAYS_HE[d.getDay()]}`;
}

function msUntilNextMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return next - now;
}

function persistRecordingFlag() {
  if (!state.recording) {
    localStorage.removeItem(RECORDING_STORAGE_KEY);
  } else {
    localStorage.setItem(RECORDING_STORAGE_KEY, JSON.stringify({
      routeId: state.recording.routeId,
      date: state.recording.date
    }));
  }
}

function updateRecordUi() {
  const recording = !!state.recording;
  $("#route-record-btn").classList.toggle("recording", recording);
  $("#route-record-label").textContent = recording ? "עצירת הקלטה" : "התחלת הקלטה";
  $("#route-record-stats").classList.toggle("hidden", !recording);
  if (recording) {
    const { meters } = routeDayStats({ points: state.recording.points });
    const elapsedMs = Date.now() - state.recording.startedAtMs;
    $("#route-record-stats").textContent = `מקליט · ${formatElapsed(elapsedMs)} · ${formatDistanceKm(meters)}`;
  }
}

function renderRoutesList() {
  const list = $("#routes-days-list");
  list.innerHTML = "";
  $("#routes-empty").classList.toggle("hidden", state.routeDays.length > 0);

  state.routeDays.forEach(day => {
    const selected = state.selectedRouteDayOrder.includes(day.id);
    const color = selected ? colorForRouteDay(day.id) : null;
    const { meters, durationMs } = routeDayStats(day);
    const card = document.createElement("div");
    card.className = "item-card route-day-card" + (selected ? " selected" : "");
    card.innerHTML = `
      <button type="button" class="route-day-swatch" style="background:${color || ""}" aria-label="הצגה/הסתרה במפה">${selected ? "✓" : ""}</button>
      <div class="item-text">
        <p class="item-title">${escapeHtml(formatRouteDayLabel(day.date))}</p>
        <p class="item-subtitle">${escapeHtml(formatDistanceKm(meters))} · ${escapeHtml(formatDurationHm(durationMs))}${day.endedAt ? "" : " · מוקלט כרגע"}</p>
      </div>
      <button class="icon-btn-ghost danger" aria-label="מחיקה" data-action="delete">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>
      </button>
    `;
    card.addEventListener("click", e => {
      if (e.target.closest('[data-action="delete"]')) return;
      toggleRouteDaySelection(day.id);
    });
    card.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      if (!confirm("למחוק את המסלול המוקלט ליום הזה?")) return;
      try {
        await deleteRouteDay(day.id);
        state.routeDays = state.routeDays.filter(d => d.id !== day.id);
        state.selectedRouteDayOrder = state.selectedRouteDayOrder.filter(id => id !== day.id);
        renderRoutesList();
        renderSelectedRoutesOnMap(false);
      } catch (err) {
        toast(err.message);
      }
    });
    list.appendChild(card);
  });
}

function toggleRouteDaySelection(id) {
  const idx = state.selectedRouteDayOrder.indexOf(id);
  if (idx === -1) state.selectedRouteDayOrder.push(id);
  else state.selectedRouteDayOrder.splice(idx, 1);
  renderRoutesList();
  renderSelectedRoutesOnMap(true);
}

function renderSelectedRoutesOnMap(fit) {
  recordedRoutesLayer.clearLayers();
  state.selectedRouteDayOrder.forEach(id => {
    const day = state.routeDays.find(d => d.id === id);
    if (!day || day.points.length < 2) return;
    const latlngs = day.points.map(p => [p.lat, p.lng]);
    L.polyline(latlngs, { color: colorForRouteDay(id), weight: 5, opacity: 0.85, lineCap: "round" }).addTo(recordedRoutesLayer);
  });
  if (fit && state.selectedRouteDayOrder.length) {
    const bounds = recordedRoutesLayer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [60, 60] });
  }
}

async function loadRouteDays() {
  try {
    state.routeDays = await getRouteDays();
  } catch (err) {
    toast(err.message);
    return;
  }
  renderRoutesList();
  renderSelectedRoutesOnMap(false);
}

// --- Recording engine ------------------------------------------------------

let watchId = null;
let midnightTimer = null;
let dateRollCheckInterval = null;
let recordUiTimer = null;
let recordingErrorToasted = false;
let flushInFlight = false;

function handleRecordingPosition(pos) {
  if (!state.recording) return;
  const point = { lat: pos.coords.latitude, lng: pos.coords.longitude, t: Date.now() };
  const points = state.recording.points;
  const last = points[points.length - 1];
  if (last) {
    const dist = haversineMeters(last, point);
    const dt = point.t - last.t;
    if (dist < MIN_POINT_DISTANCE_M && dt < MIN_POINT_INTERVAL_MS) return;
  }
  points.push(point);
  if (liveRecordingLayer) liveRecordingLayer.addLatLng([point.lat, point.lng]);
  if (points.length - state.recording.lastSavedCount >= 15) flushRecordingPoints();
}

function handleRecordingError() {
  if (recordingErrorToasted) return;
  recordingErrorToasted = true;
  toast("לא ניתן לאתר את המיקום - בדקו הרשאות מיקום בדפדפן");
}

async function flushRecordingPoints() {
  if (!state.recording || flushInFlight) return;
  flushInFlight = true;
  const snapshot = state.recording.points.slice();
  try {
    await updateRoutePoints(state.recording.routeId, snapshot);
    if (state.recording) state.recording.lastSavedCount = snapshot.length;
  } catch (err) {
    // best-effort - the next periodic flush (or the final one on stop) retries with the fuller array
  } finally {
    flushInFlight = false;
  }
}

function checkRecordingDateRollover() {
  if (!state.recording) return;
  if (toDateInputValue(new Date()) !== state.recording.date) stopRecording(true);
}

function armRecordingTimers() {
  clearTimeout(midnightTimer);
  midnightTimer = setTimeout(() => stopRecording(true), msUntilNextMidnight());
  clearInterval(dateRollCheckInterval);
  dateRollCheckInterval = setInterval(checkRecordingDateRollover, 60000);
  clearInterval(recordUiTimer);
  recordUiTimer = setInterval(updateRecordUi, 1000);
}

function disarmRecordingTimers() {
  clearTimeout(midnightTimer); midnightTimer = null;
  clearInterval(dateRollCheckInterval); dateRollCheckInterval = null;
  clearInterval(recordUiTimer); recordUiTimer = null;
}

async function startRecording() {
  if (!("geolocation" in navigator)) { toast("הדפדפן לא תומך באיתור מיקום"); return; }
  if (state.recording) return;

  const today = toDateInputValue(new Date());
  let routeId;
  try {
    routeId = await addRouteDay(today);
  } catch (err) {
    toast(err.message);
    return;
  }

  recordingErrorToasted = false;
  state.recording = { routeId, date: today, points: [], startedAtMs: Date.now(), lastSavedCount: 0 };
  persistRecordingFlag();

  liveRecordingLayer = L.polyline([], { color: "#c0533f", weight: 5, opacity: 0.9, lineCap: "round" }).addTo(map);
  watchId = navigator.geolocation.watchPosition(handleRecordingPosition, handleRecordingError, {
    enableHighAccuracy: true, maximumAge: 5000, timeout: 20000
  });
  armRecordingTimers();

  updateRecordUi();
  renderRoutesList();
  toast("הקלטת המסלול התחילה");
}

async function stopRecording(auto) {
  if (!state.recording) return;
  const { routeId, points } = state.recording;

  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  disarmRecordingTimers();
  if (liveRecordingLayer) { map.removeLayer(liveRecordingLayer); liveRecordingLayer = null; }

  state.recording = null;
  persistRecordingFlag();
  updateRecordUi();

  try {
    await finishRouteDay(routeId, points);
  } catch (err) {
    toast(err.message);
  }

  await loadRouteDays();
  toast(auto ? "ההקלטה הסתיימה אוטומטית בסוף היום" : "המסלול נשמר!");
}

$("#route-record-btn").addEventListener("click", () => {
  if (state.recording) stopRecording(false);
  else startRecording();
});

// Picks up an in-progress recording after a page reload (the user re-opened
// the PWA, or it was relaunched) instead of silently losing it. If the
// stored day has already rolled past midnight while the page was away, it's
// finalized right away rather than resumed.
function resumeRecordingIfNeeded() {
  const raw = localStorage.getItem(RECORDING_STORAGE_KEY);
  if (!raw) return;
  let saved;
  try { saved = JSON.parse(raw); } catch (e) { localStorage.removeItem(RECORDING_STORAGE_KEY); return; }

  const day = state.routeDays.find(d => d.id === saved.routeId);
  if (!day) { localStorage.removeItem(RECORDING_STORAGE_KEY); return; }

  const today = toDateInputValue(new Date());
  if (day.date !== today || day.endedAt) {
    if (!day.endedAt) finishRouteDay(day.id, day.points).catch(() => {});
    localStorage.removeItem(RECORDING_STORAGE_KEY);
    return;
  }

  recordingErrorToasted = false;
  state.recording = {
    routeId: day.id,
    date: day.date,
    points: day.points.slice(),
    startedAtMs: day.startedAt.getTime(),
    lastSavedCount: day.points.length
  };
  liveRecordingLayer = L.polyline(day.points.map(p => [p.lat, p.lng]), {
    color: "#c0533f", weight: 5, opacity: 0.9, lineCap: "round"
  }).addTo(map);
  watchId = navigator.geolocation.watchPosition(handleRecordingPosition, handleRecordingError, {
    enableHighAccuracy: true, maximumAge: 5000, timeout: 20000
  });
  armRecordingTimers();
  updateRecordUi();
  toast("ממשיכים בהקלטת המסלול מהיום");
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

(async function init() {
  locateMe(false);
  try {
    state.locations = await getLocations();
  } catch (err) {
    toast(err.message);
    state.locations = [];
  }
  renderLocationsList();

  try {
    state.customCategories = await getCategories();
  } catch (err) {
    state.customCategories = []; // best-effort - the built-in categories still work fine without these
  }

  try {
    state.routeDays = await getRouteDays();
  } catch (err) {
    state.routeDays = [];
  }
  resumeRecordingIfNeeded();

  if (state.selectedLocationId && state.locations.some(l => l.id === state.selectedLocationId)) {
    await selectLocation(state.selectedLocationId, { skipFly: false });
  } else {
    state.selectedLocationId = null;
    localStorage.removeItem("travel_selected_location");
  }
})();
