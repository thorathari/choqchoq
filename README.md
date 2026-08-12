# 촠촠

실시간 초성퀴즈 단일 게임방입니다.

## 로컬 실행

```powershell
npm run dev
```

기본 주소는 `http://localhost:5173`입니다. 로컬 개발 서버는 `data/store.json`을 사용합니다.

Supabase DB를 쓰는 실시간 서버를 로컬에서 확인하려면 환경변수를 설정한 뒤 아래 명령을 사용합니다.

```powershell
npm run realtime
```

기본 주소는 `http://localhost:5174`입니다.

## Vercel + Supabase 배포

온라인 배포에서는 Vercel Serverless Functions와 Supabase DB를 사용합니다.

1. Supabase에서 새 프로젝트를 만듭니다.
2. Supabase SQL Editor에서 `supabase/schema.sql` 내용을 실행합니다.
3. Vercel에서 새 프로젝트를 만들고 이 저장소/폴더를 연결합니다.
4. Vercel Project Settings > Environment Variables에 아래 값을 추가합니다.

```text
SUPABASE_URL
SUPABASE_SECRET_KEY
SESSION_SECRET
```

`SUPABASE_SECRET_KEY`는 브라우저에 노출하면 안 됩니다. Supabase service role 또는 secret key를 Vercel 환경변수에만 저장하세요.

Vercel 배포는 계속 fallback으로 동작하지만, 서버리스 특성상 채팅/버튼 반응이 느릴 수 있습니다.

## 실시간 서버 배포

빠른 게임 진행용 배포는 항상 켜져 있는 Node 서버를 사용합니다. Render, Railway, Fly.io 같은 Node 서버 호스팅에 이 저장소를 연결하고 아래처럼 설정합니다.

```text
Build Command: npm install
Start Command: npm start
```

필수 환경변수는 Vercel과 같습니다.

```text
SUPABASE_URL
SUPABASE_SECRET_KEY
SESSION_SECRET
```

커스텀 프론트엔드에서 이 서버 API를 직접 호출해야 한다면 `CORS_ORIGIN`에 허용할 도메인을 넣을 수 있습니다. 다만 가장 빠르고 안정적인 사용 방식은 실시간 서버가 제공하는 URL로 직접 접속하는 것입니다. 이 서버는 정적 화면, `/api/*`, `/events` 실시간 스트림을 한 번에 제공합니다.

실시간 서버는 라운드, 채팅, 참여 상태를 Render 서버 메모리에서 즉시 처리합니다. Supabase는 회원, 권한, 누적 점수 저장에 사용합니다. Render 무료 인스턴스가 sleep 또는 재시작되면 진행 중인 라운드와 채팅은 초기화되고, 회원과 점수 기록은 Supabase에서 다시 불러옵니다.

## 무료 플랜 메모

Supabase Free는 활성 프로젝트 제한이 있으므로, 이미 `catnyam` 프로젝트 하나만 쓰고 있다면 `choqchoq`용 프로젝트를 하나 더 만들 수 있습니다. 이미 활성 프로젝트가 2개라면 하나를 중지하거나 유료 플랜이 필요합니다.
