create extension if not exists pgcrypto;

create table if not exists public.choq_users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  username_key text not null unique,
  nickname text not null unique,
  password_hash text not null,
  password_salt text not null,
  role text not null default 'user' check (role in ('user', 'admin')),
  status text not null default 'watching' check (status in ('playing', 'watching', 'away')),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists public.choq_game_state (
  id integer primary key default 1 check (id = 1),
  phase text not null default 'waiting' check (phase in ('waiting', 'countdown', 'hosting', 'active')),
  host_id uuid references public.choq_users(id) on delete set null,
  round_id integer not null default 0 check (round_id >= 0),
  category text not null default '',
  answer text not null default '',
  chosung text not null default '',
  hints jsonb not null default '[]'::jsonb,
  guesses jsonb not null default '[]'::jsonb,
  reissue_requests uuid[] not null default '{}',
  countdown_ends_at timestamptz,
  active_started_at timestamptz,
  first_guess_deadline_at timestamptz,
  last_guess_deadline_at timestamptz,
  correct_streak_user_id uuid references public.choq_users(id) on delete set null,
  correct_streak_count integer not null default 0 check (correct_streak_count >= 0),
  answer_ban_user_id uuid references public.choq_users(id) on delete set null,
  answer_ban_round_id integer,
  last_system_message text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create table if not exists public.choq_score_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.choq_users(id) on delete cascade,
  type text not null check (type in ('ANSWER_CORRECT', 'QUESTION_SOLVED', 'HOST_TRANSFER', 'ADMIN_ADJUST')),
  points integer not null,
  round_id integer not null default 0,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.choq_chat_messages (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.choq_users(id) on delete cascade,
  message text not null check (char_length(message) between 1 and 300),
  created_at timestamptz not null default now()
);

insert into public.choq_game_state (id)
values (1)
on conflict (id) do nothing;

create index if not exists choq_users_status_idx
  on public.choq_users (status, created_at asc);

create index if not exists choq_score_events_user_created_idx
  on public.choq_score_events (user_id, created_at desc);

create index if not exists choq_score_events_created_idx
  on public.choq_score_events (created_at desc);

create index if not exists choq_chat_messages_created_idx
  on public.choq_chat_messages (created_at desc);

alter table public.choq_users enable row level security;
alter table public.choq_game_state enable row level security;
alter table public.choq_score_events enable row level security;
alter table public.choq_chat_messages enable row level security;
