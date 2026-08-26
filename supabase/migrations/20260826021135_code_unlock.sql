-- ─────────────────────────────────────────────────────────────────────────────
--  CODE UNLOCK — the 4-digit lock code moves server-side.
--
--  The app sends the code; the server swaps it for the access key. So a new
--  phone needs only the code — no pasted key — and the wrong-guess cooldown
--  (every 3rd miss: 5 → 15 → 30 → 60 min) is enforced where a browser can't
--  clear it. The code itself is never stored: only a salted sha-256.
--
--  The code is seeded/changed via nathan_set_pin (service_role only), so the
--  actual digits never appear in any committed file.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto with schema extensions;

create table if not exists memory.app_lock (
  one          boolean primary key default true check (one),  -- exactly one row
  salt         text not null,
  pin_hash     text not null,                                 -- sha256(salt || code)
  fails        int  not null default 0,
  locked_until timestamptz
);

-- check a code; on success reset the slate, on a 3rd miss start a cooldown
create or replace function public.nathan_unlock(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = memory, extensions, public
as $$
declare
  r memory.app_lock%rowtype;
  n int;
  mins int;
  until_ts timestamptz;
begin
  select * into r from memory.app_lock where one for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'setup');
  end if;

  if r.locked_until is not null and r.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'locked',
      'until', r.locked_until, 'fails', r.fails);
  end if;

  if encode(digest(r.salt || p_pin, 'sha256'), 'hex') = r.pin_hash then
    update memory.app_lock set fails = 0, locked_until = null where one;
    return jsonb_build_object('ok', true);
  end if;

  n := r.fails + 1;
  if n % 3 = 0 then
    mins := (array[5, 15, 30, 60])[least(n / 3, 4)];
    until_ts := now() + make_interval(mins => mins);
    update memory.app_lock set fails = n, locked_until = until_ts where one;
    return jsonb_build_object('ok', false, 'error', 'locked', 'until', until_ts, 'fails', n);
  end if;

  update memory.app_lock set fails = n where one;
  return jsonb_build_object('ok', false, 'error', 'wrong', 'fails', n, 'left', 3 - (n % 3));
end $$;

-- set (or first-seed) the code: fresh salt, slate wiped
create or replace function public.nathan_set_pin(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = memory, extensions, public
as $$
declare
  s text;
begin
  if p_pin !~ '^\d{4}$' then
    return jsonb_build_object('ok', false, 'error', 'bad_pin');
  end if;
  s := encode(gen_random_bytes(16), 'hex');
  insert into memory.app_lock (one, salt, pin_hash, fails, locked_until)
  values (true, s, encode(digest(s || p_pin, 'sha256'), 'hex'), 0, null)
  on conflict (one) do update
    set salt = excluded.salt, pin_hash = excluded.pin_hash, fails = 0, locked_until = null;
  return jsonb_build_object('ok', true);
end $$;

-- edge functions only — never callable from a browser directly
revoke all on function public.nathan_unlock(text) from public, anon, authenticated;
revoke all on function public.nathan_set_pin(text) from public, anon, authenticated;
grant execute on function public.nathan_unlock(text) to service_role;
grant execute on function public.nathan_set_pin(text) to service_role;
