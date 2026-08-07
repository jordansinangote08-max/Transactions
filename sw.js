const CACHE='smart-card-advisor-complete-v1';
const ASSETS=[
'./','./index.html','./manifest.webmanifest',
'./assets/logos/eastwest.png','./assets/logos/unionbank.png','./assets/logos/rcbc.png',
'./assets/logos/bpi.png','./assets/logos/bdo.png','./assets/logos/metrobank.png'
];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));
self.addEventListener('activate',event=>event.waitUntil(
  caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key))))
));
self.addEventListener('fetch',event=>event.respondWith(caches.match(event.request).then(hit=>hit||fetch(event.request))));
