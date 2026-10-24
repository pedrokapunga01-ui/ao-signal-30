'use strict';

/**
 * CAPUNGA DADOS — BAC BO · v7
 *
 *  - Sinais até GALE 1 (2 tentativas).
 *  - Confiança HONESTA: limite inferior de Wilson (95%+) da taxa de acerto do padrão,
 *    medida no histórico guardado. Não existe estratégia 100% neste jogo; este número
 *    nunca é forçado nem arredondado para cima.
 *  - Só emite padrões com amostra mínima e com evidência; padrões que estejam a falhar
 *    ao vivo são suspensos automaticamente.
 *  - Empate = GREEN, identificado com o gale em que ocorreu, a soma e o multiplicador da mesa.
 *    (O empate só paga a quem cobriu o empate — a mensagem avisa.)
 *  - A mensagem de GALE é APAGADA do canal quando o sinal fecha (Green/Red/Cancelado).
 *  - Fila de Telegram com retry (nenhuma mensagem se perde).
 *
 * Variáveis: BOT_TOKEN, CHAT_ID (obrigatórias p/ enviar) · DATABASE_URL (opcional)
 *  ADMIN_TOKEN · INTERVALO_SINAL_MS (180000) · MIN_CONFIANCA (76) · MIN_AMOSTRA (150) · CONSENSO_MIN (2)
 *  SYNC_MS (4000) · SINAL_EXPIRA_MIN (8) · SINAL_INICIAL (1704) · SINAIS_ATIVOS · API_BACBO
 *  O bot precisa de ser ADMIN do canal com permissão de apagar mensagens.
 */

const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

/* ============================ CONFIG ============================ */

const num = (name, def, min, max) => {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
};
const bool = (v, def) =>
  v === undefined || v === '' ? def : ['true', '1', 'yes', 'sim', 'on'].includes(String(v).trim().toLowerCase());

const PORT = Number(process.env.PORT || 10000);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL || '';
const API_BACBO =
  process.env.API_BACBO || 'https://api-cs.casino.org/svc-evolution-game-events/api/bacbo';

const MAX_GALE = 1; // fixo: sinais vão até Gale 1
const CFG = {
  ativos: bool(process.env.SINAIS_ATIVOS, true),
  intervaloSinalMs: num('INTERVALO_SINAL_MS', 180000, 0, 3600000),
  minConf: num('MIN_CONFIANCA', 76, 0, 99),
  consensoMin: num('CONSENSO_MIN', 2, 1, 6),
  minAmostra: num('MIN_AMOSTRA', 150, 20, 5000),
  syncMs: num('SYNC_MS', 4000, 2000, 30000),
  expiraMin: num('SINAL_EXPIRA_MIN', 8, 3, 120),
  sinalInicial: num('SINAL_INICIAL', 1704, 1, 100000000),
  maxHist: 4000,
  gapMs: 6 * 60 * 1000, // buraco entre rodadas que quebra a sequência
  frescoMs: 5 * 60 * 1000 // rodada mais recente tem de ser "viva" para gerar sinal
};

const J = 'Jogador';
const B = 'Banca';
const E = 'Empate';
const isCol = (x) => x === J || x === B;
const opp = (c) => (c === J ? B : c === B ? J : null);

/* ============================ ESTADO ============================ */

const S = {
  hist: [], // rodadas, ordem cronológica
  seen: new Set(),
  signals: [], // sinais recentes, ordem cronológica
  nextId: CFG.sinalInicial,
  lastSignalAt: 0,
  stats: null,
  statsAtLen: -1
};

const R = {
  iniciadoEm: new Date().toISOString(),
  ultimaSync: null,
  ultimaRodadaNova: null,
  novosUltimoCiclo: 0,
  ciclosSemNovos: 0,
  erroAPI: null,
  erroDB: null,
  erroTelegram: null,
  ultimoMotivo: null,
  ultimoSinal: null,
  telegramPendentes: 0
};

let pool = null;
let server = null;
let timer = null;
let busy = false;
let stopping = false;

/* ============================ UTILS ============================ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(tag, data) {
  const p = typeof data === 'string' ? data : JSON.stringify(data);
  console.log(`[${new Date().toISOString()}] [${tag}] ${p}`);
}

const fmtHora = new Intl.DateTimeFormat('pt-PT', {
  timeZone: 'Africa/Luanda',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});
const fmtDia = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Luanda',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
const hora = (ms = Date.now()) => fmtHora.format(new Date(ms));
const dia = (ms = Date.now()) => fmtDia.format(new Date(ms));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const corTxt = (c) => (c === B ? '🔴 <b>BANCA</b>' : c === J ? '🔵 <b>JOGADOR</b>' : '🟡 <b>EMPATE</b>');
const corCurta = (c) => (c === B ? '🔴 Banca' : c === J ? '🔵 Jogador' : '🟡 Empate');
const barra = (c) => {
  const f = Math.max(0, Math.min(10, Math.round(c / 10)));
  return '▰'.repeat(f) + '▱'.repeat(10 - f);
};

/* ============================ API / NORMALIZAÇÃO ============================ */

