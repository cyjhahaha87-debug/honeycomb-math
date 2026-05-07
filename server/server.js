// =====================================================================
// 육각퍼즐 길찾기 — Online Battle Server
// VERSION: v0.5.0
// =====================================================================
// v0.4.0: playerId 분리, grace 30초, room:rejoin, 옵저버 모드.
// v0.4.1: 방장 leave 시 권한 자동 이양 (transferHost), 폭파 제거.
// v0.4.2: 게임 액션(cell:select 등)으로 lastActivity 즉시 갱신, idle TTL 부조리 픽스.
// v0.5.0: 이스터에그 맵 시스템.
//   - room:start에서 4인 색 조합 검사 → 매치 시 강제 트리거.
//   - 매치 없으면 5% 확률 + 등급 가중치로 추첨.
//   - game:over 페이로드에 specialMap 실어 보냄.
// v0.5.1: 색깔 강제 트리거도 EXEX3 한정으로 게이트.
//   - 거제도/한국 cluster가 12칸까지라 maxLen 12인 EXEX3에서만 풀이 가능.
//   - EX1/EX2에서 색 맞춰도 발동 안 함. (이전엔 모드 무관 → 저난이도 충격과 공포)
// =====================================================================

const SERVER_VERSION = 'v0.5.2';
const keyOf = (q, r) => `${q},${r}`;

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const gameLogic = require('./game');

const PORT = process.env.PORT || 3000;
const app = express();

function ts() {
  const d = new Date();
  return d.toISOString().slice(11, 23);
}
function dlog(tag, msg, extra) {
  const e = extra ? ' ' + JSON.stringify(extra) : '';
  console.log(`[${ts()}] [${tag}] ${msg}${e}`);
}

console.log(`육각퍼즐 길찾기 server starting [${SERVER_VERSION}]`);
dlog('BOOT', `pid=${process.pid} node=${process.version}`);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ ok: true, version: SERVER_VERSION, gameVersion: gameLogic.VERSION || 'unknown', rooms: Object.keys(rooms).length });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

// ---------------------------------------------------------------------
// 공통 상수
// ---------------------------------------------------------------------
const COLORS = ['red','blue','green','navy','purple','orange','cyan','pink'];
const MAX_PLAYERS = 4;
const MAX_OBSERVERS = 8;
const ROOM_TTL_MS = 30 * 60 * 1000;
const DISCONNECT_GRACE_MS = 30 * 1000;    // v0.4.0

// ---------------------------------------------------------------------
// 방 상태
// ---------------------------------------------------------------------
const rooms = {};
const socketToPlayer = new Map();

function genCode() {
  const pool = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s;
  do {
    s = '';
    for (let i = 0; i < 4; i++) s += pool[Math.floor(Math.random() * pool.length)];
  } while (rooms[s]);
  return s;
}

function genPlayerId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return crypto.randomBytes(16).toString('hex');
}

function pickAvailableColor(room) {
  const taken = new Set(room.players.filter(p => p.role === 'player').map(p => p.color));
  for (const c of COLORS) if (!taken.has(c)) return c;
  return COLORS[0];
}

function countByRole(room, role) {
  return room.players.filter(p => p.role === role).length;
}

function snapshotForClient(room) {
  return {
    code: room.code,
    mode: room.mode,
    timeLimit: room.timeLimit,
    players: room.players.map(p => ({
      id: p.playerId, name: p.name, color: p.color,
      ready: p.ready, isHost: p.isHost,
      role: p.role,
      disconnected: !!p.disconnected,
    })),
  };
}

function broadcastState(room) {
  io.to(room.code).emit('room:state', snapshotForClient(room));
  room.lastActivity = Date.now();
}

function findPlayer(room, playerId) {
  return room.players.find(p => p.playerId === playerId);
}

function relabelTeams(room) {
  const players = room.players.filter(p => p.role === 'player');
  let teamIdx = 0;
  players.forEach(p => {
    if (p.isHost) {
      p.name = '1팀 (방장)';
    } else {
      teamIdx++;
      p.name = `${teamIdx + 1}팀`;
    }
  });
  const observers = room.players.filter(p => p.role === 'observer');
  let obIdx = 0;
  observers.forEach(p => {
    obIdx++;
    if (p.isHost) {
      p.name = `관전자 ${obIdx} (방장)`;
    } else {
      p.name = `관전자 ${obIdx}`;
    }
  });
}

