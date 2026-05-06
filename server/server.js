// =====================================================================
// Honeycomb Math — Online Battle Server
// VERSION: v0.3.7
// =====================================================================
// 한 파일에 다 들어있음. Render에 배포할 수 있는 최소 서버.
//
// 흐름:
//   클라이언트 → socket.emit('room:create' | 'room:join' | ...)
//   서버 → io.to(roomCode).emit('room:state' | 'room:joined' | ...)
//
// 모든 게임 상태는 서버 메모리에만 있음. 서버 재시작 시 모두 휘발.
// =====================================================================

const SERVER_VERSION = 'v0.3.7';
const keyOf = (q, r) => `${q},${r}`;

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const gameLogic = require('./game');

const PORT = process.env.PORT || 3000;
const app = express();

console.log(`Honeycomb Math server starting [${SERVER_VERSION}]`);

// 정적 파일 서빙 — server/public/ 폴더의 모든 파일을 루트로 노출
// 즉 server/public/index.html → https://your-domain.com/ 에서 보임
app.use(express.static(path.join(__dirname, 'public')));

// 헬스 체크 — 버전 + 방 개수
app.get('/health', (req, res) => {
  res.json({ ok: true, version: SERVER_VERSION, gameVersion: gameLogic.VERSION || 'unknown', rooms: Object.keys(rooms).length });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }, // 클라가 GitHub Pages 등 다른 도메인일 수 있음
});

// ---------------------------------------------------------------------
// 공통 상수
// ---------------------------------------------------------------------
const COLORS = ['red','blue','green','navy','purple','orange','cyan','pink'];
const MAX_PLAYERS = 4;
const ROOM_TTL_MS = 30 * 60 * 1000; // 30분 비활성 방 자동 폭파

// ---------------------------------------------------------------------
// 방 상태 (메모리)
// ---------------------------------------------------------------------
const rooms = {};       // code -> room
const socketToPlayer = new Map(); // socketId -> { code, playerId }

function genCode() {
  const pool = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s;
  do {
    s = '';
    for (let i = 0; i < 4; i++) s += pool[Math.floor(Math.random() * pool.length)];
  } while (rooms[s]);
  return s;
}

function pickAvailableColor(room) {
  const taken = new Set(room.players.map(p => p.color));
  for (const c of COLORS) if (!taken.has(c)) return c;
  return COLORS[0];
}

function teamLabel(idx) { return `${idx + 1}팀`; }

function snapshotForClient(room) {
  return {
    code: room.code,
    mode: room.mode,
    timeLimit: room.timeLimit,
    players: room.players.map(p => ({
      id: p.id, name: p.name, color: p.color,
      ready: p.ready, isHost: p.isHost,
    })),
  };
}

function broadcastState(room) {
  io.to(room.code).emit('room:state', snapshotForClient(room));
  room.lastActivity = Date.now();
}

function findPlayer(room, playerId) {
  return room.players.find(p => p.id === playerId);
}

function relabelTeams(room) {
  let teamIdx = 0;
  room.players.forEach(p => {
    if (p.isHost) p.name = '1팀 (방장)';
    else { teamIdx++; p.name = `${teamIdx + 1}팀`; }
  });
}