function normalizeOutcome(v) {
  if (v && typeof v === 'object') v = v.outcome ?? v.resultado ?? v.winner ?? v.name;
  const s = String(v ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  if (['player', 'jogador', 'playerwin', 'playerwins', 'playerwon', 'playerwinner', 'blue'].includes(s)) return J;
  if (['banker', 'banca', 'bankerwin', 'bankerwins', 'bankerwon', 'bankerwinner', 'red', 'vermelho'].includes(s)) return B;
  if (['tie', 'draw', 'empate', 'equal', 'push', 'tied'].includes(s)) return E;
  return null;
}

function validMs(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

function extractItems(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  const c = [
    body.data, body.results, body.items, body.resultados, body.rounds, body.events,
    body.data?.results, body.data?.items, body.data?.resultados, body.data?.rounds,
    body.data?.events, body.data?.data
  ];
  return c.find(Array.isArray) || [];
}

function normalizeRound(item) {
  const d = item?.data || item?.round || item || {};
  const r = d.result && typeof d.result === 'object'
    ? d.result
    : item?.result && typeof item.result === 'object' ? item.result : {};

  const status = String(d.status ?? d.estado ?? item?.status ?? item?.estado ?? '').toLowerCase();
  const t = validMs(
    d.settledAt ?? d.endTime ?? d.endedAt ?? d.finishedAt ?? d.fim ?? item?.settledAt ?? item?.fim
  );

  const raw =
    r.outcome ?? r.resultado ?? r.winner ??
    d.outcome ?? d.resultado ?? d.winner ??
    item?.outcome ?? item?.resultado ?? item?.winner ??
    (typeof d.result === 'string' ? d.result : null) ??
    (typeof item?.result === 'string' ? item.result : null);

  const resultado = normalizeOutcome(raw);
  const resolvida =
    ['resolved', 'settled', 'finished', 'complete', 'completed', 'resolvido', 'concluido', 'finalizado']
      .some((w) => status.includes(w)) || Boolean(t);

  const id = String(
    d.id ?? d.roundId ?? d.round_id ?? d.eventId ??
    item?.id ?? item?.roundId ?? item?.round_id ?? item?.eventId ?? ''
  ).trim();

  if (!id || !resultado || !resolvida || !t) return null;

  const pj = Number(r.playerDice?.score ?? d.playerDice?.score ?? d.playerScore ?? d.player_score ?? d.pontos_jogador);
  const pb = Number(r.bankerDice?.score ?? d.bankerDice?.score ?? d.bankerScore ?? d.banker_score ?? d.pontos_banca);
  const mult = r.multiplier ?? d.multiplier ?? d.multiplicador ?? null;

  return {
    id,
    resultado,
    t,
    pj: Number.isFinite(pj) ? pj : null,
    pb: Number.isFinite(pb) ? pb : null,
    mult: mult == null ? null : String(mult)
  };
}

async function fetchRounds() {
  let last = null;
  for (let i = 1; i <= 3; i++) {
    try {
      const resp = await axios.get(API_BACBO, {
        timeout: 15000,
        headers: { Accept: 'application/json', 'User-Agent': 'CapungaDadosBot/6.0' }
      });
      const map = new Map();
      for (const it of extractItems(resp.data)) {
        const rd = normalizeRound(it);
        if (rd) map.set(rd.id, rd);
      }
      R.erroAPI = null;
      return [...map.values()].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
    } catch (e) {
      last = e;
      R.erroAPI = e.message;
      if (i < 3) await sleep(600 * i);
    }
  }
  throw last || new Error('Falha na API');
}

/* ============================ ESTRATÉGIAS ============================ */
/* Cada estratégia recebe `ctx` (rodadas mais recentes primeiro) e devolve
   { cor, key, nome, emoji } ou null. `key` identifica o "setup" para o backtest. */

function streak(seq) {
  if (!seq.length) return 0;
  let n = 0;
  for (const r of seq) {
    if (r.resultado === seq[0].resultado) n++;
    else break;
  }
  return n;
}

const hasScore = (r) => r && Number.isFinite(r.pj) && Number.isFinite(r.pb);
const margem = (r) => Math.abs(r.pj - r.pb);
const scoreVencedor = (r) => (r.resultado === J ? r.pj : r.pb);

const STRATS = [
  // ---------- padrões de cor ----------
  function repeticao({ seq }) {
    const n = streak(seq);
    if (n < 3 || n > 8) return null;
    return { cor: seq[0].resultado, key: `REPETICAO_${Math.min(n, 6)}`, nome: `Repetição x${n}`, emoji: '🔁' };
  },
  function quebra({ seq }) {
    const n = streak(seq);
    if (n < 4 || n > 9) return null;
    return { cor: opp(seq[0].resultado), key: `QUEBRA_${Math.min(n, 7)}`, nome: `Quebra de sequência x${n}`, emoji: '💥' };
  },
  function surf({ seq }) {
    if (seq.length < 4) return null;
    let L = 1;
    while (L < seq.length && seq[L].resultado !== seq[L - 1].resultado) L++;
    if (L < 4) return null;
    return { cor: opp(seq[0].resultado), key: `SURF_${Math.min(L, 6)}`, nome: `Surf (alternância ${L})`, emoji: '🌊' };
  },
  function doisDois({ seq }) {
    if (seq.length < 4) return null;
    const [a, b, c, d] = seq.map((x) => x.resultado);
    if (a === b && c === d && a !== c) {
      return { cor: c, key: 'DOIS_DOIS', nome: '2+2 (blocos de dois)', emoji: '♟️' };
    }
    return null;
  },
  function tresUm({ seq }) {
    if (seq.length < 4) return null;
    const [a, b, c, d] = seq.map((x) => x.resultado);
    if (a !== b && b === c && c === d) {
      return { cor: a, key: 'TRES_UM', nome: 'Quebra confirmada (3→1)', emoji: '🧩' };
    }
    return null;
  },
  function forca({ seq }) {
    const s = seq.slice(0, 12);
    if (s.length < 10) return null;
    const j = s.filter((x) => x.resultado === J).length;
    const pj = j / s.length;
    const dom = pj >= 0.5 ? J : B;
    const pct = Math.max(pj, 1 - pj);
    if (pct < 0.67) return null;
    const bucket = pct >= 0.75 ? 75 : pct >= 0.7 ? 70 : 67;
    return { cor: dom, key: `FORCA_${bucket}`, nome: `Força da mesa ${Math.round(pct * 100)}%`, emoji: '💪' };
  },
  function reversao({ seq }) {
    const s = seq.slice(0, 20);
    if (s.length < 16) return null;
    const j = s.filter((x) => x.resultado === J).length;
    const pj = j / s.length;
    const pct = Math.max(pj, 1 - pj);
    if (pct < 0.65) return null;
    const dom = pj >= 0.5 ? J : B;
    return { cor: opp(dom), key: 'REVERSAO_20', nome: `Retorno à média (${Math.round(pct * 100)}% ${dom})`, emoji: '⚖️' };
  },

  // ---------- numéricas (pontos dos dados) ----------
  function numMargem({ rows }) {
    const r = rows[0];
    if (!r || !isCol(r.resultado) || !hasScore(r)) return null;
    if (margem(r) < 5) return null;
    return { cor: r.resultado, key: 'NUM_MARGEM_5', nome: `Numérica · margem ${r.pj}×${r.pb}`, emoji: '🔢' };
  },
  function numMargem3({ seq }) {
    if (seq.length < 3) return null;
    const t = seq.slice(0, 3);
    if (!t.every((r) => hasScore(r) && margem(r) >= 3 && r.resultado === t[0].resultado)) return null;
    return { cor: t[0].resultado, key: 'NUM_MARGEM_3X', nome: 'Numérica · 3 vitórias com margem ≥3', emoji: '📐' };
  },
  function numFraca({ seq }) {
    if (seq.length < 2) return null;
    const [a, b] = seq;
    if (!hasScore(a) || !hasScore(b)) return null;
    if (a.resultado !== b.resultado) return null;
    if (scoreVencedor(a) > 6 || scoreVencedor(b) > 6) return null;
    return { cor: opp(a.resultado), key: 'NUM_FRACA', nome: 'Numérica · 2 vitórias fracas (≤6)', emoji: '📉' };
  },
  function numAlta({ rows }) {
    const r = rows[0];
    if (!r || !isCol(r.resultado) || !hasScore(r)) return null;
    if (scoreVencedor(r) < 11 || margem(r) < 3) return null;
    return { cor: r.resultado, key: 'NUM_ALTA_11', nome: `Numérica · vitória forte ${r.pj}×${r.pb}`, emoji: '🚀' };
  },
  function numTendencia({ rows }) {
    const s = rows.slice(0, 6).filter(hasScore);
    if (s.length < 6) return null;
    const mj = s.reduce((a, r) => a + r.pj, 0) / s.length;
    const mb = s.reduce((a, r) => a + r.pb, 0) / s.length;
    const diff = mj - mb;
    if (Math.abs(diff) < 1.3) return null;
    return {
      cor: diff > 0 ? J : B,
      key: `NUM_TEND_${Math.abs(diff) >= 2 ? 2 : 1}`,
      nome: `Numérica · média de pontos ${mj.toFixed(1)}×${mb.toFixed(1)}`,
      emoji: '📊'
    };
  },
  function numPosEmpate({ rows, seq }) {
    if (!rows[0] || rows[0].resultado !== E || !seq.length) return null;
    return { cor: seq[0].resultado, key: 'NUM_POS_EMPATE', nome: 'Numérica · pós-empate (cor anterior)', emoji: '🎯' };
  }
];

function runStrategies(rows) {
  const ctx = { rows, seq: rows.filter((r) => isCol(r.resultado)) };
  const out = [];
  for (const fn of STRATS) {
    try {
      const c = fn(ctx);
      if (c && isCol(c.cor)) out.push(c);
    } catch (_) { /* estratégia com dados em falta: ignora */ }
  }
  return out;
}

/* ============================ BACKTEST / CONFIANÇA ============================ */

/** janela de rodadas (mais recente primeiro) a terminar no índice i, sem atravessar buracos */
function windowAt(H, i) {
  const rows = [];
  for (let j = i; j >= 0 && rows.length < 24; j--) {
    if (rows.length && rows[rows.length - 1].t - H[j].t > CFG.gapMs) break;
    rows.push(H[j]);
  }
  return rows;
}

/** true = ganhou dentro de Gale 2 (empate conta como green) · false = red · null = sem dados */
function evalEntry(H, i, cor) {
  for (let k = 0; k <= MAX_GALE; k++) {
    const idx = i + 1 + k;
    if (idx >= H.length) return null;
    if (H[idx].t - H[idx - 1].t > CFG.gapMs) return null;
    const r = H[idx].resultado;
    if (r === E || r === cor) return true;
  }
  return false;
}

function backtest() {
  const H = S.hist;
  const per = {};
  let bw = 0;
  let bn = 0;

  for (let i = 8; i < H.length - 1; i++) {
    const win = windowAt(H, i);
    if (win.length < 6) continue;

    for (const cor of [J, B]) {
      const v = evalEntry(H, i, cor);
      if (v === null) continue;
      bn++;
      if (v) bw++;
    }

    for (const c of runStrategies(win)) {
      const v = evalEntry(H, i, c.cor);
      if (v === null) continue;
      const p = per[c.key] || (per[c.key] = { n: 0, w: 0 });
      p.n++;
      if (v) p.w++;
    }
  }

  return { per, baseRate: bn ? bw / bn : null, baseN: bn };
}

function getStats() {
  if (!S.stats || S.hist.length - S.statsAtLen >= 20) {
    S.stats = backtest();
    S.statsAtLen = S.hist.length;
  }
  return S.stats;
}

/** Limite inferior de Wilson (z=2 ≈ 97,7% unilateral): penaliza amostras pequenas e a "maldição do vencedor"
 *  (escolher o melhor de vários padrões infla a taxa observada). */
function wilsonLB(w, n, z = 2) {
  if (!n) return 0;
  const p = w / n;
  const z2 = z * z;
  const c = p + z2 / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return (c - m) / (1 + z2 / n);
}

function confOf(st, key) {
  const e = st.per[key] || { n: 0, w: 0 };
  return {
    conf: e.n >= CFG.minAmostra ? Math.min(99, Math.floor(wilsonLB(e.w, e.n) * 100)) : 0,
    n: e.n,
    taxa: e.n ? Math.round((e.w / e.n) * 100) : 0
  };
}

/** suspende padrões que estão a falhar ao vivo (últimas 6h, mínimo 12 sinais fechados, <70% de acerto) */
function suspensoAoVivo(key) {
  const desde = Date.now() - 6 * 3600 * 1000;
  const L = S.signals.filter((x) => x.key === key && FECHADOS.includes(x.estado) && x.criadoMs >= desde).slice(-20);
  if (L.length < 12) return false;
  return L.filter((x) => x.estado !== 'LOSS').length / L.length < 0.7;
}

function pickEntry(rows) {
  const st = getStats();
  const cands = runStrategies(rows)
    .map((c) => {
      const e = confOf(st, c.key);
      return { ...c, confianca: e.conf, amostra: e.n, taxa: e.taxa };
    })
    .filter((c) => c.confianca >= CFG.minConf && !suspensoAoVivo(c.key));

  if (!cands.length) return null;

  const grupos = { [J]: [], [B]: [] };
  for (const c of cands) grupos[c.cor].push(c);

  const best = (arr) => (arr.length ? Math.max(...arr.map((c) => c.confianca)) + 1.0 * (arr.length - 1) : -1);
  const sJ = best(grupos[J]);
  const sB = best(grupos[B]);

  if (sJ >= 0 && sB >= 0 && Math.abs(sJ - sB) < 1.5) return { conflito: true };

  const arr = sJ > sB ? grupos[J] : grupos[B];
  arr.sort((a, b) => b.confianca - a.confianca || b.amostra - a.amostra);
  if (arr.length < CFG.consensoMin) return null; // exige vários padrões na mesma cor
  return { ...arr[0], consenso: arr.length };
}

/* ============================ BASE DE DADOS (opcional) ============================ */

let dbChain = Promise.resolve();
function dbq(fn) {
  if (!pool) return;
  dbChain = dbChain
    .then(fn)
    .catch((e) => {
      R.erroDB = e.message;
      log('DB_ERRO', e.message);
    });
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bb_rodadas (
      id TEXT PRIMARY KEY,
      resultado TEXT NOT NULL,
      fim TIMESTAMPTZ NOT NULL,
      pj INTEGER, pb INTEGER, mult TEXT
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bb_rodadas_fim ON bb_rodadas (fim DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bb_sinais (
      id BIGINT PRIMARY KEY,
      criado_em TIMESTAMPTZ NOT NULL,
      cor TEXT NOT NULL,
      estrategia TEXT, nome TEXT,
      confianca INTEGER,
      estado TEXT NOT NULL,
      gale INTEGER NOT NULL DEFAULT 0,
      empate BOOLEAN NOT NULL DEFAULT FALSE,
      resultado_final TEXT,
      resolvido_em TIMESTAMPTZ,
      base_id TEXT
    )`);
  await pool.query(`ALTER TABLE bb_sinais ADD COLUMN IF NOT EXISTS empate_gale INTEGER`);
  await pool.query(`ALTER TABLE bb_sinais ADD COLUMN IF NOT EXISTS empate_mult TEXT`);
  await pool.query(`ALTER TABLE bb_sinais ADD COLUMN IF NOT EXISTS taxa INTEGER`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bb_sinais_criado ON bb_sinais (criado_em DESC)`);
}

async function loadFromDB() {
  const rr = await pool.query(
    `SELECT id, resultado, fim, pj, pb, mult FROM bb_rodadas ORDER BY fim DESC LIMIT $1`,
    [CFG.maxHist]
  );
  S.hist = rr.rows
    .map((x) => ({ id: x.id, resultado: x.resultado, t: new Date(x.fim).getTime(), pj: x.pj, pb: x.pb, mult: x.mult }))
    .sort((a, b) => a.t - b.t);
  S.seen = new Set(S.hist.map((x) => x.id));

  const sr = await pool.query(
    `SELECT * FROM bb_sinais WHERE criado_em >= NOW() - INTERVAL '36 hours' ORDER BY id ASC`
  );
  S.signals = sr.rows.map((x) => ({
    id: Number(x.id),
    criadoMs: new Date(x.criado_em).getTime(),
    cor: x.cor,
    key: x.estrategia,
    nome: x.nome,
    confianca: x.confianca,
    estado: x.estado,
    gale: x.gale,
    empate: x.empate,
    empateGale: x.empate_gale,
    empateMult: x.empate_mult,
    taxa: x.taxa,
    resultadoFinal: x.resultado_final,
    resolvidoMs: x.resolvido_em ? new Date(x.resolvido_em).getTime() : null,
    baseId: x.base_id
  }));

  const mx = await pool.query(`SELECT COALESCE(MAX(id), 0)::bigint AS m FROM bb_sinais`);
  const m = Number(mx.rows[0].m);
  S.nextId = m > 0 ? m + 1 : CFG.sinalInicial;

  // sinais que ficaram abertos num reinício não podem ser resolvidos com rodadas antigas
  for (const s of S.signals) {
    if (s.estado === 'PENDENTE') {
      s.estado = 'CANCELADO';
      s.resolvidoMs = Date.now();
      dbSaveSignal(s);
    }
  }
  const lastS = S.signals[S.signals.length - 1];
  if (lastS) S.lastSignalAt = lastS.criadoMs;
}

function dbSaveRound(r) {
  dbq(() =>
    pool.query(
      `INSERT INTO bb_rodadas (id, resultado, fim, pj, pb, mult) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [r.id, r.resultado, new Date(r.t), r.pj, r.pb, r.mult]
    )
  );
}

function dbSaveSignal(s) {
  dbq(() =>
    pool.query(
      `INSERT INTO bb_sinais (id, criado_em, cor, estrategia, nome, confianca, estado, gale, empate, resultado_final, resolvido_em, base_id, empate_gale, empate_mult, taxa)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET
         estado = EXCLUDED.estado, gale = EXCLUDED.gale, empate = EXCLUDED.empate,
         resultado_final = EXCLUDED.resultado_final, resolvido_em = EXCLUDED.resolvido_em,
         empate_gale = EXCLUDED.empate_gale, empate_mult = EXCLUDED.empate_mult`,
      [
        s.id, new Date(s.criadoMs), s.cor, s.key, s.nome, s.confianca, s.estado, s.gale,
        Boolean(s.empate), s.resultadoFinal || null, s.resolvidoMs ? new Date(s.resolvidoMs) : null, s.baseId || null,
        s.empateGale ?? null, s.empateMult ?? null, s.taxa ?? null
      ]
    )
  );
}

/* ============================ TELEGRAM (fila + retry + apagar) ============================ */

const tgQueue = [];
let tgRunning = false;

const stripHtml = (t) =>
  t.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function tgCall(method, payload) {
  if (!BOT_TOKEN || !CHAT_ID) {
    R.erroTelegram = 'BOT_TOKEN ou CHAT_ID não configurado';
    return { ok: true, skipped: true };
  }
  try {
    const resp = await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
      { chat_id: CHAT_ID, ...payload },
      { timeout: 15000 }
    );
    if (resp.data?.ok === true) {
      R.erroTelegram = null;
      return { ok: true, result: resp.data.result };
    }
    R.erroTelegram = JSON.stringify(resp.data);
    return { ok: false };
  } catch (e) {
    const data = e.response?.data;
    R.erroTelegram = data ? JSON.stringify(data) : e.message;
    const status = e.response?.status;
    if (status === 429) return { ok: false, retryAfter: Number(data?.parameters?.retry_after) || 5 };
    if (status === 400 && /parse entities/i.test(String(data?.description))) return { ok: false, parseError: true };
    if (status === 400 && method === 'deleteMessage') return { ok: true, gone: true }; // já apagada / sem permissão
    return { ok: false };
  }
}

async function tgPost(text, plain = false) {
  const payload = { text: plain ? stripHtml(text) : text, disable_web_page_preview: true };
  if (!plain) payload.parse_mode = 'HTML';
  return tgCall('sendMessage', payload);
}

async function tgRun() {
  tgRunning = true;
  while (tgQueue.length) {
    const m = tgQueue[0];

    if (m.kind === 'delete') {
      for (const id of [...(m.sig.galeMsgIds || [])]) {
        for (let t = 0; t < 3; t++) {
          const rr = await tgCall('deleteMessage', { message_id: id });
          if (rr.retryAfter) { await sleep(rr.retryAfter * 1000 + 300); continue; }
          break;
        }
        await sleep(250);
      }
      m.sig.galeMsgIds = [];
      tgQueue.shift();
      R.telegramPendentes = tgQueue.length;
      continue;
    }

    const r = await tgCall('sendMessage', m.plain
      ? { text: stripHtml(m.text), disable_web_page_preview: true }
      : { text: m.text, parse_mode: 'HTML', disable_web_page_preview: true });

    if (r.ok) {
      if (m.onId && r.result?.message_id) m.onId(r.result.message_id);
      tgQueue.shift();
      R.telegramPendentes = tgQueue.length;
      await sleep(450);
      continue;
    }
    if (r.retryAfter) { await sleep(r.retryAfter * 1000 + 300); continue; }
    if (r.parseError) { m.plain = true; continue; }
    m.tries = (m.tries || 0) + 1;
    if (m.tries >= 6) {
      log('TELEGRAM_DESCARTADA', { erro: R.erroTelegram });
      tgQueue.shift();
    } else {
      await sleep(1500 * m.tries);
    }
    R.telegramPendentes = tgQueue.length;
  }
  tgRunning = false;
}

function kick() {
  if (!tgRunning) tgRun().catch((e) => { tgRunning = false; log('TG_FILA_ERRO', e.message); });
}

function tgSend(text, onId) {
  tgQueue.push({ kind: 'send', text, onId, tries: 0, plain: false });
  R.telegramPendentes = tgQueue.length;
  kick();
}

/** apaga as mensagens de GALE do sinal (corre depois da mensagem de resultado, pela ordem da fila) */
function tgApagarGale(sig) {
  tgQueue.push({ kind: 'delete', sig });
  kick();
}

/* ============================ PLACAR / MENSAGENS ============================ */

const FECHADOS = ['GREEN', 'G1', 'EMPATE', 'LOSS'];

function placar() {
  const hoje = dia();
  const L = S.signals.filter((s) => dia(s.criadoMs) === hoje);
  const c = (st) => L.filter((s) => s.estado === st).length;
  const green = c('GREEN');
  const g1 = c('G1');
  const emp = c('EMPATE');
  const emp0 = L.filter((s) => s.estado === 'EMPATE' && Number(s.empateGale) === 0).length;
  const emp1 = emp - emp0;
  const loss = c('LOSS');
  const wins = green + g1 + emp;
  const fechados = wins + loss;
  const taxa = fechados ? (wins / fechados) * 100 : 0;
  const base = green + g1 + loss;
  const taxaSem = base ? ((green + g1) / base) * 100 : 0;

  let seguidos = 0;
  const fin = L.filter((s) => FECHADOS.includes(s.estado));
  for (let i = fin.length - 1; i >= 0; i--) {
    if (fin[i].estado === 'LOSS') break;
    seguidos++;
  }
  return { green, g1, emp, emp0, emp1, loss, wins, fechados, taxa, taxaSem, seguidos };
}

function msgPlacar(p) {
  return [
    '┌─ <b>BALANÇO DE HOJE</b>',
    `├ ✅ ${p.wins} Greens  ·  ❌ ${p.loss} Reds  ·  <b>${p.taxa.toFixed(1)}%</b>`,
    `├ Direto ${p.green}  ·  Gale 1: ${p.g1}  ·  🟡 Empate: ${p.emp} <i>(E0 ${p.emp0} · E1 ${p.emp1})</i>`,
    `├ Sem contar empates: ${p.taxaSem.toFixed(1)}%`,
    `└ Greens seguidos: ${p.seguidos}`
  ].join('\n');
}

function msgEntrada(s) {
  return [
    '┏━━━ 🎲 <b>CAPUNGA · BAC BO</b> ━━━┓',
    `<b>SINAL #${s.id}</b>`,
    '',
    `Entrar: ${corTxt(s.cor)}`,
    '🔁 Máximo: <b>Gale 1</b>',
    '🟡 Empate só vale Green se você cobrir o empate',
    '',
    `Confiança: <b>${s.confianca}%</b>`,
    `Hora: ${hora(s.criadoMs)} (Angola)`,
    '┗━━━━━━━━━━━━━━━━━━━━┛',
    '<i>Sem garantia: cada rodada é independente. Faça gestão de banca.</i>'
  ].join('\n');
}

function placarDados(r) {
  return hasScore(r) ? `  <i>(J ${r.pj} × ${r.pb} B)</i>` : '';
}

function msgGale(s, r) {
  return [
    `⚠️ <b>GALE 1</b>  ·  #${s.id}`,
    `Saiu ${corCurta(r.resultado)}${placarDados(r)}`,
    `Repita: ${corTxt(s.cor)}`,
    '<i>(esta mensagem some quando o sinal fechar)</i>'
  ].join('\n');
}

function multTxt(m) {
  if (m == null || m === '') return 'não informado pela mesa';
  return `×${String(m).replace(/^x/i, '')}`;
}

function msgGreen(s, r) {
  let titulo;
  let extra = null;
  if (s.estado === 'EMPATE') {
    const g = s.empateGale === 0 ? 'ENTRADA DIRETA' : 'GALE 1';
    titulo = `✅ <b>GREEN POR EMPATE</b> · ${g}`;
    extra = [
      `🟡 Empate na <b>${s.empateGale === 0 ? 'entrada direta' : 'Gale 1'}</b>${hasScore(r) ? `  ·  soma ${r.pj} × ${r.pb}` : ''}`,
      `Multiplicador do empate: <b>${multTxt(r.mult)}</b>`,
      '<i>Só paga o multiplicador quem apostou no EMPATE; na Banca/Jogador o empate não é vitória.</i>'
    ].join('\n');
  } else if (s.estado === 'GREEN') {
    titulo = '✅ <b>GREEN · ENTRADA DIRETA</b>';
  } else {
    titulo = '✅ <b>GREEN · GALE 1</b>';
  }
  return [
    `${titulo}  ·  #${s.id}`,
    `${corCurta(s.cor)}  →  saiu ${corCurta(r.resultado)}${placarDados(r)}`,
    extra,
    `Confiança do sinal: ${s.confianca}%`,
    `Hora: ${hora()}`,
    '',
    msgPlacar(placar())
  ].filter((x) => x !== null).join('\n');
}

function msgRed(s, r) {
  return [
    `❌ <b>RED</b>  ·  #${s.id}`,
    `${corCurta(s.cor)}  →  saiu ${corCurta(r.resultado)}${placarDados(r)}`,
    'Gale 1 usado sem acerto',
    `Confiança do sinal: ${s.confianca}%`,
    `Hora: ${hora()}`,
    '',
    msgPlacar(placar())
  ].join('\n');
}

/* ============================ MOTOR DE SINAIS ============================ */

const pendente = () => S.signals.find((s) => s.estado === 'PENDENTE') || null;

function cancelarSeExpirado() {
  const s = pendente();
  if (!s) return false;
  if (Date.now() - s.criadoMs < CFG.expiraMin * 60000) return false;
  s.estado = 'CANCELADO';
  s.resolvidoMs = Date.now();
  dbSaveSignal(s);
  tgSend(`⚠️ <b>SINAL #${s.id} CANCELADO</b>\nSem rodadas novas da mesa. Não conta no balanço.\nHora: ${hora()}`);
  tgApagarGale(s);
  log('SINAL_EXPIRADO', { id: s.id });
  return true;
}

/** devolve true se o sinal fechou nesta rodada */
function resolver(r) {
  const s = pendente();
  if (!s) return false;
  if (r.t <= s.baseT || r.id === s.baseId) return false; // só rodadas posteriores ao sinal

  if (r.resultado === E) { // EMPATE = GREEN, guardando em que gale ocorreu
    s.empateGale = s.gale;
    s.empateMult = r.mult ?? null;
    fechar(s, r, 'EMPATE', true);
    return true;
  }
  if (r.resultado === s.cor) {
    fechar(s, r, s.gale === 0 ? 'GREEN' : 'G1', false);
    return true;
  }
  if (s.gale < MAX_GALE) {
    s.gale += 1;
    dbSaveSignal(s);
    tgSend(msgGale(s, r), (id) => { (s.galeMsgIds = s.galeMsgIds || []).push(id); });
    log('GALE', { id: s.id, gale: s.gale });
    return false;
  }
  s.estado = 'LOSS';
  s.resultadoFinal = r.resultado;
  s.resolvidoMs = Date.now();
  dbSaveSignal(s);
  tgSend(msgRed(s, r));
  tgApagarGale(s);
  log('RED', { id: s.id });
  return true;
}

function fechar(s, r, estado, empate) {
  s.estado = estado;
  s.empate = empate;
  s.resultadoFinal = r.resultado;
  s.resolvidoMs = Date.now();
  dbSaveSignal(s);
  tgSend(msgGreen(s, r));
  tgApagarGale(s); // a mensagem de gale desaparece depois do resultado
  log('GREEN', { id: s.id, estado, empateGale: s.empateGale ?? null });
}

function criarSinal(ultima) {
  if (!CFG.ativos) return (R.ultimoMotivo = 'sinais_desativados');
  if (pendente()) return (R.ultimoMotivo = 'sinal_em_andamento');
  if (Date.now() - S.lastSignalAt < CFG.intervaloSinalMs) return (R.ultimoMotivo = 'aguardando_cadencia');
  if (Date.now() - ultima.t > CFG.frescoMs) return (R.ultimoMotivo = 'rodada_desatualizada');

  const rows = windowAt(S.hist, S.hist.length - 1);
  if (rows.length < 6) return (R.ultimoMotivo = 'historico_curto');

  const e = pickEntry(rows);
  if (!e) return (R.ultimoMotivo = 'sem_padrao_com_evidencia_suficiente');
  if (e.conflito) return (R.ultimoMotivo = 'padroes_em_conflito');

  const s = {
    id: S.nextId++,
    criadoMs: Date.now(),
    cor: e.cor,
    key: e.key,
    nome: e.nome,
    emoji: e.emoji,
    confianca: e.confianca,
    taxa: e.taxa,
    amostra: e.amostra,
    consenso: e.consenso,
    estado: 'PENDENTE',
    gale: 0,
    empate: false,
    galeMsgIds: [],
    baseId: ultima.id,
    baseT: ultima.t
  };
  S.signals.push(s);
  if (S.signals.length > 1500) S.signals.splice(0, S.signals.length - 1500);
  S.lastSignalAt = s.criadoMs;
  R.ultimoSinal = { id: s.id, cor: s.cor, nome: s.nome, confianca: s.confianca, hora: hora(s.criadoMs) };
  R.ultimoMotivo = null;
  dbSaveSignal(s);
  tgSend(msgEntrada(s));
  log('SINAL', { id: s.id, cor: s.cor, key: s.key, piso: s.confianca, taxa: s.taxa, n: s.amostra });
}

/* ============================ SINCRONIZAÇÃO ============================ */

async function syncOnce() {
  if (busy || stopping) return { ignorada: true };
  busy = true;
  try {
    const rounds = await fetchRounds();
    const warm = S.hist.length === 0; // 1ª carga: importa histórico sem emitir nada
    let lastT = S.hist.length ? S.hist[S.hist.length - 1].t : 0;

    const fresh = rounds.filter((r) => !S.seen.has(r.id));
    let live = 0;
    let ultimaViva = null;
    let desordem = false;
    let fechou = false;

    for (const r of fresh) {
      S.seen.add(r.id);
      const eAoVivo = !warm && r.t > lastT;
      if (r.t < lastT) desordem = true;
      S.hist.push(r);
      dbSaveRound(r);
      if (r.t > lastT) lastT = r.t;
      if (eAoVivo) {
        live++;
        ultimaViva = r;
        if (resolver(r)) fechou = true;
      }
    }

    if (desordem) S.hist.sort((a, b) => a.t - b.t);
    if (S.hist.length > CFG.maxHist) S.hist.splice(0, S.hist.length - CFG.maxHist);

    if (fresh.length) {
      R.ultimaRodadaNova = new Date().toISOString();
      R.ciclosSemNovos = 0;
    } else {
      R.ciclosSemNovos++;
    }
    R.novosUltimoCiclo = fresh.length;

    cancelarSeExpirado();

    if (warm && fresh.length) {
      R.ultimoMotivo = 'base_historica_inicializada';
      log('BASE_INICIAL', { rodadas: fresh.length });
    } else if (live > 0 && ultimaViva) {
      if (fechou) R.ultimoMotivo = 'a_aguardar_apos_resultado';
      else criarSinal(ultimaViva);
    }

    R.ultimaSync = new Date().toISOString();
    return { sucesso: true, novas: fresh.length, aoVivo: live, motivo: R.ultimoMotivo };
  } catch (e) {
    log('SYNC_ERRO', e.message);
    return { sucesso: false, erro: e.message };
  } finally {
    busy = false;
  }
}

function agendar() {
  if (stopping) return;
  timer = setTimeout(async () => {
    await syncOnce();
    agendar();
  }, CFG.syncMs);
}

/* ============================ ROTAS ============================ */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

function admin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ sucesso: false, erro: 'ADMIN_TOKEN não configurado' });
  if (req.get('x-admin-token') !== ADMIN_TOKEN) return res.status(401).json({ sucesso: false, erro: 'Token inválido' });
  next();
}

app.get('/', (_req, res) =>
  res.json({
    nome: 'Capunga Dados — Bac Bo v7',
    estado: 'online',
    horaAngola: hora(),
    estrategias: STRATS.length,
    rotas: ['/health', '/diagnostico', '/sinais', '/estatisticas', '/estatisticas/horas']
  })
);

app.get('/health', (_req, res) =>
  res.json({
    sucesso: true,
    horaAngola: hora(),
    iniciadoEm: R.iniciadoEm,
    ultimaSync: R.ultimaSync,
    ultimaRodadaNova: R.ultimaRodadaNova,
    ciclosSemNovos: R.ciclosSemNovos,
    motivoSemSinal: R.ultimoMotivo,
    erroAPI: R.erroAPI,
    erroTelegram: R.erroTelegram,
    erroDB: R.erroDB,
    telegramPendentes: R.telegramPendentes
  })
);

app.get('/diagnostico', (_req, res) => {
  const st = S.stats || { per: {}, baseRate: null, baseN: 0 };
  res.json({
    sucesso: true,
    horaAngola: hora(),
    telegramConfigurado: Boolean(BOT_TOKEN && CHAT_ID),
    dbConfigurada: Boolean(pool),
    rodadasEmMemoria: S.hist.length,
    ultimasRodadas: S.hist.slice(-12).reverse().map((r) => ({ r: r.resultado, pj: r.pj, pb: r.pb, hora: hora(r.t) })),
    sinalPendente: pendente(),
    ultimoSinal: R.ultimoSinal,
    motivoSemSinal: R.ultimoMotivo,
    proximoSinalEmSeg: Math.max(0, Math.round((S.lastSignalAt + CFG.intervaloSinalMs - Date.now()) / 1000)),
    taxaBaseHistorica: st.baseRate ? Number((st.baseRate * 100).toFixed(1)) : null,
    amostrasBacktest: st.baseN,
    configuracao: { ...CFG, maxGale: MAX_GALE },
    placar: placar()
  });
});

app.get('/sinais', (req, res) => {
  const n = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 500);
  res.json({ sucesso: true, sinais: S.signals.slice(-n).reverse() });
});

