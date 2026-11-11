-- ======================================================================
-- Etiquetas 3D · banco de dados (Supabase / PostgreSQL 15)
-- Migração 001 — estrutura, regras de negócio e permissões.
--
-- Segurança:
--  * Os dados ficam no schema "etiquetas", que NÃO é exposto pela API.
--  * O aplicativo acessa somente as funções public.etq_* (RPC via PostgREST).
--  * Cada função confere a sessão (token) e o perfil do usuário antes de
--    qualquer leitura ou alteração. As funções rodam como "postgres"
--    (SECURITY DEFINER) com search_path vazio.
--  * RLS ligado sem políticas: acesso direto às tabelas é negado.
--
-- Perfis: admin, supervisor, consulta (somente leitura), analista (um ou
-- mais andares; vê e imprime só o que foi distribuído para ele).
-- ======================================================================

create schema if not exists etiquetas;
comment on schema etiquetas is 'Etiquetas 3D — dados do sistema (acesso somente pelas funções public.etq_*)';
revoke all on schema etiquetas from public, anon, authenticated;

-- ---------------------------------------------------------------- tabelas
create table if not exists etiquetas.meta (
  id int primary key default 1 check (id = 1),
  version bigint not null default 0,
  updated_at timestamptz not null default now()
);
insert into etiquetas.meta (id) values (1) on conflict do nothing;

create table if not exists etiquetas.settings (
  id int primary key default 1 check (id = 1),
  company_name text not null default 'Minha Empresa',
  label_width int not null default 100,
  label_height int not null default 50,
  allow_reprint boolean not null default true,
  timezone text not null default 'America/Sao_Paulo'
);
insert into etiquetas.settings (id) values (1) on conflict do nothing;

create table if not exists etiquetas.floors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null,
  color text not null default '#22d3ee',
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists etiquetas.users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  username text not null unique,
  role text not null check (role in ('admin', 'supervisor', 'consulta', 'analista')),
  active boolean not null default true,
  password_hash text not null,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists etiquetas.user_floors (
  user_id uuid not null references etiquetas.users(id) on delete cascade,
  floor_id uuid not null references etiquetas.floors(id) on delete restrict,
  primary key (user_id, floor_id)
);

create table if not exists etiquetas.lots (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  created_by text not null default ''
);
create unique index if not exists lots_code_uq on etiquetas.lots (lower(code));

create table if not exists etiquetas.labels (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  lot_id uuid not null references etiquetas.lots(id) on delete cascade,
  code text not null,
  description text not null default '',
  address text not null default '',
  qty text not null default '',
  floor_id uuid references etiquetas.floors(id) on delete restrict,
  analyst_id uuid references etiquetas.users(id) on delete set null,
  print_count int not null default 0,
  printed_at timestamptz,
  printed_by uuid,
  printed_by_name text not null default '',
  assigned_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists labels_lot_idx on etiquetas.labels (lot_id, seq);
create index if not exists labels_analyst_idx on etiquetas.labels (analyst_id);
create index if not exists labels_floor_idx on etiquetas.labels (floor_id);

create table if not exists etiquetas.logs (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,
  user_name text not null default 'Sistema',
  action text not null,
  details text not null default '',
  host text not null default ''
);

create table if not exists etiquetas.sessions (
  token_hash bytea primary key,
  user_id uuid not null references etiquetas.users(id) on delete cascade,
  host text not null default '',
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_idx on etiquetas.sessions (user_id);

create table if not exists etiquetas.login_attempts (
  username text primary key,
  count int not null default 0,
  locked_until timestamptz
);

-- Andares padrão (somente se ainda não houver nenhum)
insert into etiquetas.floors (name, code, color, sort_order)
select * from (values ('Térreo', 'T', '#22d3ee', 0), ('1º Andar', '1', '#a78bfa', 1),
                      ('2º Andar', '2', '#f472b6', 2), ('3º Andar', '3', '#fbbf24', 3)) v
where not exists (select 1 from etiquetas.floors);

-- ---------------------------------------------------------------- utilitários
create or replace function etiquetas.err(p_msg text, p_code text default 'APP')
returns void language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = p_msg, hint = p_code;
end $$;

create or replace function etiquetas.norm(p_s text)
returns text language sql immutable set search_path = '' as $$
  select btrim(translate(lower(coalesce(p_s, '')), 'áàâãäåéèêëíìîïóòôõöúùûüçñ', 'aaaaaaeeeeiiiiooooouuuucn'))
$$;

create or replace function etiquetas.txt(p_v text, p_max int default 160)
returns text language sql immutable set search_path = '' as $$
  select left(btrim(regexp_replace(regexp_replace(coalesce(p_v, ''), '[[:cntrl:]]', ' ', 'g'), '\s+', ' ', 'g')), p_max)
$$;

create or replace function etiquetas.to_uuid(p_v text)
returns uuid language sql immutable set search_path = '' as $$
  select case when p_v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_v::uuid end
$$;

create or replace function etiquetas.to_bool(p_v jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select case jsonb_typeof(p_v)
    when 'boolean' then (p_v #>> '{}')::boolean
    when 'string' then lower(p_v #>> '{}') in ('true', '1', 'on', 'sim')
    when 'number' then (p_v #>> '{}')::numeric <> 0
  end
$$;

create or replace function etiquetas.clamp_int(p_v text, p_min int, p_max int, p_default int)
returns int language sql immutable set search_path = '' as $$
  select case when coalesce(p_v, '') ~ '^\s*-?\d+(\.\d+)?\s*$'
    then least(p_max, greatest(p_min, round(p_v::numeric)::int)) else p_default end
$$;

create or replace function etiquetas.tz()
returns text language sql stable set search_path = '' as $$
  select coalesce((select s.timezone from etiquetas.settings s where s.id = 1), 'America/Sao_Paulo')
$$;

create or replace function etiquetas.local_date(p_ts timestamptz)
returns date language sql stable set search_path = '' as $$
  select (p_ts at time zone etiquetas.tz())::date
$$;

/** Lista de ids (uuid) vinda do app, sem repetição e na ordem recebida. */
create or replace function etiquetas.ids(p jsonb, p_key text, p_max int default 50000)
returns uuid[] language plpgsql set search_path = '' as $$
declare
  v_arr jsonb := p -> p_key;
  v_ids uuid[];
begin
  if v_arr is null or jsonb_typeof(v_arr) <> 'array' or jsonb_array_length(v_arr) = 0 then
    perform etiquetas.err('Nenhuma etiqueta selecionada.');
  end if;
  if jsonb_array_length(v_arr) > p_max then
    perform etiquetas.err('Seleção muito grande.');
  end if;
  select array_agg(s.u order by s.o) into v_ids
  from (select etiquetas.to_uuid(t.x) as u, min(t.o) as o
        from jsonb_array_elements_text(v_arr) with ordinality t(x, o) group by 1) s;
  if array_position(v_ids, null) is not null then
    perform etiquetas.err('Algumas etiquetas não foram encontradas. Atualize a tela.');
  end if;
  return v_ids;
end $$;

create or replace function etiquetas.bump()
returns void language sql set search_path = '' as $$
  update etiquetas.meta set version = version + 1, updated_at = now() where id = 1;
$$;

create or replace function etiquetas.add_log(p_user_id uuid, p_user_name text, p_action text, p_details text)
returns void language sql set search_path = '' as $$
  insert into etiquetas.logs (user_id, user_name, action, details, host)
  values (p_user_id, coalesce(p_user_name, 'Sistema'), p_action, coalesce(p_details, ''),
          coalesce(current_setting('etiquetas.host', true), ''));
$$;

-- ---------------------------------------------------------------- JSON
create or replace function etiquetas.floor_json(p_f etiquetas.floors)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', p_f.id, 'name', p_f.name, 'code', p_f.code, 'color', p_f.color,
                            'order', p_f.sort_order, 'createdAt', p_f.created_at)
$$;

create or replace function etiquetas.floors_all()
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(etiquetas.floor_json(fl) order by fl.sort_order, fl.name), '[]'::jsonb) from etiquetas.floors fl
$$;

create or replace function etiquetas.user_floors_json(p_user uuid)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(etiquetas.floor_json(fl) order by fl.sort_order, fl.name), '[]'::jsonb)
  from etiquetas.floors fl join etiquetas.user_floors uf on uf.floor_id = fl.id
  where uf.user_id = p_user
$$;

create or replace function etiquetas.user_json(p_u etiquetas.users)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_u.id, 'name', p_u.name, 'username', p_u.username, 'role', p_u.role, 'active', p_u.active,
    'floorIds', coalesce((select jsonb_agg(uf.floor_id order by fl.sort_order, fl.name)
                          from etiquetas.user_floors uf join etiquetas.floors fl on fl.id = uf.floor_id
                          where uf.user_id = p_u.id), '[]'::jsonb),
    'createdAt', p_u.created_at, 'lastLoginAt', p_u.last_login_at)
$$;

create or replace function etiquetas.lot_json(p_l etiquetas.lots)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', p_l.id, 'code', p_l.code, 'description', p_l.description,
                            'createdAt', p_l.created_at, 'createdBy', p_l.created_by)
$$;

create or replace function etiquetas.label_json(p_l etiquetas.labels)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_l.id, 'lotId', p_l.lot_id, 'code', p_l.code, 'description', p_l.description, 'address', p_l.address,
    'qty', p_l.qty, 'floorId', p_l.floor_id, 'analystId', p_l.analyst_id, 'printCount', p_l.print_count,
    'printedAt', p_l.printed_at, 'printedBy', p_l.printed_by, 'printedByName', p_l.printed_by_name,
    'assignedAt', p_l.assigned_at, 'createdAt', p_l.created_at)
