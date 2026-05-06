// =====================================================================
// game.js — 멀티플레이 게임 로직
// VERSION: v0.3.1
//
// v0.3.0 → v0.3.1 변경:
//   - trySelect: maxLen 도달 시점도 deadEnd로 처리
//   - selection 절반 점수 페널티 (모드 minLen 미달)
//   - 수식 형태 보장: 5칸 이상에서만 평가
//
// 서버 측 진실(authority). 클라이언트는 결과만 받아서 그림.
// =====================================================================

const VERSION = 'v0.3.1';

const DIRS = [
  [+1,  0], [+1, -1], [ 0, -1],
  [-1,  0], [-1, +1], [ 0, +1]
];

const MODE_INFO = {
  easy:    { minLen: 5, maxLen: 6,  k: 1.5 },
  normal:  { minLen: 6, maxLen: 8,  k: 1.8 },
  hard:    { minLen: 7, maxLen: 11, k: 2.1 },
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
// 게임 객체 — 한 방의 진행 상태
// =====================================================================
function createGame(room) {
  const baseDiff = BASE_DIFF_OF[room.mode] || 'easy';
  const clusters = buildMap(baseDiff, 100);
  const cells = new Map(); // key -> { token, clusterId, owner: null, indexInCluster }

  clusters.forEach(cl => {
    cl.path.forEach(([q, r], i) => {
      cells.set(keyOf(q, r), {
        q, r,
        token: cl.tokens[i],
        clusterId: cl.id,
        indexInCluster: i,
        owner: null,    // 잠긴 칸의 팀 색 (id)
      });
    });
  });

  // 각 플레이어의 진행 중 selection: playerId -> [key, key, ...]
  const selections = new Map();
  // 점수: playerId -> number
  const scores = new Map();
  // 영토 칸 수: playerId -> number
  const territory = new Map();

  room.players.forEach(p => {
    selections.set(p.id, []);
    scores.set(p.id, 0);
    territory.set(p.id, 0);
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
  };
}

// 한 칸 추가 시도. 결과 객체 반환.
function trySelect(game, playerId, key) {
  const cell = game.cells.get(key);
  if (!cell) return { ok: false, reason: 'no-cell' };
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
  let completed = null;
  if (tokens.length >= 5) {
    const ok = evaluateTokens(tokens) || evaluateTokens(tokens.slice().reverse());
    if (ok) completed = sel.slice();
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
        const ok = evaluateTokens(tokens) || evaluateTokens(tokens.slice().reverse());
        if (ok) {
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
  const info = MODE_INFO[game.baseDiff];
  const minLen = info.minLen;
  const visited = new Set();
  for (const [k, c] of game.cells.entries()) {
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
        if (nc && !nc.owner && !visited.has(nk)) {
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
    })),
    selections: [...game.selections.entries()].map(([id, sel]) => ({
      playerId: id, keys: sel.slice(),
    })),
    scores: [...game.scores.entries()].map(([id, s]) => ({ playerId: id, score: s })),
    territory: [...game.territory.entries()].map(([id, t]) => ({ playerId: id, count: t })),
    startedAt: game.startedAt,
    timeLimitSec: game.timeLimitSec,
  };
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
};