app.get('/estatisticas', (_req, res) => {
  const st = getStats();
  const porEstrategia = {};
  for (const s of S.signals) {
    const k = s.key || 'N/D';
    const e = porEstrategia[k] || (porEstrategia[k] = { sinais: 0, greens: 0, reds: 0 });
    if (s.estado === 'LOSS') { e.reds++; e.sinais++; }
    else if (['GREEN', 'G1', 'EMPATE'].includes(s.estado)) { e.greens++; e.sinais++; }
  }
  const backtest = Object.entries(st.per)
    .map(([key, v]) => ({ key, amostras: v.n, acertoPercent: Number(((v.w / v.n) * 100).toFixed(1)), pisoConfianca: confOf(st, key).conf, elegivel: confOf(st, key).conf >= CFG.minConf }))
    .sort((a, b) => b.pisoConfianca - a.pisoConfianca);
  res.json({ sucesso: true, placarDia: placar(), taxaBasePercent: st.baseRate ? Number((st.baseRate * 100).toFixed(1)) : null, aviso: 'Nenhum padrão é 100%. pisoConfianca = limite inferior estatístico.', backtest, ao_vivo_por_estrategia: porEstrategia });
});

/* ---------- relatório por hora do dia (descritivo; não prevê nada) ---------- */

function wilsonCI(w, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = w / n;
  const z2 = z * z;
  const c = p + z2 / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const d = 1 + z2 / n;
  return [(c - m) / d, (c + m) / d];
}