$$;

create or replace function etiquetas.log_json(p_g etiquetas.logs)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', p_g.id, 'at', p_g.at, 'userId', p_g.user_id, 'userName', p_g.user_name,
                            'action', p_g.action, 'details', p_g.details, 'host', p_g.host)
$$;

create or replace function etiquetas.settings_json()
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('companyName', s.company_name, 'labelWidth', s.label_width,
                            'labelHeight', s.label_height, 'allowReprint', s.allow_reprint)
  from etiquetas.settings s where s.id = 1
$$;

create or replace function etiquetas.lot_stats(p_lot uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('total', t, 'assigned', a, 'printed', pr, 'pending', t - pr,
    'status', case when t = 0 then 'Vazio' when pr = t then 'Concluído' when a = t then 'Distribuído'
                   when a > 0 then 'Parcial' else 'Aguardando distribuição' end)
  from (select count(*)::int as t, count(lb.analyst_id)::int as a,
               (count(*) filter (where lb.print_count > 0))::int as pr
        from etiquetas.labels lb where lb.lot_id = p_lot) s
$$;

create or replace function etiquetas.role_label(p_role text, p_floors uuid[])
returns text language sql stable set search_path = '' as $$
  select case p_role
    when 'admin' then 'Administrador' when 'supervisor' then 'Supervisor' when 'consulta' then 'Consulta'
    else 'Analista · ' || coalesce((select string_agg(fl.name, ', ' order by fl.sort_order, fl.name)
                                    from etiquetas.floors fl where fl.id = any(p_floors)), '')
  end
$$;

-- ---------------------------------------------------------------- sessão
/** Confere o token e (opcionalmente) o perfil. Devolve o usuário. */
create or replace function etiquetas.auth(p_token text, p_roles text[] default null)
returns etiquetas.users language plpgsql set search_path = '' as $$
declare
  v_s etiquetas.sessions;
  v_u etiquetas.users;
begin
  if p_token is null or length(p_token) < 32 then
    perform etiquetas.err('Sessão encerrada. Faça login novamente.', 'AUTH');
  end if;
  select * into v_s from etiquetas.sessions
   where token_hash = extensions.digest(p_token, 'sha256') and expires_at > now();
  if not found then
    perform etiquetas.err('Sessão encerrada. Faça login novamente.', 'AUTH');
  end if;
  select * into v_u from etiquetas.users where id = v_s.user_id;
  if not found or not v_u.active then
    perform etiquetas.err('Seu acesso foi desativado ou removido.', 'AUTH');
  end if;
  if v_s.last_seen < now() - interval '5 minutes' then
    update etiquetas.sessions set last_seen = now(), expires_at = now() + interval '12 hours'
     where token_hash = v_s.token_hash;
  end if;
  perform set_config('etiquetas.host', v_s.host, true);
  if p_roles is not null and not (v_u.role = any(p_roles)) then
    perform etiquetas.err(case when p_roles = array['admin'] then 'Acesso restrito ao administrador.'
                               else 'Seu perfil não tem permissão para esta ação.' end);
  end if;
  return v_u;
end $$;

/** Devolve para distribuição as etiquetas pendentes do usuário fora dos andares mantidos. */
create or replace function etiquetas.unassign_pending(p_user uuid, p_keep uuid[] default '{}')
returns int language plpgsql set search_path = '' as $$
declare v_n int;
begin
  update etiquetas.labels set analyst_id = null
   where analyst_id = p_user and print_count = 0
     and (floor_id is null or not (floor_id = any(p_keep)));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

/** Regras de impressão: admin/supervisor imprimem qualquer etiqueta; analista só as dele nos seus andares. */
create or replace function etiquetas.check_printable(p_u etiquetas.users, p_ids uuid[], p_for_print boolean)
returns void language plpgsql set search_path = '' as $$
declare v_n int;
begin
  select count(*) into v_n from etiquetas.labels where id = any(p_ids);
  if v_n <> cardinality(p_ids) then
    perform etiquetas.err('Algumas etiquetas não foram encontradas. Atualize a tela.');
  end if;
  if p_u.role in ('admin', 'supervisor') then return; end if;
  if p_u.role <> 'analista' then
    perform etiquetas.err('Seu perfil não tem permissão para imprimir etiquetas.');
  end if;
  if exists (select 1 from etiquetas.labels lb
             where lb.id = any(p_ids)
               and (lb.analyst_id is distinct from p_u.id
                    or not exists (select 1 from etiquetas.user_floors uf
                                   where uf.user_id = p_u.id and uf.floor_id = lb.floor_id))) then
    perform etiquetas.err('Você só pode imprimir as etiquetas distribuídas para você nos seus andares.');
  end if;
  if p_for_print
     and not (select s.allow_reprint from etiquetas.settings s where s.id = 1)
     and exists (select 1 from etiquetas.labels lb where lb.id = any(p_ids) and lb.print_count > 0) then
    perform etiquetas.err('A reimpressão está bloqueada pelo administrador. Solicite a liberação.');
  end if;
end $$;

-- ======================================================================
-- API (public.etq_*) — todas recebem (p_token text, p jsonb) e devolvem jsonb
-- ======================================================================

-- Público --------------------------------------------------------------
create or replace function public.etq_public_info(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('companyName', s.company_name, 'ok', true) from etiquetas.settings s where s.id = 1
$$;

create or replace function public.etq_login(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_username text := lower(etiquetas.txt(p ->> 'username', 40));
  v_password text := coalesce(p ->> 'password', '');
  v_host text := etiquetas.txt(p ->> 'host', 80);
  v_att etiquetas.login_attempts;
  v_u etiquetas.users;
  v_ok boolean;
  v_token text;
begin
  if v_username = '' or v_password = '' then
    return jsonb_build_object('error', 'Informe usuário e senha.');
  end if;
  select * into v_att from etiquetas.login_attempts where username = v_username;
  if found and v_att.locked_until > now() then
    return jsonb_build_object('error', format('Muitas tentativas. Aguarde %s segundos.',
                              ceil(extract(epoch from v_att.locked_until - now()))::int));
  end if;
  select * into v_u from etiquetas.users where username = v_username;
  if v_u.id is null then
    perform extensions.crypt(v_password, extensions.gen_salt('bf', 10)); -- mesmo tempo de resposta
    v_ok := false;
  else
    v_ok := extensions.crypt(v_password, v_u.password_hash) = v_u.password_hash;
  end if;
  if not v_ok then
    insert into etiquetas.login_attempts as la (username, count) values (v_username, 1)
    on conflict (username) do update set count = la.count + 1;
    update etiquetas.login_attempts set count = 0, locked_until = now() + interval '60 seconds'
     where username = v_username and count >= 5;
    return jsonb_build_object('error', 'Usuário ou senha inválidos.');
  end if;
  if not v_u.active then
    return jsonb_build_object('error', 'Usuário desativado. Procure o administrador.');
  end if;
  if v_u.role = 'analista' and not exists (select 1 from etiquetas.user_floors uf where uf.user_id = v_u.id) then
    return jsonb_build_object('error', 'Seu usuário não está vinculado a nenhum andar. Procure o administrador.');
  end if;
  delete from etiquetas.login_attempts where username = v_username;
  delete from etiquetas.sessions where expires_at < now();
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into etiquetas.sessions (token_hash, user_id, host, expires_at)
  values (extensions.digest(v_token, 'sha256'), v_u.id, v_host, now() + interval '12 hours');
  update etiquetas.users set last_login_at = now() where id = v_u.id returning * into v_u;
  perform set_config('etiquetas.host', v_host, true);
  perform etiquetas.add_log(v_u.id, v_u.name, 'Login', format('Acesso pelo computador %s', v_host));
  perform etiquetas.bump();
  return jsonb_build_object('token', v_token, 'user', etiquetas.user_json(v_u),
                            'floors', etiquetas.user_floors_json(v_u.id));
end $$;

-- Qualquer usuário logado ------------------------------------------------
create or replace function public.etq_me(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_u etiquetas.users;
begin
  v_u := etiquetas.auth(p_token);
  return jsonb_build_object('user', etiquetas.user_json(v_u), 'floors', etiquetas.user_floors_json(v_u.id));
end $$;

create or replace function public.etq_logout(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_u etiquetas.users;
begin
  v_u := etiquetas.auth(p_token);
  delete from etiquetas.sessions where token_hash = extensions.digest(p_token, 'sha256');
  perform etiquetas.add_log(v_u.id, v_u.name, 'Logout', '');
  perform etiquetas.bump();
  return 'true'::jsonb;
end $$;

create or replace function public.etq_change_password(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_u etiquetas.users; v_next text := coalesce(p ->> 'next', '');
begin
  v_u := etiquetas.auth(p_token);
  if length(v_next) < 6 then perform etiquetas.err('A nova senha precisa ter pelo menos 6 caracteres.'); end if;
  if extensions.crypt(coalesce(p ->> 'current', ''), v_u.password_hash) <> v_u.password_hash then
    perform etiquetas.err('Senha atual incorreta.');
  end if;
  update etiquetas.users set password_hash = extensions.crypt(v_next, extensions.gen_salt('bf', 10)) where id = v_u.id;
  perform etiquetas.add_log(v_u.id, v_u.name, 'Senha alterada', 'O próprio usuário alterou a senha');
  perform etiquetas.bump();
  return 'true'::jsonb;
end $$;

create or replace function public.etq_stamp(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform etiquetas.auth(p_token);
  return to_jsonb((select m.version::text from etiquetas.meta m where m.id = 1));
end $$;

create or replace function public.etq_floors_list(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform etiquetas.auth(p_token);
  return etiquetas.floors_all();
end $$;

create or replace function public.etq_settings_get(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform etiquetas.auth(p_token);
  return etiquetas.settings_json();
end $$;

create or replace function public.etq_logs_list(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_u etiquetas.users; v_q text := etiquetas.norm(p ->> 'q'); v_all boolean;
begin
  v_u := etiquetas.auth(p_token);
  v_all := v_u.role in ('admin', 'supervisor', 'consulta');
  return (select coalesce(jsonb_agg(etiquetas.log_json(g) order by g.id desc), '[]'::jsonb)
          from (select * from etiquetas.logs lg
                where (v_all or lg.user_id = v_u.id)
                  and (v_q = '' or strpos(etiquetas.norm(lg.user_name || ' ' || lg.action || ' ' || lg.details), v_q) > 0)
                order by lg.id desc limit 500) g);
end $$;

-- Impressão ---------------------------------------------------------------
create or replace function public.etq_print_payload(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_u etiquetas.users; v_ids uuid[];
begin
  v_u := etiquetas.auth(p_token, array['admin', 'supervisor', 'analista']);
  v_ids := etiquetas.ids(p, 'labelIds');
  perform etiquetas.check_printable(v_u, v_ids, coalesce(etiquetas.to_bool(p -> 'forPrint'), false));
  return jsonb_build_object(
    'settings', (select jsonb_build_object('companyName', s.company_name, 'labelWidth', s.label_width,
                                           'labelHeight', s.label_height) from etiquetas.settings s where s.id = 1),
    'labels', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', lb.id, 'code', lb.code, 'description', lb.description, 'address', lb.address, 'qty', lb.qty,
                  'floorName', coalesce(fl.name, 'Sem andar'), 'floorCode', coalesce(fl.code, '-'),
                  'lotCode', coalesce(lo.code, '-'), 'analystName', coalesce(us.name, ''),
                  'printCount', lb.print_count) order by x.o), '[]'::jsonb)
               from unnest(v_ids) with ordinality x(id, o)
               join etiquetas.labels lb on lb.id = x.id
               left join etiquetas.floors fl on fl.id = lb.floor_id
               left join etiquetas.lots lo on lo.id = lb.lot_id
               left join etiquetas.users us on us.id = lb.analyst_id));
end $$;

create or replace function public.etq_mark_printed(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_u etiquetas.users; v_ids uuid[]; v_mode text := case when p ->> 'mode' = 'pdf' then 'pdf' else 'print' end;
  v_reprinted int; v_lots text; v_floors text; v_n int; v_action text;
begin
  v_u := etiquetas.auth(p_token, array['admin', 'supervisor', 'analista']);
  v_ids := etiquetas.ids(p, 'labelIds');
  perform 1 from etiquetas.labels where id = any(v_ids) for update;
  perform etiquetas.check_printable(v_u, v_ids, true);
  select count(*) filter (where lb.print_count > 0), string_agg(distinct lo.code, ', '), string_agg(distinct fl.name, ', ')
    into v_reprinted, v_lots, v_floors
  from etiquetas.labels lb
  left join etiquetas.lots lo on lo.id = lb.lot_id
  left join etiquetas.floors fl on fl.id = lb.floor_id
  where lb.id = any(v_ids);
  update etiquetas.labels set print_count = print_count + 1, printed_at = now(), printed_by = v_u.id, printed_by_name = v_u.name
   where id = any(v_ids);
  get diagnostics v_n = row_count;
  v_action := case when v_mode = 'pdf' then 'PDF gerado' when v_reprinted > 0 then 'Reimpressão' else 'Impressão' end;
  perform etiquetas.add_log(v_u.id, v_u.name, v_action,
    format('%s etiqueta(s) · Lote %s · %s%s', v_n, coalesce(v_lots, '-'), coalesce(v_floors, 'sem andar'),
           case when v_reprinted > 0 then format(' · %s reimpressa(s)', v_reprinted) else '' end));
  perform etiquetas.bump();
  return jsonb_build_object('count', v_n);
end $$;

-- Analista ---------------------------------------------------------------
create or replace function public.etq_analyst_overview(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_u etiquetas.users; v_mine uuid[]; v_floors jsonb;
begin
  v_u := etiquetas.auth(p_token, array['analista']);
  select coalesce(array_agg(uf.floor_id), '{}') into v_mine from etiquetas.user_floors uf where uf.user_id = v_u.id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', fl.id, 'name', fl.name, 'code', fl.code, 'color', fl.color, 'order', fl.sort_order,
           'total', case when fl.id = any(v_mine) then (select count(*) from etiquetas.labels lb
                     where lb.analyst_id = v_u.id and lb.floor_id = fl.id) end,
           'printed', case when fl.id = any(v_mine) then (select count(*) from etiquetas.labels lb
                     where lb.analyst_id = v_u.id and lb.floor_id = fl.id and lb.print_count > 0) end)
         order by fl.sort_order, fl.name), '[]'::jsonb)
    into v_floors from etiquetas.floors fl;
  return jsonb_build_object(
    'floors', v_floors,
    'myFloors', (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(v_floors) e
                 where (e ->> 'id')::uuid = any(v_mine)),
    'totals', (select jsonb_build_object(
                 'total', count(*), 'printed', count(*) filter (where lb.print_count > 0),
                 'pending', count(*) filter (where lb.print_count = 0),
                 'printedToday', count(*) filter (where lb.printed_by = v_u.id
                                   and etiquetas.local_date(lb.printed_at) = etiquetas.local_date(now())))
               from etiquetas.labels lb where lb.analyst_id = v_u.id and lb.floor_id = any(v_mine)),
    'lots', (select coalesce(jsonb_agg(z.j order by z.created_at desc), '[]'::jsonb) from (
               select lo.created_at, jsonb_build_object(
                 'id', lo.id, 'code', lo.code, 'description', lo.description, 'createdAt', lo.created_at,
                 'labels', jsonb_agg(jsonb_build_object(
                    'id', lb.id, 'code', lb.code, 'description', lb.description, 'address', lb.address, 'qty', lb.qty,
                    'floorId', lb.floor_id, 'printCount', lb.print_count, 'printedAt', lb.printed_at,
                    'printedByName', lb.printed_by_name) order by lb.seq)) as j
               from etiquetas.labels lb join etiquetas.lots lo on lo.id = lb.lot_id
               where lb.analyst_id = v_u.id and lb.floor_id = any(v_mine)
               group by lo.id) z),
    'settings', etiquetas.settings_json());
end $$;

-- Painel (admin, supervisor, consulta) -----------------------------------
create or replace function public.etq_dashboard(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform etiquetas.auth(p_token, array['admin', 'supervisor', 'consulta']);
  return jsonb_build_object(
    'totals', (select jsonb_build_object(
        'lots', (select count(*) from etiquetas.lots),
        'activeLots', (select count(*) from etiquetas.lots lo where etiquetas.lot_stats(lo.id) ->> 'status' <> 'Concluído'),
        'labels', count(*), 'printed', count(*) filter (where lb.print_count > 0),
        'pending', count(*) filter (where lb.print_count = 0),
        'unassigned', count(*) filter (where lb.analyst_id is null),
        'printedToday', count(*) filter (where etiquetas.local_date(lb.printed_at) = etiquetas.local_date(now())),
        'noFloor', count(*) filter (where lb.floor_id is null),
        'analysts', (select count(*) from etiquetas.users us where us.role = 'analista' and us.active))
      from etiquetas.labels lb),
    'floors', (select coalesce(jsonb_agg(etiquetas.floor_json(fl) || jsonb_build_object(
        'total', (select count(*) from etiquetas.labels lb where lb.floor_id = fl.id),
        'printed', (select count(*) from etiquetas.labels lb where lb.floor_id = fl.id and lb.print_count > 0),
        'assigned', (select count(*) from etiquetas.labels lb where lb.floor_id = fl.id and lb.analyst_id is not null),
        'analysts', coalesce((select jsonb_agg(us.name order by us.created_at)
                              from etiquetas.users us join etiquetas.user_floors uf on uf.user_id = us.id
                              where uf.floor_id = fl.id and us.role = 'analista' and us.active), '[]'::jsonb))
      order by fl.sort_order, fl.name), '[]'::jsonb) from etiquetas.floors fl),
    'recent', (select coalesce(jsonb_agg(etiquetas.log_json(g) order by g.id desc), '[]'::jsonb)
               from (select * from etiquetas.logs lg order by lg.id desc limit 10) g));
end $$;

-- Administrador: configurações, backup, andares, usuários ------------------
create or replace function public.etq_settings_save(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_u etiquetas.users; v_s etiquetas.settings;
begin
  v_u := etiquetas.auth(p_token, array['admin']);
  update etiquetas.settings set
    company_name = coalesce(nullif(etiquetas.txt(p ->> 'companyName', 60), ''), 'Minha Empresa'),
    label_width = etiquetas.clamp_int(p ->> 'labelWidth', 30, 200, 100),
    label_height = etiquetas.clamp_int(p ->> 'labelHeight', 20, 200, 50),
    allow_reprint = coalesce(etiquetas.to_bool(p -> 'allowReprint'), false)
  where id = 1 returning * into v_s;
  perform etiquetas.add_log(v_u.id, v_u.name, 'Configurações alteradas',
    format('Etiqueta %s×%s mm · Reimpressão %s', v_s.label_width, v_s.label_height,
           case when v_s.allow_reprint then 'liberada' else 'bloqueada' end));
  perform etiquetas.bump();
  return etiquetas.settings_json();
end $$;

create or replace function public.etq_export(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_u etiquetas.users; v_out jsonb;
begin
  v_u := etiquetas.auth(p_token, array['admin']);
  v_out := jsonb_build_object(
    'app', 'Etiquetas 3D', 'schema', 1, 'exportedAt', now(), 'exportedBy', v_u.name,
    'settings', etiquetas.settings_json(),
    'floors', etiquetas.floors_all(),
    'users', (select coalesce(jsonb_agg(etiquetas.user_json(us) order by us.created_at), '[]'::jsonb) from etiquetas.users us),
    'lots', (select coalesce(jsonb_agg(etiquetas.lot_json(lo) order by lo.created_at), '[]'::jsonb) from etiquetas.lots lo),
    'labels', (select coalesce(jsonb_agg(etiquetas.label_json(lb) order by lb.seq), '[]'::jsonb) from etiquetas.labels lb),
    'logs', (select coalesce(jsonb_agg(etiquetas.log_json(lg) order by lg.id), '[]'::jsonb) from etiquetas.logs lg));
  perform etiquetas.add_log(v_u.id, v_u.name, 'Backup exportado', 'Cópia completa dos dados');
  perform etiquetas.bump();
  return v_out;
end $$;

create or replace function public.etq_floors_save(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_u etiquetas.users; v_f etiquetas.floors; v_dup etiquetas.floors;
  v_name text := etiquetas.txt(p ->> 'name', 40);
  v_code text := upper(etiquetas.txt(p ->> 'code', 6));
  v_color text := case when coalesce(p ->> 'color', '') ~* '^#[0-9a-f]{6}$' then p ->> 'color' else '#22d3ee' end;
  v_order int := etiquetas.clamp_int(p ->> 'order', -100000, 100000, 0);
  v_is_new boolean := coalesce(p ->> 'id', '') = '';
  v_id uuid := etiquetas.to_uuid(p ->> 'id');
begin
  v_u := etiquetas.auth(p_token, array['admin']);
  if v_name = '' then perform etiquetas.err('Informe o nome do andar.'); end if;
  if v_code = '' then perform etiquetas.err('Informe o código curto do andar (ex.: T, 1, 2, M).'); end if;
  select * into v_dup from etiquetas.floors fl
   where (v_is_new or fl.id <> v_id)
     and (etiquetas.norm(fl.name) = etiquetas.norm(v_name) or etiquetas.norm(fl.code) = etiquetas.norm(v_code))
   limit 1;
  if found then perform etiquetas.err(format('Já existe um andar com esse nome ou código (%s).', v_dup.name)); end if;
  if v_is_new then
    insert into etiquetas.floors (name, code, color, sort_order) values (v_name, v_code, v_color, v_order) returning * into v_f;
    perform etiquetas.add_log(v_u.id, v_u.name, 'Andar criado', v_name);
  else
    update etiquetas.floors set name = v_name, code = v_code, color = v_color, sort_order = v_order
     where id = v_id returning * into v_f;
    if not found then perform etiquetas.err('Andar não encontrado.'); end if;
    perform etiquetas.add_log(v_u.id, v_u.name, 'Andar alterado', v_name);
  end if;
  perform etiquetas.bump();
  return etiquetas.floor_json(v_f);
end $$;

create or replace function public.etq_floors_delete(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_u etiquetas.users; v_f etiquetas.floors; v_users int; v_labels int;
begin
  v_u := etiquetas.auth(p_token, array['admin']);
  select * into v_f from etiquetas.floors where id = etiquetas.to_uuid(p ->> 'id');
  if not found then perform etiquetas.err('Andar não encontrado.'); end if;
  select count(*) into v_users from etiquetas.user_floors where floor_id = v_f.id;
  select count(*) into v_labels from etiquetas.labels where floor_id = v_f.id;
  if v_users > 0 or v_labels > 0 then
    perform etiquetas.err(format('Não é possível excluir: %s usuário(s) e %s etiqueta(s) estão vinculados a este andar.', v_users, v_labels));
  end if;
  delete from etiquetas.floors where id = v_f.id;
  perform etiquetas.add_log(v_u.id, v_u.name, 'Andar excluído', v_f.name);
  perform etiquetas.bump();
  return 'true'::jsonb;
end $$;

create or replace function public.etq_users_list(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform etiquetas.auth(p_token, array['admin']);
  return (select coalesce(jsonb_agg(etiquetas.user_json(us) || jsonb_build_object('pending',
            (select count(*) from etiquetas.labels lb where lb.analyst_id = us.id and lb.print_count = 0))
          order by case when us.role = 'admin' then 0 else 1 end, us.name), '[]'::jsonb)
          from etiquetas.users us);
end $$;

create or replace function public.etq_users_save(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me etiquetas.users; v_x etiquetas.users;
  v_name text := etiquetas.txt(p ->> 'name', 80);
  v_username text := lower(etiquetas.txt(p ->> 'username', 40));
  v_role text := case when p ->> 'role' in ('admin', 'supervisor', 'consulta', 'analista') then p ->> 'role' else 'analista' end;
  v_active boolean := coalesce(etiquetas.to_bool(p -> 'active'), true);
  v_password text := coalesce(p ->> 'password', '');
  v_is_new boolean := coalesce(p ->> 'id', '') = '';
  v_id uuid := etiquetas.to_uuid(p ->> 'id');
  v_raw jsonb; v_floors uuid[] := '{}'; v_released int;
begin
  v_me := etiquetas.auth(p_token, array['admin']);
  v_raw := case when jsonb_typeof(p -> 'floorIds') = 'array' then p -> 'floorIds'
                when coalesce(p ->> 'floorId', '') <> '' then jsonb_build_array(p ->> 'floorId')
                else '[]'::jsonb end;
  if v_role = 'analista' then
    select coalesce(array_agg(distinct etiquetas.to_uuid(e)), '{}') into v_floors
      from jsonb_array_elements_text(v_raw) e where e <> '';
  end if;
  if v_name = '' then perform etiquetas.err('Informe o nome.'); end if;
  if v_username !~ '^[a-z0-9._-]{3,40}$' then
    perform etiquetas.err('Usuário deve ter de 3 a 40 caracteres (letras minúsculas, números, ponto, hífen).');
  end if;
  if v_is_new and length(v_password) < 6 then perform etiquetas.err('A senha precisa ter pelo menos 6 caracteres.'); end if;
  if v_role = 'analista' then
    if cardinality(v_floors) = 0 then perform etiquetas.err('Selecione pelo menos um andar para o analista.'); end if;
    if array_position(v_floors, null) is not null
       or (select count(*) from etiquetas.floors fl where fl.id = any(v_floors)) <> cardinality(v_floors) then
      perform etiquetas.err('Um dos andares escolhidos não existe mais. Atualize a tela.');
    end if;
  end if;
  if exists (select 1 from etiquetas.users us where us.username = v_username and (v_is_new or us.id <> v_id)) then
    perform etiquetas.err('Este nome de usuário já está em uso.');
  end if;

  if v_is_new then
    insert into etiquetas.users (name, username, role, active, password_hash)
    values (v_name, v_username, v_role, v_active, extensions.crypt(v_password, extensions.gen_salt('bf', 10)))
    returning * into v_x;
    insert into etiquetas.user_floors (user_id, floor_id) select v_x.id, unnest(v_floors);
    perform etiquetas.add_log(v_me.id, v_me.name, 'Usuário criado',
      format('%s (%s)', v_name, etiquetas.role_label(v_role, v_floors)));
  else
    select * into v_x from etiquetas.users where id = v_id for update;
    if not found then perform etiquetas.err('Usuário não encontrado.'); end if;
    if v_x.role = 'admin' and (v_role <> 'admin' or not v_active) then
      if v_x.id = v_me.id then perform etiquetas.err('Você não pode remover o seu próprio acesso de administrador.'); end if;
      if (select count(*) from etiquetas.users us where us.role = 'admin' and us.active) <= 1 then
        perform etiquetas.err('É necessário manter pelo menos um administrador ativo.');
      end if;
    end if;
    v_released := etiquetas.unassign_pending(v_x.id, case when v_active and v_role = 'analista' then v_floors else '{}'::uuid[] end);
    update etiquetas.users set name = v_name, username = v_username, role = v_role, active = v_active
     where id = v_x.id returning * into v_x;
    delete from etiquetas.user_floors where user_id = v_x.id;
    insert into etiquetas.user_floors (user_id, floor_id) select v_x.id, unnest(v_floors);
    if not v_active then delete from etiquetas.sessions where user_id = v_x.id; end if;
    perform etiquetas.add_log(v_me.id, v_me.name, 'Usuário alterado',
      format('%s (%s)%s', v_name, etiquetas.role_label(v_role, v_floors),
             case when v_released > 0 then format(' · %s etiqueta(s) pendente(s) voltaram para distribuição', v_released) else '' end));
  end if;
  perform etiquetas.bump();
  return etiquetas.user_json(v_x);
end $$;

create or replace function public.etq_users_reset_password(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_me etiquetas.users; v_x etiquetas.users; v_password text := coalesce(p ->> 'password', '');
begin
  v_me := etiquetas.auth(p_token, array['admin']);
  if length(v_password) < 6 then perform etiquetas.err('A senha precisa ter pelo menos 6 caracteres.'); end if;
  update etiquetas.users set password_hash = extensions.crypt(v_password, extensions.gen_salt('bf', 10))
   where id = etiquetas.to_uuid(p ->> 'id') returning * into v_x;
  if not found then perform etiquetas.err('Usuário não encontrado.'); end if;
  perform etiquetas.add_log(v_me.id, v_me.name, 'Senha redefinida', v_x.name);
  perform etiquetas.bump();
  return 'true'::jsonb;
end $$;

create or replace function public.etq_users_delete(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_me etiquetas.users; v_x etiquetas.users; v_released int;
begin
  v_me := etiquetas.auth(p_token, array['admin']);
  select * into v_x from etiquetas.users where id = etiquetas.to_uuid(p ->> 'id') for update;
  if not found then perform etiquetas.err('Usuário não encontrado.'); end if;
  if v_x.id = v_me.id then perform etiquetas.err('Você não pode excluir o próprio usuário.'); end if;
  if v_x.role = 'admin' and (select count(*) from etiquetas.users us
                             where us.role = 'admin' and us.active and us.id <> v_x.id) < 1 then
    perform etiquetas.err('É necessário manter pelo menos um administrador ativo.');
  end if;
  v_released := etiquetas.unassign_pending(v_x.id);
  delete from etiquetas.users where id = v_x.id;
  perform etiquetas.add_log(v_me.id, v_me.name, 'Usuário excluído',
    format('%s%s', v_x.name, case when v_released > 0 then format(' · %s etiqueta(s) voltaram para distribuição', v_released) else '' end));
  perform etiquetas.bump();
  return 'true'::jsonb;
end $$;

-- Lotes (leitura: admin/supervisor/consulta · alteração: admin/supervisor) --
create or replace function public.etq_lots_list(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform etiquetas.auth(p_token, array['admin', 'supervisor', 'consulta']);
  return (select coalesce(jsonb_agg(etiquetas.lot_json(lo) || jsonb_build_object('stats', etiquetas.lot_stats(lo.id))
                                    order by lo.created_at desc), '[]'::jsonb)
          from etiquetas.lots lo);
end $$;

create or replace function public.etq_lots_get(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_lot etiquetas.lots;
begin
  perform etiquetas.auth(p_token, array['admin', 'supervisor', 'consulta']);
  select * into v_lot from etiquetas.lots where id = etiquetas.to_uuid(p ->> 'id');
  if not found then perform etiquetas.err('Lote não encontrado.'); end if;
  return jsonb_build_object(
    'lot', etiquetas.lot_json(v_lot),
    'stats', etiquetas.lot_stats(v_lot.id),
    'labels', (select coalesce(jsonb_agg(etiquetas.label_json(lb) order by lb.seq), '[]'::jsonb)
               from etiquetas.labels lb where lb.lot_id = v_lot.id),
    'floors', etiquetas.floors_all(),
    'users', (select coalesce(jsonb_agg(jsonb_build_object(
                'id', us.id, 'name', us.name, 'role', us.role, 'active', us.active,
                'floorIds', coalesce((select jsonb_agg(uf.floor_id) from etiquetas.user_floors uf where uf.user_id = us.id), '[]'::jsonb))
              order by us.created_at), '[]'::jsonb) from etiquetas.users us));
end $$;

create or replace function public.etq_lots_create(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_u etiquetas.users; v_lot etiquetas.lots;
  v_code text := upper(etiquetas.txt(p ->> 'code', 40));
  v_desc text := etiquetas.txt(p ->> 'description', 200);
  v_prefix text; v_n int;
begin
  v_u := etiquetas.auth(p_token, array['admin', 'supervisor']);
  if v_code = '' then
    v_prefix := 'L' || to_char(now() at time zone etiquetas.tz(), 'YYYYMMDD') || '-';
    select count(*) + 1 into v_n from etiquetas.lots lo where lo.code like v_prefix || '%';
    while exists (select 1 from etiquetas.lots lo where lo.code = v_prefix || lpad(v_n::text, 2, '0')) loop
      v_n := v_n + 1;
    end loop;
    v_code := v_prefix || lpad(v_n::text, 2, '0');
  end if;
  if exists (select 1 from etiquetas.lots lo where etiquetas.norm(lo.code) = etiquetas.norm(v_code)) then
    perform etiquetas.err('Já existe um lote com este código.');
  end if;
  insert into etiquetas.lots (code, description, created_by) values (v_code, v_desc, v_u.name) returning * into v_lot;
  perform etiquetas.add_log(v_u.id, v_u.name, 'Lote criado',
    v_code || case when v_desc <> '' then ' · ' || v_desc else '' end);
  perform etiquetas.bump();
  return etiquetas.lot_json(v_lot);
end $$;

create or replace function public.etq_lots_update(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_u etiquetas.users; v_lot etiquetas.lots;
  v_code text := upper(etiquetas.txt(p ->> 'code', 40));
begin
  v_u := etiquetas.auth(p_token, array['admin', 'supervisor']);
  select * into v_lot from etiquetas.lots where id = etiquetas.to_uuid(p ->> 'id') for update;
  if not found then perform etiquetas.err('Lote não encontrado.'); end if;
  if v_code = '' then perform etiquetas.err('Informe o código do lote.'); end if;
  if exists (select 1 from etiquetas.lots lo where lo.id <> v_lot.id and etiquetas.norm(lo.code) = etiquetas.norm(v_code)) then
    perform etiquetas.err('Já existe um lote com este código.');
  end if;
  update etiquetas.lots set code = v_code, description = etiquetas.txt(p ->> 'description', 200)
   where id = v_lot.id returning * into v_lot;
  perform etiquetas.add_log(v_u.id, v_u.name, 'Lote alterado', v_code);
  perform etiquetas.bump();
  return etiquetas.lot_json(v_lot);
end $$;

create or replace function public.etq_lots_delete(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_u etiquetas.users; v_lot etiquetas.lots; v_n int;
begin
  v_u := etiquetas.auth(p_token, array['admin', 'supervisor']);
  select * into v_lot from etiquetas.lots where id = etiquetas.to_uuid(p ->> 'id') for update;
  if not found then perform etiquetas.err('Lote não encontrado.'); end if;
  select count(*) into v_n from etiquetas.labels where lot_id = v_lot.id;
  delete from etiquetas.lots where id = v_lot.id;
  perform etiquetas.add_log(v_u.id, v_u.name, 'Lote excluído', format('%s · %s etiqueta(s) removida(s)', v_lot.code, v_n));
  perform etiquetas.bump();
  return 'true'::jsonb;
end $$;

-- Etiquetas (admin/supervisor) ---------------------------------------------
create or replace function public.etq_labels_add(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_u etiquetas.users; v_lot etiquetas.lots; v_rows jsonb := p -> 'rows'; v_n int;
begin
  v_u := etiquetas.auth(p_token, array['admin', 'supervisor']);
  if v_rows is null or jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) = 0 then
    perform etiquetas.err('Nenhuma linha para importar.');
  end if;
  if jsonb_array_length(v_rows) > 20000 then perform etiquetas.err('Limite de 20.000 etiquetas por importação.'); end if;
  select * into v_lot from etiquetas.lots where id = etiquetas.to_uuid(p ->> 'lotId');
  if not found then perform etiquetas.err('Lote não encontrado.'); end if;
  insert into etiquetas.labels (lot_id, code, description, address, qty, floor_id)
  select v_lot.id, etiquetas.txt(t.r ->> 'code', 60), etiquetas.txt(t.r ->> 'description', 160),
         etiquetas.txt(t.r ->> 'address', 60), etiquetas.txt(t.r ->> 'qty', 20),
         (select fl.id from etiquetas.floors fl where fl.id = etiquetas.to_uuid(t.r ->> 'floorId'))
  from jsonb_array_elements(v_rows) with ordinality t(r, o)
  where etiquetas.txt(t.r ->> 'code', 60) <> ''
  order by t.o;
  get diagnostics v_n = row_count;
  if v_n = 0 then perform etiquetas.err('Nenhuma linha válida (o código é obrigatório).'); end if;
  perform etiquetas.add_log(v_u.id, v_u.name, 'Etiquetas adicionadas', format('%s etiqueta(s) no lote %s', v_n, v_lot.code));
  perform etiquetas.bump();
  return jsonb_build_object('added', v_n);
end $$;

create or replace function public.etq_labels_update(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_u etiquetas.users; v_l etiquetas.labels;
  v_code text := etiquetas.txt(p ->> 'code', 60);
  v_floor uuid; v_analyst uuid;
begin
  v_u := etiquetas.auth(p_token, array['admin', 'supervisor']);
  select * into v_l from etiquetas.labels where id = etiquetas.to_uuid(p ->> 'id') for update;
  if not found then perform etiquetas.err('Etiqueta não encontrada.'); end if;
  if v_code = '' then perform etiquetas.err('O código é obrigatório.'); end if;
  select fl.id into v_floor from etiquetas.floors fl where fl.id = etiquetas.to_uuid(p ->> 'floorId');
  v_analyst := v_l.analyst_id;
  if v_floor is distinct from v_l.floor_id and v_analyst is not null then
    -- Mantém o analista só se ele também atende o novo andar
    if v_floor is null or not exists (select 1 from etiquetas.user_floors uf
                                      where uf.user_id = v_analyst and uf.floor_id = v_floor) then
      v_analyst := null;
    end if;
  end if;
  update etiquetas.labels set code = v_code, description = etiquetas.txt(p ->> 'description', 160),
         address = etiquetas.txt(p ->> 'address', 60), qty = etiquetas.txt(p ->> 'qty', 20),
         floor_id = v_floor, analyst_id = v_analyst
   where id = v_l.id returning * into v_l;
  perform etiquetas.add_log(v_u.id, v_u.name, 'Etiqueta alterada', v_code);
  perform etiquetas.bump();
  return etiquetas.label_json(v_l);
end $$;

create or replace function public.etq_labels_delete(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_u etiquetas.users; v_ids uuid[]; v_n int;
begin
  v_u := etiquetas.auth(p_token, array['admin', 'supervisor']);
  v_ids := etiquetas.ids(p, 'ids');
  delete from etiquetas.labels where id = any(v_ids);
  get diagnostics v_n = row_count;
  perform etiquetas.add_log(v_u.id, v_u.name, 'Etiquetas excluídas', format('%s etiqueta(s)', v_n));
  perform etiquetas.bump();
  return jsonb_build_object('removed', v_n);
end $$;

create or replace function public.etq_labels_reset_print(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_u etiquetas.users; v_ids uuid[]; v_n int;
begin
  v_u := etiquetas.auth(p_token, array['admin', 'supervisor']);
  v_ids := etiquetas.ids(p, 'ids');
  update etiquetas.labels set print_count = 0, printed_at = null where id = any(v_ids) and print_count > 0;
  get diagnostics v_n = row_count;
  perform etiquetas.add_log(v_u.id, v_u.name, 'Reimpressão liberada', format('%s etiqueta(s) voltaram para pendente', v_n));
  perform etiquetas.bump();
  return jsonb_build_object('reset', v_n);
end $$;

-- Distribuição (admin/supervisor) -------------------------------------------
create or replace function public.etq_dist_auto(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_u etiquetas.users; v_lot etiquetas.lots; v_l etiquetas.labels;
  v_amap jsonb; v_fmap jsonb; v_load jsonb; v_cands jsonb; v_missing jsonb := '{}'::jsonb; v_missing_out jsonb;
  v_aid text; v_fid text; v_pick text; v_best int; v_c text; v_cl int;
  v_assigned int := 0; v_nofloor int := 0;
begin
  v_u := etiquetas.auth(p_token, array['admin', 'supervisor']);
  select * into v_lot from etiquetas.lots where id = etiquetas.to_uuid(p ->> 'lotId') for update;
  if not found then perform etiquetas.err('Lote não encontrado.'); end if;

  -- analistas ativos -> andares que atendem
  select coalesce(jsonb_object_agg(s.id::text, s.fl), '{}'::jsonb) into v_amap
  from (select us.id, jsonb_agg(uf.floor_id::text) as fl
        from etiquetas.users us join etiquetas.user_floors uf on uf.user_id = us.id
        where us.role = 'analista' and us.active group by us.id) s;
  -- andar -> analistas (ordem de cadastro)
  select coalesce(jsonb_object_agg(s.floor_id::text, s.ids), '{}'::jsonb) into v_fmap
  from (select uf.floor_id, jsonb_agg(us.id::text order by us.created_at, us.id) as ids
        from etiquetas.users us join etiquetas.user_floors uf on uf.user_id = us.id
        where us.role = 'analista' and us.active group by uf.floor_id) s;
  -- carga atual de cada analista neste lote
  select coalesce(jsonb_object_agg(s.analyst_id::text, s.n), '{}'::jsonb) into v_load
  from (select lb.analyst_id, count(*) as n from etiquetas.labels lb
        where lb.lot_id = v_lot.id and lb.analyst_id is not null group by lb.analyst_id) s;

  for v_l in select * from etiquetas.labels lb where lb.lot_id = v_lot.id order by lb.seq for update loop
    v_aid := v_l.analyst_id::text;
    v_fid := v_l.floor_id::text;
    -- já está com um analista ativo que atende o andar
    if v_aid is not null and v_amap ? v_aid and v_fid is not null and (v_amap -> v_aid) ? v_fid then continue; end if;
    if v_l.print_count > 0 and v_aid is not null then continue; end if;
    if v_fid is null then v_nofloor := v_nofloor + 1; continue; end if;
    v_cands := v_fmap -> v_fid;
    if v_aid is not null then
      v_load := jsonb_set(v_load, array[v_aid], to_jsonb(greatest(coalesce((v_load ->> v_aid)::int, 0) - 1, 0)));
    end if;
    if v_cands is null or jsonb_array_length(v_cands) = 0 then
      v_missing := jsonb_set(v_missing, array[v_fid], to_jsonb(coalesce((v_missing ->> v_fid)::int, 0) + 1));
      if v_aid is not null then update etiquetas.labels set analyst_id = null where id = v_l.id; end if;
      continue;
    end if;
    v_pick := null; v_best := null;
    for v_c in select jsonb_array_elements_text(v_cands) loop
      v_cl := coalesce((v_load ->> v_c)::int, 0);
      if v_pick is null or v_cl < v_best then v_pick := v_c; v_best := v_cl; end if;
    end loop;
    update etiquetas.labels set analyst_id = v_pick::uuid, assigned_at = now() where id = v_l.id;
    v_load := jsonb_set(v_load, array[v_pick], to_jsonb(coalesce((v_load ->> v_pick)::int, 0) + 1));
    v_assigned := v_assigned + 1;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(fl.name, '?'), 'count', (m.value #>> '{}')::int)
                            order by fl.sort_order, fl.name), '[]'::jsonb)
    into v_missing_out
  from jsonb_each(v_missing) m left join etiquetas.floors fl on fl.id = m.key::uuid;

  perform etiquetas.add_log(v_u.id, v_u.name, 'Distribuição automática',
    format('Lote %s · %s etiqueta(s) distribuída(s)%s%s', v_lot.code, v_assigned,
           case when v_nofloor > 0 then format(' · %s sem andar', v_nofloor) else '' end,
           case when jsonb_array_length(v_missing_out) > 0
                then ' · sem analista: ' || (select string_agg(e ->> 'name', ', ') from jsonb_array_elements(v_missing_out) e)
                else '' end));
  perform etiquetas.bump();
  return jsonb_build_object('assigned', v_assigned, 'noFloor', v_nofloor, 'missingFloors', v_missing_out);
end $$;

create or replace function public.etq_dist_assign(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_u etiquetas.users; v_a etiquetas.users; v_ids uuid[]; v_served uuid[]; v_target uuid; v_target_name text;
  v_moved int; v_n int;
begin
  v_u := etiquetas.auth(p_token, array['admin', 'supervisor']);
  v_ids := etiquetas.ids(p, 'labelIds');
  select * into v_a from etiquetas.users us
   where us.id = etiquetas.to_uuid(p ->> 'analystId') and us.role = 'analista' and us.active;
  if not found then perform etiquetas.err('Selecione um analista ativo.'); end if;
  select coalesce(array_agg(uf.floor_id order by fl.sort_order, fl.name), '{}') into v_served
    from etiquetas.user_floors uf join etiquetas.floors fl on fl.id = uf.floor_id where uf.user_id = v_a.id;
  if cardinality(v_served) = 0 then perform etiquetas.err('Este analista não está vinculado a nenhum andar.'); end if;
  -- andar de destino para etiquetas sem andar ou de um andar que o analista não atende
  if coalesce(p ->> 'floorId', '') <> '' then
    v_target := etiquetas.to_uuid(p ->> 'floorId');
    if v_target is null or not (v_target = any(v_served)) then
      perform etiquetas.err('Este analista não atende o andar escolhido.');
    end if;
  else
    v_target := v_served[1];
  end if;
  select fl.name into v_target_name from etiquetas.floors fl where fl.id = v_target;
  select count(*) into v_moved from etiquetas.labels lb
   where lb.id = any(v_ids) and lb.floor_id is not null and not (lb.floor_id = any(v_served));
  update etiquetas.labels set
    floor_id = case when floor_id is null or not (floor_id = any(v_served)) then v_target else floor_id end,
    analyst_id = v_a.id, assigned_at = now()
  where id = any(v_ids);
  get diagnostics v_n = row_count;
  perform etiquetas.add_log(v_u.id, v_u.name, 'Distribuição manual',
    format('%s etiqueta(s) para %s%s', v_n, v_a.name,
           case when v_moved > 0 then format(' · %s mudaram para %s', v_moved, v_target_name) else '' end));
  perform etiquetas.bump();
  return jsonb_build_object('count', v_n, 'moved', v_moved, 'analyst', v_a.name, 'floor', v_target_name);
end $$;

create or replace function public.etq_dist_unassign(p_token text default null, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_u etiquetas.users; v_ids uuid[]; v_n int;
begin
  v_u := etiquetas.auth(p_token, array['admin', 'supervisor']);
  v_ids := etiquetas.ids(p, 'labelIds');
  update etiquetas.labels set analyst_id = null where id = any(v_ids) and analyst_id is not null;
  get diagnostics v_n = row_count;
  perform etiquetas.add_log(v_u.id, v_u.name, 'Distribuição removida', format('%s etiqueta(s)', v_n));
  perform etiquetas.bump();
  return jsonb_build_object('count', v_n);
end $$;

-- ---------------------------------------------------------------- permissões
do $$
declare r record;
begin
  -- tabelas: RLS ligado e nenhum acesso para os papéis da API
  for r in select tablename from pg_tables where schemaname = 'etiquetas' loop
    execute format('alter table etiquetas.%I enable row level security', r.tablename);
    execute format('revoke all on etiquetas.%I from public, anon, authenticated', r.tablename);
  end loop;
  -- funções internas: ninguém além do dono
  for r in select p.oid::regprocedure as sig from pg_proc p where p.pronamespace = 'etiquetas'::regnamespace loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
  -- API: somente as funções etq_*
  for r in select p.oid::regprocedure as sig from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname like 'etq\_%' loop
    execute format('revoke all on function %s from public', r.sig);
    execute format('grant execute on function %s to anon, authenticated, service_role', r.sig);
  end loop;
end $$;
