'use strict';

/**
 * CAPUNGA DADOS — BAC BO · v8 (SEM GALE · SEM PROTEÇÃO DE EMPATE)
 *
 *  - Cada sinal = 1 única entrada. Green só se sair a cor indicada. Empate = RED.
 *  - Estratégias: apenas padrões de cor simples, medidos em backtest com o histórico real.
 *  - A taxa mostrada na mensagem é a taxa REAL medida no histórico (e o piso estatístico de Wilson).
 *    Nunca é inflacionada. Neste jogo cada rodada é independente: nenhuma estratégia garante acerto.
 *  - Cadência: intervalo aleatório entre INTERVALO_MIN_MS (2 min) e INTERVALO_MAX_MS (5 min).
 *  - Fila de Telegram com retry.
 *
 * Variáveis: BOT_TOKEN, CHAT_ID · DATABASE_URL (opcional) · ADMIN_TOKEN
 *  INTERVALO_MIN_MS (120000) · INTERVALO_MAX_MS (300000) · MIN_AMOSTRA (100)
 *  SYNC_MS (3000) · SINAL_EXPIRA_MIN (5) · SINAL_INICIAL (1704) · SINAIS_ATIVOS · API_BACBO
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

const CFG = {
  ativos: bool(process.env.SINAIS_ATIVOS, true),
  intMinMs: num('INTERVALO_MIN_MS', 120000, 0, 3600000),
  intMaxMs: num('INTERVALO_MAX_MS', 300000, 0, 3600000),
  minAmostra: num('MIN_AMOSTRA', 100, 30, 5000),
  syncMs: num('SYNC_MS', 3000, 2000, 30000),
  expiraMin: num('SINAL_EXPIRA_MIN', 5, 2, 60),
  sinalInicial: num('SINAL_INICIAL', 1704, 1, 100000000),
  maxHist: 5000,
  gapMs: 6 * 60 * 1000,
  frescoMs: 5 * 60 * 1000
};
if (CFG.intMaxMs < CFG.intMinMs) CFG.intMaxMs = CFG.intMinMs;

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
  lastSignalAt: 0,
  proximoEm: 0,
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

const sorteiaIntervalo = () =>
  CFG.intMinMs + Math.floor(Math.random() * (CFG.intMaxMs - CFG.intMinMs + 1));

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

/* ============================ API / NORMALIZAÇÃO ============================ */