/** rows: [{ h, green, g1, emp, loss }] por hora (0-23) */
function calcHoras(rows) {
  const porH = Array.from({ length: 24 }, (_, h) => ({ h, green: 0, g1: 0, emp: 0, loss: 0 }));
  for (const r of rows) {
    const o = porH[r.h];
    o.green += r.green; o.g1 += r.g1; o.emp += r.emp; o.loss += r.loss;
  }
  let W = 0, N = 0;
  for (const o of porH) { W += o.green + o.g1 + o.emp; N += o.green + o.g1 + o.emp + o.loss; }
  const media = N ? W / N : null;

  const horas = porH.map((o) => {
    const wins = o.green + o.g1 + o.emp;
    const n = wins + o.loss;
    const base = o.green + o.g1 + o.loss;
    const [lo, hi] = wilsonCI(wins, n);
    let leitura;
    if (n < 30) leitura = 'amostra insuficiente';
    else if (media != null && lo <= media && media <= hi) leitura = 'indistinguível da média (ruído)';
    else leitura = hi < media ? 'abaixo da média (pode ser sorte)' : 'acima da média (pode ser sorte)';
    return {
      hora: `${String(o.h).padStart(2, '0')}h`,
      sinais: n,
      greens: wins,
      reds: o.loss,
      empates: o.emp,
      acertoPercent: n ? Number(((wins / n) * 100).toFixed(1)) : null,
      acertoSemEmpatesPercent: base ? Number((((o.green + o.g1) / base) * 100).toFixed(1)) : null,
      margem95Percent: n ? [Number((lo * 100).toFixed(1)), Number((hi * 100).toFixed(1))] : null,
      leitura
    };
  });
  return { total: N, mediaPercent: media == null ? null : Number((media * 100).toFixed(1)), horas };
}

