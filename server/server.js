// =====================================================================
// Honeycomb Math — Online Battle Server
// =====================================================================
// 한 파일에 다 들어있음. Render에 배포할 수 있는 최소 서버.
//
// 흐름:
//   클라이언트 → socket.emit('room:create' | 'room:join' | ...)
//   서버 → io.to(roomCode).emit('room:state' | 'room:joined' | ...)
//
// 모든 게임 상태는 서버 메모리에만 있음. 서버 재시작 시 모두 휘발.
// =====================================================================

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const app = express();

// 정적 파일 서빙 — server/public/ 폴더의 모든 파일을 루트로 노출
// 즉 server/public/index.html → https://your-domain.com/ 에서 보임
app.use(express.static(path.join(__dirname, 'public')));

// 헬스 체크 — JSON 대신 루트 경로는 위 static이 처리. 따로 두려면 /health 로
app.get('/health', (req, res) => {
  res.json({ ok: true, rooms: Object.keys(rooms).length });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }, // 클라가 GitHub Pages 등 다른 도메인일 수 있음
});

// ---------------------------------------------------------------------
// 공통 상수
// ---------------------------------------------------------------------
const COLORS = ['red','blue','green','yellow','purple','orange','cyan','pink'];
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
        color: 'yellow',
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

    // 게임 시작 신호 — 실제 게임 로직은 별도 모듈에서 (TODO)
    io.to(room.code).emit('game:start', {
      mode: room.mode,
      timeLimit: room.timeLimit,
      players: room.players.map(p => ({
        id: p.id, name: p.name, color: p.color, isHost: p.isHost,
      })),
      // seed 등 게임 초기 상태는 여기에 추가
    });
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

function handleLeave(socket) {
  const ref = socketToPlayer.get(socket.id);
  if (!ref) return;
  socketToPlayer.delete(socket.id);
  const room = rooms[ref.code];
  if (!room) return;
  const me = findPlayer(room, ref.playerId);
  if (!me) return;

  // 방장이 나가면 방 폭파
  if (me.isHost) {
    io.to(room.code).emit('room:closed', { reason: '방장이 나갔습니다' });
    // 모든 소켓을 방에서 내보내기
    io.in(room.code).socketsLeave(room.code);
    delete rooms[ref.code];
    return;
  }

  room.players = room.players.filter(p => p.id !== me.id);
  relabelTeams(room);
  socket.leave(room.code);
  broadcastState(room);
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
