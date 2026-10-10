// Project settings for WPB Rides. These values identify the projects; they
// are not passwords. Firebase data is protected by the rules in
// firestore.rules, and the Google Maps key only works on this website
// (restricted in Google Cloud to https://wagonprototype.github.io/*).
export const FIREBASE_VERSION = '12.19.0';

export const firebaseConfig = {
  apiKey: 'AIzaSyAhri2wxGSbE3FRm4jy3REMbg5peVPLoz0',
  authDomain: 'rapid-wagon.firebaseapp.com',
  projectId: 'rapid-wagon',
  storageBucket: 'rapid-wagon.firebasestorage.app',
  messagingSenderId: '344593531736',
  appId: '1:344593531736:web:97abc70ec74d0ece921b2d',
  measurementId: 'G-N6W1M3CTXJ'
};

// Google Maps Platform key for the map, address search and road routes.
export const MAPS_API_KEY = 'AIzaSyCkHFyAEGCce9Zqfu2ZY-GWB3NYIp4uzI8';

// Map style ID. DEMO_MAP_ID is Google's test ID; create a real Map ID in
// Google Cloud (Map Management) before launch.
export const MAP_ID = 'DEMO_MAP_ID';