async function horasFonte() {
  if (pool) {
    await dbChain;
    const q = await pool.query(`
      SELECT EXTRACT(HOUR FROM criado_em AT TIME ZONE 'Africa/Luanda')::int AS h,
        COUNT(*) FILTER (WHERE estado = 'GREEN')::int AS green,
        COUNT(*) FILTER (WHERE estado IN ('G1','G2'))::int AS g1,
        COUNT(*) FILTER (WHERE estado = 'EMPATE')::int AS emp,
        COUNT(*) FILTER (WHERE estado = 'LOSS')::int AS loss
      FROM bb_sinais GROUP BY 1`);
    return { fonte: 'banco de dados (todos os sinais)', rows: q.rows };
  }
  const fh = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Luanda', hour: '2-digit', hour12: false });
  const mapa = {};
  for (const x of S.signals) {
    if (!FECHADOS.includes(x.estado)) continue;
    const h = Number(fh.format(new Date(x.criadoMs))) % 24;
    const o = mapa[h] || (mapa[h] = { h, green: 0, g1: 0, emp: 0, loss: 0 });
    if (x.estado === 'GREEN') o.green++;
    else if (x.estado === 'G1') o.g1++;
    else if (x.estado === 'EMPATE') o.emp++;
    else o.loss++;
  }
  return { fonte: 'memória (sem banco: só os últimos sinais)', rows: Object.values(mapa) };
}

