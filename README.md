# WPB Rides (prototype)

A test version of a rideshare app for West Palm Beach. One phone requests a ride, another accepts it and drives, and both follow the trip with live GPS to a receipt. It is a plain web app (no build step) that also installs as an app and can be packaged for Google Play.

**Status:** prototype for a few known testers. Not for public release. No payments.

## How it works

| Piece | What it does |
|---|---|
| `index.html`, `styles.css` | The screens: home, rider, driver. |
| `app.js` | All app logic (ES module, no framework). |
| `config.js` | Firebase settings (project `rapid-wagon`), SDK version, Google Maps key and Map ID. Not secret; the Maps key is restricted to this website. |
| `firestore.rules` | Database access rules. Paste into Firebase console → Firestore → Rules. |
| `manifest.webmanifest`, `sw.js`, `icons/` | Makes it an installable web app (needed for Google Play packaging). |
| `privacy.html` | Privacy page, required for the Play listing. |

Services:
- **Firebase Authentication, anonymous sign-in.** Each phone gets a random user ID; no accounts.
- **Cloud Firestore** for live sync. The SDK loads from `www.gstatic.com/firebasejs/<version>/`.
- **Google Maps Platform** (Maps JavaScript API, `v=weekly`): the map with Advanced Markers, Place Autocomplete (Places API New, with session tokens) for typed addresses, and the Routes library (`Route.computeRoutes`, traffic-unaware, so it bills as Essentials) for road routes. The key is restricted to `https://wagonprototype.github.io/*` and to those three APIs.
- **Browser geolocation** (`watchPosition`, high accuracy) for GPS.

## Data model

`rides/{autoId}`

| Field | Notes |
|---|---|
| `riderUid`, `riderName` | Set by the rider at creation. |
| `pickup`, `dropoff` | `{id, name, lat, lng}`. |
| `fare`, `miles`, `minutes` | Upfront quote from the Google road route (falls back to straight line × 1.3), sample prices. |
| `route` | `{poly, meters, seconds}`: planned road route pickup → destination, Google encoded polyline. |
| `approach` | Same shape: the driver's road route to the pickup, written by the driver's phone after accepting. |
| `trail` | Encoded polyline of where the car actually drove during the trip, written by the driver's phone. |
| `status` | `requested` → `accepted` → `arrived` → `in_progress` → `completed`; or `cancelled`. A driver can release a ride back to `requested`. |
| `driverUid`, `driver` | `driver` = `{name, car, plate, photo}`; photo is a 128 px JPEG data URL. |
| `driverLoc` | `{lat, lng, at}`. Updated by the driver's phone every ~4 s while moving during a ride. |
| `createdAt`, `acceptedAt`, `arrivedAt`, `startedAt`, `completedAt`, `cancelledAt`, `releasedAt` | Client clock, milliseconds. |
| `tripMiles`, `tripMinutes` | Measured on the driver's phone from GPS during the trip. |
| `cancelledBy` | `rider` or `expired` (requests older than 45 min). |
| `rating` | 1–5, from the rider. |

`drivers/{uid}`: `{name, car, plate, photo, online, loc:{lat,lng}, updatedAt}`. A driver counts as online for 3 minutes after the last update; the phone sends one at least every 45 s while the app is open.

Queries (all single-field, no composite indexes needed): rides by `riderUid`, rides by `driverUid`, rides with `status == requested` (limit 50), drivers with `online == true`. Accepting a ride uses a transaction so two drivers can't take the same request.

## Known limits (things to fix before real customers)

1. **GPS only works while the app is open on screen.** The app asks the phone to keep the screen on, but a locked phone stops sharing location. Real background tracking needs a native app (or a native wrapper) and Google Play's background-location review.
2. **Fares are calculated on the phone.** Fine for testing; a real service must price on a server.
3. **No real accounts.** Anonymous IDs are tied to one browser/app install. Add phone-number sign-in before launch.
4. **No driver verification.** Florida §627.748 requires background checks, driving-record checks, insurance and more before anyone drives.
5. **Rules are a starting point.** They stop the obvious abuse (editing other people's rides, changing fares), but they don't validate every field. Review before launch.
6. **Map ID is Google's `DEMO_MAP_ID`.** Create a real Map ID in Google Cloud (Map Management) and put it in `config.js` before launch.
7. **Routes are computed once** (at request and at accept), not continuously re-routed. Time estimates follow the car's progress along that route. The "Directions" buttons open Google Maps for turn-by-turn navigation.
8. **No payments.** Plan: Stripe Connect, with card entry in Stripe's own fields so card numbers never touch this app.

## Running and deploying

- Any static host works. It is set up for **GitHub Pages** from a `username.github.io` repository (root of the domain, which Google Play's asset links file needs). `.nojekyll` makes GitHub serve the `.well-known` folder.
- Firebase setup: Firestore database created in production mode, rules from `firestore.rules`, Anonymous sign-in enabled.
- Locally: `python3 -m http.server 8080` in this folder, then open `http://localhost:8080`. Browsers allow GPS on `localhost`; anywhere else needs HTTPS.

## Google Play

Package with PWABuilder (pwabuilder.com) using the site URL, Android package. It produces the app bundle, a signing key (keep it safe; it can't be replaced), and an `assetlinks.json` file. Put that file at `.well-known/assetlinks.json` in this repo so the app opens without a browser address bar. Upload the bundle to **Internal testing** in Play Console.

## Testing tips

- **Test drive** (driver screen, while online) moves the car along the road route to the pickup, then to the destination, at about 60 mph, sending positions exactly like real GPS. Use it when testing indoors.
- **Set my spot on the map** places the driver by hand when GPS is blocked or inaccurate. "Use my GPS" switches back.