function activePlayersCount(room) {
  if (!room.game) return 0;
  return room.players.filter(p => p.role === 'player' && !p.disconnected).length;
}

// ---------------------------------------------------------------------
// Socket 핸들러
// ---------------------------------------------------------------------
io.on('connection', (socket) => {
  dlog('CONNECT', `socket=${socket.id.slice(0,6)} ip=${socket.handshake.address}`);

  // ----- 방 만들기 -----
  socket.on('room:create', () => {
    const code = genCode();
    const playerId = genPlayerId();
    const room = {
      code,
      players: [{
        playerId,
        currentSocketId: socket.id,
        name: '1팀 (방장)',
        color: 'navy',
        ready: true,
        isHost: true,
        role: 'player',
        disconnected: false,
        disconnectedAt: 0,
        leaveTimer: null,
      }],
      mode: 'exex1',
      timeLimit: 5,
      lastActivity: Date.now(),
      createdAt: Date.now(),
    };
    rooms[code] = room;
    socket.join(code);
    socketToPlayer.set(socket.id, { code, playerId });
    socket.emit('room:joined', {
      code, myId: playerId, isHost: true, role: 'player',
    });
    broadcastState(room);
    dlog('ROOM-CREATE', `code=${code} host=${playerId.slice(0,6)} totalRooms=${Object.keys(rooms).length}`);
  });

  // ----- 방 참가 -----
  socket.on('room:join', ({ code }) => {
    code = (code || '').toUpperCase();
    const room = rooms[code];
    if (!room) {
      socket.emit('room:error', { reason: '방을 찾을 수 없습니다' });
      dlog('ROOM-JOIN-FAIL', `code=${code} socket=${socket.id.slice(0,6)} reason=not-found`);
      return;
    }
    const inGame = !!(room.game && !room.game.ended);
    let role = 'player';
    if (inGame) {
      role = 'observer';
    } else if (countByRole(room, 'player') >= MAX_PLAYERS) {
      role = 'observer';
    }
    if (role === 'observer' && countByRole(room, 'observer') >= MAX_OBSERVERS) {
      socket.emit('room:error', { reason: '방이 가득 찼습니다' });
      dlog('ROOM-JOIN-FAIL', `code=${code} socket=${socket.id.slice(0,6)} reason=full`);
      return;
    }

    const playerId = genPlayerId();
    const newPlayer = {
      playerId,
      currentSocketId: socket.id,
      name: role === 'observer' ? '관전자' : '?팀',
      color: role === 'observer' ? 'cyan' : pickAvailableColor(room),
      ready: false,
      isHost: false,
      role,
      disconnected: false,
      disconnectedAt: 0,
      leaveTimer: null,
    };
    room.players.push(newPlayer);
    relabelTeams(room);

    socket.join(code);
    socketToPlayer.set(socket.id, { code, playerId });
    socket.emit('room:joined', {
      code, myId: playerId, isHost: false, role,
    });

    if (inGame) {
      socket.emit('game:start', {
        mode: room.mode,
        timeLimit: room.timeLimit,
        players: room.players.filter(p => p.role === 'player').map(p => ({
          id: p.playerId, name: p.name, color: p.color, isHost: p.isHost,
        })),
        state: gameLogic.snapshotGame(room.game),
        asObserver: true,
      });
    }
    broadcastState(room);
    dlog('ROOM-JOIN', `code=${code} player=${playerId.slice(0,6)} role=${role} totalPlayers=${room.players.length}`);
  });

  // ----- v0.4.0: 끊김 후 재접속 -----
  socket.on('room:rejoin', ({ code, playerId }) => {
    code = (code || '').toUpperCase();
    const room = rooms[code];
    if (!room) {
      socket.emit('room:error', { reason: '방이 더 이상 존재하지 않습니다' });
      dlog('REJOIN-FAIL', `code=${code} socket=${socket.id.slice(0,6)} reason=no-room`);
      return;
    }
    const me = findPlayer(room, playerId);
    if (!me) {
      socket.emit('room:error', { reason: '이 방에 본인 슬롯이 없습니다' });
      dlog('REJOIN-FAIL', `code=${code} player=${(playerId||'').slice(0,6)} reason=no-slot`);
      return;
    }
    if (me.leaveTimer) {
      clearTimeout(me.leaveTimer);
      me.leaveTimer = null;
    }
    me.disconnected = false;
    me.disconnectedAt = 0;
    me.currentSocketId = socket.id;
    socket.join(code);
    socketToPlayer.set(socket.id, { code, playerId });

    socket.emit('room:joined', {
      code, myId: playerId, isHost: me.isHost, role: me.role,
      rejoined: true,
    });

    if (room.game && !room.game.ended) {
      socket.emit('game:start', {
        mode: room.mode,
        timeLimit: room.timeLimit,
        players: room.players.filter(p => p.role === 'player').map(p => ({
          id: p.playerId, name: p.name, color: p.color, isHost: p.isHost,
        })),
        state: gameLogic.snapshotGame(room.game),
        asObserver: me.role === 'observer',
        rejoined: true,
      });
    }

    broadcastState(room);
    io.to(room.code).emit('player:reconnected', { playerId });
    dlog('REJOIN-OK', `code=${code} player=${playerId.slice(0,6)} role=${me.role} inGame=${!!(room.game && !room.game.ended)}`);
  });

  // ----- 색상 변경 -----
  socket.on('player:setColor', ({ color }) => {
    const ref = socketToPlayer.get(socket.id);
    if (!ref) return;
    const room = rooms[ref.code];
    if (!room) return;
    const me = findPlayer(room, ref.playerId);
    if (!me || me.role !== 'player') return;
    if (!me.isHost && me.ready) return;
    if (!COLORS.includes(color)) return;
    if (room.players.some(p => p.playerId !== me.playerId && p.role === 'player' && p.color === color)) return;
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
    if (!me || me.isHost) return;
    if (me.role !== 'player') return;
    me.ready = !!ready;
    broadcastState(room);
  });

  // ----- v0.4.0: 역할 전환 -----
  socket.on('room:setRole', ({ role }) => {
    const ref = socketToPlayer.get(socket.id);
    if (!ref) return;
    const room = rooms[ref.code];
    if (!room) return;
    if (room.game && !room.game.ended) {
      socket.emit('room:error', { reason: '게임 중에는 역할을 바꿀 수 없습니다' });
      return;
    }
    const me = findPlayer(room, ref.playerId);
    if (!me) return;
    if (role !== 'player' && role !== 'observer') return;
    if (me.role === role) return;

    if (role === 'player') {
      if (countByRole(room, 'player') >= MAX_PLAYERS) {
        socket.emit('room:error', { reason: '플레이어 슬롯이 가득 찼습니다' });
        return;
      }
      me.role = 'player';
      me.color = pickAvailableColor(room);
      me.ready = me.isHost;
    } else {
      if (countByRole(room, 'observer') >= MAX_OBSERVERS) {
        socket.emit('room:error', { reason: '관전자 슬롯이 가득 찼습니다' });
        return;
      }
      me.role = 'observer';
      me.ready = false;
    }
    relabelTeams(room);
    broadcastState(room);
    dlog('ROLE-CHANGE', `code=${ref.code} player=${me.playerId.slice(0,6)} → ${role}`);
  });

  // ----- 모드 변경 -----
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

  // ----- 시간 변경 -----
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

  // ----- 게임 시작 -----
  socket.on('room:start', () => {
    const ref = socketToPlayer.get(socket.id);
    if (!ref) return;
    const room = rooms[ref.code];
    if (!room) return;
    const me = findPlayer(room, ref.playerId);
    if (!me || !me.isHost) return;
    const players = room.players.filter(p => p.role === 'player');
    if (players.length < 2) return;
    const nonHostPlayers = players.filter(p => !p.isHost);
    if (!nonHostPlayers.every(p => p.ready)) return;

    // game.js의 createGame이 room.players를 보고 selections init
    // game.js를 v0.4.0에서 같이 수정해 p.playerId 사용
    const gameRoom = {
      players,
      timeLimit: room.timeLimit,
      mode: room.mode,
    };
    // v0.5.0: 이스터에그 맵 옵션 결정
    //   1) 4인 + 색 순서 일치 → 강제 트리거
    //   2) 일치 없으면 5% 추첨
    // v0.5.1: 둘 다 EXEX3 한정. 거제도/한국은 cluster 길이 12까지라 maxLen 12인 EXEX3에서만
    //         풀이 가능. EX1/EX2에서 발동되면 maxLen 6/10에 12칸 cluster → 풀이 불가.
    const isExex3 = room.mode === 'exex3';
    const forceSpecialMap = isExex3 ? gameLogic.checkForceTrigger(room) : null;
    const allowSpecialMap = isExex3 && !forceSpecialMap;
    const game = gameLogic.createGame(gameRoom, { forceSpecialMap, allowSpecialMap });

    room.game = game;
    room.gameTimer = null;
    room.hintTimer = null;

    if (game.timeLimitSec > 0) {
      room.gameTimer = setTimeout(() => endGame(room, 'time'), game.timeLimitSec * 1000);
    }

    if (room.mode === 'exex3') {
      const N = players.length;
      gameLogic.generateHints(game, N, { startsOnly: true });
    }

    io.to(room.code).emit('game:start', {
      mode: room.mode,
      timeLimit: room.timeLimit,
      players: players.map(p => ({
        id: p.playerId, name: p.name, color: p.color, isHost: p.isHost,
      })),
      state: gameLogic.snapshotGame(game),
    });

    scheduleHintCycle(room, 30 * 1000);
    const specialTag = game.specialMap ? ` special=${game.specialMap.name}${forceSpecialMap ? '/forced' : ''}` : '';
    dlog('GAME-START', `code=${ref.code} players=${players.length} observers=${countByRole(room, 'observer')} mode=${room.mode}${specialTag}`);
  });

  // ----- 게임 중: 칸 선택 -----
  socket.on('cell:select', ({ key }) => {
    const ref = socketToPlayer.get(socket.id);
    if (!ref) return;
    const room = rooms[ref.code];
    if (!room || !room.game || room.game.ended) return;
    const me = findPlayer(room, ref.playerId);
    if (!me || me.role !== 'player') return;
    // v0.4.2: 시도 자체로 사람 활동 신호. trySelect 성공/실패 무관 갱신.
    room.lastActivity = Date.now();
    const result = gameLogic.trySelect(room.game, ref.playerId, key);
    if (!result.ok) return;
    const sel = room.game.selections.get(ref.playerId);
    io.to(room.code).emit('selection:update', { playerId: ref.playerId, keys: sel.slice() });

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
        lockResult.brokenPlayers.forEach(pid => {
          io.to(room.code).emit('selection:reset', { playerId: pid, reason: 'overrun' });
        });
        const removedHints = [];
        const stillActive = [];
        for (const h of room.game.activeHints) {
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
        if (!gameLogic.hasRemainingPlayable(room.game)) {
          endGame(room, 'cleared');
        }
      }
    } else if (result.deadEnd) {
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
    const me = findPlayer(room, ref.playerId);
    if (!me || me.role !== 'player') return;
    room.lastActivity = Date.now();    // v0.4.2: 시도 자체로 갱신
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
    const me = findPlayer(room, ref.playerId);
    if (!me || me.role !== 'player') return;
    room.lastActivity = Date.now();    // v0.4.2
    if (gameLogic.tryReset(room.game, ref.playerId).ok) {
      io.to(room.code).emit('selection:reset', { playerId: ref.playerId, reason: 'manual' });
    }
  });

  // ----- 명시적 나가기 -----
  socket.on('room:leave', () => {
    dlog('LEAVE-EXPLICIT', `socket=${socket.id.slice(0,6)}`);
    handleLeave(socket, 'explicit-leave');
  });

  // ----- 연결 끊김 -----
  socket.on('disconnect', (reason) => {
    const ref = socketToPlayer.get(socket.id);
    const refStr = ref ? `code=${ref.code} player=${ref.playerId.slice(0,6)}` : 'unmapped';
    dlog('DISCONNECT', `socket=${socket.id.slice(0,6)} reason=${reason} ${refStr}`);
    handleLeave(socket, `disconnect:${reason}`);
  });
});

