alter table public.meta_config add column if not exists token_expires_at bigint;
alter table public.meta_config add column if not exists user_name text;