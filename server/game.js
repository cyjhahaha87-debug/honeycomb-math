// =====================================================================
// game.js — 멀티플레이 게임 로직
// VERSION: v0.5.0
//
// v0.4.0: createGame이 room.players[*].playerId를 영구 키로 사용.
// v0.4.1: 변경 없음.
// v0.4.2: 변경 없음. 버전만 동기화.
// v0.5.0: 이스터에그 맵 시스템 통합.
//   - createGame이 옵션으로 specialMap을 받아 사전 정의 path 사용 (랜덤 buildMap 대신).
//   - 짧은 cluster (len<5) 자동 decoration 승격: generateEquation 최소 5칸 한계 회피.
//   - decoration 셀: 이모지 token, owner null 고정, 게임 룰 제외 (점수/영토/잠김 X).
//   - hasRemainingPlayable: decoration은 무시 (cleared 판정 정확화).
//
// 서버 측 진실(authority). 클라이언트는 결과만 받아서 그림.
// =====================================================================

const VERSION = 'v0.5.0';
const { SPECIAL_MAPS, FORCE_TRIGGERS, LEVEL_WEIGHTS, SPECIAL_MAP_PROBABILITY } = require('./special_maps');

const DECORATION_EMOJI = '🏝️';

const DIRS = [
  [+1,  0], [+1, -1], [ 0, -1],
  [-1,  0], [-1, +1], [ 0, +1]
];

const MODE_INFO = {
  easy:    { minLen: 5, maxLen: 6,  k: 1.5 },
  normal:  { minLen: 6, maxLen: 10, k: 1.8 },
  hard:    { minLen: 7, maxLen: 12, k: 2.1 },
};

const BASE_DIFF_OF = {
  exex1: 'easy', exex2: 'normal', exex3: 'hard',
};

const keyOf = (q, r) => `${q},${r}`;

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ---------- 수식 생성 ----------
function isTrivialEquation(eq) {
  const m = eq.match(/^(\d+)([+\-×÷])(\d+)=(\d+)$/);
  if (!m) return false;
  const a = parseInt(m[1], 10);
  const op = m[2];
  const b = parseInt(m[3], 10);
  if (a === b) return true;
  if (op === '×' && (a === 0 || b === 0)) return true;
  if (op === '÷' && a === 0) return true;
  if ((op === '+' || op === '-') && b === 0) return true;
  return false;
}

function generateEquationOnce(diff) {
  let pool;
  if (diff === 'easy') pool = ['add1', 'sub1'];
  else if (diff === 'normal') pool = ['add2', 'sub2', 'mul'];
  else pool = ['add3', 'sub3', 'mul', 'div'];

  const type = pick(pool);
  let a, b, op;
  switch (type) {
    case 'add1': a = randInt(1, 9); b = randInt(1, 9); op = '+'; break;
    case 'sub1': a = randInt(2, 9); b = randInt(1, a); op = '-'; break;
    case 'add2': a = randInt(10, 99); b = randInt(1, 99); op = '+'; break;
    case 'sub2': a = randInt(10, 99); b = randInt(1, a); op = '-'; break;
    case 'add3': a = randInt(100, 999); b = randInt(1, 999); op = '+'; break;
    case 'sub3': a = randInt(100, 999); b = randInt(1, a); op = '-'; break;
    case 'mul':  a = randInt(11, 99); b = randInt(2, 9); op = '×'; break;
    case 'div': {
      b = randInt(2, 9);
      const q = randInt(15, Math.floor(999 / b));
      a = b * q; op = '÷'; break;
    }
  }
  let result;
  switch (op) {
    case '+': result = a + b; break;
    case '-': result = a - b; break;
    case '×': result = a * b; break;
    case '÷': result = a / b; break;
  }
  return `${a}${op}${b}=${result}`;
}

function generateEquation(diff) {
  for (let i = 0; i < 30; i++) {
    const eq = generateEquationOnce(diff);
    if (!isTrivialEquation(eq)) return eq;
  }
  return generateEquationOnce(diff);
}

function tokenize(eq) { return eq.split(''); }

