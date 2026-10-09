/* WPB Rides: prototype rideshare app for West Palm Beach with live GPS.
   Plain JavaScript module, no build step. Firebase (anonymous Auth + Firestore)
   keeps the phones in sync. Google Maps Platform draws the map, finds typed
   addresses and road routes. README.md describes the data model and limits. */
import { firebaseConfig, FIREBASE_VERSION, MAPS_API_KEY, MAP_ID } from './config.js';

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
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/* ---------- places, distance, pricing ---------- */
const PLACES = [
  {id:'clematis', name:'Clematis St', area:'Downtown West Palm Beach', lat:26.7137, lng:-80.0525, popular:true},
  {id:'brightline', name:'Brightline Station', area:'West Palm Beach', lat:26.7158, lng:-80.0560, popular:true},
  {id:'trirail', name:'Tri-Rail Station', area:'Tamarind Ave, West Palm Beach', lat:26.7126, lng:-80.0622},
  {id:'rosemary', name:'Rosemary Square', area:'Downtown West Palm Beach', lat:26.7093, lng:-80.0567, popular:true},
  {id:'kravis', name:'Kravis Center', area:'Okeechobee Blvd, West Palm Beach', lat:26.7062, lng:-80.0585},
  {id:'norton', name:'Norton Museum of Art', area:'S Dixie Hwy, West Palm Beach', lat:26.6990, lng:-80.0525},
  {id:'goodsam', name:'Good Samaritan Medical Center', area:'N Flagler Dr, West Palm Beach', lat:26.7268, lng:-80.0515},
  {id:'currie', name:'Currie Park', area:'N Flagler Dr, West Palm Beach', lat:26.7365, lng:-80.0512},
  {id:'stmarys', name:"St. Mary's Medical Center", area:'45th St, West Palm Beach', lat:26.7420, lng:-80.0640},
  {id:'outlets', name:'Palm Beach Outlets', area:'Palm Beach Lakes Blvd, West Palm Beach', lat:26.7225, lng:-80.0880, popular:true},
  {id:'pbi', name:'PBI Airport', area:'Palm Beach International Airport', lat:26.6832, lng:-80.0956, popular:true},
  {id:'worth', name:'Worth Avenue', area:'Palm Beach', lat:26.7030, lng:-80.0380, popular:true},
  {id:'breakers', name:'The Breakers', area:'Palm Beach', lat:26.7155, lng:-80.0355}
];
const P = Object.fromEntries(PLACES.map(p => [p.id, p]));
const WPB = {lat:26.712, lng:-80.062};
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
function pathLen(pts){ let m = 0; for (let i = 1; i < pts.length; i++) m += meters(pts[i - 1], pts[i]); return m; }
// Fare from the road route when we have one, otherwise from straight-line distance.
function quote(a, b, route){
  let mi, minutes, byRoad = false;
  if (route && route.meters > 0) { mi = route.meters / 1609.344; minutes = Math.round(route.seconds / 60); byRoad = true; }
  else { mi = milesBetween(a, b) * 1.3; minutes = Math.round(mi / 19 * 60 + 2); }
  mi = Math.max(0.3, mi); minutes = Math.max(4, minutes);
  const raw = PRICE.base + PRICE.mile * mi + PRICE.min * minutes + PRICE.booking;
  return {miles:Math.round(mi * 10) / 10, minutes, fare:Math.max(PRICE.minFare, Math.round(raw * 100) / 100), byRoad};
}
function etaStraight(from, to){ const mi = milesBetween(from, to) * 1.3; return {mi, min:Math.max(1, Math.round(mi / 22 * 60))}; }
// Time left along a road route from the car's position; falls back to straight line when off the route.
function etaAlong(route, loc, target){
  if (route && route.pts.length > 1 && route.len > 0) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < route.pts.length; i++) { const d = meters(route.pts[i], loc); if (d < bd) { bd = d; best = i; } }
    if (bd < 250) {
      let rem = 0;
      for (let i = best; i < route.pts.length - 1; i++) rem += meters(route.pts[i], route.pts[i + 1]);
      const secs = route.seconds > 0 ? route.seconds * rem / route.len : rem / 9;
      return {mi:rem / 1609.344, min:Math.max(1, Math.round(secs / 60))};
    }
  }
  return etaStraight(loc, target);
}
function nearName(p){
  let best = null, bd = Infinity;
  PLACES.forEach(q => { const d = milesBetween(p, q); if (d < bd) { bd = d; best = q; } });
  return bd < 0.5 ? best.name : '';
}