// ---------------------------------------------------------------------
// Socket 핸들러
// ---------------------------------------------------------------------
io.on('connection', (socket) => {
  console.log('[connect]', socket.id);

  // ----- 방 만들기 -----
  socket.on('room:create', () => {
    const code = genCode();
    const playerId = socket.id;
    const room = {
      code,
      players: [{
        id: playerId,
        name: '1팀 (방장)',
        color: 'navy',
        ready: true,
        isHost: true,
      }],
      mode: 'exex1',
      timeLimit: 5,
      lastActivity: Date.now(),
    };
    rooms[code] = room;
    socket.join(code);
    socketToPlayer.set(socket.id, { code, playerId });
    socket.emit('room:joined', { code, myId: playerId, isHost: true });
    broadcastState(room);
  });

  // ----- 방 참가 -----
  socket.on('room:join', ({ code }) => {
    code = (code || '').toUpperCase();
    const room = rooms[code];
    if (!room) {
      socket.emit('room:error', { reason: '방을 찾을 수 없습니다' });
      return;
    }
    if (room.players.length >= MAX_PLAYERS) {
      socket.emit('room:error', { reason: '방이 가득 찼습니다' });
      return;
    }
    const playerId = socket.id;
    const idx = room.players.length;
    room.players.push({
      id: playerId,
      name: teamLabel(idx),
      color: pickAvailableColor(room),
      ready: false,
      isHost: false,
    });
    socket.join(code);
    socketToPlayer.set(socket.id, { code, playerId });
    socket.emit('room:joined', { code, myId: playerId, isHost: false });
    broadcastState(room);
  });

  // ----- 색상 변경 -----
  socket.on('player:setColor', ({ color }) => {
    const ref = socketToPlayer.get(socket.id);
    if (!ref) return;
    const room = rooms[ref.code];
    if (!room) return;
    const me = findPlayer(room, ref.playerId);
    if (!me) return;
    if (!me.isHost && me.ready) return; // 비방장은 ready 전에만
    if (!COLORS.includes(color)) return;
    if (room.players.some(p => p.id !== me.id && p.color === color)) return;
    me.color = color;
    broadcastState(room);
  });

  // ----- 레디 토글 -----
  socket.on('player:setReady', ({ ready }) => {
    const ref = socketToPlayer.get(socket.id);
    if (!ref) return;
    const room = rooms[ref.code];
    if (!room) return;
    const me = findPlayer(room, ref.playerId);
    if (!me || me.isHost) return; // 방장은 자동 ready
    me.ready = !!ready;
    broadcastState(room);
  });

  // ----- 모드 변경 (방장) -----
  socket.on('room:setMode', ({ mode }) => {
    const ref = socketToPlayer.get(socket.id);
    if (!ref) return;
    const room = rooms[ref.code];
    if (!room) return;
    const me = findPlayer(room, ref.playerId);
    if (!me || !me.isHost) return;
    if (!['exex1', 'exex2', 'exex3'].includes(mode)) return;
    room.mode = mode;
    broadcastState(room);
  });

  // ----- 시간 변경 (방장) -----
  socket.on('room:setTime', ({ timeLimit }) => {
    const ref = socketToPlayer.get(socket.id);
    if (!ref) return;
    const room = rooms[ref.code];
    if (!room) return;
    const me = findPlayer(room, ref.playerId);
    if (!me || !me.isHost) return;
    if (![0, 1, 5, 10].includes(timeLimit)) return;
    room.timeLimit = timeLimit;
    broadcastState(room);
  });

  // ----- 게임 시작 (방장) -----
  socket.on('room:start', () => {
    const ref = socketToPlayer.get(socket.id);
    if (!ref) return;
    const room = rooms[ref.code];
    if (!room) return;
    const me = findPlayer(room, ref.playerId);
    if (!me || !me.isHost) return;
    if (room.players.length < 2) return;
    if (!room.players.filter(p => !p.isHost).every(p => p.ready)) return;

    // 게임 시작
    const game = gameLogic.createGame(room);
    room.game = game;
    room.gameTimer = null;
    room.hintTimer = null;

    // 시간 제한이 있으면 타이머
    if (game.timeLimitSec > 0) {
      room.gameTimer = setTimeout(() => endGame(room, 'time'), game.timeLimitSec * 1000);
    }

    // EXEX3: 게임 시작 시 시작점 N개 사전 힌트 (시작점만, 연산자 X)
    if (room.mode === 'exex3') {
      const N = room.players.length;
      gameLogic.generateHints(game, N, { startsOnly: true });
    }

    io.to(room.code).emit('game:start', {
      mode: room.mode,
      timeLimit: room.timeLimit,
      players: room.players.map(p => ({
        id: p.id, name: p.name, color: p.color, isHost: p.isHost,
      })),
      state: gameLogic.snapshotGame(game),
    });

    // 힌트 사이클: 첫 사이클 30초 후, 이후 30~50초 랜덤
    scheduleHintCycle(room, 30 * 1000);
  });

  // ----- 게임 중: 칸 선택 -----
  socket.on('cell:select', ({ key }) => {
    const ref = socketToPlayer.get(socket.id);
    if (!ref) return;
    const room = rooms[ref.code];
    if (!room || !room.game || room.game.ended) return;
    const result = gameLogic.trySelect(room.game, ref.playerId, key);
    if (!result.ok) {
      // 무효 거부 — selection 보존, 그냥 무시
      // (반응성 위해 본인에게는 알릴 수도 있지만 일단 침묵)
      return;
    }
    // 진행 중 selection 갱신 broadcast
    const sel = room.game.selections.get(ref.playerId);
    io.to(room.code).emit('selection:update', { playerId: ref.playerId, keys: sel.slice() });

    // 수식 완성 시 잠금 처리
    if (result.completed) {
      const lockResult = gameLogic.lockSelection(room.game, ref.playerId);
      if (lockResult) {
        io.to(room.code).emit('cluster:locked', {
          playerId: ref.playerId,
          keys: lockResult.lockedKeys,
          score: lockResult.score,
          totalScore: room.game.scores.get(ref.playerId),
          territory: room.game.territory.get(ref.playerId),
          brokenPlayers: lockResult.brokenPlayers,
        });
        // 깨진 플레이어 알림
        lockResult.brokenPlayers.forEach(pid => {
          io.to(room.code).emit('selection:reset', { playerId: pid, reason: 'overrun' });
        });
        // 잠긴 칸을 포함한 힌트는 무효화 (해당 클러스터를 더 풀 수 없거나, 이미 풀렸음)
        const removedHints = [];
        const stillActive = [];
        for (const h of room.game.activeHints) {
          // 이 힌트의 클러스터에 잠긴 칸이 있나?
          const clusterCells = room.game.clusters[h.clusterId].path.map(([q, r]) => keyOf(q, r));
          const hasLocked = clusterCells.some(k => {
            const c = room.game.cells.get(k);
            return c && c.owner;
          });
          if (hasLocked) {
            removedHints.push(h.clusterId);
            h.keys.forEach(k => room.game.activeHintKeys.delete(k));
            room.game.hintedClusters.delete(h.clusterId);
          } else {
            stillActive.push(h);
          }
        }
        room.game.activeHints = stillActive;
        if (removedHints.length > 0) {
          io.to(room.code).emit('hints:remove', { clusterIds: removedHints });
        }
        // 종료 조건 검사
        if (!gameLogic.hasRemainingPlayable(room.game)) {
          endGame(room, 'cleared');
        }
      }
    } else if (result.deadEnd) {
      // 막다른 길 + 유효 수식 아님 → selection 깨기
      gameLogic.tryReset(room.game, ref.playerId);
      io.to(room.code).emit('selection:reset', { playerId: ref.playerId, reason: 'dead-end' });
    }
  });

  // ----- 게임 중: undo -----
  socket.on('cell:undo', () => {
    const ref = socketToPlayer.get(socket.id);
    if (!ref) return;
    const room = rooms[ref.code];
    if (!room || !room.game || room.game.ended) return;
    if (gameLogic.tryUndo(room.game, ref.playerId).ok) {
      const sel = room.game.selections.get(ref.playerId);
      io.to(room.code).emit('selection:update', { playerId: ref.playerId, keys: sel.slice() });
    }
  });

  // ----- 게임 중: reset -----
  socket.on('cell:reset', () => {
    const ref = socketToPlayer.get(socket.id);
    if (!ref) return;
    const room = rooms[ref.code];
    if (!room || !room.game || room.game.ended) return;
    if (gameLogic.tryReset(room.game, ref.playerId).ok) {
      io.to(room.code).emit('selection:reset', { playerId: ref.playerId, reason: 'manual' });
    }
  });

  // ----- 명시적 나가기 -----
  socket.on('room:leave', () => {
    handleLeave(socket);
  });

  // ----- 연결 끊김 -----
  socket.on('disconnect', () => {
    console.log('[disconnect]', socket.id);
    handleLeave(socket);
  });
});

