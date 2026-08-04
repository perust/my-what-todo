# My What Todo

머릿속에 뭉쳐 있는 일을 실행 단위로 쪼개서 관리하는 1인용 할 일 웹 앱입니다.
백엔드 없이 브라우저의 LocalStorage를 정본으로 저장합니다. 지원 브라우저에서는 사용자가
고른 JSON 파일에도 현재 페이지 세션 동안 변경을 자동 저장할 수 있습니다. Obsidian vault의
Markdown 파일을 고르면 앱 변경을 단방향 보기로 자동 생성하며, 이 연결도 현재 페이지
세션에만 유지됩니다. 별도의 순수 parser는 그 정본 문서에서 기존 항목만 제한적으로 편집한
결과를 검증할 수 있습니다. 빌드 없이 정적 파일 그대로 올립니다.

## 주요 기능

- **2단계 계층** — 상위 할 일을 하위 할 일로 쪼갭니다. 완료 상태가 위아래로 전파됩니다
- **우선순위 0~3** — 0이 가장 높습니다. 제목 앞에 `!`를 붙이면 0으로 들어갑니다
- **태그** — 제목 끝에 `#태그`를 붙여 그 자리에서 분류합니다. 항목당 5개까지
- **카테고리** — 기본 3종으로 시작하고, 톱니바퀴에서 직접 만들고 이름을 바꾸고 지웁니다.
  최대 64개까지 만들 수 있습니다. 항목의 배지를 누르면 소속을 나중에 바꿀 수 있고,
  하위 할 일은 상위를 따라갑니다
- **검색과 필터** — 제목·태그 실시간 검색. 카테고리·태그 필터와 함께 걸립니다
- **정렬 5종** — 우선순위 · 직접 순서 · 생성일 · 카테고리 · 완료 상태.
  직접 순서일 때는 끌어서 옮기거나 `Alt+↑`/`Alt+↓`로 옮깁니다
- **진행률** — 하위가 있는 상위는 세지 않고, 실제로 할 일인 항목만 셉니다
- **내보내기 / 가져오기** — JSON 파일로 백업하고 되돌립니다
- **JSON 파일 연결** — `파일 연결`로 고른 파일에 현재 데이터를 즉시 쓰고, 이후 성공한
  변경을 순서대로 자동 저장합니다. 연결 뒤 파일이 앱 밖에서 바뀌면 exact bytes 비교로
  자동 저장을 멈추고 앱 내용 덮어쓰기 또는 외부 파일 유지를 선택하게 합니다. footer에서
  연결 파일과 마지막 성공 저장 시각을 확인할 수 있으며, 연결은 현재 페이지 세션에만 유지됩니다.
  파일 API에 원자적 compare-and-swap이 없어 쓰기 직전 read→write 사이 TOCTOU는 남는
  best-effort 보호입니다
- **Markdown 연결** — Obsidian vault에서 고른 `.md` 파일에 현재 목록을 즉시 생성하고 앱의
  이후 변경을 순서대로 덮어씁니다. 연결 뒤 외부 변경은 exact bytes로 감지해 자동 저장을
  멈추며, 앱 내용으로 강제 덮어쓰기 또는 외부 파일 유지(연결 해제)를 선택합니다. 연결과
  baseline은 현재 페이지 세션에만 유지됩니다. 파일 API에 원자적 compare-and-swap이 없어
  Markdown read→write 사이 TOCTOU는 남는 best-effort 보호입니다. **6단계 parser/import 중 6A parser**는
  `MarkdownExport.render(currentSnapshot)`가 만든 정본 문서의 기존 ID exact-once 편집만
  fail-closed로 검증합니다. 체크박스·P0~P3·제목·태그·형제 순서·기존 카테고리 이동·2단계
  재배치를 지원하고, 항목/카테고리 추가·삭제와 설정/임의 Markdown 변경은 거부합니다.
  아직 app/Store/Sync가 parser를 호출하지 않으므로 실제 가져오기/양방향 연결은 **6B 후속 범위**입니다
- **뽀모도로 타이머** — 집중·휴식 4회차 사이클과 단일 타이머. 회차별 시간을 직접 정하고,
  펼치면 시간이 흐른 만큼 채워지는 원형 시계로 봅니다. 새로고침해도 돌아가던 자리에서 이어집니다
- **다크 모드** — OS 설정을 따르다가, 고르면 그 선택을 지킵니다
- **실행 취소** — 삭제하면 5초 동안 되돌릴 수 있습니다
- **여러 탭 동기화** — 다른 탭의 변경을 따라가고, 이미 바뀐 판을 확인하면 낡은 쓰기를 거부합니다.
  다만 LocalStorage에는 원자적 비교-저장이 없어 두 탭이 정확히 동시에 저장하면 마지막 쓰기가
  앞선 변경을 덮을 수 있습니다. 같은 순간에 두 탭에서 편집하지 않는 것을 권합니다

## 실행 방법

**바로 써보기 → <https://perust.github.io/my-what-todo/>**

빌드 없이 정적 파일 그대로 올려 쓰는 앱입니다. 이 저장소가 GitHub Pages로 그대로
서비스되므로 따로 배포할 것이 없습니다. 직접 돌려보려면 로컬 서버로 띄웁니다.