// ---------- 한붓 경로 배치 ----------
function tryPlaceCluster(start, n, occupied) {
  const path = [start];
  const used = new Set([keyOf(start[0], start[1])]);

  function step(idx) {
    if (idx === n) return true;
    const [cq, cr] = path[idx - 1];
    const candidates = [];
    for (const [dq, dr] of DIRS) {
      const nq = cq + dq, nr = cr + dr;
      const nk = keyOf(nq, nr);
      if (used.has(nk) || occupied.has(nk)) continue;
      let touches = 0;
      for (const [d2q, d2r] of DIRS) {
        if (used.has(keyOf(nq + d2q, nr + d2r))) touches++;
      }
      candidates.push({ q: nq, r: nr, touches });
    }
    if (candidates.length === 0) return false;
    candidates.sort(() => Math.random() - 0.5);
    if (Math.random() < 0.7) candidates.sort((a, b) => b.touches - a.touches);
    for (const c of candidates) {
      path.push([c.q, c.r]);
      used.add(keyOf(c.q, c.r));
      if (step(idx + 1)) return true;
      path.pop();
      used.delete(keyOf(c.q, c.r));
    }
    return false;
  }

  for (let attempt = 0; attempt < 30; attempt++) {
    path.length = 0; path.push(start);
    used.clear(); used.add(keyOf(start[0], start[1]));
    if (step(1)) return path.slice();
  }
  return null;
}

function buildMap(baseDiff, count = 100) {
  const occupied = new Set();
  const clusters = [];
  let cid = 0;
  let consecutiveFails = 0;
  const MAX_FAILS = 50;

  while (cid < count && consecutiveFails < MAX_FAILS) {
    const equation = generateEquation(baseDiff);
    const tokens = tokenize(equation);

    let startCandidates;
    if (cid === 0) {
      startCandidates = [[0, 0]];
    } else {
      const candSet = new Set();
      for (const k of occupied) {
        const [oq, or] = k.split(',').map(Number);
        for (const [dq, dr] of DIRS) {
          const nk = keyOf(oq + dq, or + dr);
          if (!occupied.has(nk)) candSet.add(nk);
        }
      }
      startCandidates = [...candSet].map(k => k.split(',').map(Number));
    }

    let placed = null;
    const shuffled = startCandidates.slice().sort(() => Math.random() - 0.5);
    for (const start of shuffled.slice(0, 12)) {
      placed = tryPlaceCluster(start, tokens.length, occupied);
      if (placed) break;
    }
    if (!placed) {
      consecutiveFails++;
      continue;
    }
    consecutiveFails = 0;

    clusters.push({
      id: cid,
      equation,
      tokens,
      path: placed,
    });
    placed.forEach(([q, r]) => occupied.add(keyOf(q, r)));
    cid++;
  }

  return clusters;
}

// ---------- 수식 평가 ----------
function evaluateTokens(tokens) {
  const str = tokens.join('');
  const parts = str.split('=');
  if (parts.length !== 2) return false;
  const [lhs, rhs] = parts;
  if (!lhs || !rhs) return false;
  const sanitize = (s) => s.replace(/×/g, '*').replace(/÷/g, '/');
  const safeRe = /^[\d+\-*/]+$/;
  const L = sanitize(lhs), R = sanitize(rhs);
  if (!safeRe.test(L) || !safeRe.test(R)) return false;
  try {
    const lv = Function(`"use strict"; return (${L});`)();
    const rv = Function(`"use strict"; return (${R});`)();
    if (typeof lv !== 'number' || typeof rv !== 'number') return false;
    if (!isFinite(lv) || !isFinite(rv)) return false;
    // v0.3.14: 자연수 결과만 인정 — 음수(4-8=-4 같은) / 분수 차단
    // 게임이 자연수 사칙이라 양변 모두 0 이상의 정수여야 의미 있는 식.
    if (lv < 0 || rv < 0) return false;
    if (!Number.isInteger(lv) || !Number.isInteger(rv)) return false;
    return Math.abs(lv - rv) < 1e-9;
  } catch (e) {
    return false;
  }
}

// ---------- 점수 계산 ----------
function computeScore(tokens, baseDiff) {
  const info = MODE_INFO[baseDiff] || MODE_INFO.easy;
  const len = tokens.length;
  const lenMul = Math.pow(len / info.minLen, info.k);
  const hasMulDiv = tokens.some(t => t === '×' || t === '÷');
  const opMul = hasMulDiv ? 1.4 : 1.0;
  const shortPenalty = len < info.minLen ? 0.5 : 1.0;
  return Math.round(10 * lenMul * opMul * shortPenalty);
}