function scheduleHintCycle(room, delayMs) {
  if (room.hintTimer) clearTimeout(room.hintTimer);
  room.hintTimer = setTimeout(() => {
    if (!room.game || room.game.ended) return;
    // 1) 기존 활성 힌트 모두에 한 칸씩 누적
    const advanced = gameLogic.advanceHints(room.game);
    // 2) 새 드롭 힌트 N±1개
    const n = room.players.length;
    const count = Math.max(1, n - 1 + Math.floor(Math.random() * 3));
    const newHints = gameLogic.generateHints(room.game, count);
    // 3) broadcast
    if (newHints.length > 0 || advanced.length > 0) {
      io.to(room.code).emit('hints:add', {
        hints: newHints.map(h => ({
          clusterId: h.clusterId,
          startKey: h.startKey,
          opKeys: h.opKeys,
          keys: h.keys,
        })),
        advanced: advanced.map(a => ({
          clusterId: a.clusterId,
          addedKey: a.addedKey,
        })),
      });
    }
    const nextDelay = (30 + Math.random() * 20) * 1000;
    scheduleHintCycle(room, nextDelay);
  }, delayMs);
}

function endGame(room, reason) {
  if (!room.game || room.game.ended) return;
  room.game.ended = true;
  if (room.gameTimer) {
    clearTimeout(room.gameTimer);
    room.gameTimer = null;
  }
  if (room.hintTimer) {
    clearTimeout(room.hintTimer);
    room.hintTimer = null;
  }
  // 승자 산정
  const ranked = room.players.map(p => ({
    id: p.id, name: p.name, color: p.color,
    score: room.game.scores.get(p.id) || 0,
    territory: room.game.territory.get(p.id) || 0,
  })).sort((a, b) => (b.score - a.score) || (b.territory - a.territory));

  io.to(room.code).emit('game:over', {
    reason, // 'time' | 'cleared' | 'host-left' | 'lone'
    ranked,
  });
}

