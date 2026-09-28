import {
  PLACE_CATEGORIES,
  geocode, searchLocationSuggestions, searchPlaceSuggestions, parseGoogleMapsLink,
  addLocation, getLocations, deleteLocation,
  addPlace, getPlacesByLocation, updatePlace, deletePlace,
  addTrip, getTripsByLocation, updateTrip, deleteTrip,
  addCategory, getCategories
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
  walkingInfo: {} // placeId -> { minutes, meters }, from OSRM's foot-routing table
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
  if (!document.hidden) map.invalidateSize();
});

const placeMarkersLayer = L.layerGroup().addTo(map);
const placeMarkerById = new Map();

let userMarker = null;
let locationMarker = null;
let routeLayer = null;

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
  }
};

function showView(key, viewName, title) {
  const s = SHEETS[key];
  Object.entries(s.views).forEach(([name, el]) => el.classList.toggle("hidden", name !== viewName));
  s.currentView = viewName;
  s.title.textContent = title || s.defaultTitle;
  s.backBtn.classList.toggle("hidden", viewName === "list");
  s.addBtn.classList.toggle("hidden", viewName !== "list");
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
      title: "",
      morning: get("morning"),
      afternoon: get("afternoon"),
      evening: get("evening"),
      logistics: get("logistics")
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
      title: "",
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

// Grows a table-cell textarea to fit its full content so nothing is ever
// clipped behind a tiny scrollbar - called on every keystroke (delegated
// "input" listener below) and once per cell right after rendering, since
// pre-filled content (an existing trip, or an imported file) needs the same
// sizing without waiting for the user to type first.
function autoGrowTextarea(el) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

$("#trip-table-body").addEventListener("input", e => {
  if (e.target.tagName === "TEXTAREA") autoGrowTextarea(e.target);
});

// A rotation or window resize changes column widths, which can make a
// previously-set height wrong again the same way the initial-render race
// could - re-measure everything once things settle.
function reflowTripTable() {
  $("#trip-table-body").querySelectorAll("textarea").forEach(autoGrowTextarea);
}
window.addEventListener("resize", reflowTripTable);
window.addEventListener("orientationchange", () => setTimeout(reflowTripTable, 300));

function partCell(field, value, label) {
  return `
    <td class="col-part part-cell">
      <button type="button" class="cell-zoom-btn" data-zoom-field="${field}" data-zoom-label="${escapeHtml(label)}" aria-label="הגדלת עריכה">${ZOOM_ICON}</button>
      <textarea data-field="${field}">${escapeHtml(value)}</textarea>
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
          <input type="text" data-field="title" placeholder="כותרת (לא חובה)" value="${escapeHtml(day.title)}">
          <input type="text" data-field="dayLabel" placeholder="יום" value="${escapeHtml(day.dayLabel)}">
          <input type="date" data-field="date" value="${escapeHtml(day.date)}">
        </div>
      </td>
      ${partCell("morning", day.morning, "בוקר")}
      ${partCell("afternoon", day.afternoon, 'אחה"צ')}
      ${partCell("evening", day.evening, "ערב")}
      <td class="col-logistics part-cell">
        <button type="button" class="cell-zoom-btn" data-zoom-field="logistics" data-zoom-label="לוגיסטיקה" aria-label="הגדלת עריכה">${ZOOM_ICON}</button>
        <textarea data-field="logistics">${escapeHtml(day.logistics)}</textarea>
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
    row.querySelectorAll("[data-zoom-field]").forEach(btn => {
      const textarea = btn.nextElementSibling;
      btn.addEventListener("click", () => openCellEditor(textarea, `${btn.dataset.zoomLabel} - ${day.dayLabel || day.date || ""}`));
    });
    body.appendChild(row);
  });

  // Auto-grow only after every row is in the DOM, not per-row during the
  // loop above: with table-layout:auto the browser picks column widths from
  // ALL rows' content together, so measuring a textarea's scrollHeight
  // before later rows (which may need a different width) are even added
  // locks in a height based on a width that then shifts under it - exactly
  // what caused text to look clipped despite auto-grow "running".
  // requestAnimationFrame waits for that layout to settle first.
  requestAnimationFrame(() => {
    body.querySelectorAll("textarea").forEach(autoGrowTextarea);
  });
}

// --- Cell "zoom" editor: bigger textarea for comfortably editing a cell --

let cellEditorTarget = null;

function openCellEditor(textarea, label) {
  cellEditorTarget = textarea;
  $("#cell-editor-title").textContent = label.trim() || "עריכה";
  $("#cell-editor-textarea").value = textarea.value;
  $("#cell-editor").classList.add("open");
  $("#cell-editor-backdrop").classList.add("visible");
  // Focusing while the sheet is still mid slide-up transition (rather than
  // settled in its final position) is what was making iOS Safari's own
  // "scroll the focused element into view" logic fight with our fixed
  // layout and reveal whatever sheet sits underneath - waiting past the
  // 0.28s CSS transition, and telling it not to scroll at all regardless,
  // avoids that entirely.
  setTimeout(() => $("#cell-editor-textarea").focus({ preventScroll: true }), 320);
}

function closeCellEditor() {
  if (cellEditorTarget) {
    cellEditorTarget.value = $("#cell-editor-textarea").value;
    autoGrowTextarea(cellEditorTarget);
  }
  cellEditorTarget = null;
  $("#cell-editor").classList.remove("open");
  $("#cell-editor-backdrop").classList.remove("visible");
}

$("#cell-editor-done-btn").addEventListener("click", closeCellEditor);
$("#cell-editor-close-btn").addEventListener("click", closeCellEditor);
$("#cell-editor-backdrop").addEventListener("click", closeCellEditor);

function syncTableIntoCurrentTrip() {
  if (!state.currentTrip) return;
  const rows = $("#trip-table-body").querySelectorAll("tr");
  rows.forEach((row, idx) => {
    const day = state.currentTrip.days[idx];
    if (!day) return;
    row.querySelectorAll("[data-field]").forEach(input => {
      day[input.dataset.field] = input.value;
    });
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
  const nextDate = last ? new Date(last.date + "T00:00:00") : new Date();
  if (last) nextDate.setDate(nextDate.getDate() + 1);
  days.push({
    date: toDateInputValue(nextDate),
    dayLabel: WEEKDAYS_HE[nextDate.getDay()],
    title: "",
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

  if (state.selectedLocationId && state.locations.some(l => l.id === state.selectedLocationId)) {
    await selectLocation(state.selectedLocationId, { skipFly: false });
  } else {
    state.selectedLocationId = null;
    localStorage.removeItem("travel_selected_location");
  }
})();
