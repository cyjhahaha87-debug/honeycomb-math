# Honeycomb Math — Server

온라인 멀티플레이용 Socket.io 서버. Node.js + Express + Socket.io.

## 로컬 실행

```bash
cd server
npm install
npm start
```

기본 포트 `3000`. 환경변수 `PORT`로 변경 가능.

## Render 배포

1. 이 `server/` 폴더를 GitHub 리포에 푸시
2. [Render Dashboard](https://dashboard.render.com)에서 **New → Web Service**
3. GitHub 리포 연결
4. 설정:
   - **Root Directory**: `server`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
5. 생성하면 `https://your-app.onrender.com` URL이 발급됨

> 무료 플랜은 15분 무트래픽 시 슬립. 첫 접속이 1분 정도 걸림.

## 클라이언트 연결

`honeycomb_math.html`의 `mockNet`을 `socketNet`으로 교체:

```js
// 1. <head>에 socket.io 클라이언트 라이브러리 추가
<script src="https://cdn.socket.io/4.8.1/socket.io.min.js"></script>

// 2. mockServer 블록 전체를 삭제하고 net 정의를 아래로 교체
const SERVER_URL = 'https://your-app.onrender.com';
const socket = io(SERVER_URL);
const net = {
  send(type, payload) { socket.emit(type, payload); },
  on(type, cb) { socket.on(type, cb); },
};
```

이게 전부. 클라이언트 다른 코드는 손 댈 필요 없음.

## 메시지 프로토콜

### 클라 → 서버

| Type | Payload | 설명 |
|---|---|---|
| `room:create` | `{}` | 새 방 만들기 |
| `room:join` | `{ code }` | 방 참가 |
| `player:setColor` | `{ color }` | 색상 변경 |
| `player:setReady` | `{ ready }` | 레디 토글 |
| `room:setMode` | `{ mode }` | 게임 모드 (방장만) |
| `room:setTime` | `{ timeLimit }` | 제한시간 (방장만, 단위: 분, 0=무제한) |
| `room:start` | `{}` | 게임 시작 (방장만) |
| `room:leave` | `{}` | 나가기 |

### 서버 → 클라

| Type | Payload | 설명 |
|---|---|---|
| `room:joined` | `{ code, myId, isHost }` | 입장 성공 |
| `room:state` | `{ code, mode, timeLimit, players }` | 방 상태 갱신 (모든 클라에게 broadcast) |
| `room:error` | `{ reason }` | 입장 실패 등 |
| `room:closed` | `{ reason }` | 방 폭파 |
| `game:start` | `{ mode, timeLimit, players, ... }` | 게임 시작 |

## TODO (게임 로직 추가 시)

- 시드 기반 맵 생성 (모든 클라가 같은 맵 그리도록)
- 칸 점령 메시지 (`cell:claim`, `cell:locked`)
- 수식 완성 판정 (서버에서)
- 게임 종료 / 승자 산정

## 데이터 보존 정책

- 모든 게임 상태는 서버 메모리에만 보관
- 방장이 나가거나 30분 비활성 시 방 폭파
- 어떤 데이터도 디스크에 저장하지 않음 (PIPA 부담 최소화)
