'use strict';

/**
 * CAPUNGA DADOS — BAC BO · v9 (ATÉ GALE 2 · UM SINAL A CADA 5 MIN NO RELÓGIO)
 *
 *  - Slots fixos do relógio (Angola): :00 :05 :10 :15 ... :55 -> 12 sinais por hora.
 *    Cada slot emite exatamente 1 sinal (se o anterior ainda estiver aberto ou a mesa
 *    estiver parada, o slot é saltado e o motivo fica em /health).
 *  - Até Gale 2 (3 tentativas). Empate = GREEN por omissão (EMPATE_VALE_GREEN=false desliga).
 *  - ASSERTIVIDADE: limite inferior de Wilson (95%) da taxa de acerto do padrão, medida por
 *    backtest (com gale 2) no histórico guardado. Mostra também a taxa bruta e a média geral.
 *    Nunca é forçada. Com gale 2 quase todo padrão tem taxa alta, mas um RED custa ~7x a entrada.
 *  - Estratégias copiadas da v7 (cor + algumas numéricas). Padrão suspenso se falhar ao vivo.
 *  - Mensagens de Gale apagadas quando o sinal fecha (bot admin do canal c/ permissão de apagar).
 *
 * Variáveis: BOT_TOKEN, CHAT_ID · DATABASE_URL (opcional) · ADMIN_TOKEN
 *  MIN_AMOSTRA (60) · SYNC_MS (3000) · SINAL_EXPIRA_MIN (4) · SINAL_INICIAL (1) · SINAIS_ATIVOS
 *  EMPATE_VALE_GREEN (true) · API_BACBO · SELF_URL (auto-ping; no Render usa RENDER_EXTERNAL_URL) · KEEPALIVE_MS
 */

const express = require('express');
const cors = require('cors');
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

const MAX_GALE = 2;
const SLOT_MS = 5 * 60 * 1000;
const CFG = {
  ativos: bool(process.env.SINAIS_ATIVOS, true),
  empateGreen: bool(process.env.EMPATE_VALE_GREEN, true),
  minAmostra: num('MIN_AMOSTRA', 60, 20, 5000),
  syncMs: num('SYNC_MS', 3000, 2000, 30000),
  expiraMin: num('SINAL_EXPIRA_MIN', 4, 2, 4), // < 5 min: nunca invade o slot seguinte
  sinalInicial: num('SINAL_INICIAL', 1, 1, 100000000),
  maxHist: 5000,
  gapMs: 6 * 60 * 1000,
  frescoMs: 4 * 60 * 1000
};

const J = 'Jogador';
const B = 'Banca';
const E = 'Empate';
const isCol = (x) => x === J || x === B;
const opp = (c) => (c === J ? B : c === B ? J : null);

/* ============================ ESTADO ============================ */

const S = {
  hist: [],
  seen: new Set(),
  signals: [],
  nextId: CFG.sinalInicial,
  lastSlot: Math.floor(Date.now() / SLOT_MS), // não emite a meio de um slot
  stats: null,
  statsAtLen: -1
};

const R = {
  iniciadoEm: new Date().toISOString(),
  ultimaSync: null,
  ultimaRodadaNova: null,
  ciclosSemNovos: 0,
  erroAPI: null,
  erroDB: null,
  erroTelegram: null,
  ultimoMotivo: null,
  ultimoSinal: null,
  telegramPendentes: 0,
  ultimoKeepAlive: null
};

let pool = null;
let server = null;
let syncTimer = null;
let slotTimer = null;
let busy = false;
let stopping = false;

/* ============================ UTILS ============================ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(tag, data) {
  const p = typeof data === 'string' ? data : JSON.stringify(data);
  console.log(`[${new Date().toISOString()}] [${tag}] ${p}`);
}

const fmtHora = new Intl.DateTimeFormat('pt-PT', {
  timeZone: 'Africa/Luanda', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});
const fmtDia = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Luanda', year: 'numeric', month: '2-digit', day: '2-digit'
});
const hora = (ms = Date.now()) => fmtHora.format(new Date(ms));
const dia = (ms = Date.now()) => fmtDia.format(new Date(ms));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const corTxt = (c) => (c === B ? '🔴 <b>BANCA</b>' : c === J ? '🔵 <b>JOGADOR</b>' : '🟡 <b>EMPATE</b>');
const corCurta = (c) => (c === B ? '🔴 Banca' : c === J ? '🔵 Jogador' : '🟡 Empate');
const barra = (p) => {
  const f = Math.max(0, Math.min(10, Math.round(p / 10)));
  return '▰'.repeat(f) + '▱'.repeat(10 - f);
};

/* ============================ API / NORMALIZAÇÃO ============================ */

