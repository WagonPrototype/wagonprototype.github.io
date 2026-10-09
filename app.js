/* WPB Rides: prototype rideshare app for West Palm Beach with live GPS.
   Plain JavaScript module, no build step. Firebase (anonymous Auth + Firestore)
   keeps the phones in sync; Leaflet with OpenStreetMap tiles draws the map.
   README.md describes the data model and the known limits. */
import { firebaseConfig, FIREBASE_VERSION } from './config.js';

/* ---------- small helpers ---------- */
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const ESC = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
const str = (v, n) => typeof v === 'string' ? v.slice(0, n || 60) : '';
const obj = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
const store = {
  get(k, d){ try { const v = localStorage.getItem('wpbrides.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v){ try { localStorage.setItem('wpbrides.' + k, JSON.stringify(v)); } catch (e) {} },
  del(k){ try { localStorage.removeItem('wpbrides.' + k); } catch (e) {} }
};
const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/* ---------- places, distance, pricing ---------- */
const PLACES = [
  {id:'clematis', name:'Clematis St', lat:26.7137, lng:-80.0525, group:'wpb'},
  {id:'brightline', name:'Brightline Station', lat:26.7158, lng:-80.0560, group:'wpb'},
  {id:'trirail', name:'Tri-Rail Station', lat:26.7126, lng:-80.0622, group:'wpb'},
  {id:'rosemary', name:'Rosemary Square', lat:26.7093, lng:-80.0567, group:'wpb'},
  {id:'kravis', name:'Kravis Center', lat:26.7062, lng:-80.0585, group:'wpb'},
  {id:'norton', name:'Norton Museum of Art', lat:26.6990, lng:-80.0525, group:'wpb'},
  {id:'goodsam', name:'Good Samaritan Medical Center', lat:26.7268, lng:-80.0515, group:'wpb'},
  {id:'currie', name:'Currie Park', lat:26.7365, lng:-80.0512, group:'wpb'},
  {id:'stmarys', name:"St. Mary's Medical Center", lat:26.7420, lng:-80.0640, group:'wpb'},
  {id:'outlets', name:'Palm Beach Outlets', lat:26.7225, lng:-80.0880, group:'wpb'},
  {id:'pbi', name:'PBI Airport', lat:26.6832, lng:-80.0956, group:'wpb'},
  {id:'worth', name:'Worth Avenue', lat:26.7030, lng:-80.0380, group:'pb'},
  {id:'breakers', name:'The Breakers', lat:26.7155, lng:-80.0355, group:'pb'}
];
const P = Object.fromEntries(PLACES.map(p => [p.id, p]));
const placeOf = p => ({id:p.id || '', name:p.name, lat:p.lat, lng:p.lng});
const PRICE = {base:2.50, mile:1.35, min:0.28, booking:1.75, minFare:8.00, share:0.75};
const ACTIVE = ['requested','accepted','arrived','in_progress'];
const DRIVING = ['accepted','arrived','in_progress'];
const STATUSES = new Set(['requested','accepted','arrived','in_progress','completed','cancelled']);
const TEST_DRIVE_MPS = 26.8;          // about 60 mph
const NEAR_MI = 0.06;                 // about 100 m counts as "at" a spot
const DRIVER_STALE_MS = 3 * 60e3;     // a driver is shown as online for 3 min after their last update
const money = n => '$' + (Math.round(n * 100) / 100).toFixed(2);

function meters(a, b){
  const R = 6371008.8, r = Math.PI / 180;
  const dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const milesBetween = (a, b) => meters(a, b) / 1609.344;
function quote(a, b){
  const mi = Math.max(0.3, milesBetween(a, b) * 1.3);
  const minutes = Math.max(4, Math.round(mi / 19 * 60 + 2));
  const raw = PRICE.base + PRICE.mile * mi + PRICE.min * minutes + PRICE.booking;
  return {miles:Math.round(mi * 10) / 10, minutes, fare:Math.max(PRICE.minFare, Math.round(raw * 100) / 100)};
}
function etaTo(from, to){ const mi = milesBetween(from, to) * 1.3; return {mi, min:Math.max(1, Math.round(mi / 22 * 60))}; }
function nearName(p){
  let best = null, bd = Infinity;
  PLACES.forEach(q => { const d = milesBetween(p, q); if (d < bd) { bd = d; best = q; } });
  return bd < 0.5 ? best.name : '';
}
function pinPlace(p){ const n = nearName(p); return {id:'', lat:p.lat, lng:p.lng, name:n ? 'Near ' + n : 'Pinned spot'}; }

/* ---------- cleaning shared data (it comes from other phones) ---------- */
function cleanPhoto(s){
  return (typeof s === 'string' && s.length < 90000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) ? s : '';
}
function cleanPt(p){
  if (!p || typeof p !== 'object') return null;
  const lat = num(p.lat), lng = num(p.lng);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return {lat, lng};
}
function cleanPlace(p){ const q = cleanPt(p); return q ? Object.assign(q, {id:str(p.id, 30), name:str(p.name, 80) || 'Pinned spot'}) : null; }
function cleanRide(id, d){
  if (!d || typeof d !== 'object' || !STATUSES.has(d.status)) return null;
  const pickup = cleanPlace(d.pickup), dropoff = cleanPlace(d.dropoff);
  if (!pickup || !dropoff) return null;
  const dv = d.driver && typeof d.driver === 'object'
    ? {name:str(d.driver.name, 40) || 'Driver', car:str(d.driver.car, 40), plate:str(d.driver.plate, 10), photo:cleanPhoto(d.driver.photo)}
    : null;
  const loc = cleanPt(d.driverLoc);
  return {
    id, status:d.status, pickup, dropoff,
    riderUid:str(d.riderUid, 128), riderName:str(d.riderName, 40) || 'Rider',
    driverUid:str(d.driverUid, 128), driver:dv,
    driverLoc:loc ? Object.assign(loc, {at:num(d.driverLoc.at) || 0}) : null,
    fare:num(d.fare) || 0, miles:num(d.miles) || 0, minutes:num(d.minutes) || 0,
    createdAt:num(d.createdAt) || 0, acceptedAt:num(d.acceptedAt), arrivedAt:num(d.arrivedAt),
    startedAt:num(d.startedAt), completedAt:num(d.completedAt), cancelledAt:num(d.cancelledAt),
    cancelledBy:str(d.cancelledBy, 10), releasedAt:num(d.releasedAt), rating:num(d.rating),
    tripMiles:num(d.tripMiles), tripMinutes:num(d.tripMinutes)
  };
}

/* ---------- state ---------- */
const rs = obj(store.get('rider', {}));
const ds = obj(store.get('driver', {}));
const validSel = (v, allowGps) => (allowGps && v === 'gps') || v === 'pin' || !!P[v];
const savedScreen = store.get('screen', 'home');
const savedDismissed = store.get('dismissed', []);
const S = {
  uid:null,
  conn:'connecting',                  // connecting | live | error
  screen:['home','rider','driver'].includes(savedScreen) ? savedScreen : 'home',
  myRides:new Map(), driveRides:new Map(), openReqs:new Map(), drivers:new Map(),
  dismissed:new Set(Array.isArray(savedDismissed) ? savedDismissed.slice(-200) : []),
  busy:new Set(), expiring:new Set(),
  me:null, realGps:null,
  gps:{state:'off', watchId:null},     // off | asking | on | denied | unavailable
  arm:null,                            // pickup | dropoff | spot: the next map tap sets it
  lastFit:'', trip:null,
  rider:{
    name:typeof rs.name === 'string' ? rs.name : '',
    pickupSel:validSel(rs.pickupSel, true) ? rs.pickupSel : 'gps',
    dropoffSel:validSel(rs.dropoffSel, false) ? rs.dropoffSel : 'pbi',
    pickupPin:cleanPt(rs.pickupPin), dropoffPin:cleanPt(rs.dropoffPin)
  },
  driver:{
    name:typeof ds.name === 'string' ? ds.name : '',
    car:typeof ds.car === 'string' ? ds.car : '',
    plate:typeof ds.plate === 'string' ? ds.plate : '',
    photo:cleanPhoto(ds.photo),
    online:ds.online === true,
    testDrive:ds.testDrive === true
  }
};
const saveRider = () => store.set('rider', S.rider);
const saveDriver = () => store.set('driver', S.driver);
function dismiss(key){ S.dismissed.add(key); store.set('dismissed', Array.from(S.dismissed).slice(-200)); }

/* ---------- derived views ---------- */
const allRides = () => new Map([...S.openReqs, ...S.myRides, ...S.driveRides]);
function myRiderRide(){
  const r = Array.from(S.myRides.values()).filter(x => !S.dismissed.has('r:' + x.id)).sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!r) return null;
  if (ACTIVE.includes(r.status)) return r;
  if (r.status === 'completed' && Date.now() - (r.completedAt || 0) < 3 * 3600e3) return r;
  return null;
}
function myDriverRide(){
  const list = Array.from(S.driveRides.values()).filter(x => !S.dismissed.has('d:' + x.id)).sort((a, b) => (b.acceptedAt || 0) - (a.acceptedAt || 0));
  const active = list.find(x => DRIVING.includes(x.status));
  if (active) return active;
  const r = list[0];
  if (!r) return null;
  if (r.status === 'completed' && Date.now() - (r.completedAt || 0) < 3 * 3600e3) return r;
  if (r.status === 'cancelled' && r.cancelledBy === 'rider' && Date.now() - (r.cancelledAt || 0) < 3600e3) return r;
  return null;
}
function openRequests(){
  const now = Date.now();
  return Array.from(S.openReqs.values()).filter(r => r.status === 'requested' && now - r.createdAt < 45 * 60e3).sort((a, b) => a.createdAt - b.createdAt);
}
function onlineDrivers(){
  const now = Date.now();
  return Array.from(S.drivers.values()).filter(d => d.online && d.loc && now - d.updatedAt < DRIVER_STALE_MS);
}
function pickupPoint(){
  const r = S.rider;
  if (r.pickupSel === 'gps') {
    const g = S.realGps;   // the phone's real GPS, even if this phone is also test-driving
    if (!g) return null;
    const n = nearName(g);
    return {id:'', lat:g.lat, lng:g.lng, name:n ? 'My location, near ' + n : 'My location'};
  }
  if (r.pickupSel === 'pin') return r.pickupPin ? pinPlace(r.pickupPin) : null;
  return placeOf(P[r.pickupSel]);
}
function dropoffPoint(){
  const r = S.rider;
  if (r.dropoffSel === 'pin') return r.dropoffPin ? pinPlace(r.dropoffPin) : null;
  return placeOf(P[r.dropoffSel]);
}

/* ---------- messages ---------- */
let toastT = 0;
function toast(msg){ const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2800); }
function setNotice(msg){ const n = $('#notice'); n.textContent = msg || ''; n.hidden = !msg; }

/* ---------- Firebase ---------- */
let FB = null, db = null, auth = null, subscribed = false;
async function loadFirebase(){
  const base = 'https://www.gstatic.com/firebasejs/' + FIREBASE_VERSION + '/';
  const [app, authM, fs] = await Promise.all([import(base + 'firebase-app.js'), import(base + 'firebase-auth.js'), import(base + 'firebase-firestore.js')]);
  return {app, auth:authM, fs};
}
function dbErr(e){
  const code = (e && e.code) || '';
  if (code === 'permission-denied') setNotice("The database isn't letting the app in yet. In Firebase, open Firestore Database → Rules, paste the access rules, and click Publish.");
  else if (code === 'not-found' || code === 'failed-precondition') setNotice("The database isn't set up yet. In Firebase, open Firestore Database and click Create database.");
  else setNotice('Live updates stopped. Check your internet connection and reload the app.');
  console.warn(e);
  render();
}
function writeErr(e){
  const code = (e && e.code) || '';
  if (code === 'permission-denied') setNotice("The database refused that change. Check that the access rules in Firebase match the ones in the setup steps.");
  else if (code === 'not-found' || code === 'failed-precondition') setNotice("The database isn't set up yet. In Firebase, open Firestore Database and click Create database.");
  else if (code === 'unavailable') toast("No connection right now. Try again in a moment.");
  else toast('Something went wrong. Try again.');
  console.warn(e);
}
async function fsWrite(fn){ try { await fn(); return true; } catch (e) { writeErr(e); return false; } }
function authErr(e){
  const code = (e && e.code) || '';
  S.conn = 'error';
  if (code === 'auth/operation-not-allowed' || code === 'auth/admin-restricted-operation') setNotice('Anonymous sign-in is off. In Firebase, open Authentication → Sign-in method, choose Anonymous, and turn it on.');
  else if (code === 'auth/network-request-failed') setNotice('No internet connection. Connect and reload the app.');
  else if (code.includes('unauthorized-domain') || code.includes('are-blocked')) setNotice('Firebase has not approved this web address yet. In Firebase, open Authentication → Settings → Authorized domains, click Add domain, and enter ' + location.hostname + '.');
  else setNotice("The app couldn't sign in (" + (code || 'unknown error') + '). Reload to try again.');
  console.warn(e);
  render();
}
function snapToMap(snap){
  const m = new Map();
  snap.forEach(d => { const r = cleanRide(d.id, d.data()); if (r) m.set(d.id, r); });
  return m;
}
function subscribe(){
  if (subscribed) return;
  subscribed = true;
  const {collection, query, where, limit, onSnapshot} = FB.fs;
  const rides = collection(db, 'rides');
  onSnapshot(query(rides, where('riderUid', '==', S.uid)), snap => { S.myRides = snapToMap(snap); expireStale(); render(); }, dbErr);
  onSnapshot(query(rides, where('driverUid', '==', S.uid)), snap => { S.driveRides = snapToMap(snap); render(); }, dbErr);
  onSnapshot(query(rides, where('status', '==', 'requested'), limit(50)), snap => { S.openReqs = snapToMap(snap); render(); }, dbErr);
  onSnapshot(query(collection(db, 'drivers'), where('online', '==', true)), snap => {
    const m = new Map();
    snap.forEach(d => { const x = d.data() || {}; m.set(d.id, {id:d.id, online:x.online === true, loc:cleanPt(x.loc), updatedAt:num(x.updatedAt) || 0}); });
    S.drivers = m;
    render();
  }, dbErr);
}
function expireStale(){
  const now = Date.now();
  S.myRides.forEach(r => {
    if (r.status === 'requested' && now - r.createdAt > 45 * 60e3 && !S.expiring.has(r.id)) {
      S.expiring.add(r.id);
      FB.fs.updateDoc(FB.fs.doc(db, 'rides', r.id), {status:'cancelled', cancelledBy:'expired', cancelledAt:now}).catch(e => console.warn(e));
    }
  });
}
const api = {
  request(ride){
    const {doc, collection, setDoc} = FB.fs;
    return fsWrite(() => setDoc(doc(collection(db, 'rides')), ride));
  },
  patch(id, p){
    const {doc, updateDoc} = FB.fs;
    return fsWrite(() => updateDoc(doc(db, 'rides', id), p));
  },
  async accept(id, p){
    const {doc, runTransaction} = FB.fs;
    let taken = false;
    try {
      await runTransaction(db, async tx => {
        const ref = doc(db, 'rides', id);
        const snap = await tx.get(ref);
        if (!snap.exists() || snap.data().status !== 'requested') { taken = true; return; }
        tx.update(ref, p);
      });
    } catch (e) {
      if ((e && e.code) === 'permission-denied') taken = true; else { writeErr(e); return false; }
    }
    if (taken) { toast('Another driver already took this ride.'); return false; }
    return true;
  },
  driverDoc(fields){
    const {doc, setDoc} = FB.fs;
    return fsWrite(() => setDoc(doc(db, 'drivers', S.uid), fields, {merge:true}));
  }
};

/* ---------- location ---------- */
function startGps(){
  if (S.gps.watchId != null) return;
  if (!('geolocation' in navigator)) { S.gps.state = 'unavailable'; render(); return; }
  S.gps.state = 'asking';
  S.gps.watchId = navigator.geolocation.watchPosition(pos => {
    const p = {lat:pos.coords.latitude, lng:pos.coords.longitude, acc:Math.round(pos.coords.accuracy || 0), at:Date.now(), source:'gps'};
    S.realGps = p;
    S.gps.state = 'on';
    // A spot set by hand, or Test drive, keeps control of the car until "Use my GPS".
    if (S.me && (S.me.source === 'manual' || (S.driver.online && S.driver.testDrive))) { render(); return; }
    onMyPosition(p);
  }, err => {
    if (err.code === 1) { S.gps.state = 'denied'; stopGps(); }
    else if (err.code === 2) S.gps.state = 'unavailable';
    render();
  }, {enableHighAccuracy:true, maximumAge:5000, timeout:30000});
  render();
}
function stopGps(){
  if (S.gps.watchId != null) { navigator.geolocation.clearWatch(S.gps.watchId); S.gps.watchId = null; }
}
function onMyPosition(p){
  S.me = p;
  trackTrip(p);
  pushLocation(false);
  render();
}
let lastDrv = {at:0, lat:null, lng:null}, lastRide = {id:null, at:0, lat:null, lng:null};
const inflight = new Set();
function pushLocation(force){
  if (!S.uid || !FB || !S.driver.online || !S.me) return;
  const now = Date.now(), p = S.me;
  const movedD = lastDrv.lat == null ? Infinity : meters(lastDrv, p);
  if ((force || (now - lastDrv.at > 10000 && movedD > 25) || now - lastDrv.at > 45000) && !inflight.has('drv')) {
    inflight.add('drv');
    lastDrv = {at:now, lat:p.lat, lng:p.lng};
    api.driverDoc({online:true, loc:{lat:p.lat, lng:p.lng}, updatedAt:now}).finally(() => inflight.delete('drv'));
  }
  const r = myDriverRide();
  if (r && DRIVING.includes(r.status)) {
    const movedR = (lastRide.id !== r.id || lastRide.lat == null) ? Infinity : meters(lastRide, p);
    if ((force || (now - lastRide.at > 4000 && movedR > 10) || now - lastRide.at > 30000) && !inflight.has('ride')) {
      inflight.add('ride');
      lastRide = {id:r.id, at:now, lat:p.lat, lng:p.lng};
      FB.fs.updateDoc(FB.fs.doc(db, 'rides', r.id), {driverLoc:{lat:p.lat, lng:p.lng, at:now}}).catch(e => console.warn(e)).finally(() => inflight.delete('ride'));
    }
  }
}
function trackTrip(p){
  const r = myDriverRide();
  if (!r || r.status !== 'in_progress' || p.source === 'manual') return;
  if (!S.trip || S.trip.id !== r.id) S.trip = obj(store.get('trip.' + r.id, null)).id === r.id ? store.get('trip.' + r.id) : {id:r.id, meters:0, last:null};
  const t = S.trip;
  if (!t.last) t.last = {lat:p.lat, lng:p.lng};
  else {
    const m = meters(t.last, p);
    if (m >= 8 && (p.acc || 0) <= 60) { t.meters += m; t.last = {lat:p.lat, lng:p.lng}; }
  }
  if (!t.savedAt || Date.now() - t.savedAt > 10000) { t.savedAt = Date.now(); store.set('trip.' + r.id, t); }
}
function testDriveTick(){
  if (!S.driver.online || !S.driver.testDrive || !S.me) return;
  const r = myDriverRide();
  const target = r && r.status === 'accepted' ? r.pickup : r && r.status === 'in_progress' ? r.dropoff : null;
  if (!target) return;
  const d = meters(S.me, target);
  if (d < 5) return;
  const f = Math.min(1, TEST_DRIVE_MPS / d);
  onMyPosition({lat:S.me.lat + (target.lat - S.me.lat) * f, lng:S.me.lng + (target.lng - S.me.lng) * f, acc:5, at:Date.now(), source:'sim'});
}

/* ---------- keep the screen on while driving or riding ---------- */
let wakeLock = null, wakePending = false;
const needAwake = () => S.driver.online || !!myRiderRide();
async function keepAwake(on){
  try {
    if (on && !wakeLock && !wakePending && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakePending = true;
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) { const w = wakeLock; wakeLock = null; await w.release(); }
  } catch (e) { /* not supported or refused: the app still works */ }
  wakePending = false;
}

/* ---------- map ---------- */
let map = null, dashLine = null, solidLine = null, accCircle = null;
const markers = {};
let usedMarkers = new Set();
const CAR_SVG = '<svg viewBox="-6 -4.5 12 9" aria-hidden="true"><path d="M-5 2.1V-.4l1.5-2.8h7L5-.4v2.5z"/><circle cx="-3" cy="2.6" r="1.3"/><circle cx="3" cy="2.6" r="1.3"/></svg>';
const ICON_HTML = {
  A:['<div class="mk mk-a">A</div>', 28],
  B:['<div class="mk mk-b">B</div>', 28],
  car:['<div class="car">' + CAR_SVG + '</div>', 34],
  carOther:['<div class="car other">' + CAR_SVG + '</div>', 24],
  me:['<div class="me-dot"></div>', 18],
  req:['<div class="req-pin"></div>', 20]
};
const iconCache = {};
function getIcon(k){
  if (!iconCache[k]) { const [html, s] = ICON_HTML[k]; iconCache[k] = L.divIcon({className:'mkw', html, iconSize:[s, s], iconAnchor:[s / 2, s / 2]}); }
  return iconCache[k];
}
function buildMap(){
  if (typeof L === 'undefined') {
    const el = $('#map');
    el.classList.add('map-off');
    el.textContent = "The map couldn't load. Check your internet connection and reload.";
    return;
  }
  // No +/- buttons: pinch to zoom on phones, scroll or double-click on computers.
  map = L.map('map', {zoomControl:false, attributionControl:true}).setView([26.712, -80.062], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);
  dashLine = L.polyline([], {className:'rt-line dashed', interactive:false}).addTo(map);
  solidLine = L.polyline([], {className:'rt-line', interactive:false}).addTo(map);
  map.on('click', onMapClick);
}
function setMk(key, pt, iconKey, opts){
  if (!map || !pt) return;
  usedMarkers.add(key);
  const ll = [pt.lat, pt.lng];
  const rec = markers[key];
  if (!rec || rec.iconKey !== iconKey) {
    if (rec) map.removeLayer(rec.m);
    markers[key] = {m:L.marker(ll, {icon:getIcon(iconKey), keyboard:false, interactive:false, zIndexOffset:(opts && opts.z) || 0}).addTo(map), iconKey};
    return;
  }
  if (opts && opts.animate) animateMk(rec, ll);
  else { if (rec.raf) cancelAnimationFrame(rec.raf); rec.m.setLatLng(ll); }
}
function animateMk(rec, to){
  const from = rec.m.getLatLng();
  if (from.lat === to[0] && from.lng === to[1]) return;
  if (rec.raf) cancelAnimationFrame(rec.raf);
  if (reduceMotion || meters({lat:from.lat, lng:from.lng}, {lat:to[0], lng:to[1]}) > 3000) { rec.m.setLatLng(to); return; }
  const t0 = performance.now(), dur = 900;
  const step = now => {
    const t = Math.min(1, (now - t0) / dur);
    rec.m.setLatLng([from.lat + (to[0] - from.lat) * t, from.lng + (to[1] - from.lng) * t]);
    if (t < 1) rec.raf = requestAnimationFrame(step); else rec.raf = 0;
  };
  rec.raf = requestAnimationFrame(step);
}
let fitRetry = 0;
function fit(key, pts){
  if (!map || key === S.lastFit) return;
  // Leaflet ignores a new view while a zoom animation is running, so try again after it ends.
  if (map._animatingZoom) { clearTimeout(fitRetry); fitRetry = setTimeout(renderMap, 320); return; }
  S.lastFit = key;
  const good = pts.filter(Boolean);
  if (!good.length) return;
  if (good.length === 1 || good.every(p => meters(p, good[0]) < 30)) map.setView([good[0].lat, good[0].lng], 16, {animate:!reduceMotion});
  else map.fitBounds(L.latLngBounds(good.map(p => [p.lat, p.lng])), {paddingTopLeft:[44, 52], paddingBottomRight:[44, 70], maxZoom:16, animate:!reduceMotion});
}
const k3 = p => p ? p.lat.toFixed(3) + ',' + p.lng.toFixed(3) : '-';
function renderMap(){
  if (!map) return;
  usedMarkers = new Set();
  let dash = [], solid = [], fitKey = 'home', fitPts = PLACES;
  let showMe = false;
  if (S.screen === 'rider') {
    const r = myRiderRide();
    if (!r) {
      const a = pickupPoint(), b = dropoffPoint();
      setMk('A', a, 'A'); setMk('B', b, 'B');
      if (a && b) dash = [a, b];
      onlineDrivers().forEach(d => setMk('d:' + d.id, d.loc, 'carOther', {animate:true}));
      showMe = S.rider.pickupSel !== 'gps';
      fitKey = 'rform:' + k3(a) + '|' + k3(b);
      fitPts = [a, b];
    } else {
      setMk('A', r.pickup, 'A'); setMk('B', r.dropoff, 'B');
      if (r.status === 'requested') {
        dash = [r.pickup, r.dropoff];
        onlineDrivers().forEach(d => setMk('d:' + d.id, d.loc, 'carOther', {animate:true}));
        fitPts = [r.pickup, r.dropoff];
      } else {
        solid = [r.pickup, r.dropoff];
        if (r.driverLoc && r.status !== 'completed') setMk('car', r.driverLoc, 'car', {animate:true, z:1000});
        fitPts = r.status === 'accepted' ? [r.driverLoc, r.pickup] : r.status === 'arrived' ? [r.pickup] : [r.pickup, r.dropoff];
      }
      fitKey = 'rride:' + r.id + ':' + r.status + ':' + (r.driverLoc ? 'L' : '');
    }
  } else if (S.screen === 'driver') {
    const r = myDriverRide();
    if (r && DRIVING.includes(r.status)) {
      setMk('A', r.pickup, 'A'); setMk('B', r.dropoff, 'B');
      solid = [r.pickup, r.dropoff];
      if (S.me) setMk('car', S.me, 'car', {animate:true, z:1000});
      fitPts = r.status === 'accepted' ? [S.me, r.pickup] : r.status === 'arrived' ? [r.pickup] : [S.me, r.dropoff];
      fitKey = 'dride:' + r.id + ':' + r.status + ':' + (S.me ? 'M' : '');
    } else {
      if (S.me) setMk(S.driver.online ? 'car' : 'mecar', S.me, S.driver.online ? 'car' : 'me', {animate:true, z:1000});
      const reqs = S.driver.online ? openRequests() : [];
      reqs.forEach(q => setMk('q:' + q.id, q.pickup, 'req'));
      fitPts = [S.me].concat(reqs.map(q => q.pickup));
      fitKey = 'didle:' + reqs.map(q => q.id).join(',') + ':' + (S.me ? 'M' : '');
      if (!S.me && !reqs.length) { fitPts = PLACES; fitKey = 'didle-none'; }
    }
  } else {
    showMe = true;
  }
  const g = S.realGps;
  if (showMe && g) setMk('me', g, 'me', {animate:true});
  if (S.screen === 'rider' && S.rider.pickupSel === 'gps' && g && !myRiderRide()) {
    if (!accCircle) accCircle = L.circle([g.lat, g.lng], {radius:Math.max(5, g.acc || 10), className:'acc-circle', interactive:false}).addTo(map);
    else { accCircle.setLatLng([g.lat, g.lng]); accCircle.setRadius(Math.max(5, g.acc || 10)); }
  } else if (accCircle) { map.removeLayer(accCircle); accCircle = null; }
  dashLine.setLatLngs(dash.map(p => [p.lat, p.lng]));
  solidLine.setLatLngs(solid.map(p => [p.lat, p.lng]));
  Object.keys(markers).forEach(k => {
    if (!usedMarkers.has(k)) { const rec = markers[k]; if (rec.raf) cancelAnimationFrame(rec.raf); map.removeLayer(rec.m); delete markers[k]; }
  });
  fit(fitKey, fitPts);
}
function renderMapHint(){
  const hint = $('#map-hint');
  const text = {pickup:'Tap the map where you want to be picked up.', dropoff:"Tap the map where you're going.", spot:'Tap the map where your car is.'}[S.arm];
  hint.hidden = !text;
  if (text) $('#map-hint-text').textContent = text;
}
function onMapClick(e){
  if (!S.arm) return;
  const pt = {lat:Math.round(e.latlng.lat * 1e6) / 1e6, lng:Math.round(e.latlng.lng * 1e6) / 1e6};
  const arm = S.arm;
  S.arm = null;
  if (arm === 'pickup') { S.rider.pickupPin = pt; S.rider.pickupSel = 'pin'; saveRider(); }
  else if (arm === 'dropoff') { S.rider.dropoffPin = pt; S.rider.dropoffSel = 'pin'; saveRider(); }
  else if (arm === 'spot') { onMyPosition(Object.assign(pt, {acc:0, at:Date.now(), source:'manual'})); toast('Your spot is set'); return; }
  render();
}

/* ---------- small renderers ---------- */
const initials = n => (String(n || '').trim().split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase()) || '?';
const avatar = (name, photo, size) => `<div class="av ${size || ''}">${photo ? `<img src="${photo}" alt="">` : esc(initials(name))}</div>`;
function plate(p){
  const t = String(p || '').toUpperCase().trim() || 'NO PLATE';
  const parts = t.split(/\s+/);
  const inner = parts.length > 1 ? `${esc(parts[0])}<i></i>${esc(parts.slice(1).join(' '))}` : esc(t);
  return `<span class="plate" aria-label="License plate ${esc(t)}"><small>Florida</small><b>${inner}</b></span>`;
}
const driverCard = (d, big) => `<div class="who${big ? ' big' : ''}">${avatar(d.name, d.photo, 'lg')}<div class="who-t"><b>${esc(d.name || 'Driver')}</b><span>${esc(d.car || 'Car not listed')}</span></div>${plate(d.plate)}</div>`;
const legs = r => `<ol class="legs"><li><span class="dot a sm">A</span><span>${esc(r.pickup.name)}</span></li><li><span class="dot b sm">B</span><span>${esc(r.dropoff.name)}</span></li></ol>`;
function steps(i){
  const L2 = ['Requested','Driver coming','In the car','Arrived'];
  return `<ol class="steps" aria-label="Ride progress">${L2.map((l, j) => `<li class="${j < i ? 'done' : j === i ? 'now' : ''}"><span></span>${l}</li>`).join('')}</ol>`;
}
const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m + ' min ago'; };
const fmtMin = m => m == null ? '' : m < 1 ? Math.max(1, Math.round(m * 60)) + ' sec' : Math.round(m) + ' min';
const navUrl = p => `https://www.google.com/maps/dir/?api=1&destination=${p.lat.toFixed(6)},${p.lng.toFixed(6)}&travelmode=driving`;
function driversHint(){
  if (S.conn !== 'live') return S.conn === 'error' ? '' : 'Connecting…';
  const n = onlineDrivers().length;
  return n ? `${n} driver${n > 1 ? 's' : ''} online now.` : 'No drivers online yet. Your driver opens the app, taps Drive, then Go online.';
}

/* ---------- rider ---------- */
function fillSelects(){
  const groups = PLACES.reduce((acc, p) => { (acc[p.group] = acc[p.group] || []).push(p); return acc; }, {});
  const opts = list => list.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const places = `<optgroup label="West Palm Beach">${opts(groups.wpb)}</optgroup><optgroup label="Palm Beach island">${opts(groups.pb)}</optgroup>`;
  $('#r-pickup').innerHTML = '<option value="gps">My current location</option><option value="pin">A spot I pick on the map</option>' + places;
  $('#r-dropoff').innerHTML = '<option value="pin">A spot I pick on the map</option>' + places;
}
function riderHintHTML(){
  const r = S.rider, lines = [];
  if (r.pickupSel === 'gps') {
    if (S.gps.state === 'denied') lines.push("Location is blocked for this app. Allow it in your phone's settings, or choose a pickup from the list.");
    else if (S.gps.state === 'unavailable') lines.push("Your phone couldn't find your location. Choose a pickup from the list or on the map.");
    else if (!S.realGps) lines.push('Finding your location… Allow location if your phone asks.');
    else lines.push('Pickup is where you are now.');
  }
  if (r.pickupSel === 'pin') lines.push(r.pickupPin ? 'Pickup is pinned on the map. <button type="button" class="linkbtn" data-arm="pickup">Move pickup pin</button>' : 'Tap the map to set your pickup.');
  if (r.dropoffSel === 'pin') lines.push(r.dropoffPin ? 'Destination is pinned on the map. <button type="button" class="linkbtn" data-arm="dropoff">Move destination pin</button>' : 'Tap the map to set your destination.');
  return lines.map(l => `<p>${l}</p>`).join('');
}
function setHTML(el, html){ if (el.__h !== html) { el.innerHTML = html; el.__h = html; return true; } return false; }
function renderRiderForm(){
  const pick = $('#r-pickup'), drop = $('#r-dropoff');
  if (pick.value !== S.rider.pickupSel) pick.value = S.rider.pickupSel;
  if (drop.value !== S.rider.dropoffSel) drop.value = S.rider.dropoffSel;
  setHTML($('#r-hint'), riderHintHTML());
  const a = pickupPoint(), b = dropoffPoint();
  let html, ok = false;
  if (!a || !b) html = '<span class="eyebrow">Price before you ride</span><p>Choose a pickup and destination to see the price.</p>';
  else if (milesBetween(a, b) < 0.05) html = '<span class="eyebrow">Price before you ride</span><p>Pickup and destination are the same spot. Choose a different destination.</p>';
  else {
    const q = quote(a, b);
    ok = true;
    html = `<div class="fare-main"><span class="eyebrow">Price before you ride</span><span class="amt">${money(q.fare)}</span></div>
      <div class="fare-meta">About ${q.miles.toFixed(1)} mi · about ${q.minutes} min</div>
      <details><summary>How this price is set</summary><p>${money(PRICE.base)} base + ${money(PRICE.mile)} per mile + ${money(PRICE.min)} per minute + ${money(PRICE.booking)} booking fee. Minimum ${money(PRICE.minFare)}. Sample prices for testing. Distance is estimated from the map before the ride.</p></details>`;
  }
  setHTML($('#r-fare'), html);
  const btn = $('#r-request');
  btn.disabled = !ok || S.conn !== 'live' || S.busy.has('request');
  btn.textContent = S.busy.has('request') ? 'Requesting…' : 'Request ride';
  $('#r-drivers').textContent = driversHint();
}
function riderTripHTML(r){
  const d = r.driver || {name:'Your driver'};
  if (r.status === 'requested') {
    return `${steps(0)}
      <div class="status-h"><h2>Finding you a driver</h2><span class="spinner" aria-hidden="true"></span></div>
      ${r.releasedAt ? '<p class="inline-note">Your driver had to cancel. Finding you another one.</p>' : ''}
      ${legs(r)}
      <div class="kv"><span class="sub">Fare</span><b>${money(r.fare)}</b></div>
      <p class="hint">${esc(driversHint())}</p>
      <button class="btn ghost" type="button" data-act="cancel">Cancel request</button>`;
  }
  if (r.status === 'accepted') {
    return `${steps(1)}
      <div><h2>${esc(d.name)} is on the way</h2><p class="eta" data-eta="${esc(r.id)}" data-who="rider"></p></div>
      ${driverCard(d)}
      ${legs(r)}
      <button class="btn ghost" type="button" data-act="cancel">Cancel ride</button>`;
  }
  if (r.status === 'arrived') {
    return `${steps(1)}
      <div><h2>Your driver is here</h2><p class="sub">Match the plate before you get in.</p></div>
      ${driverCard(d, true)}
      <button class="btn ghost" type="button" data-act="cancel">Cancel ride</button>`;
  }
  if (r.status === 'in_progress') {
    return `${steps(2)}
      <div><h2>On the way to ${esc(r.dropoff.name)}</h2><p class="eta" data-eta="${esc(r.id)}" data-who="rider"></p></div>
      ${driverCard(d)}
      ${legs(r)}`;
  }
  const when = r.completedAt ? new Date(r.completedAt).toLocaleString([], {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'}) : '';
  const rated = r.rating ? Math.round(r.rating) : 0;
  const measured = r.tripMiles != null && r.tripMiles >= 0.05;
  const stars = [1, 2, 3, 4, 5].map(n => `<button type="button" class="${n <= rated ? 'on' : ''}" data-act="rate" data-n="${n}" aria-label="Rate ${n} star${n > 1 ? 's' : ''}"${rated ? ' disabled' : ''}>★</button>`).join('');
  return `${steps(4)}
    <div><h2>You've arrived</h2><p class="sub">Thanks for riding with ${esc(d.name)}.</p></div>
    <div class="receipt">
      <div class="rc-h"><span class="eyebrow">Receipt</span><span>${esc(when)}</span></div>
      <dl>
        <div><dt>From</dt><dd>${esc(r.pickup.name)}</dd></div>
        <div><dt>To</dt><dd>${esc(r.dropoff.name)}</dd></div>
        <div><dt>Distance</dt><dd>${measured ? r.tripMiles.toFixed(1) + ' mi, measured by GPS' : r.miles.toFixed(1) + ' mi, estimated'}</dd></div>
        <div><dt>Time</dt><dd>${r.tripMinutes != null ? fmtMin(r.tripMinutes) : 'About ' + r.minutes + ' min, estimated'}</dd></div>
        <div class="total"><dt>Total fare</dt><dd>${money(r.fare)}</dd></div>
      </dl>
      <p class="hint">No card was charged. This is a prototype.</p>
    </div>
    <div class="rate"><span class="eyebrow">${rated ? 'Your rating' : 'Rate ' + esc(d.name)}</span><div class="stars">${stars}</div></div>
    <button class="btn primary" type="button" data-act="again">Book another ride</button>`;
}
function renderRider(){
  const r = myRiderRide();
  $('#rider-form').hidden = !!r;
  const trip = $('#rider-trip');
  trip.hidden = !r;
  if (r) setHTML(trip, riderTripHTML(r));
  else { trip.__h = ''; renderRiderForm(); }
}
async function riderRequest(){
  if (S.busy.has('request') || S.conn !== 'live') return;
  const a = pickupPoint(), b = dropoffPoint();
  if (!a || !b || milesBetween(a, b) < 0.05) return;
  const q = quote(a, b);
  const ride = {
    riderUid:S.uid, riderName:(S.rider.name.trim() || 'Rider').slice(0, 40),
    pickup:{id:a.id, name:a.name, lat:a.lat, lng:a.lng}, dropoff:{id:b.id, name:b.name, lat:b.lat, lng:b.lng},
    fare:q.fare, miles:q.miles, minutes:q.minutes, status:'requested', createdAt:Date.now(), driverUid:null
  };
  S.busy.add('request'); render();
  const ok = await api.request(ride);
  S.busy.delete('request');
  if (ok) toast('Ride requested');
  render();
}
async function riderAct(act, n){
  const r = myRiderRide();
  if (!r || S.busy.has('rider')) return;
  S.busy.add('rider');
  try {
    if (act === 'cancel') { if (await api.patch(r.id, {status:'cancelled', cancelledBy:'rider', cancelledAt:Date.now()})) toast('Ride cancelled'); }
    else if (act === 'rate' && !r.rating) { if (await api.patch(r.id, {rating:clamp(n, 1, 5)})) toast('Thanks for rating'); }
    else if (act === 'again') dismiss('r:' + r.id);
  } finally { S.busy.delete('rider'); render(); }
}

/* ---------- driver ---------- */
function paintDriverAvatar(){
  $('#d-av').innerHTML = S.driver.photo ? `<img src="${S.driver.photo}" alt="Your photo">` : esc(initials(S.driver.name));
  $('#d-photo-rm').hidden = !S.driver.photo;
}
function driverLocLine(){
  if (S.driver.testDrive && S.me) return ['ok', 'Test drive is moving your car on the map. Riders see it move.'];
  if (S.me && S.me.source === 'manual') return ['ok', 'Using the spot you set on the map.'];
  switch (S.gps.state) {
    case 'on': return ['ok', 'Sharing your location with riders.'];
    case 'asking': return ['wait', 'Waiting for your location… Allow location if your phone asks.'];
    case 'denied': return ['bad', "Location is blocked for this app. Turn it on in your phone's settings, or set your spot on the map."];
    case 'unavailable': return ['bad', "Your phone couldn't find your location. Set your spot on the map instead."];
    default: return ['wait', 'Location is off.'];
  }
}
function requestCard(r, canAccept){
  const mine = r.riderUid === S.uid ? ' (you)' : '';
  const far = S.me ? ` · ${milesBetween(S.me, r.pickup).toFixed(1)} mi from you` : '';
  return `<article class="req">
    <div class="req-top"><b>${esc(r.riderName)}${mine}</b><span class="amt-sm">${money(r.fare)}</span></div>
    ${legs(r)}
    <div class="req-meta">${r.miles.toFixed(1)} mi trip${far} · you'd earn ${money(r.fare * PRICE.share)} · ${ago(r.createdAt)}</div>
    <button class="btn primary" type="button" data-act="accept" data-id="${esc(r.id)}"${canAccept ? '' : ' disabled'}>${canAccept ? 'Accept ride' : 'Go online to accept'}</button>
  </article>`;
}
function driverTripHTML(r){
  if (r.status === 'cancelled') {
    return `<h2>${esc(r.riderName)} cancelled</h2><p class="sub">No trip this time. New requests show up once you're back.</p>
      <button class="btn primary" type="button" data-act="done">Back to requests</button>`;
  }
  if (r.status === 'accepted') {
    return `${steps(1)}
      <div><h2>Pick up ${esc(r.riderName)}</h2><p class="eta" data-eta="${esc(r.id)}" data-who="driver"></p></div>
      ${legs(r)}
      <a class="btn ghost" href="${navUrl(r.pickup)}" target="_blank" rel="noopener">Directions to pickup</a>
      <div class="btn-row"><button class="btn primary" type="button" data-act="arrived">I've arrived</button>
      <button class="btn ghost" type="button" data-act="release">Release ride</button></div>`;
  }
  if (r.status === 'arrived') {
    return `${steps(1)}
      <div><h2>Waiting for ${esc(r.riderName)}</h2><p class="sub">Confirm their name before you start the trip.</p></div>
      ${legs(r)}
      <div class="btn-row"><button class="btn primary" type="button" data-act="start">Start trip</button>
      <button class="btn ghost" type="button" data-act="release">Release ride</button></div>`;
  }
  if (r.status === 'in_progress') {
    return `${steps(2)}
      <div><h2>Driving to ${esc(r.dropoff.name)}</h2><p class="eta" data-eta="${esc(r.id)}" data-who="driver"></p></div>
      ${legs(r)}
      <a class="btn ghost" href="${navUrl(r.dropoff)}" target="_blank" rel="noopener">Directions to destination</a>
      <button class="btn primary" type="button" data-act="end">End trip</button>`;
  }
  const rated = r.rating ? Math.round(r.rating) : 0;
  const measured = r.tripMiles != null && r.tripMiles >= 0.05;
  return `${steps(4)}
    <div><h2>Trip complete</h2><p class="sub">${esc(r.riderName)} · ${esc(r.pickup.name)} to ${esc(r.dropoff.name)}</p></div>
    <div class="earn"><span>You earned <span class="hint">(sample ${Math.round(PRICE.share * 100)}% of ${money(r.fare)})</span></span><b>${money(r.fare * PRICE.share)}</b></div>
    <p class="sub">${measured ? r.tripMiles.toFixed(1) + ' mi' : 'Distance not measured'}${r.tripMinutes != null ? ' · ' + fmtMin(r.tripMinutes) : ''}</p>
    <p class="sub">${rated ? `Rider gave you ${'★'.repeat(rated)}${'☆'.repeat(5 - rated)}` : 'Waiting for the rider to rate the trip.'}</p>
    <button class="btn primary" type="button" data-act="done">Back to requests</button>`;
}
function renderDriver(){
  const r = myDriverRide();
  const online = S.driver.online;
  $('#driver-setup').hidden = online;
  $('#driver-online').hidden = !online || !!r;
  $('#d-test-row').hidden = !online;
  $('#d-test').checked = S.driver.testDrive;
  if (online) {
    setHTML($('#d-card'), driverCard(S.driver));
    const [cls, text] = driverLocLine();
    $('#d-loc').className = 'loc-line ' + cls;
    $('#d-loc-text').textContent = text;
    $('#d-retry').hidden = !(S.gps.state === 'denied' || S.gps.state === 'unavailable' || (S.me && S.me.source === 'manual'));
  }
  const trip = $('#driver-trip');
  trip.hidden = !r;
  if (r) setHTML(trip, driverTripHTML(r)); else trip.__h = '';
  const box = $('#driver-requests');
  box.hidden = !!r;
  if (!r) {
    const reqs = online ? openRequests() : [];
    const canAccept = online && S.conn === 'live';
    let html = `<div class="reqs-h"><h3>Ride requests</h3><span>${reqs.length ? reqs.length + ' waiting' : ''}</span></div>`;
    if (reqs.length) html += reqs.map(q => requestCard(q, canAccept)).join('');
    else html += `<div class="empty">${online ? 'No requests yet. When someone taps Request ride, it shows up here and on the map.' : 'Go online to see ride requests.'}</div>`;
    setHTML(box, html);
  }
}
async function goOnline(){
  const name = $('#d-name').value.trim(), plateV = $('#d-plate').value.trim().toUpperCase();
  const err = $('#d-err');
  if (!name || !plateV) { err.textContent = !name ? 'Add the name riders will see.' : 'Add your plate so riders can find your car.'; err.hidden = false; return; }
  err.hidden = true;
  if (S.conn !== 'live') { toast('Still connecting. Try again in a moment.'); return; }
  if (S.busy.has('online')) return;
  S.busy.add('online');
  Object.assign(S.driver, {name, plate:plateV, car:$('#d-car').value.trim()});
  startGps();
  const d = S.driver;
  const ok = await api.driverDoc({name:d.name.slice(0, 40), car:d.car.slice(0, 40), plate:d.plate.slice(0, 10), photo:d.photo, online:true, updatedAt:Date.now(), loc:S.me ? {lat:S.me.lat, lng:S.me.lng} : null});
  S.busy.delete('online');
  if (ok) { S.driver.online = true; saveDriver(); lastDrv = {at:Date.now(), lat:S.me ? S.me.lat : null, lng:S.me ? S.me.lng : null}; toast("You're online"); }
  render();
}
async function goOffline(){
  if (S.busy.has('online')) return;
  S.busy.add('online');
  await api.driverDoc({online:false, updatedAt:Date.now()});
  S.busy.delete('online');
  S.driver.online = false;
  saveDriver();
  if (S.rider.pickupSel !== 'gps') stopGps();
  render();
}
async function driverAccept(id){
  if (!S.driver.online || S.busy.has('driver')) return;
  S.busy.add('driver');
  const d = S.driver, now = Date.now();
  const ok = await api.accept(id, {
    status:'accepted', driverUid:S.uid, acceptedAt:now, releasedAt:null,
    driver:{name:d.name.slice(0, 40), car:d.car.slice(0, 40), plate:d.plate.slice(0, 10), photo:d.photo},
    driverLoc:S.me ? {lat:S.me.lat, lng:S.me.lng, at:now} : null
  });
  S.busy.delete('driver');
  if (ok) { S.arm = null; lastRide = {id:id, at:now, lat:S.me ? S.me.lat : null, lng:S.me ? S.me.lng : null}; toast('Ride accepted'); }
  render();
}
async function driverAct(act){
  const r = myDriverRide();
  if (!r || S.busy.has('driver')) return;
  S.busy.add('driver');
  const now = Date.now();
  try {
    if (act === 'arrived') await api.patch(r.id, {status:'arrived', arrivedAt:now});
    else if (act === 'start') {
      if (await api.patch(r.id, {status:'in_progress', startedAt:now})) {
        S.trip = {id:r.id, meters:0, last:S.me ? {lat:S.me.lat, lng:S.me.lng} : null};
        store.set('trip.' + r.id, S.trip);
      }
    } else if (act === 'end') {
      const t = (S.trip && S.trip.id === r.id) ? S.trip : obj(store.get('trip.' + r.id, null));
      const tripMiles = t && typeof t.meters === 'number' ? Math.round(t.meters / 1609.344 * 100) / 100 : null;
      const tripMinutes = r.startedAt ? Math.round((now - r.startedAt) / 6000) / 10 : null;
      if (await api.patch(r.id, {status:'completed', completedAt:now, tripMiles, tripMinutes})) { store.del('trip.' + r.id); S.trip = null; }
    } else if (act === 'release') {
      if (await api.patch(r.id, {status:'requested', driverUid:null, driver:null, driverLoc:null, acceptedAt:null, arrivedAt:null, releasedAt:now})) toast('Ride released');
    } else if (act === 'done') dismiss('d:' + r.id);
  } finally { S.busy.delete('driver'); render(); }
}

/* ---------- live ETA text ---------- */
function updateEta(){
  $$('[data-eta]').forEach(el => {
    const r = allRides().get(el.dataset.eta);
    if (!r) return;
    const target = r.status === 'in_progress' ? r.dropoff : r.pickup;
    let txt = '';
    if (el.dataset.who === 'rider') {
      const loc = r.driverLoc;
      if (!loc) txt = "Waiting for your driver's location";
      else {
        const e = etaTo(loc, target);
        txt = e.mi < NEAR_MI ? (r.status === 'accepted' ? 'Arriving now' : 'Almost there')
          : `About ${e.min} min · ${e.mi.toFixed(1)} mi ${r.status === 'accepted' ? 'away' : 'to go'}`;
        const age = Date.now() - (loc.at || 0);
        if (loc.at && age > 90000) txt += ` · location from ${Math.round(age / 60000)} min ago`;
      }
    } else if (!S.me) txt = 'Waiting for your location';
    else {
      const e = etaTo(S.me, target);
      txt = e.mi < NEAR_MI ? (r.status === 'accepted' ? "You're at the pickup" : "You're at the destination") : `${e.mi.toFixed(1)} mi · about ${e.min} min`;
    }
    if (el.textContent !== txt) el.textContent = txt;
  });
  const r = myDriverRide();
  const arr = $('#driver-trip [data-act="arrived"]');
  if (arr) arr.classList.toggle('glow', !!(r && S.me && milesBetween(S.me, r.pickup) < NEAR_MI));
  const end = $('#driver-trip [data-act="end"]');
  if (end) end.classList.toggle('glow', !!(r && S.me && milesBetween(S.me, r.dropoff) < NEAR_MI));
}

/* ---------- top-level render ---------- */
let rendering = false;
function render(){
  if (rendering) return;
  rendering = true;
  try {
    ['home','rider','driver'].forEach(s => { $('#screen-' + s).hidden = S.screen !== s; });
    $$('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.go === S.screen)));
    const pill = $('#conn-pill');
    pill.dataset.mode = S.conn;
    pill.lastElementChild.textContent = S.conn === 'live' ? 'Live' : S.conn === 'error' ? 'Offline' : 'Connecting';
    if (S.screen === 'rider') renderRider();
    if (S.screen === 'driver') renderDriver();
    renderMapHint();
    renderMap();
    updateEta();
    keepAwake(needAwake());
  } finally { rendering = false; }
}
function go(screen){
  S.screen = screen;
  S.arm = null;
  store.set('screen', screen);
  if (screen === 'rider' && S.rider.pickupSel === 'gps' && !myRiderRide()) startGps();
  render();
}

/* ---------- events ---------- */
function bindEvents(){
  $('#brand').addEventListener('click', () => go('home'));
  $$('.seg button').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
  $('#go-ride').addEventListener('click', () => go('rider'));
  $('#go-drive').addEventListener('click', () => go('driver'));
  $('#recenter').addEventListener('click', () => { S.lastFit = ''; render(); });
  $('#map-hint-cancel').addEventListener('click', () => { S.arm = null; render(); });

  const nameIn = $('#r-name');
  nameIn.value = S.rider.name;
  nameIn.addEventListener('input', () => { S.rider.name = nameIn.value; saveRider(); });
  fillSelects();
  $('#r-pickup').addEventListener('change', e => {
    S.rider.pickupSel = e.target.value;
    S.arm = (e.target.value === 'pin' && !S.rider.pickupPin) ? 'pickup' : null;
    if (e.target.value === 'gps') startGps();
    saveRider(); render();
  });
  $('#r-dropoff').addEventListener('change', e => {
    S.rider.dropoffSel = e.target.value;
    S.arm = (e.target.value === 'pin' && !S.rider.dropoffPin) ? 'dropoff' : null;
    saveRider(); render();
  });
  $('#r-swap').addEventListener('click', () => {
    const r = S.rider, g = S.realGps;
    const pickAsDrop = r.pickupSel === 'gps' ? (g ? 'pin' : null) : r.pickupSel;
    if (!pickAsDrop) { toast("Your location isn't ready yet."); return; }
    const newPickupPin = r.dropoffSel === 'pin' ? r.dropoffPin : r.pickupPin;
    const newDropoffPin = r.pickupSel === 'gps' ? {lat:g.lat, lng:g.lng} : r.pickupSel === 'pin' ? r.pickupPin : r.dropoffPin;
    const newPickupSel = r.dropoffSel;
    r.dropoffSel = pickAsDrop;
    r.pickupSel = newPickupSel;
    r.pickupPin = newPickupPin;
    r.dropoffPin = newDropoffPin;
    saveRider(); render();
  });
  $('#r-hint').addEventListener('click', e => { const b = e.target.closest('[data-arm]'); if (b) { S.arm = b.dataset.arm; render(); } });
  $('#r-request').addEventListener('click', riderRequest);
  $('#rider-trip').addEventListener('click', e => { const b = e.target.closest('button[data-act]'); if (b && !b.disabled) riderAct(b.dataset.act, Number(b.dataset.n)); });

  $('#d-name').value = S.driver.name;
  $('#d-car').value = S.driver.car;
  $('#d-plate').value = S.driver.plate;
  $('#d-name').addEventListener('input', e => { S.driver.name = e.target.value; saveDriver(); if (!S.driver.photo) paintDriverAvatar(); });
  $('#d-car').addEventListener('input', e => { S.driver.car = e.target.value; saveDriver(); });
  $('#d-plate').addEventListener('input', e => { const up = e.target.value.toUpperCase(); if (up !== e.target.value) e.target.value = up; S.driver.plate = up; saveDriver(); });
  $('#d-photo').addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas'), s = 128;
        c.width = c.height = s;
        const m = Math.min(img.width, img.height);
        c.getContext('2d').drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, s, s);
        S.driver.photo = cleanPhoto(c.toDataURL('image/jpeg', 0.75));
        saveDriver(); paintDriverAvatar();
      };
      img.onerror = () => toast("That photo couldn't be read. Try another one.");
      img.src = reader.result;
    };
    reader.onerror = () => toast("That photo couldn't be read. Try another one.");
    reader.readAsDataURL(file);
  });
  $('#d-photo-rm').addEventListener('click', () => { S.driver.photo = ''; saveDriver(); paintDriverAvatar(); });
  $('#d-online').addEventListener('click', goOnline);
  $('#d-offline').addEventListener('click', goOffline);
  $('#d-spot').addEventListener('click', () => { S.arm = 'spot'; render(); });
  $('#d-retry').addEventListener('click', () => {
    if (S.me && S.me.source === 'manual') S.me = null;
    if (S.realGps && S.gps.state === 'on') { onMyPosition(S.realGps); return; }
    stopGps(); S.gps.state = 'off'; startGps();
  });
  $('#d-test').addEventListener('change', e => {
    S.driver.testDrive = e.target.checked;
    saveDriver();
    if (S.driver.testDrive && !S.me) toast('Set your spot on the map first, so the test drive knows where to start.');
    if (!S.driver.testDrive && S.realGps && (!S.me || S.me.source === 'sim')) onMyPosition(S.realGps);
    render();
  });
  $('#driver-trip').addEventListener('click', e => { const b = e.target.closest('button[data-act]'); if (b && !b.disabled) driverAct(b.dataset.act); });
  $('#driver-requests').addEventListener('click', e => { const b = e.target.closest('button[data-act="accept"]'); if (b && !b.disabled) driverAccept(b.dataset.id); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { keepAwake(needAwake()); pushLocation(true); } });
}

/* ---------- start ---------- */
async function start(){
  buildMap();
  bindEvents();
  paintDriverAvatar();
  if (S.driver.online || (S.screen === 'rider' && S.rider.pickupSel === 'gps')) startGps();
  render();
  setInterval(testDriveTick, 1000);
  setInterval(() => { pushLocation(false); updateEta(); }, 15000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  try { FB = await loadFirebase(); }
  catch (e) { S.conn = 'error'; setNotice("Couldn't reach the app's servers. Check your internet connection and reload."); console.warn(e); render(); return; }
  const app = FB.app.initializeApp(firebaseConfig);
  auth = FB.auth.getAuth(app);
  db = FB.fs.getFirestore(app);
  FB.auth.onAuthStateChanged(auth, user => {
    if (!user) return;
    S.uid = user.uid;
    S.conn = 'live';
    subscribe();
    if (S.driver.online) pushLocation(true);
    render();
  });
  try { await FB.auth.signInAnonymously(auth); } catch (e) { authErr(e); }
}
start();