```bash
git clone https://github.com/perust/my-what-todo.git
cd my-what-todo
python3 -m http.server 8000
```

그 다음 `http://localhost:8000`으로 들어갑니다. `index.html`을 파일로 직접 여는 것은
지원하지 않습니다 — 첫 페인트 전에 테마를 정하려고 `store.js`를 `<head>`에서 읽는데,
`file://`에서는 브라우저마다 저장소 동작이 갈립니다.

회귀 테스트도 외부 패키지 없이 Node.js로 실행합니다.

```bash
node tests/regressions.js
node tests/file-sync.js
node tests/markdown-export.js
node tests/markdown-import.js
node tests/markdown-sync.js
```

## 프로젝트 구조

```text
.
├── index.html    # 화면 뼈대와 대화상자
├── styles.css    # 라이트/다크 팔레트, 레이아웃
├── theme.js      # 첫 페인트 전에 고른 테마를 칠한다
├── parse.js      # 입력 문자열 → { title, priority, tags }. 순수 함수만
├── store.js      # 데이터 계층: 저장·검증·전파·정렬·집계. DOM을 모른다
├── file-sync.js  # 페이지 세션 한정 JSON 파일 연결과 직렬 쓰기 큐
├── markdown-export.js # Store 스냅샷 → 결정론적 Obsidian Markdown
├── markdown-import.js # canonical Markdown 기존 항목 제한 편집 strict parser
├── markdown-sync.js   # 페이지 세션 한정 Markdown 연결과 직렬 쓰기 큐
├── app.js        # UI 계층: 렌더링과 이벤트. Store와 Parse만 호출한다
├── tests/
│   ├── regressions.js  # Node 내장 모듈만 쓰는 회귀 테스트
│   ├── file-sync.js    # 파일 연결·직렬 저장 focused 테스트
│   ├── markdown-export.js # Markdown exact bytes·검증 테스트
│   ├── markdown-import.js # canonical parser·hostile matrix·Store 경계 테스트
│   └── markdown-sync.js   # Markdown 연결·실패 복구 테스트
├── CLAUDE.md     # 이 저장소에서 지켜야 할 제약
└── docs/
    ├── todo-app-prd.md         # 상세 명세 (기능·데이터 모델·엣지 케이스)
    └── claude-code-prompts.md  # 단계별 작업 지시 문서
```

## 기술 스택

HTML + CSS + JavaScript(ES2020+)만 씁니다. npm 패키지, 프레임워크, 빌드 도구,
외부 CDN 요청이 하나도 없습니다. 화면이 한번 뜨고 나면 그 뒤로는 네트워크를 쓰지 않아,
할 일을 넣고 고치고 지우는 일이 전부 브라우저 안에서 끝납니다. 다만 그 첫 화면은
받아와야 합니다 — 서비스 워커를 두지 않으므로 네트워크 없이 주소를 열 수는 없습니다.
`Content-Security-Policy`로 `connect-src 'none'`을 걸어, 밖으로 내보낼 길 자체를 막아뒀습니다.

- 저장소: `localStorage` 키 하나 (스키마 버전 4).
  돌아가는 타이머만 `sessionStorage`에 따로 두어 탭을 닫으면 사라집니다.
  브라우저 저장소는 **출처 단위**라, 같은 도메인에 올린 다른 페이지의 스크립트도
  이 데이터를 읽고 고칠 수 있습니다
- 접근성: 전 기능 키보드 조작, 색 외에 텍스트·숫자로도 구분, 모션 줄이기 설정 반영.
  글자 대비는 라이트·다크 양쪽에서 WCAG AA(4.5:1)를 지킵니다 — 평면 배경뿐 아니라
  그 색이 실제로 얹히는 틴트 위에서도 잽니다
- 성능: 조회는 `Map` 색인으로 항목 수에 비례하게 유지하고, 판 번호와 테마는 저장본
  앞머리만 읽어 첫 페인트를 막지 않습니다. 목표는 항목 100개 기준 초기 로드 200ms,
  토글·추가 반응 16ms 이내이고, 실측은 초기 로드 37ms · 목록 렌더 4.5ms ·
  완료 토글 4.7ms · 검색 한 타 1.9ms입니다 (Chrome, 레이아웃까지 포함한 중앙값)
- 지원 브라우저: 앱과 LocalStorage, 기존 내보내기/가져오기는 최신 Chrome, Edge, Safari,
  Firefox에서 동작합니다. `파일 연결`은 File System Access API의 `showSaveFilePicker`를
  제공하는 브라우저에서만 동작합니다(주로 Chromium 계열). 미지원 브라우저에서는 연결을
  시도하지 않고 안내하며, LocalStorage와 내보내기/가져오기는 그대로 사용할 수 있습니다

## 문서

- [`docs/todo-app-prd.md`](docs/todo-app-prd.md) — 기능 요구사항 22개(F-01~F-22), 데이터 모델,
  엣지 케이스, 그리고 명세와 다르게 구현한 것들의 이유
- [`CLAUDE.md`](CLAUDE.md) — 프로젝트 내내 변하지 않는 제약