function normalizeOutcome(v) {
  if (v && typeof v === 'object') v = v.outcome ?? v.resultado ?? v.winner ?? v.name;
  const s = String(v ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .trim().toLowerCase().replace(/[\s_-]+/g, '');
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
  const t = validMs(d.settledAt ?? d.endTime ?? d.endedAt ?? d.finishedAt ?? d.fim ?? item?.settledAt ?? item?.fim);

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
    d.id ?? d.roundId ?? d.round_id ?? d.eventId ?? item?.id ?? item?.roundId ?? item?.round_id ?? item?.eventId ?? ''
  ).trim();

  if (!id || !resultado || !resolvida || !t) return null;

  const pj = Number(r.playerDice?.score ?? d.playerDice?.score ?? d.playerScore ?? d.player_score ?? d.pontos_jogador);
  const pb = Number(r.bankerDice?.score ?? d.bankerDice?.score ?? d.bankerScore ?? d.banker_score ?? d.pontos_banca);
  const mult = r.multiplier ?? d.multiplier ?? d.multiplicador ?? null;

  return {
    id, resultado, t,
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
        headers: { Accept: 'application/json', 'User-Agent': 'CapungaDadosBot/9.0' }
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

/* ============================ ESTRATÉGIAS (copiadas da v7) ============================ */
/* `seq` = só Jogador/Banca, mais recente primeiro. `rows` = todas (incl. empates). */

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

const STRATS = [
  function repeticao({ seq }) {
    const n = streak(seq);
    if (n < 2 || n > 8) return null;
    return { cor: seq[0].resultado, key: `REPETICAO_${Math.min(n, 6)}`, nome: `Repetição x${n}`, emoji: '🔁' };
  },
  function quebra({ seq }) {
    const n = streak(seq);
    if (n < 3 || n > 9) return null;
    return { cor: opp(seq[0].resultado), key: `QUEBRA_${Math.min(n, 7)}`, nome: `Quebra de sequência x${n}`, emoji: '💥' };
  },
  function surf({ seq }) {
    if (seq.length < 4) return null;
    let L = 1;
    while (L < seq.length && seq[L].resultado !== seq[L - 1].resultado) L++;
    if (L < 3) return null;
    return { cor: opp(seq[0].resultado), key: `SURF_${Math.min(L, 6)}`, nome: `Surf (alternância ${L})`, emoji: '🌊' };
  },
  function doisDois({ seq }) {
    if (seq.length < 4) return null;
    const [a, b, c, d] = seq.map((x) => x.resultado);
    if (a === b && c === d && a !== c) return { cor: c, key: 'DOIS_DOIS', nome: '2+2 (blocos de dois)', emoji: '♟️' };
    return null;
  },
  function tresUm({ seq }) {
    if (seq.length < 4) return null;
    const [a, b, c, d] = seq.map((x) => x.resultado);
    if (a !== b && b === c && c === d) return { cor: a, key: 'TRES_UM', nome: 'Quebra confirmada (3→1)', emoji: '🧩' };
    return null;
  },
  function forca({ seq }) {
    const s = seq.slice(0, 12);
    if (s.length < 10) return null;
    const pj = s.filter((x) => x.resultado === J).length / s.length;
    const dom = pj >= 0.5 ? J : B;
    const pct = Math.max(pj, 1 - pj);
    if (pct < 0.67) return null;
    const bucket = pct >= 0.75 ? 75 : pct >= 0.7 ? 70 : 67;
    return { cor: dom, key: `FORCA_${bucket}`, nome: `Força da mesa ${Math.round(pct * 100)}%`, emoji: '💪' };
  },
  function reversao({ seq }) {
    const s = seq.slice(0, 20);
    if (s.length < 16) return null;
    const pj = s.filter((x) => x.resultado === J).length / s.length;
    const pct = Math.max(pj, 1 - pj);
    if (pct < 0.65) return null;
    const dom = pj >= 0.5 ? J : B;
    return { cor: opp(dom), key: 'REVERSAO_20', nome: `Retorno à média (${Math.round(pct * 100)}% ${dom})`, emoji: '⚖️' };
  },
  function numMargem({ rows }) {
    const r = rows[0];
    if (!r || !isCol(r.resultado) || !hasScore(r) || margem(r) < 5) return null;
    return { cor: r.resultado, key: 'NUM_MARGEM_5', nome: `Numérica · margem ${r.pj}×${r.pb}`, emoji: '🔢' };
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
  function doisDoisPar({ seq }) {
    if (seq.length < 3) return null;
    const [a, b, c] = seq.map((x) => x.resultado);
    if (a !== b && b === c) return { cor: a, key: 'DOIS_DOIS_PAR', nome: '2+2 (completa par)', emoji: '♟️' };
    return null;
  },
  function numAlta({ rows }) {
    const r = rows[0];
    if (!r || !isCol(r.resultado) || !hasScore(r)) return null;
    const v = r.resultado === J ? r.pj : r.pb;
    if (v < 10 || margem(r) < 1) return null;
    return { cor: r.resultado, key: 'NUM_ALTA_10', nome: `Numérica Alta (${v})`, emoji: '🔢' };
  },
  function numDiff4({ seq }) {
    if (seq.length < 3) return null;
    const t = seq.slice(0, 3);
    if (!t.every((r) => hasScore(r) && margem(r) >= 4 && r.resultado === t[0].resultado)) return null;
    return { cor: t[0].resultado, key: 'NUM_DIFF4_X3', nome: 'Numérica Diff≥4 x3', emoji: '🔢' };
  },
  function numViradaBaixa({ seq }) {
    if (seq.length < 2) return null;
    const [a, b] = seq;
    if (!hasScore(a) || !hasScore(b) || a.resultado !== b.resultado) return null;
    const sc = (r) => (r.resultado === J ? r.pj : r.pb);
    if (sc(a) > 5 || sc(b) > 5) return null;
    return { cor: opp(a.resultado), key: 'NUM_VIRADA_BAIXA', nome: 'Numérica Virada Baixa', emoji: '🔢' };
  },
  /** Padrões de contexto: as últimas k cores (k=3,4,5). Gera sempre as duas hipóteses (seguir / contrariar
   *  a última cor); o backtest mede qual delas funcionou no histórico real e só depois entra em jogo. */
  function contexto({ seq }) {
    const out = [];
    for (const k of [3, 4, 5]) {
      if (seq.length < k) continue;
      const p = seq.slice(0, k).map((x) => (x.resultado === J ? 'J' : 'B')).join('');
      const vis = p.split('').reverse().join(''); // ordem cronológica
      const last = seq[0].resultado;
      out.push({ cor: last, key: `CTX${k}_${p}_SEG`, nome: `Sequência ${vis} → segue`, emoji: '🧬' });
      out.push({ cor: opp(last), key: `CTX${k}_${p}_CON`, nome: `Sequência ${vis} → contraria`, emoji: '🧬' });
    }
    return out;
  },
  function numPosEmpate({ rows, seq }) {
    if (!rows[0] || rows[0].resultado !== E || !seq.length) return null;
    return { cor: seq[0].resultado, key: 'NUM_POS_EMPATE', nome: 'Pós-empate (cor anterior)', emoji: '🎯' };
  }
];

function runStrategies(rows) {
  const ctx = { rows, seq: rows.filter((r) => isCol(r.resultado)) };
  const out = [];
  for (const fn of STRATS) {
    try {
      const r = fn(ctx);
      for (const c of Array.isArray(r) ? r : [r]) if (c && isCol(c.cor)) out.push(c);
    } catch (_) { /* dados em falta: ignora */ }
  }
  return out;
}

/* ============================ BACKTEST / ASSERTIVIDADE ============================ */

function windowAt(H, i) {
  const rows = [];
  for (let j = i; j >= 0 && rows.length < 24; j--) {
    if (rows.length && rows[rows.length - 1].t - H[j].t > CFG.gapMs) break;
    rows.push(H[j]);
  }
  return rows;
}

/** true = ganhou dentro de Gale 2 · false = red · null = sem dados */
function evalEntry(H, i, cor) {
  for (let k = 0; k <= MAX_GALE; k++) {
    const idx = i + 1 + k;
    if (idx >= H.length) return null;
    if (H[idx].t - H[idx - 1].t > CFG.gapMs) return null;
    const r = H[idx].resultado;
    if (r === cor || (r === E && CFG.empateGreen)) return true;
  }
  return false;
}

function backtest() {
  const H = S.hist;
  const per = {};
  const ini = 8;
  const fim = H.length - 1;
  const corte = ini + Math.floor((fim - ini) * 0.7); // 70% treino · 30% teste fora da amostra
  let bw = 0;
  let bn = 0;
  let tw = 0;
  let tn = 0;
  for (let i = ini; i < fim; i++) {
    const win = windowAt(H, i);
    if (win.length < 6) continue;
    const teste = i >= corte;
    for (const cor of [J, B]) {
      const v = evalEntry(H, i, cor);
      if (v === null) continue;
      bn++;
      if (v) bw++;
      if (teste) { tn++; if (v) tw++; }
    }
    for (const c of runStrategies(win)) {
      const v = evalEntry(H, i, c.cor);
      if (v === null) continue;
      const p = per[c.key] || (per[c.key] = { n: 0, w: 0, nt: 0, wt: 0 });
      p.n++;
      if (v) p.w++;
      if (teste) { p.nt++; if (v) p.wt++; }
    }
  }
  return { per, baseW: bw, baseN: bn, baseRate: bn ? bw / bn : null, testeRate: tn ? tw / tn : null };
}

function getStats(force = false) {
  if (force || !S.stats || S.hist.length - S.statsAtLen >= 25) {
    S.stats = backtest();
    S.statsAtLen = S.hist.length;
  }
  return S.stats;
}

/** limite inferior de Wilson (95%): o número honesto de assertividade */
function wilsonLB(w, n, z = 1.96) {
  if (!n) return 0;
  const p = w / n;
  const z2 = z * z;
  const c = p + z2 / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return (c - m) / (1 + z2 / n);
}

const FECHADOS = ['GREEN', 'G1', 'G2', 'EMPATE', 'LOSS'];
const VITORIAS = ['GREEN', 'G1', 'G2', 'EMPATE'];

/** suspende padrão que falha ao vivo: últimos 15 sinais fechados (≥10) com <60% de greens */
function suspensoAoVivo(key) {
  const L = S.signals.filter((x) => x.key === key && FECHADOS.includes(x.estado)).slice(-15);
  if (L.length < 10) return false;
  return L.filter((x) => x.estado !== 'LOSS').length / L.length < 0.6;
}

/** O slot é obrigatório, por isso há sempre uma escolha: 1) padrão elegível (amostra ≥ MIN_AMOSTRA),
 *  2) melhor padrão com amostra ≥ 20, 3) maioria dos últimos 12 resultados (assertividade = média geral). */
function pickEntry(rows) {
  const st = getStats();
  const base = st.baseN
    ? { taxa: (st.baseW / st.baseN) * 100, piso: wilsonLB(st.baseW, st.baseN) * 100, amostra: st.baseN }
    : null;

  const todos = runStrategies(rows)
    .map((c) => {
      const e = st.per[c.key] || { n: 0, w: 0, nt: 0, wt: 0 };
      return {
        ...c,
        amostra: e.n,
        taxa: e.n ? (e.w / e.n) * 100 : 0,
        piso: wilsonLB(e.w, e.n) * 100,
        pisoTreino: wilsonLB(e.w - e.wt, e.n - e.nt) * 100, // usado para ESCOLHER (sem espiar o teste)
        testeN: e.nt,
        testeTaxa: e.nt ? (e.wt / e.nt) * 100 : 0
      };
    })
    .filter((c) => !suspensoAoVivo(c.key));

  const pickBest = (arr) => {
    if (!arr.length) return null;
    const g = { [J]: [], [B]: [] };
    for (const c of arr) g[c.cor].push(c);
    const top = (a) => (a.length ? Math.max(...a.map((c) => c.pisoTreino)) : -1);
    const sJ = top(g[J]);
    const sB = top(g[B]);
    const a = sJ >= sB ? g[J] : g[B];
    a.sort((x, y) => y.pisoTreino - x.pisoTreino || y.amostra - x.amostra);
    return { ...a[0], consenso: a.length };
  };

  // Elegível = amostra suficiente E bom também no período de TESTE (30% mais recente, não usado
  // para escolher): taxa de teste ≥ média geral do teste. Filtra padrões que só "decoraram" o passado.
  const refTeste = (st.testeRate != null ? st.testeRate : st.baseRate || 0) * 100;
  const validado = (c) => c.testeN >= 15 && c.testeTaxa >= refTeste - 0.5;
  let e = pickBest(todos.filter((c) => c.amostra >= CFG.minAmostra && validado(c)));
  let nivel = 'padrao';
  if (!e) {
    e = pickBest(todos.filter((c) => c.amostra >= 20 && c.testeN >= 8));
    nivel = 'amostra_baixa';
  }
  if (!e) {
    const seq = rows.filter((r) => isCol(r.resultado)).slice(0, 12);
    const j = seq.filter((x) => x.resultado === J).length;
    const cor = j >= seq.length - j ? J : B;
    e = {
      cor, key: 'MAIORIA_12', nome: 'Maioria dos últimos 12', emoji: '📈', consenso: 1,
      amostra: base ? base.amostra : 0, taxa: base ? base.taxa : 0, piso: base ? base.piso : 0
    };
    nivel = 'base';
  }
  return { ...e, nivel, base: base ? base.taxa : null };
}

/* ============================ BASE DE DADOS (opcional) ============================ */

let dbChain = Promise.resolve();
function dbq(fn) {
  if (!pool) return;
  dbChain = dbChain.then(fn).catch((e) => {
    R.erroDB = e.message;
    log('DB_ERRO', e.message);
  });
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS g2_rodadas (
      id TEXT PRIMARY KEY, resultado TEXT NOT NULL, fim TIMESTAMPTZ NOT NULL,
      pj INTEGER, pb INTEGER, mult TEXT
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_g2_rodadas_fim ON g2_rodadas (fim DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS g2_sinais (
      id BIGINT PRIMARY KEY, criado_em TIMESTAMPTZ NOT NULL, cor TEXT NOT NULL,
      estrategia TEXT, nome TEXT, assertividade INTEGER, taxa INTEGER, amostra INTEGER,
      estado TEXT NOT NULL, gale INTEGER NOT NULL DEFAULT 0,
      empate_gale INTEGER, empate_mult TEXT,
      resultado_final TEXT, resolvido_em TIMESTAMPTZ, base_id TEXT
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_g2_sinais_criado ON g2_sinais (criado_em DESC)`);
}

async function loadFromDB() {
  const rr = await pool.query(
    `SELECT id, resultado, fim, pj, pb, mult FROM g2_rodadas ORDER BY fim DESC LIMIT $1`, [CFG.maxHist]
  );
  S.hist = rr.rows
    .map((x) => ({ id: x.id, resultado: x.resultado, t: new Date(x.fim).getTime(), pj: x.pj, pb: x.pb, mult: x.mult }))
    .sort((a, b) => a.t - b.t);
  S.seen = new Set(S.hist.map((x) => x.id));

  const sr = await pool.query(`SELECT * FROM g2_sinais WHERE criado_em >= NOW() - INTERVAL '36 hours' ORDER BY id ASC`);
  S.signals = sr.rows.map((x) => ({
    id: Number(x.id),
    criadoMs: new Date(x.criado_em).getTime(),
    cor: x.cor,
    key: x.estrategia,
    nome: x.nome,
    assertividade: x.assertividade,
    taxa: x.taxa,
    amostra: x.amostra,
    estado: x.estado,
    gale: x.gale,
    empateGale: x.empate_gale,
    empateMult: x.empate_mult,
    resultadoFinal: x.resultado_final,
    resolvidoMs: x.resolvido_em ? new Date(x.resolvido_em).getTime() : null,
    baseId: x.base_id,
    galeMsgIds: []
  }));

  const mx = await pool.query(`SELECT COALESCE(MAX(id), 0)::bigint AS m FROM g2_sinais`);
  const m = Number(mx.rows[0].m);
  S.nextId = m > 0 ? m + 1 : CFG.sinalInicial;

  for (const s of S.signals) {
    if (s.estado === 'PENDENTE') {
      s.estado = 'CANCELADO';
      s.resolvidoMs = Date.now();
      dbSaveSignal(s);
    }
  }
}

function dbSaveRound(r) {
  dbq(() =>
    pool.query(
      `INSERT INTO g2_rodadas (id, resultado, fim, pj, pb, mult) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [r.id, r.resultado, new Date(r.t), r.pj, r.pb, r.mult]
    )
  );
}

function dbSaveSignal(s) {
  dbq(() =>
    pool.query(
      `INSERT INTO g2_sinais (id, criado_em, cor, estrategia, nome, assertividade, taxa, amostra, estado, gale,
                              empate_gale, empate_mult, resultado_final, resolvido_em, base_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET
         estado = EXCLUDED.estado, gale = EXCLUDED.gale,
         empate_gale = EXCLUDED.empate_gale, empate_mult = EXCLUDED.empate_mult,
         resultado_final = EXCLUDED.resultado_final, resolvido_em = EXCLUDED.resolvido_em`,
      [
        s.id, new Date(s.criadoMs), s.cor, s.key, s.nome, s.assertividade ?? null, s.taxa ?? null, s.amostra ?? null,
        s.estado, s.gale, s.empateGale ?? null, s.empateMult ?? null, s.resultadoFinal || null,
        s.resolvidoMs ? new Date(s.resolvidoMs) : null, s.baseId || null
      ]
    )
  );
}

/* ============================ TELEGRAM (fila + retry + apagar gale) ============================ */

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
    if (status === 400 && method === 'deleteMessage') return { ok: true, gone: true };
    return { ok: false };
  }
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
      await sleep(400);
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
function tgApagarGale(sig) {
  tgQueue.push({ kind: 'delete', sig });
  kick();
}

/* ============================ PLACAR / MENSAGENS ============================ */

function placar() {
  const hoje = dia();
  const L = S.signals.filter((s) => dia(s.criadoMs) === hoje);
  const c = (st) => L.filter((s) => s.estado === st).length;
  const green = c('GREEN');
  const g1 = c('G1');
  const g2 = c('G2');
  const emp = c('EMPATE');
  const loss = c('LOSS');
  const wins = green + g1 + g2 + emp;
  const fechados = wins + loss;
  const taxa = fechados ? (wins / fechados) * 100 : 0;

  let seguidos = 0;
  const fin = L.filter((s) => FECHADOS.includes(s.estado));
  for (let i = fin.length - 1; i >= 0; i--) {
    if (fin[i].estado === 'LOSS') break;
    seguidos++;
  }
  return { green, g1, g2, emp, loss, wins, fechados, taxa, seguidos };
}

function msgPlacar(p) {
  return [
    '┌─ 📊 <b>BALANÇO DE HOJE</b>',
    `├ ✅ ${p.wins} Greens  ·  🟥 ${p.loss} Reds  ·  <b>${p.taxa.toFixed(1)}%</b>`,
    `├ Direto ${p.green}  ·  G1: ${p.g1}  ·  G2: ${p.g2}  ·  🟡 Empate: ${p.emp}`,
    `└ 🔥 Greens seguidos: ${p.seguidos}`
  ].join('\n');
}

function placarDados(r) {
  return hasScore(r) ? `  <i>(J ${r.pj} × ${r.pb} B)</i>` : '';
}

function msgEntrada(s) {
  const a = s.assertividade;
  const nivel = a >= 90 ? '💎 Forte' : a >= 80 ? '🟢 Boa' : a >= 70 ? '🟡 Moderada' : '🟠 Baixa';
  const aviso = s.nivel === 'amostra_baixa'
    ? '⚠️ Padrão com poucos casos no histórico'
    : s.nivel === 'base'
      ? '⚠️ Sem padrão forte agora · usando a média geral'
      : null;
  return [
    '┏━━━ 🎲 <b>CAPUNGA · BAC BO</b> ━━━┓',
    `🎯 <b>SINAL #${s.id}</b>  ·  ${hora(s.criadoMs).slice(0, 5)}`,
    '',
    `👉 Entrar: ${corTxt(s.cor)}`,
    `🔁 Proteção: até <b>Gale 2</b>${CFG.empateGreen ? '  ·  🟡 Empate = Green' : ''}`,
    '',
    `${s.emoji || '🧠'} Padrão: ${esc(s.nome)}`,
    `📈 <b>Assertividade: ${a}%</b>  ${nivel}`,
    `${barra(a)}`,
    `📊 Histórico: ${s.taxa}% em ${s.amostra} casos${s.base != null ? `  ·  média geral ${s.base.toFixed(1)}%` : ''}`,
    s.consenso > 1 ? `🤝 ${s.consenso} padrões na mesma cor` : null,
    aviso,
    '┗━━━━━━━━━━━━━━━━━━━━┛',
    '<i>Assertividade = piso estatístico do histórico, não garantia. Um RED após Gale 2 custa ~7x a entrada.</i>'
  ].filter((x) => x !== null).join('\n');
}

function msgGale(s, r) {
  return [
    `⚠️ <b>GALE ${s.gale}</b>  ·  #${s.id}`,
    `Rodada anterior: ${corCurta(r.resultado)}${placarDados(r)}`,
    `👉 Repita: ${corTxt(s.cor)}`,
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
    const g = s.empateGale === 0 ? 'ENTRADA DIRETA' : `GALE ${s.empateGale}`;
    titulo = `🟡✅ <b>GREEN POR EMPATE</b> · ${g}`;
    extra = [
      `💰 Multiplicador do empate: <b>${multTxt(r.mult)}</b>`,
      '<i>Só paga o multiplicador quem apostou no EMPATE.</i>'
    ].join('\n');
  } else if (s.estado === 'GREEN') {
    titulo = '✅ <b>GREEN · ENTRADA DIRETA</b>';
  } else {
    titulo = `⚡✅ <b>GREEN · GALE ${s.gale}</b>`;
  }
  return [
    `${titulo}  ·  #${s.id}`,
    `🎯 ${corCurta(s.cor)}  →  saiu ${corCurta(r.resultado)}${placarDados(r)}`,
    extra,
    `${s.emoji || '🧠'} ${esc(s.nome)}  ·  ${s.assertividade}%`,
    `⏱ ${hora()}`,
    '',
    msgPlacar(placar())
  ].filter((x) => x !== null).join('\n');
}

function msgRed(s, r) {
  return [
    `🟥 <b>RED</b>  ·  #${s.id}`,
    `🎯 ${corCurta(s.cor)}  →  saiu ${corCurta(r.resultado)}${placarDados(r)}`,
    `${s.emoji || '🧠'} ${esc(s.nome)}  ·  ${s.assertividade}%`,
    '🔁 Gale 2 usado sem acerto',
    `⏱ ${hora()}`,
    '',
    msgPlacar(placar())
  ].join('\n');
}

/* ============================ MOTOR DE SINAIS ============================ */

const pendente = () => S.signals.find((s) => s.estado === 'PENDENTE') || null;

function cancelarSeExpirado() {
  const s = pendente();
  if (!s) return;
  if (Date.now() - s.criadoMs < CFG.expiraMin * 60000) return;
  s.estado = 'CANCELADO';
  s.resolvidoMs = Date.now();
  dbSaveSignal(s);
  tgSend(`⏰ <b>SINAL #${s.id} CANCELADO</b>\nSem rodadas novas da mesa. Não conta no balanço.\n⏱ ${hora()}`);
  tgApagarGale(s);
  log('SINAL_EXPIRADO', { id: s.id });
}

function fechar(s, r, estado) {
  s.estado = estado;
  s.resultadoFinal = r.resultado;
  s.resolvidoMs = Date.now();
  dbSaveSignal(s);
  tgSend(msgGreen(s, r));
  tgApagarGale(s);
  log('GREEN', { id: s.id, estado });
}

/** devolve true se o sinal fechou nesta rodada */
function resolver(r) {
  const s = pendente();
  if (!s) return false;
  if (r.t <= s.baseT || r.id === s.baseId) return false;

  if (r.resultado === E && CFG.empateGreen) {
    s.empateGale = s.gale;
    s.empateMult = r.mult ?? null;
    fechar(s, r, 'EMPATE');
    return true;
  }
  if (r.resultado === s.cor) {
    fechar(s, r, s.gale === 0 ? 'GREEN' : `G${s.gale}`);
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

function criarSinal(ultima) {
  const rows = windowAt(S.hist, S.hist.length - 1);
  const e = pickEntry(rows);

  const s = {
    id: S.nextId++,
    criadoMs: Date.now(),
    cor: e.cor,
    key: e.key,
    nome: e.nome,
    emoji: e.emoji,
    assertividade: Math.max(0, Math.min(99, Math.floor(e.piso))),
    taxa: Math.round(e.taxa),
    amostra: e.amostra,
    base: e.base,
    consenso: e.consenso,
    nivel: e.nivel,
    estado: 'PENDENTE',
    gale: 0,
    galeMsgIds: [],
    baseId: ultima.id,
    baseT: ultima.t
  };
  S.signals.push(s);
  if (S.signals.length > 1500) S.signals.splice(0, S.signals.length - 1500);
  R.ultimoSinal = { id: s.id, cor: s.cor, nome: s.nome, assertividade: s.assertividade, hora: hora(s.criadoMs) };
  R.ultimoMotivo = null;
  dbSaveSignal(s);
  tgSend(msgEntrada(s));
  log('SINAL', { id: s.id, cor: s.cor, key: s.key, assertividade: s.assertividade, taxa: s.taxa, n: s.amostra, nivel: s.nivel });
}

/** Chamado a cada segundo. Quando o relógio entra num novo slot de 5 min, emite 1 sinal. */
function tentarSlot() {
  if (stopping) return;
  const slot = Math.floor(Date.now() / SLOT_MS);
  if (slot <= S.lastSlot) return;
  S.lastSlot = slot;

  cancelarSeExpirado();
  if (!CFG.ativos) return (R.ultimoMotivo = 'sinais_desativados');
  if (S.hist.length < 10) return (R.ultimoMotivo = 'historico_curto');
  if (pendente()) return (R.ultimoMotivo = 'slot_saltado_sinal_anterior_aberto');

  const ultima = S.hist[S.hist.length - 1];
  if (Date.now() - ultima.t > CFG.frescoMs) return (R.ultimoMotivo = 'slot_saltado_mesa_parada');

  try {
    criarSinal(ultima);
  } catch (e) {
    R.ultimoMotivo = `erro_criar_sinal: ${e.message}`;
    log('ERRO_SINAL', e.message);
  }
}

/* ============================ SINCRONIZAÇÃO ============================ */

async function syncOnce() {
  if (busy || stopping) return { ignorada: true };
  busy = true;
  try {
    const rounds = await fetchRounds();
    const warm = S.hist.length === 0;
    let lastT = S.hist.length ? S.hist[S.hist.length - 1].t : 0;

    const fresh = rounds.filter((r) => !S.seen.has(r.id));
    let desordem = false;

    for (const r of fresh) {
      S.seen.add(r.id);
      const eAoVivo = !warm && r.t > lastT;
      if (r.t < lastT) desordem = true;
      S.hist.push(r);
      dbSaveRound(r);
      if (r.t > lastT) lastT = r.t;
      if (eAoVivo) resolver(r);
    }

    if (desordem) S.hist.sort((a, b) => a.t - b.t);
    if (S.hist.length > CFG.maxHist) S.hist.splice(0, S.hist.length - CFG.maxHist);

    if (fresh.length) {
      R.ultimaRodadaNova = new Date().toISOString();
      R.ciclosSemNovos = 0;
    } else {
      R.ciclosSemNovos++;
    }

    cancelarSeExpirado();
    if (warm && fresh.length) {
      R.ultimoMotivo = 'base_historica_inicializada';
      log('BASE_INICIAL', { rodadas: fresh.length });
    }
    R.ultimaSync = new Date().toISOString();
    return { sucesso: true, novas: fresh.length };
  } catch (e) {
    log('SYNC_ERRO', e.message);
    return { sucesso: false, erro: e.message };
  } finally {
    busy = false;
  }
}

function agendarSync() {
  if (stopping) return;
  syncTimer = setTimeout(async () => {
    await syncOnce();
    agendarSync();
  }, CFG.syncMs);
}

/* ============================ KEEP-ALIVE ============================ */

const SELF_URL = process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || '';
let keepTimer = null;

function startKeepAlive() {
  if (!SELF_URL) {
    log('KEEPALIVE', 'SELF_URL/RENDER_EXTERNAL_URL ausente — use um ping externo (UptimeRobot) em /health');
    return;
  }
  const alvo = `${SELF_URL.replace(/\/+$/, '')}/health`;
  keepTimer = setInterval(() => {
    axios.get(alvo, { timeout: 15000 }).then(() => { R.ultimoKeepAlive = new Date().toISOString(); }).catch((e) => log('KEEPALIVE_ERRO', e.message));
  }, num('KEEPALIVE_MS', 240000, 60000, 840000));
  if (typeof keepTimer.unref === 'function') keepTimer.unref();
  log('KEEPALIVE', { alvo });
}

/* ============================ ROTAS ============================ */

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use((_req, _res, next) => {
  const ult = R.ultimaSync ? Date.parse(R.ultimaSync) : 0;
  if (!busy && Date.now() - ult > CFG.syncMs * 3) syncOnce().catch(() => {});
  next();
});

function admin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ sucesso: false, erro: 'ADMIN_TOKEN não configurado' });
  if (req.get('x-admin-token') !== ADMIN_TOKEN) return res.status(401).json({ sucesso: false, erro: 'Token inválido' });
  next();
}

const proximoSlotEmSeg = () => Math.max(0, Math.ceil(((Math.floor(Date.now() / SLOT_MS) + 1) * SLOT_MS - Date.now()) / 1000));

app.get('/', (_req, res) =>
  res.json({
    nome: 'Capunga Dados — Bac Bo v9 (gale 2 · slots de 5 min)',
    estado: 'online',
    horaAngola: hora(),
    estrategias: STRATS.length,
    rotas: ['/health', '/diagnostico', '/sinais', '/estatisticas']
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
    motivoUltimoSlotSemSinal: R.ultimoMotivo,
    proximoSlotEmSeg: proximoSlotEmSeg(),
    erroAPI: R.erroAPI,
    erroTelegram: R.erroTelegram,
    erroDB: R.erroDB,
    telegramPendentes: R.telegramPendentes,
    ultimoKeepAlive: R.ultimoKeepAlive
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
    proximoSlotEmSeg: proximoSlotEmSeg(),
    taxaBaseGale2Percent: st.baseRate ? Number((st.baseRate * 100).toFixed(1)) : null,
    amostrasBacktest: st.baseN,
    configuracao: { ...CFG, maxGale: MAX_GALE, slotMin: 5 },
    placar: placar()
  });
});

app.get('/sinais', (req, res) => {
  const n = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 500);
  res.json({ sucesso: true, sinais: S.signals.slice(-n).reverse().map(({ galeMsgIds, ...x }) => x) });
});

