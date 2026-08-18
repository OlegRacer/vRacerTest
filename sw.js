// vRacer — Service Worker для кешування "оболонки" застосунку (17.08.2026)
//
// Що робить: кешує сам index.html і 3 CDN-бібліотеки (leaflet, sql.js,
// Chart.js), щоб застосунок відкривався БЕЗ повторного завантаження з
// сайту щоразу. Керується перемикачем у Налаштуваннях (curTab===0,
// "📦 Офлайн-режим застосунку"), який шле сюди postMessage({type:'SET_MODE'}).
//
// ВАЖЛИВО: карта (тайли OSM), маршрутизація (ORS/OSRM/Nominatim/Overpass) —
// НЕ кешуються тут і НЕ проходять через цей SW взагалі (isShellRequest()
// нижче їх відсіює). Це кешування стосується ЛИШЕ коду самого застосунку,
// не даних із мережі, які завжди потребують реального інтернету.
//
// Два режими:
//  - 'offline' (за замовчуванням) — кеш-спочатку: якщо є в кеші, віддаємо
//    миттєво, мережу не чіпаємо взагалі (найшвидший старт, працює без
//    інтернету). Оновлюється тільки коли щось відсутнє в кеші.
//  - 'online' — мережа-спочатку: щоразу намагається дістати свіжу версію
//    з сайту; кеш — лише як резерв, якщо мережі немає в цю мить.
//
// Режим переживає перезапуск SW (браузер вбиває неактивні service worker'и
// між використаннями) через IndexedDB, бо звичайна змінна в пам'яті SW
// не гарантовано доживає до наступного fetch.

const CACHE_NAME='vracer-shell-v1';
const SHELL_URLS=[
  './',
  './index.html',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js',
  'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.2/sql-wasm.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'
];

// ── Дрібна IndexedDB-обгортка лише для одного значення (режиму) ──────
function idbGetMode(){
  return new Promise(function(resolve){
    try{
      const req=indexedDB.open('vracerSwMeta',1);
      req.onupgradeneeded=function(){ req.result.createObjectStore('kv'); };
      req.onsuccess=function(){
        const db=req.result;
        try{
          const tx=db.transaction('kv','readonly');
          const g=tx.objectStore('kv').get('mode');
          g.onsuccess=function(){ resolve(g.result||'offline'); };
          g.onerror=function(){ resolve('offline'); };
        }catch(e){ resolve('offline'); }
      };
      req.onerror=function(){ resolve('offline'); };
    }catch(e){ resolve('offline'); }
  });
}
function idbSetMode(mode){
  return new Promise(function(resolve){
    try{
      const req=indexedDB.open('vracerSwMeta',1);
      req.onupgradeneeded=function(){ req.result.createObjectStore('kv'); };
      req.onsuccess=function(){
        const db=req.result;
        try{
          const tx=db.transaction('kv','readwrite');
          tx.objectStore('kv').put(mode,'mode');
          tx.oncomplete=function(){ resolve(); };
          tx.onerror=function(){ resolve(); };
        }catch(e){ resolve(); }
      };
      req.onerror=function(){ resolve(); };
    }catch(e){ resolve(); }
  });
}

// Памʼятаємо режим у пам'яті ОДИН РАЗ за життя цього SW-процесу (щоб не
// смикати IndexedDB на КОЖЕН запит) — оновлюється миттєво повідомленням
// SET_MODE, і персистить в IndexedDB для наступного запуску SW.
let modePromise=null;
function getMode(){
  if(!modePromise) modePromise=idbGetMode();
  return modePromise;
}

function isShellRequest(request){
  if(request.mode==='navigate') return true; // сам index.html при відкритті сторінки
  return SHELL_URLS.indexOf(request.url)!==-1;
}

self.addEventListener('install', function(e){
  self.skipWaiting(); // не чекати закриття старих вкладок — новий SW одразу активний
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      // addAll падає одним махом, якщо ХОЧ ОДИН URL не завантажився (напр.
      // немає інтернету при першому встановленні) — тому кожен URL окремо
      // й неуспішні мовчки пропускаємо, а не валимо всю установку.
      return Promise.all(SHELL_URLS.map(function(url){
        return fetch(url).then(function(resp){
          if(resp && resp.ok) return cache.put(url, resp);
        }).catch(function(){});
      }));
    })
  );
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k!==CACHE_NAME; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e){
  if(!isShellRequest(e.request)) return; // все інше (карта/POI/маршрути) — напряму в мережу, SW не втручається
  e.respondWith(handleShellFetch(e.request));
});

async function handleShellFetch(request){
  const mode=await getMode();
  const cache=await caches.open(CACHE_NAME);
  if(mode==='online'){
    // Мережа-спочатку: свіжа версія за замовчуванням, кеш — тільки якщо
    // мережі зараз немає взагалі.
    try{
      const resp=await fetch(request);
      if(resp && resp.ok) cache.put(request, resp.clone());
      return resp;
    }catch(e){
      const cached=await cache.match(request);
      if(cached) return cached;
      throw e;
    }
  }
  // offline: кеш-спочатку, мережа — лише якщо в кеші взагалі нічого нема.
  const cached=await cache.match(request);
  if(cached) return cached;
  const resp=await fetch(request);
  if(resp && resp.ok) cache.put(request, resp.clone());
  return resp;
}

self.addEventListener('message', function(e){
  const data=e.data;
  if(!data || !data.type) return;
  if(data.type==='SET_MODE'){
    const mode=(data.mode==='online') ? 'online' : 'offline';
    modePromise=Promise.resolve(mode);
    idbSetMode(mode);
    if(mode==='online') refreshShellCache();
  }
});

// Проактивне оновлення кешу одразу в момент перемикання на "онлайн" — щоб
// не чекати першого природного network-first запиту. cache:'reload'
// примушує саме мережевий запит, ігноруючи HTTP-кеш браузера теж (інакше
// браузер міг би віддати свою власну застарілу копію з диску).
async function refreshShellCache(){
  const cache=await caches.open(CACHE_NAME);
  await Promise.all(SHELL_URLS.map(function(url){
    return fetch(url, {cache:'reload'}).then(function(resp){
      if(resp && resp.ok) return cache.put(url, resp);
    }).catch(function(){});
  }));
  const clientsList=await self.clients.matchAll();
  clientsList.forEach(function(c){ c.postMessage({type:'SHELL_REFRESHED'}); });
}