function normalizeOutcome(v) {
  if (v && typeof v === 'object') v = v.outcome ?? v.resultado ?? v.winner ?? v.name;
  const s = String(v ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
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
        headers: { Accept: 'application/json', 'User-Agent': 'CapungaDadosBot/8.0' }
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
/* Só padrões de cor (testáveis só com o resultado). Todos são avaliados no backtest
   do histórico guardado; a taxa real aparece na mensagem. `seq` = só Jogador/Banca,
   mais recente primeiro. */

function streak(seq) {
  if (!seq.length) return 0;
  let n = 0;
  for (const r of seq) {
    if (r.resultado === seq[0].resultado) n++;
    else break;
  }
  return n;
}

const STRATS = [
  function repeticao({ seq }) {
    const n = streak(seq);
    if (n < 2 || n > 7) return null;
    return { cor: seq[0].resultado, key: `REPETICAO_${n}`, nome: `Repetição x${n}`, emoji: '🔁' };
  },
  function quebra({ seq }) {
    const n = streak(seq);
    if (n < 3 || n > 8) return null;
    return { cor: opp(seq[0].resultado), key: `QUEBRA_${n}`, nome: `Quebra após x${n}`, emoji: '💥' };
  },
  function alternancia({ seq }) {
    if (seq.length < 4) return null;
    let L = 1;
    while (L < seq.length && seq[L].resultado !== seq[L - 1].resultado) L++;
    if (L < 3) return null;
    const k = Math.min(L, 7);
    return { cor: opp(seq[0].resultado), key: `ALTERNANCIA_${k}`, nome: `Alternância x${k}`, emoji: '🌊' };
  },
  function doisDois({ seq }) {
    if (seq.length < 4) return null;
    const [a, b, c, d] = seq.map((x) => x.resultado);
    if (a === b && c === d && a !== c) return { cor: c, key: 'DOIS_DOIS', nome: 'Blocos 2+2', emoji: '♟️' };
    return null;
  }
];

function runStrategies(rows) {
  const ctx = { rows, seq: rows.filter((r) => isCol(r.resultado)) };
  const out = [];
  for (const fn of STRATS) {
    try {
      const c = fn(ctx);
      if (c && isCol(c.cor)) out.push(c);
    } catch (_) { /* ignora */ }
  }
  return out;
}

/* ============================ BACKTEST ============================ */

function windowAt(H, i) {
  const rows = [];
  for (let j = i; j >= 0 && rows.length < 24; j--) {
    if (rows.length && rows[rows.length - 1].t - H[j].t > CFG.gapMs) break;
    rows.push(H[j]);
  }
  return rows;
}

/** SEM GALE: true só se a PRÓXIMA rodada for a cor. Empate = false. null = sem dados. */
function evalEntry(H, i, cor) {
  const idx = i + 1;
  if (idx >= H.length) return null;
  if (H[idx].t - H[idx - 1].t > CFG.gapMs) return null;
  return H[idx].resultado === cor;
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
  if (!S.stats || S.hist.length - S.statsAtLen >= 25) {
    S.stats = backtest();
    S.statsAtLen = S.hist.length;
  }
  return S.stats;
}

function wilsonLB(w, n, z = 1.96) {
  if (!n) return 0;
  const p = w / n;
  const z2 = z * z;
  const c = p + z2 / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return (c - m) / (1 + z2 / n);
}

const FECHADOS = ['GREEN', 'LOSS'];

/** suspende padrão que está pior ao vivo (últimos 15 sinais fechados, ≥10, <35% de acerto) */
function suspensoAoVivo(key) {
  const L = S.signals.filter((x) => x.key === key && FECHADOS.includes(x.estado)).slice(-15);
  if (L.length < 10) return false;
  return L.filter((x) => x.estado === 'GREEN').length / L.length < 0.35;
}

/** escolhe o padrão ativo com melhor piso estatístico (Wilson) e amostra mínima */
function pickEntry(rows) {
  const st = getStats();
  const cands = runStrategies(rows)
    .map((c) => {
      const e = st.per[c.key] || { n: 0, w: 0 };
      return {
        ...c,
        amostra: e.n,
        taxa: e.n ? (e.w / e.n) * 100 : 0,
        piso: wilsonLB(e.w, e.n) * 100
      };
    })
    .filter((c) => c.amostra >= CFG.minAmostra && !suspensoAoVivo(c.key));

  if (!cands.length) return null;

  const grupos = { [J]: [], [B]: [] };
  for (const c of cands) grupos[c.cor].push(c);
  const top = (arr) => (arr.length ? Math.max(...arr.map((c) => c.piso)) : -1);
  const sJ = top(grupos[J]);
  const sB = top(grupos[B]);
  if (sJ >= 0 && sB >= 0 && Math.abs(sJ - sB) < 0.5) return { conflito: true };

  const arr = sJ > sB ? grupos[J] : grupos[B];
  arr.sort((a, b) => b.piso - a.piso || b.amostra - a.amostra);
  return { ...arr[0], consenso: arr.length, base: st.baseRate ? st.baseRate * 100 : null };
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
    CREATE TABLE IF NOT EXISTS bb_rodadas (
      id TEXT PRIMARY KEY, resultado TEXT NOT NULL, fim TIMESTAMPTZ NOT NULL,
      pj INTEGER, pb INTEGER, mult TEXT
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bb_rodadas_fim ON bb_rodadas (fim DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bb_sinais (
      id BIGINT PRIMARY KEY, criado_em TIMESTAMPTZ NOT NULL, cor TEXT NOT NULL,
      estrategia TEXT, nome TEXT, confianca INTEGER, estado TEXT NOT NULL,
      gale INTEGER NOT NULL DEFAULT 0, empate BOOLEAN NOT NULL DEFAULT FALSE,
      resultado_final TEXT, resolvido_em TIMESTAMPTZ, base_id TEXT
    )`);
  await pool.query(`ALTER TABLE bb_sinais ADD COLUMN IF NOT EXISTS empate_gale INTEGER`);
  await pool.query(`ALTER TABLE bb_sinais ADD COLUMN IF NOT EXISTS empate_mult TEXT`);
  await pool.query(`ALTER TABLE bb_sinais ADD COLUMN IF NOT EXISTS taxa INTEGER`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bb_sinais_criado ON bb_sinais (criado_em DESC)`);
}

async function loadFromDB() {
  const rr = await pool.query(
    `SELECT id, resultado, fim, pj, pb, mult FROM bb_rodadas ORDER BY fim DESC LIMIT $1`, [CFG.maxHist]
  );
  S.hist = rr.rows
    .map((x) => ({ id: x.id, resultado: x.resultado, t: new Date(x.fim).getTime(), pj: x.pj, pb: x.pb, mult: x.mult }))
    .sort((a, b) => a.t - b.t);
  S.seen = new Set(S.hist.map((x) => x.id));

  const sr = await pool.query(`SELECT * FROM bb_sinais WHERE criado_em >= NOW() - INTERVAL '36 hours' ORDER BY id ASC`);
  S.signals = sr.rows.map((x) => ({
    id: Number(x.id),
    criadoMs: new Date(x.criado_em).getTime(),
    cor: x.cor,
    key: x.estrategia,
    nome: x.nome,
    confianca: x.confianca,
    estado: ['GREEN', 'LOSS', 'PENDENTE', 'CANCELADO'].includes(x.estado) ? x.estado : (x.estado === 'EMPATE' ? 'GREEN' : x.estado === 'G1' ? 'GREEN' : x.estado),
    empate: x.empate,
    taxa: x.taxa,
    resultadoFinal: x.resultado_final,
    resolvidoMs: x.resolvido_em ? new Date(x.resolvido_em).getTime() : null,
    baseId: x.base_id,
    legado: ['G1', 'EMPATE'].includes(x.estado)
  }));

  const mx = await pool.query(`SELECT COALESCE(MAX(id), 0)::bigint AS m FROM bb_sinais`);
  const m = Number(mx.rows[0].m);
  S.nextId = m > 0 ? m + 1 : CFG.sinalInicial;

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
      `INSERT INTO bb_sinais (id, criado_em, cor, estrategia, nome, confianca, estado, gale, empate, resultado_final, resolvido_em, base_id, taxa)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         estado = EXCLUDED.estado, empate = EXCLUDED.empate,
         resultado_final = EXCLUDED.resultado_final, resolvido_em = EXCLUDED.resolvido_em`,
      [
        s.id, new Date(s.criadoMs), s.cor, s.key, s.nome, s.confianca, s.estado,
        Boolean(s.empate), s.resultadoFinal || null, s.resolvidoMs ? new Date(s.resolvidoMs) : null,
        s.baseId || null, s.taxa ?? null
      ]
    )
  );
}

/* ============================ TELEGRAM (fila + retry) ============================ */

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
    return { ok: false };
  }
}