/* ---------- route shapes (Google's encoded polyline format) ---------- */
function encodePath(pts){
  let out = '', pLat = 0, pLng = 0;
  const enc = v => { v = v < 0 ? ~(v << 1) : (v << 1); let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const p of pts) { const la = Math.round(p.lat * 1e5), ln = Math.round(p.lng * 1e5); out += enc(la - pLat) + enc(ln - pLng); pLat = la; pLng = ln; }
  return out;
}
function decodePath(s){
  const pts = [];
  let i = 0, lat = 0, lng = 0;
  const next = () => { let b, shift = 0, res = 0; do { b = s.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < s.length); return (res & 1) ? ~(res >> 1) : (res >> 1); };
  while (i < s.length) {
    lat += next();
    if (i >= s.length) break;
    lng += next();
    const p = {lat:lat / 1e5, lng:lng / 1e5};
    if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) return [];
    pts.push(p);
  }
  return pts;
}
function thin(pts, minM){
  if (pts.length < 3) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) if (meters(out[out.length - 1], pts[i]) >= minM) out.push(pts[i]);
  out.push(pts[pts.length - 1]);
  return out;
}
const packRoute = rt => ({poly:encodePath(rt.pts), meters:Math.round(rt.meters), seconds:Math.round(rt.seconds)});
function sample(pts, n){
  if (!pts || pts.length <= n) return pts || [];
  const out = [];
  for (let k = 0; k < n; k++) out.push(pts[Math.round(k * (pts.length - 1) / (n - 1))]);
  return out;
}

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
function cleanPlace(p){ const q = cleanPt(p); return q ? Object.assign(q, {id:str(p.id, 30), name:str(p.name, 80) || 'Pinned spot', address:str(p.address, 140)}) : null; }
function cleanRoute(x){
  if (!x || typeof x !== 'object' || typeof x.poly !== 'string' || x.poly.length > 40000) return null;
  const pts = decodePath(x.poly);
  if (pts.length < 2) return null;
  const len = pathLen(pts);
  return {pts, len, meters:num(x.meters) || len, seconds:num(x.seconds) || 0};
}
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
    route:cleanRoute(d.route), approach:cleanRoute(d.approach),
    trail:typeof d.trail === 'string' && d.trail.length < 60000 ? decodePath(d.trail) : [],
    fare:num(d.fare) || 0, miles:num(d.miles) || 0, minutes:num(d.minutes) || 0,
    createdAt:num(d.createdAt) || 0, acceptedAt:num(d.acceptedAt), arrivedAt:num(d.arrivedAt),
    startedAt:num(d.startedAt), completedAt:num(d.completedAt), cancelledAt:num(d.cancelledAt),
    cancelledBy:str(d.cancelledBy, 10), releasedAt:num(d.releasedAt), rating:num(d.rating),
    tripMiles:num(d.tripMiles), tripMinutes:num(d.tripMinutes)
  };
}
// A rider's chosen pickup or destination: {kind:'gps'} or {kind:'place'|'pin', name, address, lat, lng}.
function cleanSel(s, allowGps){
  if (!s || typeof s !== 'object') return null;
  if (s.kind === 'gps') return allowGps ? {kind:'gps'} : null;
  if (s.kind !== 'place' && s.kind !== 'pin') return null;
  const p = cleanPt(s);
  return p ? {kind:s.kind, name:str(s.name, 80) || 'Pinned spot', address:str(s.address, 140), lat:p.lat, lng:p.lng} : null;
}

/* ---------- state ---------- */
const rs = obj(store.get('rider', {}));
const ds = obj(store.get('driver', {}));
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
  formRoute:{key:'', state:'idle', route:null},
  rider:{
    name:typeof rs.name === 'string' ? rs.name : '',
    pickup:cleanSel(rs.pickup, true) || {kind:'gps'},
    dropoff:cleanSel(rs.dropoff, false)
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
function selPoint(sel){
  if (!sel) return null;
  if (sel.kind === 'gps') {
    const g = S.realGps;   // the phone's real GPS, even if this phone is also test-driving
    if (!g) return null;
    const n = nearName(g);
    return {id:'', name:n ? 'My location, near ' + n : 'My location', address:'', lat:g.lat, lng:g.lng};
  }
  return {id:'', name:sel.name, address:sel.address || '', lat:sel.lat, lng:sel.lng};
}
const selLabel = sel => !sel ? '' : sel.kind === 'gps' ? 'My current location' : sel.name;
function pinSel(pt){ const n = nearName(pt); return {kind:'pin', name:n ? 'Pinned spot near ' + n : 'Pinned spot', address:'', lat:pt.lat, lng:pt.lng}; }

/* ---------- messages ---------- */
let toastT = 0;
function toast(msg){ const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2800); }
function setNotice(msg){ const n = $('#notice'); n.textContent = msg || ''; n.hidden = !msg; }