// =====================================================================
// v0.5.0: 이스터에그 맵 — 사전 정의 path에 식 채우기
// =====================================================================
// special_maps.js의 raw cluster path들을 받아, 길이 5 미만은 decoration으로
// 자동 승격하고, 5+ cluster들에는 path 길이에 맞는 식을 생성해 끼워넣음.
//
// 식 길이 분포 (실측, baseDiff별):
//   easy:   5~6
//   normal: 6~9
//   hard:   7~12
// → cluster 길이별로 baseDiff 매칭이 다름. 폴백으로 모든 diff 시도.
//
// 반환: { clusters: [{id, equation, tokens, path}, ...], decorations: [[q,r],...] }
function buildFromSpecialMap(specialMap, baseDiff) {
  const clusters = [];
  const decorations = (specialMap.decorations || []).map(c => [c[0], c[1]]);
  let cid = 0;

  // 길이별 가능한 baseDiff 매핑 (선호 순)
  // baseDiff 우선, 안 맞으면 길이 커버 가능한 다른 diff로 폴백
  const tryDiffs = [baseDiff, 'easy', 'normal', 'hard'].filter((v, i, a) => a.indexOf(v) === i);

  for (const path of specialMap.clusters) {
    if (path.length < 5) {
      // 자연수 사칙연산 식은 최소 5토큰 — 짧은 cluster는 자동 decoration 승격
      path.forEach(([q, r]) => decorations.push([q, r]));
      continue;
    }
    let equation = null;
    let tokens = null;
    // 각 diff에서 200회씩 시도 (12칸은 hard에서 ~14% 빈도라 어느 정도 시도 필요)
    for (const diff of tryDiffs) {
      for (let attempt = 0; attempt < 200; attempt++) {
        const eq = generateEquation(diff);
        if (eq.length === path.length) {
          equation = eq;
          tokens = tokenize(eq);
          break;
        }
      }
      if (equation) break;
    }
    // 못 만들면 decoration으로 강등 (안전장치 — 길이 5,6은 hard pool에서 안 나오는 등)
    if (!equation) {
      path.forEach(([q, r]) => decorations.push([q, r]));
      continue;
    }
    clusters.push({
      id: cid++,
      equation,
      tokens,
      path: path.map(c => [c[0], c[1]]),
    });
  }

  return { clusters, decorations };
}

// 멀티 강제 트리거 검사: 1~4팀 색이 트리거 조합과 정확히 일치하는지
// (4명 + 순서 + 매치)
function checkForceTrigger(room) {
  const players = room.players.filter(p => p.role === 'player');
  if (players.length !== 4) return null;
  const colors = players.map(p => p.color);
  for (const [mapName, expected] of Object.entries(FORCE_TRIGGERS)) {
    if (expected.length !== 4) continue;
    let match = true;
    for (let i = 0; i < 4; i++) {
      if (colors[i] !== expected[i]) { match = false; break; }
    }
    if (match) return mapName;
  }
  return null;
}

// 등급 가중치 기반 랜덤 픽 → 해당 등급 풀에서 균등 랜덤
// 풀이 빈 등급은 후보에서 제외
function pickSpecialMapByLevel() {
  const eligible = [];
  for (const [level, weight] of Object.entries(LEVEL_WEIGHTS)) {
    const pool = Object.values(SPECIAL_MAPS).filter(m => m.level === level);
    if (pool.length > 0) eligible.push({ level, weight, pool });
  }
  if (eligible.length === 0) return null;
  const total = eligible.reduce((s, e) => s + e.weight, 0);
  let roll = Math.random() * total;
  for (const e of eligible) {
    roll -= e.weight;
    if (roll <= 0) return pick(e.pool);
  }
  return pick(eligible[eligible.length - 1].pool);
}

// 솔로/멀티에서 호출. 옵션:
//   forceMapName: 특정 맵 이름 ('geoje' 등) — 색깔 트리거 등에서 사용
//   allowSpecial: true일 때만 5% 추첨 (기본 false). 솔로 EXEX3 / 멀티 미적용
// 반환: SPECIAL_MAPS의 한 항목 또는 null
function selectSpecialMap(opts = {}) {
  if (opts.forceMapName && SPECIAL_MAPS[opts.forceMapName]) {
    return SPECIAL_MAPS[opts.forceMapName];
  }
  if (opts.allowSpecial !== true) return null;    // v0.5.0: 명시적 true만 통과
  if (Math.random() >= SPECIAL_MAP_PROBABILITY) return null;
  return pickSpecialMapByLevel();
}