function handleLeave(socket) {
  const ref = socketToPlayer.get(socket.id);
  if (!ref) return;
  socketToPlayer.delete(socket.id);
  const room = rooms[ref.code];
  if (!room) return;
  const me = findPlayer(room, ref.playerId);
  if (!me) return;

  // 게임 중이면 — 그 팀 영토 해방
  if (room.game && !room.game.ended) {
    // 그 팀의 selection / 영토 / 점수 초기화. 영토 해방 (cells.owner 제거)
    for (const cell of room.game.cells.values()) {
      if (cell.owner === me.id) cell.owner = null;
    }
    room.game.selections.delete(me.id);
    room.game.scores.delete(me.id);
    room.game.territory.delete(me.id);
    io.to(room.code).emit('player:left', {
      playerId: me.id,
      // 영토 해방 - 클라가 그 플레이어 색을 다 지우면 됨
    });
    // 남은 인원 1명 이하면 종료
    if (room.game.selections.size <= 1) {
      endGame(room, 'lone');
    }
  }

  // 방장이 나가면 방 폭파 (게임 중이든 대기실이든)
  if (me.isHost) {
    io.to(room.code).emit('room:closed', { reason: '방장이 나갔습니다' });
    io.in(room.code).socketsLeave(room.code);
    if (room.gameTimer) clearTimeout(room.gameTimer);
    if (room.hintTimer) clearTimeout(room.hintTimer);
    delete rooms[ref.code];
    return;
  }

  // 비방장 나감 — 대기실이었다면 일반 처리
  room.players = room.players.filter(p => p.id !== me.id);
  if (!room.game) relabelTeams(room);
  socket.leave(room.code);
  if (!room.game) broadcastState(room);
}

// ---------------------------------------------------------------------
// 비활성 방 청소 (10분마다)
// ---------------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(rooms)) {
    if (now - rooms[code].lastActivity > ROOM_TTL_MS) {
      io.to(code).emit('room:closed', { reason: '비활성으로 방이 종료되었습니다' });
      io.in(code).socketsLeave(code);
      delete rooms[code];
    }
  }
}, 10 * 60 * 1000);

// ---------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`Honeycomb Math server listening on :${PORT}`);
});