/* ---------- Google Maps ---------- */
const MAPS = {ready:null, ok:false, failed:false, libs:{}};
const G = {};
function loadMaps(){
  if (MAPS.ready) return MAPS.ready;
  if (!MAPS_API_KEY) { MAPS.failed = true; MAPS.ready = Promise.reject(new Error('No Google Maps key')); MAPS.ready.catch(() => {}); return MAPS.ready; }
  MAPS.ready = new Promise((resolve, reject) => {
    window.__wpbMapsReady = () => resolve(window.google.maps);
    // Google calls this when the key is refused (billing off, service not enabled, wrong website).
    window.gm_authFailure = () => { MAPS.failed = true; setNotice("Google Maps didn't accept the app's key. In Google Cloud, check that billing is on, the three map services are enabled, and the key allows https://wagonprototype.github.io/*."); };
    const s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?' + new URLSearchParams({key:MAPS_API_KEY, v:'weekly', loading:'async', callback:'__wpbMapsReady'}).toString();
    s.async = true;
    s.onerror = () => { MAPS.failed = true; reject(new Error('Google Maps could not load')); };
    document.head.appendChild(s);
  });
  MAPS.ready.catch(() => {});
  return MAPS.ready;
}
async function mapsLib(name){
  const g = await loadMaps();
  if (!MAPS.libs[name]) MAPS.libs[name] = g.importLibrary(name);
  return MAPS.libs[name];
}
const withTimeout = (p, ms) => Promise.race([p, new Promise(res => setTimeout(() => res(null), ms))]);
const routeCache = new Map();
const routeKey = (a, b) => (a && b) ? `${a.lat.toFixed(4)},${a.lng.toFixed(4)}>${b.lat.toFixed(4)},${b.lng.toFixed(4)}` : '';
function getRoute(a, b){
  const key = routeKey(a, b);
  if (!key) return Promise.resolve(null);
  if (routeCache.has(key)) return routeCache.get(key);
  const p = withTimeout((async () => {
    const {Route} = await mapsLib('routes');
    const {routes} = await Route.computeRoutes({origin:{lat:a.lat, lng:a.lng}, destination:{lat:b.lat, lng:b.lng}, travelMode:'DRIVING', fields:['path', 'distanceMeters', 'durationMillis']});
    const r = routes && routes[0];
    if (!r || !r.path || r.path.length < 2) return null;
    const pts = thin(r.path.map(q => ({lat:typeof q.lat === 'function' ? q.lat() : q.lat, lng:typeof q.lng === 'function' ? q.lng() : q.lng})), 12);
    return {pts, len:pathLen(pts), meters:r.distanceMeters || pathLen(pts), seconds:Math.round((r.durationMillis || 0) / 1000)};
  })().catch(e => { console.warn(e); return null; }), 12000);
  routeCache.set(key, p);
  p.then(v => { if (!v) setTimeout(() => routeCache.delete(key), 60000); });
  return p;
}

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
  quietPatch(id, p){ return FB.fs.updateDoc(FB.fs.doc(db, 'rides', id), p).catch(e => console.warn(e)); },
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
      const patch = {driverLoc:{lat:p.lat, lng:p.lng, at:now}};
      if (r.status === 'in_progress' && S.trip && S.trip.id === r.id && S.trip.pts.length > 1) patch.trail = encodePath(S.trip.pts.slice(-1500));
      api.quietPatch(r.id, patch).finally(() => inflight.delete('ride'));
    }
  }
}
function loadTrip(id){
  const t = obj(store.get('trip.' + id, null));
  return t.id === id ? {id, meters:num(t.meters) || 0, last:cleanPt(t.last), pts:Array.isArray(t.pts) ? t.pts.map(cleanPt).filter(Boolean) : []} : {id, meters:0, last:null, pts:[]};
}
function trackTrip(p){
  const r = myDriverRide();
  if (!r || r.status !== 'in_progress' || p.source === 'manual') return;
  if (!S.trip || S.trip.id !== r.id) S.trip = loadTrip(r.id);
  const t = S.trip;
  if (!t.last) t.last = {lat:p.lat, lng:p.lng};
  else {
    const m = meters(t.last, p);
    if (m >= 8 && (p.acc || 0) <= 60) { t.meters += m; t.last = {lat:p.lat, lng:p.lng}; }
  }
  const lastPt = t.pts[t.pts.length - 1];
  if ((!lastPt || meters(lastPt, p) >= 15) && (p.acc || 0) <= 60) t.pts.push({lat:Math.round(p.lat * 1e5) / 1e5, lng:Math.round(p.lng * 1e5) / 1e5});
  if (!t.savedAt || Date.now() - t.savedAt > 10000) { t.savedAt = Date.now(); store.set('trip.' + r.id, t); }
}
function testDriveTick(){
  if (!S.driver.online || !S.driver.testDrive || !S.me) return;
  const r = myDriverRide();
  if (!r || (r.status !== 'accepted' && r.status !== 'in_progress')) return;
  const target = r.status === 'accepted' ? r.pickup : r.dropoff;
  const route = r.status === 'accepted' ? r.approach : r.route;
  // Follow the road route when there is one; otherwise head straight for the target.
  let goal = target;
  if (route && route.pts.length > 1) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < route.pts.length; i++) { const d = meters(route.pts[i], S.me); if (d < bd) { bd = d; best = i; } }
    if (bd < 300) {
      // The nearest point may be just behind the car; once on the route, aim for the next one.
      let i = best;
      if (bd < 30 && i < route.pts.length - 1) i++;
      goal = route.pts[i];
    }
  }
  let budget = TEST_DRIVE_MPS, pos = {lat:S.me.lat, lng:S.me.lng};
  for (let guard = 0; guard < 20 && budget > 0; guard++) {
    const d = meters(pos, goal);
    if (d < 1) {
      if (goal === target || meters(pos, target) < 5) break;
      // move on to the next point of the route
      const pts = route ? route.pts : [];
      let i = pts.findIndex(q => q === goal);
      goal = (i >= 0 && i < pts.length - 1) ? pts[i + 1] : target;
      continue;
    }
    const f = Math.min(1, budget / d);
    pos = {lat:pos.lat + (goal.lat - pos.lat) * f, lng:pos.lng + (goal.lng - pos.lng) * f};
    budget -= d * f;
  }
  if (meters(pos, S.me) < 0.5) return;
  onMyPosition({lat:pos.lat, lng:pos.lng, acc:5, at:Date.now(), source:'sim'});
}
const routeAsked = new Set();
function ensureDriverRoutes(r){
  if (!r || !FB || !S.uid) return;
  if (r.status === 'accepted' && !r.approach && S.me && !routeAsked.has('a' + r.id)) {
    routeAsked.add('a' + r.id);
    getRoute(S.me, r.pickup).then(rt => { if (rt) api.quietPatch(r.id, {approach:packRoute(rt)}); });
  }
  if ((r.status === 'arrived' || r.status === 'in_progress') && !r.route && !routeAsked.has('t' + r.id)) {
    routeAsked.add('t' + r.id);
    getRoute(r.pickup, r.dropoff).then(rt => { if (rt) api.quietPatch(r.id, {route:packRoute(rt)}); });
  }
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
let map = null, accCircle = null;
const markers = {}, lines = {};
let usedMarkers = new Set(), usedLines = new Set();
const CAR_SVG = '<svg viewBox="-6 -4.5 12 9" aria-hidden="true"><path d="M-5 2.1V-.4l1.5-2.8h7L5-.4v2.5z"/><circle cx="-3" cy="2.6" r="1.3"/><circle cx="3" cy="2.6" r="1.3"/></svg>';
const MARK_HTML = {
  A:'<div class="mk mk-a">A</div>',
  B:'<div class="mk mk-b">B</div>',
  car:'<div class="car">' + CAR_SVG + '</div>',
  carOther:'<div class="car other">' + CAR_SVG + '</div>',
  me:'<div class="me-dot"></div>',
  req:'<div class="req-pin"></div>'
};
async function buildMap(){
  const el = $('#map');
  if (!MAPS_API_KEY) { el.classList.add('map-off'); el.textContent = 'The map is off until a Google Maps key is added to the app.'; return; }
  try {
    const [{Map, Polyline, Circle}, {AdvancedMarkerElement}, core] = await Promise.all([mapsLib('maps'), mapsLib('marker'), mapsLib('core')]);
    Object.assign(G, {Polyline, Circle, Marker:AdvancedMarkerElement, LatLngBounds:core.LatLngBounds, event:core.event || window.google.maps.event});
    map = new Map(el, {center:WPB, zoom:13, mapId:MAP_ID, disableDefaultUI:true, gestureHandling:'greedy', clickableIcons:false, colorScheme:'FOLLOW_SYSTEM'});
    map.addListener('click', e => { if (e && e.latLng) onMapClick({lat:e.latLng.lat(), lng:e.latLng.lng()}); });
    MAPS.ok = true;
    render();
  } catch (e) {
    MAPS.failed = true;
    el.classList.add('map-off');
    el.textContent = "Google Maps couldn't load. Check your internet connection and reload.";
    console.warn(e);
  }
}
function setMk(key, pt, kind, opts){
  if (!map || !pt) return;
  usedMarkers.add(key);
  const pos = {lat:pt.lat, lng:pt.lng};
  const rec = markers[key];
  if (!rec || rec.kind !== kind) {
    if (rec) { if (rec.raf) cancelAnimationFrame(rec.raf); rec.m.map = null; }
    const content = document.createElement('div');
    content.className = 'pin-c';
    content.innerHTML = MARK_HTML[kind];
    markers[key] = {m:new G.Marker({map, position:pos, content, zIndex:(opts && opts.z) || 0}), kind, cur:pos};
    return;
  }
  if (opts && opts.animate) animateMk(rec, pos);
  else { if (rec.raf) cancelAnimationFrame(rec.raf); rec.m.position = pos; rec.cur = pos; }
}
function animateMk(rec, to){
  const from = rec.cur;
  if (from.lat === to.lat && from.lng === to.lng) return;
  if (rec.raf) cancelAnimationFrame(rec.raf);
  if (reduceMotion || meters(from, to) > 3000) { rec.m.position = to; rec.cur = to; return; }
  const t0 = performance.now(), dur = 900;
  const step = now => {
    const t = Math.min(1, (now - t0) / dur);
    rec.cur = {lat:from.lat + (to.lat - from.lat) * t, lng:from.lng + (to.lng - from.lng) * t};
    rec.m.position = rec.cur;
    rec.raf = t < 1 ? requestAnimationFrame(step) : 0;
  };
  rec.raf = requestAnimationFrame(step);
}
const lineStyles = () => {
  const primary = css('--primary') || '#0A6670', accent = css('--accent') || '#E08C2C';
  return {
    plan:{strokeColor:primary, strokeOpacity:0.45, strokeWeight:6, zIndex:1},
    straight:{strokeColor:primary, strokeOpacity:0, strokeWeight:4, zIndex:1, icons:[{icon:{path:'M 0,-1 0,1', strokeOpacity:0.9, strokeColor:primary, scale:3}, offset:'0', repeat:'14px'}]},
    way:{strokeColor:accent, strokeOpacity:0, strokeWeight:4, zIndex:2, icons:[{icon:{path:0, fillOpacity:1, fillColor:accent, strokeOpacity:0, scale:3.2}, offset:'0', repeat:'11px'}]},
    trail:{strokeColor:primary, strokeOpacity:1, strokeWeight:6, zIndex:3}
  };
};
function setLine(key, pts, style){
  if (!map || !pts || pts.length < 2) return;
  usedLines.add(key);
  const path = pts.map(p => ({lat:p.lat, lng:p.lng}));
  const mid = pts[Math.floor(pts.length / 2)];
  const sig = pts.length + ':' + pts[0].lat + ',' + pts[0].lng + ':' + mid.lat + ':' + pts[pts.length - 1].lat + ',' + pts[pts.length - 1].lng;
  let rec = lines[key];
  if (!rec || rec.style !== style) {
    if (rec) rec.l.setMap(null);
    rec = lines[key] = {l:new G.Polyline(Object.assign({map, path, clickable:false}, lineStyles()[style])), style, sig};
    return;
  }
  if (rec.sig !== sig) { rec.l.setPath(path); rec.sig = sig; }
}
let fitRetryKey = '';
function fit(key, pts){
  if (!map || key === S.lastFit) return;
  const good = pts.filter(Boolean);
  if (!good.length) return;
  S.lastFit = key;
  if (good.length === 1 || good.every(p => meters(p, good[0]) < 30)) { map.panTo({lat:good[0].lat, lng:good[0].lng}); map.setZoom(16); return; }
  const b = new G.LatLngBounds();
  good.forEach(p => b.extend({lat:p.lat, lng:p.lng}));
  map.fitBounds(b, {top:58, left:40, right:40, bottom:76});
  fitRetryKey = key;
  G.event.addListenerOnce(map, 'idle', () => { if (fitRetryKey === key && map.getZoom() > 16) map.setZoom(16); });
}
const k3 = p => p ? p.lat.toFixed(3) + ',' + p.lng.toFixed(3) : '-';
function ridePlan(r){ return r.route ? ['plan', r.route.pts] : ['straight', [r.pickup, r.dropoff]]; }
function renderMap(){
  if (!map) return;
  usedMarkers = new Set(); usedLines = new Set();
  let fitKey = 'home', fitPts = PLACES, showMe = false;
  const key = [];
  if (S.screen === 'rider') {
    const r = myRiderRide();
    if (!r) {
      const a = selPoint(S.rider.pickup), b = selPoint(S.rider.dropoff);
      setMk('A', a, 'A'); setMk('B', b, 'B');
      const fr = S.formRoute.state === 'ok' ? S.formRoute.route : null;
      if (a && b) {
        if (fr) { setLine('plan', fr.pts, 'plan'); key.push(['plan', 'Road route']); }
        else setLine('plan', [a, b], 'straight');
      }
      onlineDrivers().forEach(d => setMk('d:' + d.id, d.loc, 'carOther', {animate:true}));
      showMe = S.rider.pickup.kind !== 'gps';
      fitKey = 'rform:' + k3(a) + '|' + k3(b) + (fr ? ':R' : '');
      fitPts = [a, b].concat(fr ? sample(fr.pts, 12) : []);
    } else {
      setMk('A', r.pickup, 'A'); setMk('B', r.dropoff, 'B');
      const [style, plan] = ridePlan(r);
      setLine('plan', plan, style);
      if (style === 'plan') key.push(['plan', 'Planned route']);
      if (r.status === 'requested') {
        onlineDrivers().forEach(d => setMk('d:' + d.id, d.loc, 'carOther', {animate:true}));
        fitPts = [r.pickup, r.dropoff].concat(sample(plan, 10));
      } else {
        if (r.status === 'accepted') {
          if (r.approach) setLine('way', r.approach.pts, 'way');
          else if (r.driverLoc) setLine('way', [r.driverLoc, r.pickup], 'way');
          if (r.approach || r.driverLoc) key.push(['way', "Driver's way to you"]);
        }
        if (r.trail.length > 1) { setLine('trail', r.trail, 'trail'); key.push(['', 'Driven so far']); }
        if (r.driverLoc && r.status !== 'completed') setMk('car', r.driverLoc, 'car', {animate:true, z:1000});
        fitPts = r.status === 'accepted' ? [r.driverLoc, r.pickup].concat(r.approach ? sample(r.approach.pts, 8) : [])
          : r.status === 'arrived' ? [r.pickup] : [r.pickup, r.dropoff].concat(sample(plan, 10), sample(r.trail, 10));
      }
      fitKey = 'rride:' + r.id + ':' + r.status + ':' + (r.driverLoc ? 'L' : '') + (r.approach ? 'A' : '') + (r.route ? 'R' : '');
    }
  } else if (S.screen === 'driver') {
    const r = myDriverRide();
    if (r && DRIVING.includes(r.status)) {
      setMk('A', r.pickup, 'A'); setMk('B', r.dropoff, 'B');
      const [style, plan] = ridePlan(r);
      setLine('plan', plan, style);
      if (style === 'plan') key.push(['plan', 'Trip route']);
      if (r.status === 'accepted') {
        if (r.approach) setLine('way', r.approach.pts, 'way');
        else if (S.me) setLine('way', [S.me, r.pickup], 'way');
        key.push(['way', 'Your way to the pickup']);
      }
      const trail = S.trip && S.trip.id === r.id ? S.trip.pts : r.trail;
      if (r.status === 'in_progress' && trail.length > 1) { setLine('trail', trail, 'trail'); key.push(['', 'Driven so far']); }
      if (S.me) setMk('car', S.me, 'car', {animate:true, z:1000});
      fitPts = r.status === 'accepted' ? [S.me, r.pickup].concat(r.approach ? sample(r.approach.pts, 8) : [])
        : r.status === 'arrived' ? [r.pickup] : [S.me, r.dropoff].concat(sample(plan, 10));
      fitKey = 'dride:' + r.id + ':' + r.status + ':' + (S.me ? 'M' : '') + (r.approach ? 'A' : '') + (r.route ? 'R' : '');
    } else {
      if (S.me) setMk(S.driver.online ? 'car' : 'mecar', S.me, S.driver.online ? 'car' : 'me', {animate:true, z:1000});
      const reqs = S.driver.online ? openRequests() : [];
      reqs.forEach(q => setMk('q:' + q.id, q.pickup, 'req'));
      fitPts = [S.me].concat(reqs.map(q => q.pickup));
      fitKey = 'didle:' + reqs.map(q => q.id).join(',') + ':' + (S.me ? 'M' : '');
      if (!S.me && !reqs.length) { fitPts = PLACES; fitKey = 'didle-none'; }
    }
  } else showMe = true;
  const g = S.realGps;
  if (showMe && g) setMk('me', g, 'me', {animate:true});
  if (S.screen === 'rider' && S.rider.pickup.kind === 'gps' && g && !myRiderRide()) {
    const radius = Math.max(5, g.acc || 10);
    if (!accCircle) accCircle = new G.Circle({map, center:{lat:g.lat, lng:g.lng}, radius, clickable:false, strokeColor:css('--me'), strokeOpacity:0.35, strokeWeight:1, fillColor:css('--me'), fillOpacity:0.12});
    else { accCircle.setCenter({lat:g.lat, lng:g.lng}); accCircle.setRadius(radius); }
  } else if (accCircle) { accCircle.setMap(null); accCircle = null; }
  Object.keys(markers).forEach(k => { if (!usedMarkers.has(k)) { const rec = markers[k]; if (rec.raf) cancelAnimationFrame(rec.raf); rec.m.map = null; delete markers[k]; } });
  Object.keys(lines).forEach(k => { if (!usedLines.has(k)) { lines[k].l.setMap(null); delete lines[k]; } });
  const keyEl = $('#map-key');
  const keyHtml = key.map(([cls, label]) => `<span><i class="${cls}"></i>${esc(label)}</span>`).join('');
  if (keyEl.__h !== keyHtml) { keyEl.innerHTML = keyHtml; keyEl.__h = keyHtml; }
  keyEl.hidden = !key.length;
  fit(fitKey, fitPts);
}
function renderMapHint(){
  const hint = $('#map-hint');
  const text = {pickup:'Tap the map where you want to be picked up.', dropoff:"Tap the map where you're going.", spot:'Tap the map where your car is.'}[S.arm];
  hint.hidden = !text || !map;
  if (text) $('#map-hint-text').textContent = text;
}
function onMapClick(pt){
  if (!S.arm) return;
  const arm = S.arm;
  S.arm = null;
  pt = {lat:Math.round(pt.lat * 1e6) / 1e6, lng:Math.round(pt.lng * 1e6) / 1e6};
  if (arm === 'pickup' || arm === 'dropoff') { S.rider[arm] = pinSel(pt); saveRider(); syncAddrInputs(true); }
  else if (arm === 'spot') { onMyPosition(Object.assign(pt, {acc:0, at:Date.now(), source:'manual'})); toast('Your spot is set'); return; }
  render();
}

/* ---------- address search (Google Places) ---------- */
const ICON = {
  gps:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  pin:'<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  map:'<svg viewBox="0 0 24 24"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14"/></svg>'
};
const ADDR = {
  pickup:{input:'#r-pickup-in', list:'#r-pickup-sugg', token:null, preds:[], items:[], timer:0, seq:0, active:-1, loading:false, error:false, open:false},
  dropoff:{input:'#r-dropoff-in', list:'#r-dropoff-sugg', token:null, preds:[], items:[], timer:0, seq:0, active:-1, loading:false, error:false, open:false}
};
function syncAddrInputs(force){
  ['pickup', 'dropoff'].forEach(f => {
    const el = $(ADDR[f].input);
    if (force || document.activeElement !== el) { const v = selLabel(S.rider[f]); if (el.value !== v) el.value = v; }
  });
}
function addrQuery(field){
  const q = $(ADDR[field].input).value.trim();
  return q === selLabel(S.rider[field]) ? '' : q;
}
function renderSugg(field){
  const st = ADDR[field], list = $(st.list), input = $(st.input);
  if (!st.open) { list.hidden = true; input.setAttribute('aria-expanded', 'false'); return; }
  const q = addrQuery(field);
  const items = [];
  if (field === 'pickup') items.push({kind:'gps', title:'My current location', sub:S.gps.state === 'denied' ? 'Location is blocked on this phone' : 'Use GPS', icon:'gps'});
  st.preds.forEach((p, i) => items.push({kind:'pred', i, title:(p.mainText && p.mainText.text) || p.text.text, sub:(p.secondaryText && p.secondaryText.text) || '', dist:p.distanceMeters, icon:'pin'}));
  if (map) items.push({kind:'map', title:'Choose on the map', sub:'Tap the spot on the map', icon:'map'});
  let notes = '';
  if (q.length >= 2 && st.loading && !st.preds.length) notes = '<li class="sugg-note">Searching…</li>';
  else if (q.length >= 2 && !st.loading && !st.preds.length) notes = `<li class="sugg-note">${st.error || !map ? "Address search isn't available right now. Pick a place below or on the map." : 'No matches. Try a street address or place name.'}</li>`;
  let pops = [];
  if (!q) pops = PLACES.filter(p => p.popular).map(p => ({kind:'pop', id:p.id, title:p.name, sub:p.area, icon:'pin'}));
  st.items = items.concat(pops);
  const row = (it, idx) => `<li role="option" id="${field}-opt-${idx}"><button type="button" class="sg${idx === st.active ? ' active' : ''}" data-idx="${idx}" tabindex="-1"><span class="sg-ico">${ICON[it.icon]}</span><span class="sg-t"><b>${esc(it.title)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span>${it.dist ? `<span class="sg-d">${(it.dist / 1609.344).toFixed(1)} mi</span>` : ''}</button></li>`;
  let html = notes + items.map((it, i) => row(it, i)).join('');
  if (pops.length) html += '<li class="sugg-h">Popular in West Palm Beach</li>' + pops.map((it, j) => row(it, items.length + j)).join('');
  list.innerHTML = html;
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  if (st.active >= 0) input.setAttribute('aria-activedescendant', field + '-opt-' + st.active); else input.removeAttribute('aria-activedescendant');
}
function openSugg(field){ const st = ADDR[field]; st.open = true; st.active = -1; renderSugg(field); }
function closeSugg(field){ const st = ADDR[field]; st.open = false; st.active = -1; renderSugg(field); }
function onAddrInput(field){
  const st = ADDR[field];
  const q = addrQuery(field);
  clearTimeout(st.timer);
  st.active = -1;
  if (q.length < 2) { st.preds = []; st.loading = false; renderSugg(field); return; }
  st.loading = true;
  renderSugg(field);
  st.timer = setTimeout(() => fetchPreds(field, q), 280);
}
async function fetchPreds(field, q){
  const st = ADDR[field];
  const seq = ++st.seq;
  try {
    const places = await withTimeout(mapsLib('places'), 8000);
    if (!places) throw new Error('Places library unavailable');
    if (!st.token) st.token = new places.AutocompleteSessionToken();
    const c = S.realGps || WPB;
    const res = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
      input:q, sessionToken:st.token, locationBias:{center:{lat:c.lat, lng:c.lng}, radius:30000},
      origin:{lat:c.lat, lng:c.lng}, includedRegionCodes:['us'], language:'en-US', region:'us'
    });
    if (seq !== st.seq) return;
    st.preds = ((res && res.suggestions) || []).map(s => s.placePrediction).filter(Boolean).slice(0, 5);
    st.error = false;
  } catch (e) {
    if (seq !== st.seq) return;
    st.preds = []; st.error = true;
    console.warn(e);
  }
  st.loading = false;
  renderSugg(field);
}
async function chooseItem(field, idx){
  const st = ADDR[field], it = st.items[idx];
  if (!it) return;
  if (it.kind === 'gps') { S.rider.pickup = {kind:'gps'}; startGps(); }
  else if (it.kind === 'pop') { const p = P[it.id]; S.rider[field] = {kind:'place', name:p.name, address:p.area, lat:p.lat, lng:p.lng}; }
  else if (it.kind === 'map') S.arm = field;
  else if (it.kind === 'pred') {
    const pred = st.preds[it.i];
    try {
      const place = pred.toPlace();
      await place.fetchFields({fields:['location', 'formattedAddress']});   // ends the billing session
      const loc = place.location;
      S.rider[field] = {kind:'place', name:it.title, address:place.formattedAddress || it.sub || '', lat:loc.lat(), lng:loc.lng()};
    } catch (e) { console.warn(e); toast("Couldn't get that address. Try another one."); return; }
    st.token = null;
  }
  st.preds = [];
  closeSugg(field);
  $(st.input).blur();
  syncAddrInputs(true);
  saveRider();
  render();
}
function bindAddr(field){
  const st = ADDR[field], input = $(st.input), list = $(st.list);
  input.addEventListener('focus', () => { openSugg(field); setTimeout(() => { try { input.select(); } catch (e) {} }, 0); });
  input.addEventListener('input', () => onAddrInput(field));
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) { closeSugg(field); syncAddrInputs(false); } }, 160));
  input.addEventListener('keydown', e => {
    const n = st.items.length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); st.active = (st.active + 1) % n; renderSugg(field); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); st.active = (st.active - 1 + n) % n; renderSugg(field); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const firstPred = st.items.findIndex(i => i.kind === 'pred');
      const pick = st.active >= 0 ? st.active : firstPred;
      if (pick >= 0) chooseItem(field, pick);
    } else if (e.key === 'Escape') { closeSugg(field); input.blur(); }
  });
  // Keep the input focused while a suggestion is tapped, so the tap lands.
  list.addEventListener('pointerdown', e => { if (e.target.closest('.sg')) e.preventDefault(); });
  list.addEventListener('click', e => { const b = e.target.closest('.sg'); if (b) chooseItem(field, Number(b.dataset.idx)); });
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
const placeLine = p => `<span>${esc(p.name)}${p.address ? `<small class="addr-sub">${esc(p.address)}</small>` : ''}</span>`;
const legs = r => `<ol class="legs"><li><span class="dot a sm">A</span>${placeLine(r.pickup)}</li><li><span class="dot b sm">B</span>${placeLine(r.dropoff)}</li></ol>`;
function steps(i){
  const names = ['Requested','Driver coming','In the car','Arrived'];
  return `<ol class="steps" aria-label="Ride progress">${names.map((l, j) => `<li class="${j < i ? 'done' : j === i ? 'now' : ''}"><span></span>${l}</li>`).join('')}</ol>`;
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
let formRouteTimer = 0;
function ensureFormRoute(a, b){
  const key = routeKey(a, b);
  if (S.formRoute.key === key) return;
  if (!key) { S.formRoute = {key:'', state:'idle', route:null}; return; }
  const usable = !!MAPS_API_KEY && !MAPS.failed;
  S.formRoute = {key, state:usable ? 'loading' : 'fail', route:null};
  if (!usable) return;
  clearTimeout(formRouteTimer);
  formRouteTimer = setTimeout(async () => {
    const route = await getRoute(a, b);
    if (S.formRoute.key !== key) return;
    S.formRoute = {key, state:route ? 'ok' : 'fail', route};
    render();
  }, 350);
}
function riderHintHTML(){
  const r = S.rider, lines2 = [];
  if (r.pickup.kind === 'gps') {
    if (S.gps.state === 'denied') lines2.push("Location is blocked for this app. Allow it in your phone's settings, or type a pickup address.");
    else if (S.gps.state === 'unavailable') lines2.push("Your phone couldn't find your location. Type a pickup address instead.");
    else if (!S.realGps) lines2.push('Finding your location… Allow location if your phone asks.');
  }
  if (r.pickup.kind === 'pin') lines2.push('Pickup is pinned on the map. <button type="button" class="linkbtn" data-arm="pickup">Move pickup pin</button>');
  if (r.dropoff && r.dropoff.kind === 'pin') lines2.push('Destination is pinned on the map. <button type="button" class="linkbtn" data-arm="dropoff">Move destination pin</button>');
  return lines2.map(l => `<p>${l}</p>`).join('');
}
function setHTML(el, html){ if (el.__h !== html) { el.innerHTML = html; el.__h = html; return true; } return false; }
function renderRiderForm(){
  syncAddrInputs(false);
  setHTML($('#r-hint'), riderHintHTML());
  const a = selPoint(S.rider.pickup), b = selPoint(S.rider.dropoff);
  ensureFormRoute(a, b);
  const fr = S.formRoute;
  let html, ok = false;
  if (!b) html = '<span class="eyebrow">Price before you ride</span><p>Enter a destination to see the price.</p>';
  else if (!a) html = '<span class="eyebrow">Price before you ride</span><p>Choose a pickup to see the price.</p>';
  else if (milesBetween(a, b) < 0.05) html = '<span class="eyebrow">Price before you ride</span><p>Pickup and destination are the same spot. Choose a different destination.</p>';
  else if (fr.state === 'loading') html = '<span class="eyebrow">Price before you ride</span><p>Finding the road route…</p>';
  else {
    const q = quote(a, b, fr.state === 'ok' ? fr.route : null);
    ok = true;
    html = `<div class="fare-main"><span class="eyebrow">Price before you ride</span><span class="amt">${money(q.fare)}</span></div>
      <div class="fare-meta">${q.miles.toFixed(1)} mi · about ${q.minutes} min${q.byRoad ? ' by road' : ' (estimated)'}</div>
      <details><summary>How this price is set</summary><p>${money(PRICE.base)} base + ${money(PRICE.mile)} per mile + ${money(PRICE.min)} per minute + ${money(PRICE.booking)} booking fee. Minimum ${money(PRICE.minFare)}. Sample prices for testing. ${q.byRoad ? 'Miles and minutes come from the road route on the map.' : "The road route wasn't available, so distance is estimated from a straight line."}</p></details>`;
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
        <div><dt>From</dt><dd>${esc(r.pickup.name)}${r.pickup.address ? `<small class="addr-sub">${esc(r.pickup.address)}</small>` : ''}</dd></div>
        <div><dt>To</dt><dd>${esc(r.dropoff.name)}${r.dropoff.address ? `<small class="addr-sub">${esc(r.dropoff.address)}</small>` : ''}</dd></div>
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
  const a = selPoint(S.rider.pickup), b = selPoint(S.rider.dropoff);
  if (!a || !b || milesBetween(a, b) < 0.05) return;
  const fr = S.formRoute.key === routeKey(a, b) && S.formRoute.state === 'ok' ? S.formRoute.route : null;
  const q = quote(a, b, fr);
  const ride = {
    riderUid:S.uid, riderName:(S.rider.name.trim() || 'Rider').slice(0, 40),
    pickup:{id:'', name:a.name, address:a.address || '', lat:a.lat, lng:a.lng},
    dropoff:{id:'', name:b.name, address:b.address || '', lat:b.lat, lng:b.lng},
    fare:q.fare, miles:q.miles, minutes:q.minutes, status:'requested', createdAt:Date.now(), driverUid:null
  };
  if (fr) ride.route = packRoute(fr);
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
  ensureDriverRoutes(r);
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
    $('#d-spot').hidden = !map;
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
  if (S.rider.pickup.kind !== 'gps') stopGps();
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
        S.trip = {id:r.id, meters:0, last:S.me ? {lat:S.me.lat, lng:S.me.lng} : null, pts:S.me ? [{lat:S.me.lat, lng:S.me.lng}] : []};
        store.set('trip.' + r.id, S.trip);
      }
    } else if (act === 'end') {
      const t = (S.trip && S.trip.id === r.id) ? S.trip : loadTrip(r.id);
      const tripMiles = Math.round(t.meters / 1609.344 * 100) / 100;
      const tripMinutes = r.startedAt ? Math.round((now - r.startedAt) / 6000) / 10 : null;
      const patch = {status:'completed', completedAt:now, tripMiles, tripMinutes};
      if (t.pts.length > 1) patch.trail = encodePath(t.pts.slice(-1500));
      if (await api.patch(r.id, patch)) { store.del('trip.' + r.id); S.trip = null; }
    } else if (act === 'release') {
      if (await api.patch(r.id, {status:'requested', driverUid:null, driver:null, driverLoc:null, approach:null, acceptedAt:null, arrivedAt:null, releasedAt:now})) toast('Ride released');
    } else if (act === 'done') dismiss('d:' + r.id);
  } finally { S.busy.delete('driver'); render(); }
}