// =====================================================================
// 게임 객체 — 한 방의 진행 상태
// =====================================================================
// v0.5.0: 옵션 인자 추가
//   options.forceSpecialMap: 특정 맵 강제 (색 트리거 등) — 우선
//   options.allowSpecialMap: 5% 추첨 허용 (기본 false, server.js에서 결정)
function createGame(room, options = {}) {
  const baseDiff = BASE_DIFF_OF[room.mode] || 'easy';

  // 이스터에그 맵 결정
  const specialMap = selectSpecialMap({
    forceMapName: options.forceSpecialMap,
    allowSpecial: !!options.allowSpecialMap,
  });

  let clusters, decorations;
  if (specialMap) {
    const built = buildFromSpecialMap(specialMap, baseDiff);
    clusters = built.clusters;
    decorations = built.decorations;
  } else {
    clusters = buildMap(baseDiff, 100);
    decorations = [];
  }

  const cells = new Map(); // key -> { token, clusterId, owner: null, indexInCluster, isDecoration }

  clusters.forEach(cl => {
    cl.path.forEach(([q, r], i) => {
      cells.set(keyOf(q, r), {
        q, r,
        token: cl.tokens[i],
        clusterId: cl.id,
        indexInCluster: i,
        owner: null,    // 잠긴 칸의 팀 색 (id)
        isDecoration: false,
      });
    });
  });

  // decoration 셀 추가 — 게임 룰 제외, 이모지 표시
  decorations.forEach(([q, r]) => {
    cells.set(keyOf(q, r), {
      q, r,
      token: DECORATION_EMOJI,
      clusterId: -1,
      indexInCluster: 0,
      owner: null,
      isDecoration: true,
    });
  });

  // 각 플레이어의 진행 중 selection: playerId -> [key, key, ...]
  const selections = new Map();
  // 점수: playerId -> number
  const scores = new Map();
  // 영토 칸 수: playerId -> number
  const territory = new Map();

  // v0.4.0: 영구 식별자 playerId 사용 (server.js가 socket.id와 분리)
  room.players.forEach(p => {
    selections.set(p.playerId, []);
    scores.set(p.playerId, 0);
    territory.set(p.playerId, 0);
  });

  return {
    room,
    baseDiff,
    clusters,
    cells,
    selections,
    scores,
    territory,
    startedAt: Date.now(),
    timeLimitSec: room.timeLimit > 0 ? room.timeLimit * 60 : 0,
    ended: false,
    // v0.5.0: 이스터에그 맵 메타 (null이면 일반 게임)
    specialMap: specialMap ? {
      name: specialMap.name,
      displayName: specialMap.displayName,
      level: specialMap.level,
    } : null,
    // 힌트 시스템
    hintedClusters: new Set(),    // 힌트 표시 중인 클러스터 ID
    activeHintKeys: new Set(),    // 힌트로 표시 중인 셀 키 (모두)
    activeHints: [],              // [{ clusterId, startKey, opKeys, keys }]
  };
}