app.get('/estatisticas', (_req, res) => {
  const st = getStats();
  const aoVivo = {};
  for (const s of S.signals) {
    if (!FECHADOS.includes(s.estado)) continue;
    const k = s.key || 'N/D';
    const e = aoVivo[k] || (aoVivo[k] = { sinais: 0, greens: 0, reds: 0 });
    e.sinais++;
    if (s.estado === 'LOSS') e.reds++;
    else e.greens++;
  }
  const bt = Object.entries(st.per)
    .map(([key, v]) => ({
      key,
      amostras: v.n,
      acertoPercent: Number(((v.w / v.n) * 100).toFixed(1)),
      assertividadePisoPercent: Number((wilsonLB(v.w, v.n) * 100).toFixed(1)),
      testeAmostras: v.nt,
      testeAcertoPercent: v.nt ? Number(((v.wt / v.nt) * 100).toFixed(1)) : null,
      elegivel: v.n >= CFG.minAmostra
    }))
    .sort((a, b) => b.assertividadePisoPercent - a.assertividadePisoPercent)
    .slice(0, 60);
  res.json({
    sucesso: true,
    placarDia: placar(),
    taxaBaseGale2Percent: st.baseRate ? Number((st.baseRate * 100).toFixed(1)) : null,
    aviso: 'Assertividade = limite inferior de Wilson (95%) do backtest. Não é garantia.',
    backtest: bt,
    ao_vivo_por_estrategia: aoVivo
  });
});

