'use strict';
/**
 * tests/pwa.js — 설치용 파일 셋이 서로 어긋나지 않는지 본다.
 *
 * 서비스 워커의 `SHELL` 목록은 손으로 적는 목록이라 **낡는다.** 새 스크립트를
 * `index.html`에 더하고 여기 적는 것을 잊으면, 온라인에서는 멀쩡한데 오프라인에서만
 * 그 파일이 없어 앱이 반쯤 뜬다. 그 상태는 눈으로 찾기 어렵다 — 비행기 모드로
 * 열어보기 전까지는 아무도 모른다. 그래서 `index.html`과 대조해 여기서 잡는다.
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const html = read('index.html');
const sw = read('sw.js');
const manifest = JSON.parse(read('manifest.webmanifest'));

/** `index.html`이 실제로 부르는 같은 폴더의 파일들. */
function referencedByMarkup() {
  const out = new Set();
  const patterns = [
    /<script[^>]*\ssrc="([^"]+)"/g,
    /<link[^>]*\shref="([^"]+)"/g
  ];
  for (const pattern of patterns) {
    for (const [, href] of html.matchAll(pattern)) {
      if (/^(https?:|data:|mailto:|#)/.test(href)) continue;
      out.add(href.replace(/^\.\//, ''));
    }
  }
  return out;
}

/** 서비스 워커가 미리 받아두는 것들. `'./'`는 index.html과 같은 자리라 함께 본다. */
function precached() {
  const block = sw.match(/const SHELL = \[([\s\S]*?)\];/);
  assert.ok(block, 'sw.js에서 SHELL 목록을 찾지 못했다');
  return new Set(
    [...block[1].matchAll(/'([^']+)'/g)]
      .map(([, href]) => href.replace(/^\.\//, ''))
      .filter((href) => href !== '')
  );
}

test('서비스 워커가 index.html이 부르는 파일을 전부 미리 받아둔다', () => {
  const shell = precached();
  const missing = [...referencedByMarkup()].filter((href) => !shell.has(href));
  assert.deepEqual(missing, [],
    `sw.js의 SHELL에 없다 — 오프라인에서만 빠진다: ${missing.join(', ')}`);
});

test('서비스 워커가 없는 파일을 미리 받으려 하지 않는다', () => {
  // addAll은 하나라도 404면 통째로 실패한다. 설치가 조용히 안 되는 것이 아니라
  // 아예 안 되므로, 오타 하나가 오프라인 지원 전체를 끈다.
  for (const href of precached()) {
    assert.ok(fs.existsSync(path.join(ROOT, href)), `sw.js가 없는 파일을 부른다: ${href}`);
  }
});

test('매니페스트의 아이콘이 실제로 있고 크기가 적힌 대로다', () => {
  assert.ok(manifest.icons.length >= 2);
  for (const icon of manifest.icons) {
    const file = path.join(ROOT, icon.src.replace(/^\.\//, ''));
    assert.ok(fs.existsSync(file), `없는 아이콘: ${icon.src}`);

    // PNG 머리말에서 실제 크기를 읽어 적힌 값과 맞춰본다. 줄여 넣는 것을 잊으면
    // 홈 화면에서만 뭉개져 보이는데, 그건 폰을 꺼내보기 전에는 모른다.
    const buffer = fs.readFileSync(file);
    assert.equal(buffer.toString('ascii', 12, 16), 'IHDR', `PNG가 아니다: ${icon.src}`);
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    assert.equal(`${width}x${height}`, icon.sizes, `크기가 적힌 것과 다르다: ${icon.src}`);
  }

  // 마스커블 아이콘이 하나는 있어야 안드로이드에서 원형·정사각형 어느 틀에도 맞는다.
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'maskable 아이콘이 없다');
});

test('매니페스트의 주소는 전부 상대 경로다', () => {
  // 저장소 이름이 바뀌면 Pages의 경로도 바뀐다. 절대 경로로 적으면 그때 전부 깨진다.
  const paths = [manifest.start_url, manifest.scope, ...manifest.icons.map((i) => i.src)];
  for (const value of paths) {
    assert.ok(value.startsWith('./'), `절대 경로다: ${value}`);
  }
});

test('index.html이 매니페스트와 서비스 워커 등록을 실제로 건다', () => {
  assert.match(html, /<link[^>]*rel="manifest"[^>]*href="\.\/manifest\.webmanifest"/);
  assert.match(html, /<script src="pwa\.js"><\/script>/);
  assert.match(html, /<link[^>]*rel="apple-touch-icon"/, 'iOS는 매니페스트 아이콘을 안 쓴다');
  // app.js가 갈아 끼울 자리다. 없으면 조용히 아무 일도 일어나지 않는다.
  assert.match(html, /<meta name="theme-color" content="[^"]+">/);
});

test('CSP는 설치에 필요한 만큼만 열고 connect-src는 none 그대로다', () => {
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  assert.match(csp, /connect-src 'none'/, '밖으로 보내지 않는다는 규칙이 핵심이다');
  assert.match(csp, /manifest-src 'self'/);
  assert.match(csp, /worker-src 'self'/);
  assert.match(csp, /img-src 'self' data:/);
  // 인라인을 여는 순간 이 앱의 규칙 전체가 헐거워진다.
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  // 'self'가 아닌 출처를 슬쩍 들이지 않았는지 본다.
  assert.doesNotMatch(csp, /https?:\/\//);
});

test('서비스 워커는 자기 오리진 밖으로 나가지 않는다', () => {
  // 이 파일에는 페이지의 CSP가 걸리지 않는다(워커의 CSP는 HTTP 헤더로 정해지는데
  // Pages는 헤더를 못 붙인다). 그래서 connect-src 'none'이 여기까지 오지 않는다.
  // 규칙을 걸 수 없으니 테스트로 지킨다.
  assert.doesNotMatch(sw, /https?:\/\/(?!\S*\bself\.location\b)/,
    'sw.js에 바깥 주소가 들어 있다');
  assert.match(sw, /request\.url\.startsWith\(SCOPE\)/, '범위 밖 요청을 걸러야 한다');
});

let failures = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}: ${error.message}`);
  }
}
if (failures) {
  console.error(`${failures} pwa test(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`all ${tests.length} pwa tests passed`);
}
