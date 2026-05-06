# Honeycomb Math — Server + Client

게임 클라이언트(HTML) + 멀티플레이 서버를 **한 Render 서비스에서 같이 호스팅**하는 구조.

## 폴더 구조

```
server/
├── server.js          # Node + Express + Socket.io
├── package.json
├── public/
│   └── index.html     # 게임 클라이언트 (브라우저로 접속하면 보임)
└── README.md
```

`server.js`는 두 가지 역할:
1. `public/` 폴더의 정적 파일을 루트(`/`)로 서빙 — 브라우저로 접속하면 게임 화면
2. Socket.io 서버 — 멀티플레이 통신

## 로컬 실행

```bash
cd server
npm install
npm start
```

브라우저에서 `http://localhost:3000` → 게임 시작.

## Render 배포

1. 이 폴더를 GitHub 리포에 푸시
2. [Render Dashboard](https://dashboard.render.com)에서 **New → Web Service**
3. GitHub 리포 연결
4. 설정:
   - **Root Directory**: `server`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
5. 배포되면 `https://your-app.onrender.com` URL에서 게임 즉시 플레이 가능

> 무료 플랜은 15분 무트래픽 시 슬립. 첫 접속이 1분 정도 걸림.

## 클라이언트 갱신 절차

게임 코드 수정 시:
1. `public/index.html` 수정
2. GitHub에 푸시
3. Render 자동 재배포

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
| `room:state` | `{ code, mode, timeLimit, players }` | 방 상태 갱신 (broadcast) |
| `room:error` | `{ reason }` | 입장 실패 등 |
| `room:closed` | `{ reason }` | 방 폭파 |
| `game:start` | `{ mode, timeLimit, players, ... }` | 게임 시작 |

## 데이터 보존 정책

- 모든 게임 상태는 서버 메모리에만 보관
- 방장이 나가거나 30분 비활성 시 방 폭파
- 어떤 데이터도 디스크에 저장하지 않음 (PIPA 부담 최소화)

## TODO

- 시드 기반 맵 생성 (모든 클라가 같은 맵 그리도록)
- 칸 점령 메시지 (`cell:claim`, `cell:locked`)
- 수식 완성 판정 (서버에서)
- 게임 종료 / 승자 산정