// 한 칸 추가 시도. 결과 객체 반환.
function trySelect(game, playerId, key) {
  const cell = game.cells.get(key);
  if (!cell) return { ok: false, reason: 'no-cell' };
  if (cell.isDecoration) return { ok: false, reason: 'decoration' };  // v0.5.0
  if (cell.owner) return { ok: false, reason: 'locked' };

  const sel = game.selections.get(playerId);
  if (!sel) return { ok: false, reason: 'no-player' };

  // 이미 자기 selection에 있으면 무시
  if (sel.includes(key)) return { ok: false, reason: 'already' };

  // 첫 칸 — 시작점 규칙: 다른 팀의 시작점이면 거부
  if (sel.length === 0) {
    for (const [otherId, otherSel] of game.selections.entries()) {
      if (otherId === playerId) continue;
      if (otherSel.length > 0 && otherSel[0] === key) {
        return { ok: false, reason: 'start-taken' };
      }
    }
  } else {
    // 마지막 칸과 인접해야 함
    const lastKey = sel[sel.length - 1];
    const last = game.cells.get(lastKey);
    let adjacent = false;
    for (const [dq, dr] of DIRS) {
      if (last.q + dq === cell.q && last.r + dr === cell.r) { adjacent = true; break; }
    }
    if (!adjacent) return { ok: false, reason: 'not-adjacent' };
  }

  // EX 모드 무효 토큰 검사 — 거부만 함, selection 보존
  const tokens = sel.map(k => game.cells.get(k).token);
  tokens.push(cell.token);
  const isOp = (t) => /[+\-×÷]/.test(t);
  const eqCount = tokens.filter(t => t === '=').length;
  const opCount = tokens.filter(isOp).length;
  if (eqCount > 1) return { ok: false, reason: 'invalid' };
  if (opCount > 1) return { ok: false, reason: 'invalid' };
  // 비숫자 두 개 연속
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    const prev = tokens[tokens.length - 2];
    if (!/\d/.test(last) && !/\d/.test(prev)) {
      return { ok: false, reason: 'invalid' };
    }
  }
  // 최대 길이 초과 - 추가 거부 (selection은 그대로)
  const info = MODE_INFO[game.baseDiff];
  if (tokens.length > info.maxLen) return { ok: false, reason: 'too-long' };

  // 추가
  sel.push(key);

  // 유효 수식 자동 완성 검사 (수식 형태 최소 5칸 이상)
  // 모드 minLen 미달이어도 인정 (점수는 절반)
  // v0.3.14: reverse 평가 제거 — 정방향만 평가.
  //   `6=4+2` 같이 결과가 좌변에 오는 형태도 정방향 평가만으로 인정됨.
  //   이전엔 reverse 시도 부작용으로 `4-8=4`(역순 시 `4=8-4`)가 잘못 인정됐음.
  let completed = null;
  if (tokens.length >= 5) {
    if (evaluateTokens(tokens)) completed = sel.slice();
  }

  // 막다른 길 검사: 더 갈 칸이 없으면 자동 평가
  // (1) 6방향 인접에 미점령/미selection 칸이 있고
  // (2) 그 칸을 추가해도 maxLen을 넘지 않을 때만 "갈 수 있음"
  let deadEnd = false;
  if (!completed) {
    let hasNext = false;
    // maxLen 도달 시점이면 더 갈 곳 없는 것과 같음 (다음 칸은 무조건 거부됨)
    if (sel.length < info.maxLen) {
      const lastCell = game.cells.get(key);
      for (const [dq, dr] of DIRS) {
        const nq = lastCell.q + dq, nr = lastCell.r + dr;
        const nk = keyOf(nq, nr);
        const nc = game.cells.get(nk);
        if (!nc) continue;
        if (nc.owner) continue;
        if (sel.includes(nk)) continue;
        hasNext = true;
        break;
      }
    }
    if (!hasNext) {
      // 더 갈 곳 없음 — 현재 길이로 유효한지 마지막 검사
      if (tokens.length >= 5) {
        if (evaluateTokens(tokens)) {
          completed = sel.slice();
        } else {
          deadEnd = true;
        }
      } else {
        deadEnd = true;
      }
    }
  }

  return { ok: true, completed, deadEnd, tokens };
}

// 마지막 칸 빼기
function tryUndo(game, playerId) {
  const sel = game.selections.get(playerId);
  if (!sel || sel.length === 0) return { ok: false };
  sel.pop();
  return { ok: true };
}

// 전체 selection 비우기
function tryReset(game, playerId) {
  const sel = game.selections.get(playerId);
  if (!sel) return { ok: false };
  sel.length = 0;
  return { ok: true };
}

// 수식 완성: 이 selection을 영토로 굳히고, 충돌하는 다른 팀 selection을 깨뜨림
function lockSelection(game, playerId) {
  const sel = game.selections.get(playerId);
  if (!sel || sel.length === 0) return null;
  const tokens = sel.map(k => game.cells.get(k).token);
  const score = computeScore(tokens, game.baseDiff);

  // 영토 굳히기
  sel.forEach(k => {
    const c = game.cells.get(k);
    c.owner = playerId;
  });

  // 점수/영토 가산
  game.scores.set(playerId, (game.scores.get(playerId) || 0) + score);
  game.territory.set(playerId, (game.territory.get(playerId) || 0) + sel.length);

  const lockedKeys = sel.slice();
  // 자기 selection 비우기
  sel.length = 0;

  // 다른 팀 selection 중 잠긴 칸 포함된 거 — 깨버리기 (전체 reset)
  const brokenPlayers = [];
  for (const [otherId, otherSel] of game.selections.entries()) {
    if (otherId === playerId) continue;
    if (otherSel.some(k => lockedKeys.includes(k))) {
      otherSel.length = 0;
      brokenPlayers.push(otherId);
    }
  }

  return { lockedKeys, score, brokenPlayers };
}

