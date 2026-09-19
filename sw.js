/* ================================================================
   MantCAP · Service Worker (PWA offline-first)
   - Precachea el "esqueleto" de la app (HTML, CDN, iconos).
   - Archivos propios (index, js, manifest, iconos): RED PRIMERO,
     y caché solo como respaldo sin internet → los cambios llegan
     al recargar, sin quedarse con versiones viejas.
   - Librerías externas (CDN, fuentes): caché primero.
   - Las llamadas a Firebase (datos/auth) NUNCA se cachean.
   Al publicar una versión nueva, sube el número de CACHE.
   ================================================================ */
const CACHE='mantcap-v9';
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

/* Dominios de Firebase que nunca deben pasar por la caché */
const NO_CACHE_HOSTS=[
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'www.googleapis.com'
];

self.addEventListener('install',e=>{
  e.waitUntil(
    caches.open(CACHE)
      /* Se agregan uno a uno: si un archivo falla, los demás se guardan igual */
      .then(c=>Promise.all(PRECACHE.map(u=>c.add(u).catch(()=>{}))))
      .then(()=>self.skipWaiting())
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

  /* 1) Firebase (datos y autenticación): directo a la red */
  if(NO_CACHE_HOSTS.includes(url.hostname)) return;

  /* 2) Archivos propios y navegación: red primero, caché de respaldo */
  if(url.origin===self.location.origin||req.mode==='navigate'){
    e.respondWith(
      fetch(req,{cache:'no-cache'})
        .then(res=>{
          if(res&&res.ok){
            const copia=res.clone();
            caches.open(CACHE).then(c=>c.put(req,copia));
          }
          return res;
        })
        .catch(()=>caches.match(req,{ignoreSearch:true}).then(r=>
          r||(req.mode==='navigate'?caches.match('./index.html'):undefined)))
    );
    return;
  }

  /* 3) Librerías externas y fuentes: caché primero */
  e.respondWith(
    caches.match(req).then(r=>r||fetch(req).then(res=>{
      if(res&&(res.ok||res.type==='opaque')){
        const copia=res.clone();
        caches.open(CACHE).then(c=>c.put(req,copia));
      }
      return res;
    }).catch(()=>r))
  );
});