app.get('/estatisticas/horas', async (req, res) => {
  try {
    const { fonte, rows } = await horasFonte();
    const r = calcHoras(rows);
    const aviso =
      'Descritivo. Cada rodada é independente: nenhuma hora é "melhor" de forma repetível. ' +
      'Diferenças entre horas com poucos sinais são ruído estatístico.';

    if (req.query.formato === 'texto') {
      const linhas = [
        `ACERTO POR HORA (Angola) · fonte: ${fonte}`,
        `Total: ${r.total} sinais · média: ${r.mediaPercent ?? '-'}%`,
        '',
        'Hora  Sinais  Acerto  s/Emp   Margem 95%      Leitura'
      ];
      for (const h of r.horas) {
        if (!h.sinais) continue;
        linhas.push(
          `${h.hora}   ${String(h.sinais).padStart(5)}  ${String(h.acertoPercent).padStart(5)}%  ${String(h.acertoSemEmpatesPercent ?? '-').padStart(5)}%  ` +
          `${h.margem95Percent[0]}–${h.margem95Percent[1]}%`.padEnd(15) + '  ' + h.leitura
        );
      }
      linhas.push('', aviso);
      return res.type('text/plain; charset=utf-8').send(linhas.join('\n'));
    }
    res.json({ sucesso: true, fonte, aviso, ...r });
  } catch (e) {
    res.status(500).json({ sucesso: false, erro: e.message });
  }
});