async function tgRun() {
  tgRunning = true;
  while (tgQueue.length) {
    const m = tgQueue[0];
    const r = await tgCall('sendMessage', m.plain
      ? { text: stripHtml(m.text), disable_web_page_preview: true }
      : { text: m.text, parse_mode: 'HTML', disable_web_page_preview: true });

    if (r.ok) {
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

function tgSend(text) {
  tgQueue.push({ text, tries: 0, plain: false });
  R.telegramPendentes = tgQueue.length;
  if (!tgRunning) tgRun().catch((e) => { tgRunning = false; log('TG_FILA_ERRO', e.message); });
}

/* ============================ PLACAR / MENSAGENS ============================ */

function placar() {
  const hoje = dia();
  const L = S.signals.filter((s) => dia(s.criadoMs) === hoje && FECHADOS.includes(s.estado));
  const green = L.filter((s) => s.estado === 'GREEN').length;
  const loss = L.length - green;
  const lossEmp = L.filter((s) => s.estado === 'LOSS' && s.empate).length;
  const taxa = L.length ? (green / L.length) * 100 : 0;

  let seguidos = 0;
  for (let i = L.length - 1; i >= 0; i--) {
    if (L[i].estado !== 'GREEN') break;
    seguidos++;
  }
  return { green, loss, lossEmp, total: L.length, taxa, seguidos };
}

function msgPlacar(p) {
  return [
    '📊 <b>Balanço do dia</b>',
    `✅ ${p.green}  ·  ❌ ${p.loss}  ·  <b>${p.taxa.toFixed(1)}%</b>  <i>(${p.total} sinais)</i>`,
    `🟡 Reds por empate: ${p.lossEmp}  ·  🔥 Seguidos: ${p.seguidos}`
  ].join('\n');
}

function placarDados(r) {
  return Number.isFinite(r.pj) && Number.isFinite(r.pb) ? `  <i>(J ${r.pj} × ${r.pb} B)</i>` : '';
}

function msgEntrada(s) {
  return [
    `🎯 <b>SINAL #${s.id}</b>  ·  BAC BO`,
    '━━━━━━━━━━━━━━',
    `👉 Apostar em: ${corTxt(s.cor)}`,
    '🚫 <b>SEM GALE</b>  ·  1 única entrada',
    '⚠️ Empate = RED (sem proteção)',
    '━━━━━━━━━━━━━━',
    `${s.emoji} Padrão: ${esc(s.nome)}`,
    `📈 Histórico real: <b>${s.taxa}%</b> em ${s.amostra} casos`,
    s.base != null ? `📉 Média geral da cor: ${s.base.toFixed(1)}%` : null,
    `⏱ ${hora(s.criadoMs)} (Angola)`,
    '<i>Sem garantia de acerto. Cada rodada é independente. Aposte com gestão de banca.</i>'
  ].filter((x) => x !== null).join('\n');
}

function msgGreen(s, r) {
  return [
    `✅ <b>GREEN</b>  ·  #${s.id}`,
    `🎯 ${corCurta(s.cor)}  →  saiu ${corCurta(r.resultado)}${placarDados(r)}`,
    `${s.emoji} ${esc(s.nome)}`,
    `⏱ ${hora()}`,
    '',
    msgPlacar(placar())
  ].join('\n');
}

function msgRed(s, r) {
  const motivo = r.resultado === E ? '🟡 Saiu empate (sem proteção = red)' : null;
  return [
    `❌ <b>RED</b>  ·  #${s.id}`,
    `🎯 ${corCurta(s.cor)}  →  saiu ${corCurta(r.resultado)}${placarDados(r)}`,
    motivo,
    `${s.emoji} ${esc(s.nome)}`,
    `⏱ ${hora()}`,
    '',
    msgPlacar(placar())
  ].filter((x) => x !== null).join('\n');
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
  tgSend(`⏰ <b>SINAL #${s.id} CANCELADO</b>\nSem rodadas novas da mesa. Não conta no balanço.\n⏱ ${hora()}`);
  log('SINAL_EXPIRADO', { id: s.id });
  return true;
}

/** resolve o sinal com a 1ª rodada posterior. Devolve true se fechou. */
function resolver(r) {
  const s = pendente();
  if (!s) return false;
  if (r.t <= s.baseT || r.id === s.baseId) return false;

  s.resultadoFinal = r.resultado;
  s.resolvidoMs = Date.now();
  if (r.resultado === s.cor) {
    s.estado = 'GREEN';
    s.empate = false;
    dbSaveSignal(s);
    tgSend(msgGreen(s, r));
    log('GREEN', { id: s.id });
  } else {
    s.estado = 'LOSS';
    s.empate = r.resultado === E;
    dbSaveSignal(s);
    tgSend(msgRed(s, r));
    log('RED', { id: s.id, empate: s.empate });
  }
  S.proximoEm = Date.now() + sorteiaIntervalo();
  return true;
}

function criarSinal(ultima) {
  if (!CFG.ativos) return (R.ultimoMotivo = 'sinais_desativados');
  if (pendente()) return (R.ultimoMotivo = 'sinal_em_andamento');
  if (Date.now() < S.proximoEm) return (R.ultimoMotivo = 'aguardando_cadencia');
  if (Date.now() - ultima.t > CFG.frescoMs) return (R.ultimoMotivo = 'rodada_desatualizada');

  const rows = windowAt(S.hist, S.hist.length - 1);
  if (rows.length < 6) return (R.ultimoMotivo = 'historico_curto');

  const e = pickEntry(rows);
  if (!e) return (R.ultimoMotivo = 'sem_padrao_com_amostra_suficiente');
  if (e.conflito) return (R.ultimoMotivo = 'padroes_em_conflito');

  const s = {
    id: S.nextId++,
    criadoMs: Date.now(),
    cor: e.cor,
    key: e.key,
    nome: e.nome,
    emoji: e.emoji,
    confianca: Math.floor(e.piso),
    taxa: Math.round(e.taxa),
    amostra: e.amostra,
    base: e.base,
    estado: 'PENDENTE',
    empate: false,
    baseId: ultima.id,
    baseT: ultima.t
  };
  S.signals.push(s);
  if (S.signals.length > 1500) S.signals.splice(0, S.signals.length - 1500);
  S.lastSignalAt = s.criadoMs;
  R.ultimoSinal = { id: s.id, cor: s.cor, nome: s.nome, taxa: s.taxa, hora: hora(s.criadoMs) };
  R.ultimoMotivo = null;
  dbSaveSignal(s);
  tgSend(msgEntrada(s));
  log('SINAL', { id: s.id, cor: s.cor, key: s.key, taxa: s.taxa, n: s.amostra });
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
      S.proximoEm = Date.now() + sorteiaIntervalo();
      R.ultimoMotivo = 'base_historica_inicializada';
      log('BASE_INICIAL', { rodadas: fresh.length });
    } else if (live > 0 && ultimaViva && !fechou) {
      criarSinal(ultimaViva);
    } else if (fechou) {
      R.ultimoMotivo = 'a_aguardar_apos_resultado';
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
    nome: 'Capunga Dados — Bac Bo v8 (sem gale)',
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
    proximoSinalEmSeg: Math.max(0, Math.round((S.proximoEm - Date.now()) / 1000)),
    taxaBaseHistoricaPercent: st.baseRate ? Number((st.baseRate * 100).toFixed(1)) : null,
    amostrasBacktest: st.baseN,
    configuracao: { ...CFG, maxGale: 0 },
    placar: placar()
  });
});

