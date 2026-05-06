# Honeycomb Math

벌집 위 한붓그리기 수식 학습 게임. 칠판/수업용 + 반대항 온라인 멀티.

## 구조

```
honeycomb-math/
├── client/                 # 단일 HTML — 솔로 모드 + 온라인 로비 (mockNet 시뮬)
│   └── honeycomb_math.html
└── server/                 # Node + Socket.io — 온라인 멀티 서버
    ├── server.js
    ├── package.json
    └── README.md           # Render 배포 가이드
```

## 로컬 개발

### 클라이언트 (단일 모드)

`client/honeycomb_math.html` 을 브라우저로 그냥 열기. 솔로 모드는 그대로 동작하고, 온라인 모드는 mockNet으로 시뮬레이션됨.

### 클라이언트 + 서버 (온라인)

```bash
cd server
npm install
npm start
```

그 후 `client/honeycomb_math.html` 의 mockNet을 socketNet으로 교체 (`server/README.md` 참고).

## 배포

- **클라이언트**: GitHub Pages, Netlify, Render Static Site 등 정적 호스팅 어디든
- **서버**: Render Web Service (무료 티어)

자세한 배포 절차는 `server/README.md`.

## 게임 모드

- **EASY / NORMAL / HARD** — 솔로, 한 수식
- **EX1 / EX2 / EX3** — 솔로, 한 화면에 4~6 수식
- **EXEX1 / EXEX2 / EXEX3** — 솔로 100수식 또는 온라인 멀티 100수식

## 라이선스

미정.