app.post('/admin/sincronizar', admin, async (_req, res) => res.json(await syncOnce()));

app.post('/admin/telegram-teste', admin, async (_req, res) => {
  const r = await tgPost(`🎲 <b>CAPUNGA · BAC BO</b>\n✅ Ligação Telegram OK\nHora: ${hora()}`);
  res.status(r.ok ? 200 : 502).json({ sucesso: r.ok, erro: R.erroTelegram });
});

/** Apaga tudo e recomeça. Body: { "confirmar": "APAGAR", "legado": true|false } */
app.post('/admin/reset', admin, async (req, res) => {
  if (req.body?.confirmar !== 'APAGAR') return res.status(400).json({ sucesso: false, erro: 'Envie {"confirmar":"APAGAR"}' });
  try {
    S.hist = []; S.seen = new Set(); S.signals = []; S.stats = null; S.statsAtLen = -1; S.lastSignalAt = 0;
    S.nextId = CFG.sinalInicial;
    if (pool) {
      await dbChain;
      await pool.query('DROP TABLE IF EXISTS bb_sinais, bb_rodadas');
      if (req.body?.legado) await pool.query('DROP TABLE IF EXISTS sinais, bacbo_resultados');
      await ensureSchema();
    }
    res.json({ sucesso: true, mensagem: 'Base apagada. O robô vai reimportar o histórico sem emitir sinais antigos.' });
  } catch (e) {
    res.status(500).json({ sucesso: false, erro: e.message });
  }
});

