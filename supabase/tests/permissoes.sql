-- Teste dos níveis de usuário e regras de negócio.
-- Uso: (begin; <migração>; <este arquivo>; rollback;) — nada fica gravado.
-- As chamadas são feitas como o papel "anon", o mesmo que o aplicativo usa.

insert into etiquetas.users (name, username, role, password_hash)
values ('Admin Teste', 'admin.teste', 'admin', extensions.crypt('senha123', extensions.gen_salt('bf', 4)));

create function pg_temp.call(p_fn text, p_tok text, p jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $$
declare r jsonb;
begin
  execute format('select public.%I($1, $2)', p_fn) into r using p_tok, p;
  return r;
end $$;

create function pg_temp.expect_err(p_fn text, p_tok text, p jsonb, p_pattern text)
returns void language plpgsql as $$
begin
  begin
    perform pg_temp.call(p_fn, p_tok, p);
  exception when others then
    if sqlerrm !~* p_pattern then
      raise exception '% devolveu erro inesperado: "%" (esperado ~ "%")', p_fn, sqlerrm, p_pattern;
    end if;
    return;
  end;
  raise exception '% deveria ter sido negado (esperado ~ "%")', p_fn, p_pattern;
end $$;

create function pg_temp.login(p_user text, p_pass text default 'senha123')
returns text language plpgsql as $$
declare r jsonb;
begin
  r := pg_temp.call('etq_login', null, jsonb_build_object('username', p_user, 'password', p_pass, 'host', 'PC-TESTE'));
  if r ->> 'token' is null then raise exception 'login % falhou: %', p_user, r ->> 'error'; end if;
  return r ->> 'token';
end $$;

set local role anon;

do $$
declare
  t_adm text; t_sup text; t_con text; t_ana text; t_bia text;
  r jsonb; fl jsonb; f_t text; f_1 text; f_2 text; f_3 text;
  v_lot text; v_labels jsonb; v_ana jsonb; v_sup jsonb; v_ids jsonb; v_names text[];
  on1 text; on3 text; nofl text; mine jsonb; notmine text; v_stamp1 text; v_stamp2 text; n int;
begin
  -- 1. login e andares padrão
  t_adm := pg_temp.login('admin.teste');
  r := pg_temp.call('etq_login', null, '{"username":"admin.teste","password":"errada"}');
  assert r ->> 'error' = 'Usuário ou senha inválidos.', 'senha errada deveria falhar';
  fl := pg_temp.call('etq_floors_list', t_adm);
  assert jsonb_array_length(fl) = 4, 'deveria haver 4 andares padrão';
  select max(e ->> 'id') filter (where e ->> 'code' = 'T'), max(e ->> 'id') filter (where e ->> 'code' = '1'),
         max(e ->> 'id') filter (where e ->> 'code' = '2'), max(e ->> 'id') filter (where e ->> 'code' = '3')
    into f_t, f_1, f_2, f_3 from jsonb_array_elements(fl) e;
  raise notice 'ok - login do admin e andares padrão';

  -- 2. cadastro dos 4 perfis
  v_sup := pg_temp.call('etq_users_save', t_adm, '{"name":"Sérgio Sup","username":"sup","role":"supervisor","password":"senha123"}');
  perform pg_temp.call('etq_users_save', t_adm, '{"name":"Clara Con","username":"con","role":"consulta","password":"senha123"}');
  v_ana := pg_temp.call('etq_users_save', t_adm, jsonb_build_object('name', 'Ana', 'username', 'ana', 'role', 'analista',
                        'floorIds', jsonb_build_array(f_1, f_2), 'password', 'senha123'));
  perform pg_temp.call('etq_users_save', t_adm, jsonb_build_object('name', 'Bia', 'username', 'bia', 'role', 'analista',
                        'floorIds', jsonb_build_array(f_2), 'password', 'senha123'));
  perform pg_temp.expect_err('etq_users_save', t_adm, '{"name":"Sem","username":"sem","role":"analista","floorIds":[],"password":"senha123"}', 'pelo menos um andar');
  perform pg_temp.expect_err('etq_users_save', t_adm, '{"name":"X","username":"xx1","role":"root","password":"senha123"}', 'pelo menos um andar');
  assert jsonb_array_length(v_sup -> 'floorIds') = 0, 'supervisor não tem andares';
  assert jsonb_array_length(v_ana -> 'floorIds') = 2, 'analista com 2 andares';
  raise notice 'ok - admin cria os 4 perfis (perfil inválido não vira admin)';

  -- 3. lote com etiquetas em vários andares
  v_lot := pg_temp.call('etq_lots_create', t_adm, '{"code":"L1"}') ->> 'id';
  r := pg_temp.call('etq_labels_add', t_adm, jsonb_build_object('lotId', v_lot, 'rows', jsonb_build_array(
         jsonb_build_object('code', 'C0', 'floorId', f_t), jsonb_build_object('code', 'C1', 'floorId', f_1),
         jsonb_build_object('code', 'C2', 'floorId', f_1), jsonb_build_object('code', 'C3', 'floorId', f_2),
         jsonb_build_object('code', 'C4', 'floorId', f_2), jsonb_build_object('code', 'C5', 'floorId', f_2),
         jsonb_build_object('code', 'C6', 'floorId', f_3), jsonb_build_object('code', 'C7'),
         jsonb_build_object('code', '   '))));
  assert (r ->> 'added')::int = 8, 'deveria adicionar 8 (linha sem código ignorada)';
  raise notice 'ok - lote com 8 etiquetas';

  -- 4. supervisor
  t_sup := pg_temp.login('sup');
  perform pg_temp.call('etq_dashboard', t_sup);
  r := pg_temp.call('etq_dist_auto', t_sup, jsonb_build_object('lotId', v_lot));
  assert (r ->> 'assigned')::int = 5 and (r ->> 'noFloor')::int = 1, 'distribuição: ' || r::text;
  select array_agg(e ->> 'name' order by e ->> 'name') into v_names from jsonb_array_elements(r -> 'missingFloors') e;
  assert v_names = array['3º Andar', 'Térreo'], 'andares sem analista: ' || r::text;
  perform pg_temp.call('etq_lots_create', t_sup, '{"code":"L2"}');
  v_labels := pg_temp.call('etq_lots_get', t_sup, jsonb_build_object('id', v_lot)) -> 'labels';
  select jsonb_agg(e -> 'id') into v_ids from jsonb_array_elements(v_labels) e;
  perform pg_temp.call('etq_print_payload', t_sup, jsonb_build_object('labelIds', v_ids));
  perform pg_temp.expect_err('etq_users_list', t_sup, '{}', 'administrador');
  perform pg_temp.expect_err('etq_users_save', t_sup, '{"name":"H","username":"hack","role":"admin","password":"senha123"}', 'administrador');
  perform pg_temp.expect_err('etq_settings_save', t_sup, '{}', 'administrador');
  perform pg_temp.expect_err('etq_floors_save', t_sup, '{"name":"N","code":"N"}', 'administrador');
  perform pg_temp.expect_err('etq_export', t_sup, '{}', 'administrador');
  perform pg_temp.expect_err('etq_analyst_overview', t_sup, '{}', 'permissão');
  raise notice 'ok - supervisor opera lotes e distribui, mas não mexe em usuários/configurações';

  -- 5. equilíbrio da distribuição
  select count(*) into n from jsonb_array_elements(v_labels) lb
   where lb ->> 'floorId' = f_1 and lb ->> 'analystId' = v_ana ->> 'id';
  assert n = 2, 'o 1º andar só tem a Ana';
  select count(*) into n from jsonb_array_elements(v_labels) lb
   where lb ->> 'floorId' = f_2 and lb ->> 'analystId' <> v_ana ->> 'id';
  assert n >= 2, '2º andar deveria ir majoritariamente para a Bia';
  raise notice 'ok - distribuição equilibra o 2º andar entre Ana e Bia';

  -- 6. consulta (somente leitura)
  t_con := pg_temp.login('con');
  perform pg_temp.call('etq_dashboard', t_con);
  perform pg_temp.call('etq_lots_list', t_con);
  perform pg_temp.call('etq_lots_get', t_con, jsonb_build_object('id', v_lot));
  assert exists (select 1 from jsonb_array_elements(pg_temp.call('etq_logs_list', t_con)) e where e ->> 'userName' = 'Sérgio Sup'),
    'consulta vê o histórico de todos';
  perform pg_temp.expect_err('etq_lots_create', t_con, '{"code":"L3"}', 'permissão');
  perform pg_temp.expect_err('etq_dist_auto', t_con, jsonb_build_object('lotId', v_lot), 'permissão');
  perform pg_temp.expect_err('etq_labels_delete', t_con, jsonb_build_object('ids', jsonb_build_array(v_labels -> 0 -> 'id')), 'permissão');
  perform pg_temp.expect_err('etq_print_payload', t_con, jsonb_build_object('labelIds', jsonb_build_array(v_labels -> 0 -> 'id')), 'permissão');
  perform pg_temp.expect_err('etq_mark_printed', t_con, jsonb_build_object('labelIds', jsonb_build_array(v_labels -> 0 -> 'id')), 'permissão');
  perform pg_temp.expect_err('etq_users_list', t_con, '{}', 'administrador');
  raise notice 'ok - consulta só lê';

  -- 7. analista com 2 andares
  t_ana := pg_temp.login('ana');
  r := pg_temp.call('etq_me', t_ana);
  assert (select array_agg(e ->> 'code' order by e ->> 'code') from jsonb_array_elements(r -> 'floors') e) = array['1', '2'], 'me.floors';
  r := pg_temp.call('etq_analyst_overview', t_ana);
  assert jsonb_array_length(r -> 'myFloors') = 2, 'myFloors';
  select jsonb_agg(lb) into mine from jsonb_array_elements(r -> 'lots') lo, jsonb_array_elements(lo -> 'labels') lb;
  assert jsonb_array_length(mine) >= 2, 'ana tem etiquetas';
  assert not exists (select 1 from jsonb_array_elements(mine) e where e ->> 'floorId' not in (f_1, f_2)), 'só andares da ana';
  assert (select e -> 'total' from jsonb_array_elements(r -> 'floors') e where e ->> 'code' = 'T') = 'null'::jsonb, 'não vê números de outro andar';
  select jsonb_agg(e -> 'id') into v_ids from jsonb_array_elements(mine) e;
  perform pg_temp.call('etq_print_payload', t_ana, jsonb_build_object('labelIds', v_ids));
  select e ->> 'id' into notmine from jsonb_array_elements(v_labels) e
   where e ->> 'analystId' is not null and e ->> 'analystId' <> v_ana ->> 'id' limit 1;
  perform pg_temp.expect_err('etq_print_payload', t_ana, jsonb_build_object('labelIds', jsonb_build_array(notmine)), 'só pode imprimir');
  perform pg_temp.expect_err('etq_dashboard', t_ana, '{}', 'permissão');
  perform pg_temp.expect_err('etq_lots_list', t_ana, '{}', 'permissão');
  assert not exists (select 1 from jsonb_array_elements(pg_temp.call('etq_logs_list', t_ana)) e where e ->> 'userName' <> 'Ana'),
    'analista só vê o próprio histórico';
  raise notice 'ok - analista multi-andar vê e imprime só o que é dele';

  -- 8. impressão e bloqueio de reimpressão
  r := pg_temp.call('etq_mark_printed', t_ana, jsonb_build_object('labelIds', jsonb_build_array(v_ids -> 0)));
  assert (r ->> 'count')::int = 1, 'marcou impressa';
  perform pg_temp.call('etq_settings_save', t_adm, '{"companyName":"Teste","labelWidth":100,"labelHeight":50,"allowReprint":false}');
  perform pg_temp.expect_err('etq_mark_printed', t_ana, jsonb_build_object('labelIds', jsonb_build_array(v_ids -> 0)), 'reimpressão está bloqueada');
  perform pg_temp.call('etq_mark_printed', t_sup, jsonb_build_object('labelIds', jsonb_build_array(v_ids -> 0)));
  r := pg_temp.call('etq_labels_reset_print', t_sup, jsonb_build_object('ids', jsonb_build_array(v_ids -> 0)));
  assert (r ->> 'reset')::int = 1, 'voltou para pendente';
  perform pg_temp.call('etq_mark_printed', t_ana, jsonb_build_object('labelIds', jsonb_build_array(v_ids -> 0)));
  raise notice 'ok - impressão, bloqueio de reimpressão e liberação';

  -- 9. atribuição manual com andar de destino
  select e ->> 'id' into on1 from jsonb_array_elements(v_labels) e where e ->> 'floorId' = f_1 and e ->> 'id' <> (v_ids ->> 0) limit 1;
  select e ->> 'id' into on3 from jsonb_array_elements(v_labels) e where e ->> 'floorId' = f_3;
  select e ->> 'id' into nofl from jsonb_array_elements(v_labels) e where e ->> 'floorId' is null;
  r := pg_temp.call('etq_dist_assign', t_adm, jsonb_build_object('labelIds', jsonb_build_array(on1, on3, nofl),
                    'analystId', v_ana ->> 'id', 'floorId', f_2));
  assert (r ->> 'count')::int = 3 and (r ->> 'moved')::int = 1, 'assign: ' || r::text;
  v_labels := pg_temp.call('etq_lots_get', t_adm, jsonb_build_object('id', v_lot)) -> 'labels';
  assert (select e ->> 'floorId' from jsonb_array_elements(v_labels) e where e ->> 'id' = on1) = f_1, 'andar atendido é mantido';
  assert (select e ->> 'floorId' from jsonb_array_elements(v_labels) e where e ->> 'id' = on3) = f_2, 'do 3º vai para o 2º';
  assert (select e ->> 'floorId' from jsonb_array_elements(v_labels) e where e ->> 'id' = nofl) = f_2, 'sem andar ganha o 2º';
  perform pg_temp.expect_err('etq_dist_assign', t_adm, jsonb_build_object('labelIds', jsonb_build_array(on1),
                             'analystId', v_ana ->> 'id', 'floorId', f_3), 'não atende');
  raise notice 'ok - atribuição manual respeita os andares do analista';

  -- 10. tirar um andar do analista devolve as pendentes daquele andar
  perform pg_temp.call('etq_users_save', t_adm, (v_ana - 'floorIds') || jsonb_build_object('floorIds', jsonb_build_array(f_2)));
  v_labels := pg_temp.call('etq_lots_get', t_adm, jsonb_build_object('id', v_lot)) -> 'labels';
  assert not exists (select 1 from jsonb_array_elements(v_labels) e
                     where e ->> 'analystId' = v_ana ->> 'id' and e ->> 'floorId' = f_1 and (e ->> 'printCount')::int = 0),
    'pendentes do 1º andar deveriam voltar para distribuição';
  assert exists (select 1 from jsonb_array_elements(v_labels) e where e ->> 'analystId' = v_ana ->> 'id' and e ->> 'floorId' = f_2),
    'as do 2º continuam com ela';
  raise notice 'ok - tirar um andar devolve as pendentes daquele andar';

  -- 11. andar vinculado não pode ser excluído
  perform pg_temp.expect_err('etq_floors_delete', t_adm, jsonb_build_object('id', f_2), 'usuário');
  raise notice 'ok - não exclui andar em uso';

  -- 12. editar o andar da etiqueta
  perform pg_temp.call('etq_users_save', t_adm, (v_ana - 'floorIds') || jsonb_build_object('floorIds', jsonb_build_array(f_1, f_2)));
  select e into r from jsonb_array_elements(v_labels) e where e ->> 'analystId' = v_ana ->> 'id' and e ->> 'floorId' = f_2 limit 1;
  r := pg_temp.call('etq_labels_update', t_adm, r || jsonb_build_object('floorId', f_1));
  assert r ->> 'analystId' = v_ana ->> 'id', 'mantém o analista que atende o novo andar';
  r := pg_temp.call('etq_labels_update', t_adm, r || jsonb_build_object('floorId', f_3));
  assert r ->> 'analystId' is null, 'perde o analista que não atende o novo andar';
  raise notice 'ok - editar andar da etiqueta';

  -- 13. desativado perde o acesso na hora
  perform pg_temp.call('etq_users_save', t_adm, v_sup || '{"active":false}');
  perform pg_temp.expect_err('etq_dashboard', t_sup, '{}', 'Sessão encerrada|desativado');
  perform pg_temp.expect_err('etq_users_save', t_adm,
    (pg_temp.call('etq_me', t_adm) -> 'user') || '{"active":false}', 'próprio acesso');
  raise notice 'ok - usuário desativado perde o acesso; admin não se desativa';

  -- 14. bloqueio por tentativas
  for n in 1..5 loop perform pg_temp.call('etq_login', null, '{"username":"con","password":"x"}'); end loop;
  r := pg_temp.call('etq_login', null, '{"username":"con","password":"senha123"}');
  assert r ->> 'error' like 'Muitas tentativas%', 'deveria bloquear após 5 erros: ' || r::text;
  raise notice 'ok - bloqueio após 5 senhas erradas';

  -- 15. contador de mudanças
  v_stamp1 := pg_temp.call('etq_stamp', t_adm) #>> '{}';
  perform pg_temp.call('etq_lots_create', t_adm, '{}');
  v_stamp2 := pg_temp.call('etq_stamp', t_adm) #>> '{}';
  assert v_stamp2::bigint > v_stamp1::bigint, 'stamp deveria aumentar';
  perform pg_temp.expect_err('etq_stamp', 'token-invalido-token-invalido-token-invalido', '{}', 'Sessão encerrada');
  raise notice 'ok - contador de mudanças e token inválido';

  -- 16. a API não enxerga as tabelas
  begin
    perform count(*) from etiquetas.users;
    raise exception 'anon NÃO deveria ler etiquetas.users';
  exception when insufficient_privilege then null;
  end;
  begin
    perform etiquetas.auth(t_adm);
    raise exception 'anon NÃO deveria chamar funções internas';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok - tabelas e funções internas inacessíveis pela API';

  raise notice 'TODOS OS CENÁRIOS PASSARAM';
end $$;
