const CACHE='smart-card-advisor-v1';
const ASSETS=['./','./index.html','./manifest.webmanifest',
'./assets/logos/eastwest.png','./assets/logos/unionbank.png','./assets/logos/rcbc.png',
'./assets/logos/bpi.png','./assets/logos/bdo.png','./assets/logos/metrobank.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))));
self.addEventListener('fetch',e=>e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request))));
