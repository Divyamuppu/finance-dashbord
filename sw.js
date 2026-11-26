// Offline shell for the dashboard. Never caches /api/ responses: finance and vendor data must not
// stay in the browser after someone logs out.
const CACHE='atom-finance-v4';
const SHELL=['./','./index.html','./Atom%20Collective%20Dashboard.dc.html','./Vendors.dc.html','./Access.dc.html','./support.js','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>Promise.all(SHELL.map(u=>c.add(u).catch(()=>{})))).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const req=e.request;if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin===location.origin&&url.pathname.startsWith('/api/'))return; // always live, never stored
  const isFont=/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if(url.origin!==location.origin&&!isFont)return;
  if(isFont){e.respondWith(caches.match(req).then(r=>r||fetch(req).then(res=>{const c=res.clone();caches.open(CACHE).then(x=>x.put(req,c));return res;})));return;}
  e.respondWith(fetch(req).then(res=>{if(res.ok){const c=res.clone();caches.open(CACHE).then(x=>x.put(req,c));}return res;}).catch(()=>caches.match(req).then(r=>r||caches.match('./index.html'))));
});