app.get('/sinais', (req, res) => {
  const n = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 500);
  res.json({ sucesso: true, sinais: S.signals.slice(-n).reverse() });
});

app.get('/estatisticas', (_req, res) => {
  const st = getStats();
  const aoVivo = {};
  for (const s of S.signals) {
    if (!FECHADOS.includes(s.estado)) continue;
    const k = s.key || 'N/D';
    const e = aoVivo[k] || (aoVivo[k] = { sinais: 0, greens: 0, reds: 0 });
    e.sinais++;
    if (s.estado === 'GREEN') e.greens++;
    else e.reds++;
  }
  const backtest = Object.entries(st.per)
    .map(([key, v]) => ({
      key,
      amostras: v.n,
      acertoPercent: Number(((v.w / v.n) * 100).toFixed(1)),
      pisoWilsonPercent: Number((wilsonLB(v.w, v.n) * 100).toFixed(1)),
      elegivel: v.n >= CFG.minAmostra
    }))
    .sort((a, b) => b.pisoWilsonPercent - a.pisoWilsonPercent);
  res.json({
    sucesso: true,
    placarDia: placar(),
    taxaBasePercent: st.baseRate ? Number((st.baseRate * 100).toFixed(1)) : null,
    aviso: 'Sem gale e sem proteção de empate. Nenhum padrão garante acerto.',
    backtest,
    ao_vivo_por_estrategia: aoVivo
  });
});

app.post('/admin/sincronizar', admin, async (_req, res) => res.json(await syncOnce()));

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
    S.lastSignalAt = 0; S.proximoEm = 0; S.nextId = CFG.sinalInicial;
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
    log('START', { porta: PORT, estrategias: STRATS.length, gale: 0, intervaloMs: [CFG.intMinMs, CFG.intMaxMs] })
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