// 게임 종료 조건: 더 풀 수 있는 수식이 남아있는가?
function hasRemainingPlayable(game) {
  // 각 클러스터 중 모든 칸이 unowned인 것이 하나라도 있으면 완전 풀이 가능
  // 더 정확하게는: 잠긴 칸들로 인해 격리된 영역에서 수식 만들기 가능한지
  // 일단 단순 버전: 잠기지 않은 칸이 minLen 이상 연결된 영역이 있는지
  // v0.5.0: decoration 셀은 통과 불가 (게임 룰 제외) — 벽처럼 취급
  const info = MODE_INFO[game.baseDiff];
  const minLen = info.minLen;
  const visited = new Set();
  for (const [k, c] of game.cells.entries()) {
    if (c.isDecoration) continue;
    if (c.owner || visited.has(k)) continue;
    // BFS로 연결된 unowned 영역 크기 측정
    const q = [k];
    visited.add(k);
    let size = 0;
    while (q.length > 0 && size < minLen) {
      const cur = q.shift();
      size++;
      const cell = game.cells.get(cur);
      for (const [dq, dr] of DIRS) {
        const nk = keyOf(cell.q + dq, cell.r + dr);
        const nc = game.cells.get(nk);
        if (nc && !nc.isDecoration && !nc.owner && !visited.has(nk)) {
          visited.add(nk);
          q.push(nk);
        }
      }
    }
    if (size >= minLen) return true;
  }
  return false;
}

function snapshotGame(game) {
  return {
    cells: [...game.cells.entries()].map(([k, c]) => ({
      key: k, q: c.q, r: c.r, token: c.token,
      clusterId: c.clusterId, owner: c.owner,
      isDecoration: !!c.isDecoration,    // v0.5.0
    })),
    selections: [...game.selections.entries()].map(([id, sel]) => ({
      playerId: id, keys: sel.slice(),
    })),
    scores: [...game.scores.entries()].map(([id, s]) => ({ playerId: id, score: s })),
    territory: [...game.territory.entries()].map(([id, t]) => ({ playerId: id, count: t })),
    hints: game.activeHints.map(h => ({
      clusterId: h.clusterId, startKey: h.startKey, opKeys: h.opKeys.slice(), keys: h.keys.slice(),
    })),
    startedAt: game.startedAt,
    timeLimitSec: game.timeLimitSec,
    // v0.5.0: specialMap 정보 (클라는 게임 중엔 표시 안 함, game:over 시점 공개)
    specialMap: game.specialMap,
  };
}

// 힌트 후보 클러스터: 모든 칸이 미점령 + 이미 힌트로 표시 중이 아님
function eligibleClustersForHint(game) {
  const out = [];
  for (const cl of game.clusters) {
    // 이미 힌트 표시중인 클러스터 제외
    if (game.hintedClusters.has(cl.id)) continue;
    // 모든 칸이 미점령이어야 함
    let allFree = true;
    for (const [q, r] of cl.path) {
      const c = game.cells.get(keyOf(q, r));
      if (!c || c.owner) { allFree = false; break; }
    }
    if (allFree) out.push(cl);
  }
  return out;
}

// 두 헥스 좌표 사이 거리 (axial distance)
function hexDist(q1, r1, q2, r2) {
  return (Math.abs(q1 - q2) + Math.abs(q1 + r1 - q2 - r2) + Math.abs(r1 - r2)) / 2;
}

// 한 사이클에 N개 힌트 생성. EXEX3 사전 시작점 모드는 startsOnly=true
// 한 클러스터의 "힌트 한도": 시작점 ~ 연산자 다음 숫자까지의 path 인덱스 집합
function maxRevealIndicesForCluster(cluster) {
  const opIdx = cluster.tokens.findIndex(t => /[+\-×÷]/.test(t));
  if (opIdx < 0) return new Set([0]);
  const limit = opIdx + 1; // 연산자 다음 숫자 인덱스
  const out = new Set();
  for (let i = 0; i <= limit; i++) out.add(i);
  return out;
}

