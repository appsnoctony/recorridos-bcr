/* ================================================================
   MantCAP · Service Worker (PWA offline-first)
   - Precachea el "esqueleto" de la app (HTML, CDN, iconos).
   - Navegación: red primero → caché si no hay internet.
   - Las llamadas a Firebase (datos/auth) NUNCA se cachean.
   v4 — Bump de caché para desplegar fixes de DB null (v2.12)
   ================================================================ */
const CACHE='mantcap-v7';
const PRECACHE=[
  './',
  './index.html',
  './manifest.json',
  './firebase-config.js',
  './firebase-sync.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
  'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap'
];

self.addEventListener('install',e=>{
  e.waitUntil(
    caches.open(CACHE).then(c=>c.addAll(PRECACHE)).then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET') return;
  const url=new URL(req.url);

  /* 1) APIs de Firebase (datos y auth): SIEMPRE red, jamás caché */
  const esApiFirebase=(
    (url.hostname.endsWith('googleapis.com')&&/(firestore|identitytoolkit|securetoken)/.test(url.hostname))
    || url.hostname==='firebaseio.com'
  );
  if(esApiFirebase) return; /* deja pasar a la red */

  /* 2) Navegación (abrir la app): red primero, caché de respaldo */
  if(req.mode==='navigate'||req.destination==='document'){
    e.respondWith(
      fetch(req).then(res=>{
        const copia=res.clone();
        caches.open(CACHE).then(c=>c.put('./index.html',copia));
        return res;
      }).catch(()=>caches.match('./index.html'))
    );
    return;
  }

  /* 3) Estáticos (CDN, fuentes, iconos, config): caché primero */
  e.respondWith(
    caches.match(req).then(hit=>hit||fetch(req).then(res=>{
      if(res.ok){
        const copia=res.clone();
        caches.open(CACHE).then(c=>c.put(req,copia));
      }
      return res;
    }).catch(()=>hit))
  );
});
