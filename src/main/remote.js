'use strict';
/**
 * Cliente da API do Etiquetas 3D no Supabase.
 *
 * O aplicativo só chama as funções RPC public.etq_* (PostgREST). Cada função
 * confere no banco a sessão e o perfil do usuário — nada de regra de
 * permissão depende deste computador. A chave "anon" é pública por natureza:
 * sozinha ela não dá acesso a nenhum dado (as tabelas ficam num schema que a
 * API não expõe).
 */

const DEFAULT_API = {
  url: 'https://torinooficial.com.br/etiquetas-api',
  key: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXBhYmFzZSIsImlhdCI6MTc5NDQzMTQ2MCwiZXhwIjo0OTUwMTA1MDYwLCJyb2xlIjoiYW5vbiJ9.MBPVBfM7KXn8ivWk6ZdSWM-1-lCViqJnBSngjJJivWk',
};

class AppError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {() => {url: string, key: string}} getApi  endereço e chave em uso
 * @param {typeof fetch} fetchImpl  fetch do Electron (net.fetch) ou do Node
 */
function createRemote(getApi, fetchImpl) {
  async function rpc(fn, token, p = {}, timeoutMs = 60000) {
    const { url, key } = getApi();
    let res;
    try {
      res = await fetchImpl(`${url.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ p_token: token || null, p: p || {} }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new AppError('Sem conexão com o servidor. Verifique a internet e tente novamente.', 'NET');
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.ok) return data;

    const msg = data && typeof data.message === 'string' ? data.message : '';
    if (data && data.hint === 'AUTH') throw new AppError(msg || 'Sessão encerrada. Faça login novamente.', 'AUTH');
    if (data && data.code === 'P0001' && msg) throw new AppError(msg);
    if (data && data.code === '23505') throw new AppError('Já existe um registro com esses dados.');
    if (data && data.code === '23503') throw new AppError('Não é possível concluir: existem registros vinculados.');
    if ((data && data.code === 'PGRST202') || res.status === 404) {
      throw new AppError('O servidor não reconheceu esta operação. Atualize o aplicativo.');
    }
    throw new AppError(`Erro no servidor (${res.status})${msg ? `: ${msg}` : ''}. Tente novamente.`);
  }

  return { rpc };
}

module.exports = { createRemote, AppError, DEFAULT_API };
