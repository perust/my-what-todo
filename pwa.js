/**
 * pwa.js — 서비스 워커를 등록한다. 그것뿐이다.
 *
 * 파일을 따로 둔 이유는 `theme.js`와 같다. 인라인 `<script>`를 두면 CSP에
 * `'unsafe-inline'`을 열어야 한다. 그리고 이 다섯 줄을 지우는 것만으로 설치 기능을
 * 통째로 걷어낼 수 있어야, 나중에 마음이 바뀌었을 때 앱 코드를 뒤지지 않아도 된다.
 *
 * **등록에 실패해도 앱은 그대로 돈다.** 서비스 워커는 오프라인에서 열리게 하는
 * 장치일 뿐이라, 없으면 예전처럼 매번 받아올 뿐이다. 그래서 실패를 조용히 넘긴다 —
 * 여기서 알릴 것이 없다.
 */
(function () {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  // 첫 화면이 다 그려진 뒤에 등록한다. 로드 중에 걸면 같은 대역폭을 두고 다툰다.
  addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* 설치되지 않아도 앱은 예전과 똑같이 동작한다 */
    });
  });
})();
