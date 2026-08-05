/**
 * sw.js — 서비스 워커. 파일을 브라우저 안에 붙잡아둬 **네트워크가 없어도 열리게** 한다.
 *
 * 이 앱은 원래부터 밖으로 아무것도 보내지 않는다(`connect-src 'none'`). 한 번 열려
 * 있기만 하면 비행기 안에서도 온전히 돈다. 남은 구멍은 딱 하나 — `index.html`과
 * 스크립트를 처음 받아오는 그 순간이다. 여기서 막는 것이 그 하나뿐이다.
 *
 * **주의: 이 파일에는 페이지의 CSP가 적용되지 않는다.**
 * `<meta>`로 건 CSP는 문서에만 걸린다. 워커의 CSP는 이 파일을 내려줄 때의 HTTP 헤더로
 * 정해지는데, GitHub Pages는 헤더를 붙일 수 없어 아무 제약도 걸리지 않는다.
 * 즉 `connect-src 'none'`이 여기까지 오지 않는다. 그래서 이 파일은
 * **작게 유지하고, 자기 오리진 밖으로는 한 발도 나가지 않는다.** 새 코드를 더할 때
 * 그 두 가지를 먼저 확인한다.
 */
'use strict';

/**
 * 캐시 이름. 형식이 바뀌어 옛 캐시를 통째로 버려야 할 때만 올린다.
 * **배포할 때마다 올릴 필요는 없다** — 아래 network-first가 늘 새것을 먼저 받아오므로,
 * 판 번호를 손으로 올리는 것을 잊어서 옛 버전이 남는 종류의 사고가 없다.
 */
const CACHE = 'my-what-todo-v1';

/**
 * 처음 설치할 때 미리 받아둘 것. `index.html`이 부르는 것과 같아야 한다.
 * **하나라도 없으면 `addAll`이 통째로 실패해 설치가 안 된다** — 조용히 반쪽만
 * 캐시되는 것보다 낫다. 목록이 낡는 것은 `tests/pwa.js`가 `index.html`과
 * 대조해 잡는다.
 */
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './store.js',
  './theme.js',
  './parse.js',
  './file-sync.js',
  './markdown-export.js',
  './markdown-import.js',
  './markdown-sync.js',
  './app.js',
  './pwa.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

/** 우리가 맡은 경로. 오리진 하나에 여러 프로젝트가 살고 있어 여기까지 좁힌다. */
const SCOPE = new URL('./', self.location.href).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      // 새 워커를 기다리게 두지 않는다. 배포한 것이 다음 새로고침에 바로 걸려야
      // "push 하면 올라간다"가 그대로 유지된다.
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

/**
 * **네트워크를 먼저 본다.** 캐시를 먼저 보는 편이 빠르지만, 그러면 배포한 것이
 * 언제 사람들에게 닿는지가 캐시 판 번호를 손으로 올렸는지에 달린다. 이 저장소는
 * 이미 그런 종류의 수동 갱신을 거절해왔다 — 잊으면 조용히 깨지기 때문이다.
 * 실제로 Pages의 `max-age=600` 때문에 "새 화면에 옛 동작이 얹힌" 일을 겪었다.
 *
 * 느려지지 않는 이유: 여기서 부르는 `fetch`도 브라우저의 HTTP 캐시를 그대로 탄다.
 * Pages가 주는 `max-age=600` 안에서는 네트워크에 나가지도 않는다.
 * 캐시는 **네트워크가 죽었을 때만** 나선다.
 *
 * 재보고 확인한 것: HTTP 캐시를 `no-store`로 빼놓으면 이 워커는 늘 새것을 가져온다.
 * 즉 **워커가 더하는 낡음은 0이다** — 배포한 것이 언제 닿는지는 워커를 붙이기 전과
 * 똑같이 Pages의 `max-age=600`만이 정한다. `Cmd+Shift+R`도 그대로 워커를 건너뛴다.
 */
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (!request.url.startsWith(SCOPE)) return; // 같은 오리진의 남의 프로젝트는 손대지 않는다

  event.respondWith(
    fetch(request)
      .then((response) => {
        // 부분 응답(206)이나 오류는 캐시에 넣지 않는다. 넣으면 오프라인일 때
        // 그 반쪽짜리가 진짜 파일 행세를 한다.
        if (response.ok && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((hit) => {
          if (hit) return hit;
          // 주소만 다른 같은 화면이다. 네비게이션이면 앱을 띄워준다.
          if (request.mode === 'navigate') return caches.match('./index.html');
          return Response.error();
        })
      )
  );
});