/* ---------- live ETA text ---------- */
function updateEta(){
  $$('[data-eta]').forEach(el => {
    const r = allRides().get(el.dataset.eta);
    if (!r) return;
    const target = r.status === 'in_progress' ? r.dropoff : r.pickup;
    const route = r.status === 'in_progress' ? r.route : r.approach;
    let txt = '';
    if (el.dataset.who === 'rider') {
      const loc = r.driverLoc;
      if (!loc) txt = "Waiting for your driver's location";
      else {
        const e = etaAlong(route, loc, target);
        txt = e.mi < NEAR_MI ? (r.status === 'accepted' ? 'Arriving now' : 'Almost there')
          : `About ${e.min} min · ${e.mi.toFixed(1)} mi ${r.status === 'accepted' ? 'away' : 'to go'}`;
        const age = Date.now() - (loc.at || 0);
        if (loc.at && age > 90000) txt += ` · location from ${Math.round(age / 60000)} min ago`;
      }
    } else if (!S.me) txt = 'Waiting for your location';
    else {
      const e = etaAlong(route, S.me, target);
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
  if (screen === 'rider' && S.rider.pickup.kind === 'gps' && !myRiderRide()) startGps();
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
  bindAddr('pickup');
  bindAddr('dropoff');
  syncAddrInputs(true);
  $('#r-swap').addEventListener('click', () => {
    const r = S.rider;
    if (!r.dropoff) { toast('Choose a destination first.'); return; }
    let newDrop = r.pickup;
    if (r.pickup.kind === 'gps') {
      const p = selPoint(r.pickup);
      if (!p) { toast("Your location isn't ready yet."); return; }
      newDrop = {kind:'place', name:p.name, address:'', lat:p.lat, lng:p.lng};
    }
    r.pickup = r.dropoff;
    r.dropoff = newDrop;
    saveRider(); syncAddrInputs(true); render();
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
  bindEvents();
  paintDriverAvatar();
  buildMap();
  if (S.driver.online || (S.screen === 'rider' && S.rider.pickup.kind === 'gps')) startGps();
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