function scheduleHintCycle(room, delayMs) {
  if (room.hintTimer) clearTimeout(room.hintTimer);
  room.hintTimer = setTimeout(() => {
    if (!room.game || room.game.ended) return;
    const advanced = gameLogic.advanceHints(room.game);
    const n = activePlayersCount(room);
    const count = Math.max(1, n - 1 + Math.floor(Math.random() * 3));
    const newHints = gameLogic.generateHints(room.game, count);
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
  const players = room.players.filter(p => p.role === 'player');
  const ranked = players.map(p => ({
    id: p.playerId, name: p.name, color: p.color,
    score: room.game.scores.get(p.playerId) || 0,
    territory: room.game.territory.get(p.playerId) || 0,
  })).sort((a, b) => (b.score - a.score) || (b.territory - a.territory));

  io.to(room.code).emit('game:over', {
    reason,
    ranked,
    // v0.5.0: 이스터에그 맵 정체 공개
    specialMap: room.game.specialMap || null,
  });
}

// ---------------------------------------------------------------------
// v0.4.0: handleLeave — explicit vs disconnect 분기
// ---------------------------------------------------------------------
function handleLeave(socket, cause = 'unknown') {
  const ref = socketToPlayer.get(socket.id);
  if (!ref) {
    dlog('LEAVE-NOREF', `socket=${socket.id.slice(0,6)} cause=${cause}`);
    return;
  }
  socketToPlayer.delete(socket.id);
  const room = rooms[ref.code];
  if (!room) {
    dlog('LEAVE-NOROOM', `socket=${socket.id.slice(0,6)} code=${ref.code} cause=${cause}`);
    return;
  }
  const me = findPlayer(room, ref.playerId);
  if (!me) {
    dlog('LEAVE-NOPLAYER', `socket=${socket.id.slice(0,6)} code=${ref.code} cause=${cause}`);
    return;
  }
  // 이미 다른 socket으로 rejoin됐다면 (이전 socket의 disconnect가 늦게) 무시
  if (me.currentSocketId !== socket.id) {
    dlog('LEAVE-STALE', `socket=${socket.id.slice(0,6)} player=${me.playerId.slice(0,6)} current=${me.currentSocketId.slice(0,6)} cause=${cause}`);
    return;
  }

  const isExplicit = cause === 'explicit-leave';

  if (isExplicit) {
    finalizeLeave(room, me, cause);
    return;
  }

  // disconnect:* — grace
  me.disconnected = true;
  me.disconnectedAt = Date.now();
  io.to(room.code).emit('player:disconnected', { playerId: me.playerId });
  broadcastState(room);

  if (me.leaveTimer) clearTimeout(me.leaveTimer);
  me.leaveTimer = setTimeout(() => {
    if (me.disconnected) {
      dlog('LEAVE-GRACE-EXPIRED', `code=${ref.code} player=${me.playerId.slice(0,6)} cause=${cause}`);
      finalizeLeave(room, me, `grace-expired:${cause}`);
    }
  }, DISCONNECT_GRACE_MS);

  dlog('LEAVE-GRACE', `code=${ref.code} player=${me.playerId.slice(0,6)} role=${me.role} isHost=${me.isHost} cause=${cause}`);
}

function finalizeLeave(room, me, cause) {
  const inGame = !!(room.game && !room.game.ended);
  if (me.leaveTimer) {
    clearTimeout(me.leaveTimer);
    me.leaveTimer = null;
  }
  dlog('LEAVE', `code=${room.code} player=${me.playerId.slice(0,6)} role=${me.role} isHost=${me.isHost} inGame=${inGame} cause=${cause}`);

  if (inGame && me.role === 'player') {
    for (const cell of room.game.cells.values()) {
      if (cell.owner === me.playerId) cell.owner = null;
    }
    room.game.selections.delete(me.playerId);
    room.game.scores.delete(me.playerId);
    room.game.territory.delete(me.playerId);
    io.to(room.code).emit('player:left', { playerId: me.playerId });
  }

  const wasHost = me.isHost;

  // 슬롯 제거
  room.players = room.players.filter(p => p.playerId !== me.playerId);

  // 방에 아무도 안 남았으면 방 정리
  if (room.players.length === 0) {
    dlog('ROOM-DESTROYED', `code=${room.code} reason=empty cause=${cause}`);
    io.in(room.code).socketsLeave(room.code);
    if (room.gameTimer) clearTimeout(room.gameTimer);
    if (room.hintTimer) clearTimeout(room.hintTimer);
    delete rooms[room.code];
    return;
  }

  // v0.4.1: 방장이 나갔으면 권한 이양 (폭파 안 함)
  if (wasHost) {
    transferHost(room, cause);
  }

  if (!room.game) relabelTeams(room);

  // 게임 중에 활성 플레이어 1명 이하면 게임만 종료 (방은 살아있음)
  if (inGame && me.role === 'player' && activePlayersCount(room) <= 1) {
    dlog('GAME-END', `code=${room.code} reason=lone`);
    endGame(room, 'lone');
  }

  broadcastState(room);
}

// v0.4.1: 방장 권한 자동 이양
// 우선순위: 남은 플레이어 중 먼저 입장(=배열 첫 번째). 플레이어 없으면 옵저버 중 먼저.
// 이미 disconnected 상태인 사람은 후순위로 (게임 진행이 살아있는 사람한테 가도록).
function transferHost(room, cause) {
  if (room.players.length === 0) return;
  // 후보 우선순위: 1) 연결된 플레이어 2) 끊긴 플레이어 3) 연결된 옵저버 4) 끊긴 옵저버
  const tiers = [
    p => p.role === 'player'   && !p.disconnected,
    p => p.role === 'player'   &&  p.disconnected,
    p => p.role === 'observer' && !p.disconnected,
    p => p.role === 'observer' &&  p.disconnected,
  ];
  let newHost = null;
  for (const filter of tiers) {
    newHost = room.players.find(filter);
    if (newHost) break;
  }
  if (!newHost) return;

  newHost.isHost = true;
  // 새 방장은 자동 ready. 옵저버였으면 ready 무관.
  if (newHost.role === 'player') newHost.ready = true;

  // 라벨 갱신
  if (!room.game) relabelTeams(room);
  // 게임 중이라도 라벨 표시는 갱신해주는 게 좋음 (옵저버 이름 등)
  // but game.players는 게임 시작 시점 스냅샷이라 거기까지 건드리진 않음.

  io.to(room.code).emit('host:changed', {
    playerId: newHost.playerId,
    name: newHost.name,
  });
  dlog('HOST-TRANSFER', `code=${room.code} → ${newHost.playerId.slice(0,6)} role=${newHost.role} cause=${cause}`);
}

setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(rooms)) {
    const room = rooms[code];
    // v0.4.2: TTL은 lastActivity 기반. 게임 액션(cell:select 등)이 lastActivity 갱신하므로
    // 사람이 활동 중인 방은 idle 카운트 리셋됨. 진짜로 30분 동안 아무 액션 없으면 정리.
    if (now - room.lastActivity > ROOM_TTL_MS) {
      const idleMs = now - room.lastActivity;
      const ageMs = room.createdAt ? (now - room.createdAt) : 0;
      dlog('ROOM-DESTROYED', `code=${code} reason=ttl-idle idle=${Math.floor(idleMs/1000)}s age=${Math.floor(ageMs/1000)}s players=${room.players.length}`);
      io.to(code).emit('room:closed', { reason: '비활성으로 방이 종료되었습니다' });
      io.in(code).socketsLeave(code);
      room.players.forEach(p => {
        if (p.leaveTimer) clearTimeout(p.leaveTimer);
      });
      delete rooms[code];
    }
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`육각퍼즐 길찾기 server listening on :${PORT}`);
  dlog('LISTEN', `port=${PORT}`);
});
