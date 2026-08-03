/**
 * parse.js — 입력 문자열 파싱. 순수 함수만 둔다. (PRD §4 F-05, F-07)
 *
 * 부수 효과 없음. DOM도, 저장소도 모른다.
 */
(function (global) {
  'use strict';

  const MAX_TAGS = 5;

  // 제목 끝의 ` #단어` 하나. `#` 앞에는 반드시 공백이 있어야 하고,
  // 태그 본문에는 공백과 `#`가 들어갈 수 없다.
  const TAIL_TAG = /\s#([^\s#]+)$/;

  /**
   * 태그 정규화: 앞뒤 공백 제거 → 영문 소문자화 → 중복 제거 → 최대 5개.
   * 초과분은 조용히 버린다. (PRD §8 "태그 6개 이상")
   */
  function normalizeTags(list) {
    const out = [];
    if (!Array.isArray(list)) return out;

    const seen = new Set();
    for (const raw of list) {
      if (typeof raw !== 'string') continue;

      const tag = raw.trim().toLowerCase();
      if (!tag || seen.has(tag)) continue;

      seen.add(tag);
      out.push(tag);
      if (out.length === MAX_TAGS) break;
    }
    return out;
  }

  /**
   * 입력 문자열 → { title, priority, tags }
   *
   * priority는 **지정했을 때만** 값을 가진다. `null`은 "안 적었다"는 뜻이고,
   * 그때 무엇을 쓸지는 호출부가 정한다 (입력창 선택값이든 기본값이든).
   *
   *   "!세금 신고"        → { title: "세금 신고", priority: 0,    tags: [] }
   *   "중요! 확인"        → { title: "중요! 확인", priority: null, tags: [] }
   *   "!!긴급"           → { title: "!긴급",      priority: 0,    tags: [] }
   *   "C# 공부 #cs #복습" → { title: "C# 공부",    priority: null, tags: ["cs","복습"] }
   *   "#세금"            → { title: "#세금",      priority: null, tags: [] }
   */
  function parseInput(raw) {
    let title = typeof raw === 'string' ? raw.trim() : '';
    let priority = null;

    // 우선순위: 맨 앞의 `!` **하나만** 소비한다. 나머지는 제목에 남는다.
    // `!`는 "가장 높게"라는 뜻이라 0이다.
    if (title.startsWith('!')) {
      priority = 0;
      title = title.slice(1).trimStart();
    }

    // 태그: 제목 끝에서 **역방향으로** 연속된 구간만 본다.
    // 이렇게 해야 "C# 공부"의 중간 `#`를 태그로 오인하지 않는다.
    const tags = [];
    let m;
    while ((m = title.match(TAIL_TAG))) {
      tags.unshift(m[1]);
      title = title.slice(0, m.index).trimEnd();
    }

    return { title, priority, tags: normalizeTags(tags) };
  }

  global.Parse = { parseInput, normalizeTags, MAX_TAGS };
})(globalThis);