app.post('/admin/sincronizar', admin, async (_req, res) => res.json(await syncOnce()));

app.post('/admin/forcar-sinal', admin, (_req, res) => {
  if (pendente()) return res.status(409).json({ sucesso: false, erro: 'Há um sinal aberto' });
  if (!S.hist.length) return res.status(409).json({ sucesso: false, erro: 'Sem histórico' });
  criarSinal(S.hist[S.hist.length - 1]);
  res.json({ sucesso: true, sinal: R.ultimoSinal });
});

app.post('/admin/telegram-teste', admin, async (_req, res) => {
  const r = await tgCall('sendMessage', {
    text: `🎲 <b>CAPUNGA · BAC BO</b>\n✅ Ligação Telegram OK\n🕒 ${hora()}`,
    parse_mode: 'HTML'
  });
  res.status(r.ok ? 200 : 502).json({ sucesso: r.ok, erro: R.erroTelegram });
});

app.post('/admin/reset', admin, async (req, res) => {
  if (req.body?.confirmar !== 'APAGAR') return res.status(400).json({ sucesso: false, erro: 'Envie {"confirmar":"APAGAR"}' });
  try {
    S.hist = []; S.seen = new Set(); S.signals = []; S.stats = null; S.statsAtLen = -1;
    S.nextId = CFG.sinalInicial;
    if (pool) {
      await dbChain;
      await pool.query('DROP TABLE IF EXISTS g2_sinais, g2_rodadas');
      await ensureSchema();
    }
    res.json({ sucesso: true, mensagem: 'Base apagada. O robô vai reimportar o histórico.' });
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
      max: 4, idleTimeoutMillis: 20000, connectionTimeoutMillis: 12000
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
    log('START', { porta: PORT, estrategias: STRATS.length, maxGale: MAX_GALE, slotMin: 5, proximoSlotEmSeg: proximoSlotEmSeg() })
  );

  const first = await syncOnce();
  log('PRIMEIRA_SYNC', first);
  if (S.hist.length >= 10) getStats(true);
  agendarSync();
  slotTimer = setInterval(tentarSlot, 1000);
  startKeepAlive();
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (syncTimer) clearTimeout(syncTimer);
  if (slotTimer) clearInterval(slotTimer);
  if (keepTimer) clearInterval(keepTimer);
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
