/**
 * theme.js — 고른 테마를 첫 페인트 전에 칠한다. (PRD §4 F-14, §13)
 *
 * `<head>`에서 `store.js` 바로 뒤에 돈다. 본문 끝에서 돌면 OS 색으로 한 번 칠해진 뒤에
 * 뒤집혀, 새로고침할 때마다 화면이 번쩍인다.
 *
 * 인라인으로 두지 않고 파일로 뺀 이유는 CSP다. 인라인 스크립트를 허용하려면
 * 해시를 적어야 하는데, 이 파일을 고칠 때마다 그 해시를 다시 계산해야 한다.
 * 잊으면 스크립트가 조용히 막혀 깜빡임이 되살아나고, 원인을 찾기 어렵다.
 * 파일로 두면 `script-src 'self'` 하나로 끝나고 손댈 것이 없다.
 *
 * 저장소 키를 아는 건 여전히 `store.js`뿐이다. 여기서는 `Store.peekTheme()`만 부른다.
 */
(function () {
  'use strict';

  var theme = Store.peekTheme();

  // 고른 적이 없으면 비워 둔다. 그래야 styles.css가 OS 설정을 따른다.
  if (theme) document.documentElement.dataset.theme = theme;
})();