function generateHints(game, count, opts = {}) {
  const startsOnly = !!opts.startsOnly;
  const eligible = eligibleClustersForHint(game);
  if (eligible.length === 0) return [];

  // 거리 분산: 5타일 이상 → 후보 부족하면 3타일 → 그래도 부족하면 거리 무시
  const tryWithMinDist = (minDist) => {
    const picked = [];
    const shuffled = eligible.slice().sort(() => Math.random() - 0.5);
    for (const cl of shuffled) {
      if (picked.length >= count) break;
      const [sq, sr] = cl.path[0];
      let ok = true;
      for (const p of picked) {
        const [pq, pr] = p.path[0];
        if (hexDist(sq, sr, pq, pr) < minDist) { ok = false; break; }
      }
      if (ok) {
        for (const h of game.activeHints) {
          const c = game.cells.get(h.startKey);
          if (!c) continue;
          if (hexDist(sq, sr, c.q, c.r) < minDist) { ok = false; break; }
        }
      }
      if (ok) picked.push(cl);
    }
    return picked;
  };

  let picked = tryWithMinDist(5);
  if (picked.length < count) picked = tryWithMinDist(3);
  if (picked.length < count) picked = tryWithMinDist(0);

  const hints = [];
  for (const cl of picked) {
    const startKey = keyOf(cl.path[0][0], cl.path[0][1]);
    const revealed = new Set([0]); // 시작점은 항상 포함
    const opKeys = [];
    let opIndex = -1;
    if (!startsOnly) {
      const opIndices = cl.tokens
        .map((t, i) => (/[+\-×÷]/.test(t) ? i : -1))
        .filter(i => i > 0);
      if (opIndices.length > 0) {
        opIndex = opIndices[Math.floor(Math.random() * opIndices.length)];
        revealed.add(opIndex);
        const [oq, or] = cl.path[opIndex];
        opKeys.push(keyOf(oq, or));
      }
    }
    const keys = [...revealed].sort((a,b)=>a-b).map(i => keyOf(cl.path[i][0], cl.path[i][1]));
    const hint = {
      clusterId: cl.id,
      startKey,
      opKeys,
      opIndex,
      revealed,
      keys,
      maxReveal: maxRevealIndicesForCluster(cl),
    };
    hints.push(hint);
    game.hintedClusters.add(cl.id);
    keys.forEach(k => game.activeHintKeys.add(k));
    game.activeHints.push(hint);
  }
  return hints;
}

// 누적: 모든 활성 힌트에 path 순서대로 다음 인덱스 한 칸씩 추가
// (이미 maxReveal 다 채운 힌트는 변화 없음)
// 반환: 새로 추가된 키들 [{clusterId, addedKey}, ...]
function advanceHints(game) {
  const added = [];
  for (const h of game.activeHints) {
    const cluster = game.clusters[h.clusterId];
    if (!cluster) continue;
    // 다음 추가할 인덱스 찾기 (path 순서)
    let nextIdx = -1;
    for (let i = 0; i < cluster.path.length; i++) {
      if (h.maxReveal.has(i) && !h.revealed.has(i)) {
        nextIdx = i;
        break;
      }
    }
    if (nextIdx < 0) continue;
    h.revealed.add(nextIdx);
    const [q, r] = cluster.path[nextIdx];
    const k = keyOf(q, r);
    h.keys.push(k);
    game.activeHintKeys.add(k);
    added.push({ clusterId: h.clusterId, addedKey: k });
  }
  return added;
}

// 클러스터가 풀렸을 때 힌트에서 제거
function clearHintForCluster(game, clusterId) {
  game.hintedClusters.delete(clusterId);
  const idx = game.activeHints.findIndex(h => h.clusterId === clusterId);
  if (idx >= 0) {
    const removed = game.activeHints.splice(idx, 1)[0];
    removed.keys.forEach(k => game.activeHintKeys.delete(k));
  }
}

module.exports = {
  VERSION,
  createGame,
  trySelect,
  tryUndo,
  tryReset,
  lockSelection,
  hasRemainingPlayable,
  snapshotGame,
  generateHints,
  advanceHints,
  clearHintForCluster,
  // v0.5.0
  checkForceTrigger,
  SPECIAL_MAPS,
};