app.use((req, res) => res.status(404).json({ sucesso: false, erro: 'Rota não encontrada', caminho: req.path }));

/* ============================ ARRANQUE ============================ */

async function start() {
  if (DATABASE_URL) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/i.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
      max: 4,
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 12000
    });
    pool.on('error', (e) => { R.erroDB = e.message; log('POOL_ERRO', e.message); });
    try {
      await ensureSchema();
      await loadFromDB();
      log('DB', { rodadas: S.hist.length, sinaisRecentes: S.signals.length, proximoId: S.nextId });
    } catch (e) {
      R.erroDB = e.message;
      log('DB_INDISPONIVEL_SEGUE_EM_MEMORIA', e.message);
      pool = null;
    }
  } else {
    log('DB', 'DATABASE_URL ausente: a funcionar apenas em memória');
  }

  server = app.listen(PORT, '0.0.0.0', () =>
    log('START', { porta: PORT, estrategias: STRATS.length, maxGale: MAX_GALE, cadenciaMs: CFG.intervaloSinalMs, minConfianca: CFG.minConf })
  );

  const first = await syncOnce();
  log('PRIMEIRA_SYNC', first);
  agendar();
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  try { await dbChain; } catch (_) {}
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end().catch(() => {});
  process.exit(0);
}

process.on('unhandledRejection', (e) => log('UNHANDLED_REJECTION', String(e)));
process.on('uncaughtException', (e) => log('UNCAUGHT_EXCEPTION', e.message || String(e)));
process.on('SIGTERM', () => shutdown().catch(() => process.exit(1)));
process.on('SIGINT', () => shutdown().catch(() => process.exit(1)));

start().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});
