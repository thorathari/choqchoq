# 촠촠

실시간 초성퀴즈 단일 게임방입니다.

## 로컬 실행

```powershell
npm run dev
```

기본 주소는 `http://localhost:5173`입니다. 로컬 서버는 `data/store.json`을 사용합니다.

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

## 무료 플랜 메모

Supabase Free는 활성 프로젝트 제한이 있으므로, 이미 `catnyam` 프로젝트 하나만 쓰고 있다면 `choqchoq`용 프로젝트를 하나 더 만들 수 있습니다. 이미 활성 프로젝트가 2개라면 하나를 중지하거나 유료 플랜이 필요합니다.
