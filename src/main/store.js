'use strict';
/**
 * Banco de dados em arquivo JSON com trava (lock) entre computadores.
 * A pasta de dados pode ser local ou uma pasta de rede compartilhada,
 * permitindo que o administrador e os analistas usem o mesmo banco.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DB_FILE = 'etiquetas-db.json';
const SCHEMA = 2;
const LOCK_STALE_MS = 20000;
const LOCK_TIMEOUT_MS = 15000;

const sab = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(sab, 0, 0, ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function emptyDb() {
  return {
    schema: SCHEMA,
    createdAt: new Date().toISOString(),
    settings: {
      companyName: 'Minha Empresa',
      labelWidth: 100,
      labelHeight: 50,
      allowReprint: true,
    },
    floors: [],
    users: [],
    lots: [],
    labels: [],
    logs: [],
  };
}

function normalize(db) {
  const base = emptyDb();
  for (const k of Object.keys(base)) if (db[k] === undefined) db[k] = base[k];
  db.settings = { ...base.settings, ...(db.settings || {}) };
  // v2: o usuário passa de um andar (floorId) para uma lista de andares (floorIds)
  for (const u of db.users) {
    if (!Array.isArray(u.floorIds)) u.floorIds = u.floorId ? [u.floorId] : [];
    delete u.floorId;
  }
  db.schema = SCHEMA;
  return db;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, DB_FILE);
    this.lockFile = path.join(dir, DB_FILE + '.lock');
    this.cache = null;
    this.cacheStamp = null;
    this.queue = Promise.resolve();
  }

  ensure() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.file)) this._write(emptyDb());
    // Confirma que a pasta permite gravação
    const probe = path.join(this.dir, `.teste-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    this.read();
  }

  stamp() {
    try {
      const s = fs.statSync(this.file);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return 'missing';
    }
  }

  _parse() {
    let err;
    for (let i = 0; i < 8; i++) {
      try {
        return normalize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      } catch (e) {
        err = e;
        sleepSync(60);
      }
    }
    if (err && err.code === 'ENOENT') throw new Error('Arquivo de dados não encontrado na pasta configurada.');
    throw new Error('Não foi possível ler o banco de dados: ' + (err ? err.message : 'erro desconhecido'));
  }

  /** Leitura (somente consulta). Não altere o objeto retornado. */
  read() {
    const st = this.stamp();
    if (this.cache && st === this.cacheStamp) return this.cache;
    const data = this._parse();
    this.cache = data;
    this.cacheStamp = st;
    return data;
  }

  /** Executa uma alteração com trava exclusiva e grava de forma atômica. */
  transact(fn) {
    const run = async () => {
      await this._lock();
      try {
        const data = this._parse();
        const result = await fn(data);
        this._write(data);
        return result;
      } finally {
        this._unlock();
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.then(() => {}, () => {});
    return p;
  }

  _write(data) {
    const tmp = `${this.file}.${os.hostname().replace(/[^\w-]/g, '')}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    let lastErr = null;
    for (let i = 0; i < 20; i++) {
      try {
        fs.renameSync(tmp, this.file);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        sleepSync(50);
      }
    }
    if (lastErr) {
      try { fs.unlinkSync(tmp); } catch {}
      throw lastErr;
    }
    this.cache = data;
    this.cacheStamp = this.stamp();
  }

  async _lock() {
    const start = Date.now();
    for (;;) {
      try {
        fs.writeFileSync(this.lockFile, `${os.hostname()}|${process.pid}|${new Date().toISOString()}`, { flag: 'wx' });
        return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          const st = fs.statSync(this.lockFile);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            fs.unlinkSync(this.lockFile);
            continue;
          }
        } catch {}
        if (Date.now() - start > LOCK_TIMEOUT_MS) {
          throw new Error('O banco de dados está ocupado por outro computador. Tente novamente em instantes.');
        }
        await sleep(30 + Math.random() * 70);
      }
    }
  }

  _unlock() {
    try { fs.unlinkSync(this.lockFile); } catch {}
  }

  /** Cópia de segurança diária (mantém as 30 mais recentes). */
  backup() {
    try {
      const dir = path.join(this.dir, 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const target = path.join(dir, `etiquetas-db-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`);
      if (!fs.existsSync(target) && fs.existsSync(this.file)) fs.copyFileSync(this.file, target);
      const files = fs.readdirSync(dir).filter((f) => /^etiquetas-db-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      while (files.length > 30) {
        try { fs.unlinkSync(path.join(dir, files.shift())); } catch {}
      }
    } catch {
      /* backup não é crítico */
    }
  }
}

module.exports = { Store, DB_FILE };
