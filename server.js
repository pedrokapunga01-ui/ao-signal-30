'use strict';

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT || 10000);
const DATABASE_URL = process.env.DATABASE_URL || '';
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || '';
const API_BACBO = process.env.API_BACBO || 'https://api-cs.casino.org/svc-evolution-game-events/api/bacbo';

const MAX_GALE = Number(process.env.MAX_GALE || 2);
const MIN_INTERVAL_MS = Number(process.env.INTERVALO_MINIMO_MS || 40000);
const MAX_REDS_DAY = Number(process.env.MAX_REDS_DIA || 12);
const TIE_PROTECTED = (process.env.EMPATE_PROTEGIDO || 'true') === 'true';
const SYNC_INTERVAL_MS = Number(process.env.INTERVALO_SYNC_MS || 7000);

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/i.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000
    })
  : null;

const runtime = {
  startedAt: new Date().toISOString(),
  cycles: 0,
  lastError: null,
  lastSync: null,
  reason: 'starting',
  lastSignal: null
};

let syncTimer = null;

function log(tag, data) {
  console.log(`[${tag}]`, typeof data === 'string' ? data : JSON.stringify(data));
}

function angolaTime() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Luanda',
    dateStyle: 'short',
    timeStyle: 'medium',
    hour12: false
  }).format(new Date());
}

function colorDisplay(color) {
  if (color === 'Banca') return '🔴 BANKER';
  if (color === 'Jogador') return '🔵 PLAYER';
  return String(color || '');
}

function opposite(color) {
  if (color === 'Banca') return 'Jogador';
  if (color === 'Jogador') return 'Banca';
  return null;
}

function normalizeOutcome(value) {
  if (value && typeof value === 'object') {
    value = value.outcome ?? value.resultado ?? value.winner ?? value.name;
  }
  const s = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');

  if (['player', 'jogador', 'playerwin', 'playerwins', 'playerwon', 'playerwinner'].includes(s)) return 'Jogador';
  if (['banker', 'banca', 'bankerwin', 'bankerwins', 'bankerwon', 'bankerwinner', 'red', 'vermelho'].includes(s)) return 'Banca';
  if (['tie', 'draw', 'empate', 'equal', 'push', 'tied'].includes(s)) return 'Empate';
  return null;
}

function validDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function extractItems(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  const candidates = [
    body.data, body.results, body.items, body.resultados, body.rounds, body.events,
    body.data?.results, body.data?.items, body.data?.rounds, body.data?.events
  ];
  return candidates.find(Array.isArray) || [];
}

function normalizeRound(item) {
  const d = item?.data || item?.round || item || {};
  const r = (d.result && typeof d.result === 'object') ? d.result : (item?.result && typeof item.result === 'object' ? item.result : {});
  const status = String(d.status ?? item?.status ?? '').toLowerCase();
  const fim = validDate(d.settledAt ?? d.endTime ?? d.endedAt ?? d.finishedAt ?? d.fim ?? item?.settledAt);
  const raw = r.outcome ?? r.resultado ?? r.winner ?? d.outcome ?? d.resultado ?? item?.outcome ?? item?.resultado ?? (typeof d.result === 'string' ? d.result : null);
  const resultado = normalizeOutcome(raw);
  const resolvida = ['resolved', 'settled', 'finished', 'complete', 'resolvido', 'finalizado'].some(w => status.includes(w)) || Boolean(fim);
  const id = String(d.id ?? d.roundId ?? d.round_id ?? item?.id ?? item?.roundId ?? '').trim();
  if (!id || !resultado || !resolvida || !fim) return null;

  const pj = Number(r.playerDice?.score ?? d.playerDice?.score ?? d.playerScore ?? d.pontos_jogador);
  const pb = Number(r.bankerDice?.score ?? d.bankerDice?.score ?? d.bankerScore ?? d.pontos_banca);

  return {
    id,
    resultado,
    inicio: validDate(d.startedAt ?? d.startTime) || fim,
    fim,
    pontos_jogador: Number.isFinite(pj) ? pj : null,
    pontos_banca: Number.isFinite(pb) ? pb : null
  };
}

async function telegramSend(text) {
  if (!BOT_TOKEN || !CHAT_ID) return false;
  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: CHAT_ID, text, disable_web_page_preview: true },
      { timeout: 14000 }
    );
    return res.data?.ok === true;
  } catch (e) {
    console.error('[TELEGRAM]', e.response?.data || e.message);
    return false;
  }
}

async function ensureSchema() {
  if (!pool) throw new Error('DATABASE_URL not configured');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bacbo_rodadas (
      id TEXT PRIMARY KEY,
      resultado TEXT NOT NULL,
      inicio TIMESTAMPTZ,
      fim TIMESTAMPTZ,
      pontos_jogador INTEGER,
      pontos_banca INTEGER,
      guardado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      seq BIGSERIAL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bacbo_rodadas_fim ON bacbo_rodadas (fim DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bacbo_sinais (
      id BIGSERIAL PRIMARY KEY,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      cor TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'PENDENTE',
      gale INTEGER NOT NULL DEFAULT 0,
      resultado_id TEXT,
      resultado_final TEXT,
      empates INTEGER NOT NULL DEFAULT 0,
      estrategia TEXT,
      nome_estrategia TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sinais_estado ON bacbo_sinais (estado)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sinais_criado ON bacbo_sinais (criado_em DESC)`);
}

async function fetchRounds() {
  const res = await axios.get(API_BACBO, {
    timeout: 16000,
    headers: { Accept: 'application/json', 'User-Agent': 'CapungaDados/4.3' }
  });
  const items = extractItems(res.data);
  const map = new Map();
  for (const item of items) {
    const r = normalizeRound(item);
    if (r) map.set(r.id, r);
  }
  return [...map.values()].sort((a, b) => new Date(a.fim) - new Date(b.fim));
}

async function getRecent(limit = 22) {
  const { rows } = await pool.query(
    `SELECT * FROM bacbo_rodadas
     WHERE resultado IN ('Jogador','Banca')
     ORDER BY fim DESC, seq DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

async function getPending() {
  const { rows } = await pool.query(
    `SELECT * FROM bacbo_sinais WHERE estado = 'PENDENTE' ORDER BY criado_em ASC LIMIT 1`
  );
  return rows[0] || null;
}

async function getScoreboard() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE estado = 'GREEN')::int AS green,
      COUNT(*) FILTER (WHERE estado = 'G1')::int AS g1,
      COUNT(*) FILTER (WHERE estado = 'G2')::int AS g2,
      COUNT(*) FILTER (WHERE estado = 'LOSS')::int AS loss,
      COALESCE(SUM(empates),0)::int AS ties
    FROM bacbo_sinais
    WHERE criado_em >= date_trunc('day', NOW() AT TIME ZONE 'Africa/Luanda')
      AND estado IN ('GREEN','G1','G2','LOSS')
  `);
  const s = rows[0] || { green: 0, g1: 0, g2: 0, loss: 0, ties: 0 };
  const wins = s.green + s.g1 + s.g2;
  const total = wins + s.loss;
  const percent = total > 0 ? Number(((wins / total) * 100).toFixed(1)) : 100;

  const recent = await pool.query(`
    SELECT estado FROM bacbo_sinais
    WHERE criado_em >= date_trunc('day', NOW() AT TIME ZONE 'Africa/Luanda')
      AND estado IN ('GREEN','G1','G2','LOSS')
    ORDER BY criado_em DESC LIMIT 30
  `);
  let streak = 0;
  for (const r of recent.rows) {
    if (['GREEN', 'G1', 'G2'].includes(r.estado)) streak++;
    else break;
  }
  return { ...s, percent, streak };
}

async function redsToday() {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS total FROM bacbo_sinais
    WHERE estado = 'LOSS'
      AND criado_em >= date_trunc('day', NOW() AT TIME ZONE 'Africa/Luanda')
  `);
  return rows[0]?.total || 0;
}

/* ========== STRATEGIES ========== */

function streakLen(rows) {
  if (!rows.length) return 0;
  const c = rows[0].resultado;
  if (!['Jogador', 'Banca'].includes(c)) return 0;
  let n = 0;
  for (const r of rows) {
    if (r.resultado === c) n++;
    else break;
  }
  return n;
}

function stratAntiStreak(rows) {
  const n = streakLen(rows);
  if (n < 2) return null;
  const color = opposite(rows[0].resultado);
  if (!color) return null;
  return {
    cor: color,
    estrategia: 'ANTI_STREAK',
    nome: `Anti-Streak x${n}`,
    emoji: '🔄',
    prioridade: Math.min(92, 65 + n * 8)
  };
}

function stratTrend(rows) {
  const sample = rows.slice(0, 8);
  if (sample.length < 6) return null;
  let j = 0, b = 0;
  for (const r of sample) {
    if (r.resultado === 'Jogador') j++;
    else b++;
  }
  const total = j + b;
  if (b / total >= 0.60) return { cor: 'Banca', estrategia: 'TREND', nome: `Trend Banker ${Math.round(b / total * 100)}%`, emoji: '📈', prioridade: 84 };
  if (j / total >= 0.60) return { cor: 'Jogador', estrategia: 'TREND', nome: `Trend Player ${Math.round(j / total * 100)}%`, emoji: '📈', prioridade: 84 };
  return null;
}

function stratPattern(rows) {
  if (rows.length < 3) return null;
  const [a, b, c] = rows.map(r => r.resultado);
  if (![a, b, c].every(x => ['Jogador', 'Banca'].includes(x))) return null;

  if (a === b && b === c) return { cor: opposite(a), estrategia: 'PATTERN', nome: 'Pattern AAA → Reverse', emoji: '🎯', prioridade: 86 };
  if (a === c && a !== b) return { cor: a, estrategia: 'PATTERN', nome: 'Pattern ABA', emoji: '🎯', prioridade: 78 };
  if (a === b && a !== c) return { cor: a, estrategia: 'PATTERN', nome: 'Pattern AAB', emoji: '🎯', prioridade: 76 };
  if (a !== b && b === c) return { cor: a, estrategia: 'PATTERN', nome: 'Pattern BBA → Continue', emoji: '🎯', prioridade: 72 };
  return null;
}

function stratScore(rows) {
  if (!rows.length) return null;
  const last = rows[0];
  const pj = Number(last.pontos_jogador);
  const pb = Number(last.pontos_banca);
  if (!Number.isFinite(pj) || !Number.isFinite(pb)) return null;

  if (last.resultado === 'Jogador' && pj >= 8) {
    return { cor: 'Jogador', estrategia: 'SCORE', nome: `Strong Score P(${pj})`, emoji: '💪', prioridade: 79 };
  }
  if (last.resultado === 'Banca' && pb >= 8) {
    return { cor: 'Banca', estrategia: 'SCORE', nome: `Strong Score B(${pb})`, emoji: '💪', prioridade: 79 };
  }
  return null;
}

function stratMomentum(rows) {
  const sample = rows.slice(0, 4);
  if (sample.length < 4) return null;
  let j = 0, b = 0;
  for (const r of sample) {
    if (r.resultado === 'Jogador') j++;
    else b++;
  }
  if (b >= 3) return { cor: 'Banca', estrategia: 'MOMENTUM', nome: 'Momentum Banker', emoji: '⚡', prioridade: 75 };
  if (j >= 3) return { cor: 'Jogador', estrategia: 'MOMENTUM', nome: 'Momentum Player', emoji: '⚡', prioridade: 75 };
  return null;
}

function stratFallback(rows) {
  if (!rows.length) return null;
  const last = rows[0].resultado;
  if (!['Jogador', 'Banca'].includes(last)) return null;
  return {
    cor: last,
    estrategia: 'FALLBACK',
    nome: 'Follow Last',
    emoji: '🎲',
    prioridade: 45
  };
}

function detectBest(rows) {
  const candidates = [
    stratAntiStreak(rows),
    stratTrend(rows),
    stratPattern(rows),
    stratScore(rows),
    stratMomentum(rows),
    stratFallback(rows)
  ].filter(Boolean);

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.prioridade - a.prioridade);
  return candidates[0];
}

/* ========== MESSAGES ========== */

function msgEntry(entry) {
  return [
    '🎯  CAPUNGA DADOS  🎯',
    '━━━━━━━━━━━━━━━━━━',
    '🔔  NEW ENTRY',
    '━━━━━━━━━━━━━━━━━━',
    '',
    `➡️  ${colorDisplay(entry.cor)}`,
    '',
    `${entry.emoji}  ${entry.nome}`,
    `🛡️  Tie Protection`,
    `🐓  Max Gale: ${MAX_GALE}`,
    '',
    `🕒  ${angolaTime()}`,
    '━━━━━━━━━━━━━━━━━━',
    '💎 Bankroll management required'
  ].join('\n');
}

function msgGreen(signal, state) {
  const title = state === 'GREEN' ? '✅  GREEN (No Gale)' : state === 'G1' ? '⚡  GREEN GALE 1' : '🔥  GREEN GALE 2';
  return [
    '🎯  CAPUNGA DADOS  🎯',
    '────────────────────',
    title,
    '────────────────────',
    `➡️  ${colorDisplay(signal.cor)}`,
    `📌  ${signal.nome_estrategia || signal.estrategia}`,
    `🔢  #${signal.id}`,
    `🕒  ${angolaTime()}`
  ].join('\n');
}

function msgLoss(signal) {
  return [
    '🎯  CAPUNGA DADOS  🎯',
    '────────────────────',
    '❌  FINAL LOSS',
    '────────────────────',
    `➡️  ${colorDisplay(signal.cor)}`,
    `🐓  Gale \( {signal.gale}/ \){MAX_GALE}`,
    `🔢  #${signal.id}`,
    `🕒  ${angolaTime()}`
  ].join('\n');
}

function msgGale(signal, gale) {
  return [
    '🎯  CAPUNGA DADOS  🎯',
    '────────────────────',
    `🐓  GALE ${gale}`,
    '────────────────────',
    `➡️  Keep ${colorDisplay(signal.cor)}`,
    `🔢  #${signal.id}`,
    `🕒  ${angolaTime()}`
  ].join('\n');
}

function msgTie(signal) {
  return [
    '🎯  CAPUNGA DADOS  🎯',
    '────────────────────',
    '🟡  TIE PROTECTED',
    '────────────────────',
    `Signal #${signal.id} still active`,
    `➡️  ${colorDisplay(signal.cor)}`,
    `🕒  ${angolaTime()}`
  ].join('\n');
}

function formatScoreboard(p) {
  return [
    '',
    '────────────────────',
    '🏆  CAPUNGA SCOREBOARD  🏆',
    '────────────────────',
    `✅ GREEN  ${p.green}   ⚡ G1  ${p.g1}`,
    `🔥 G2     ${p.g2}   🟡 Ties ${p.ties}`,
    `❌ LOSS   ${p.loss}`,
    `📊 ${p.percent}%  |  🚀 Streak ${p.streak}`,
    '────────────────────'
  ].join('\n');
}

/* ========== CORE LOGIC ========== */

async function resolveSignal(round) {
  const signal = await getPending();
  if (!signal) return;

  if (round.resultado === 'Empate') {
    if (!TIE_PROTECTED) return;
    await pool.query(`UPDATE bacbo_sinais SET empates = COALESCE(empates,0)+1 WHERE id = $1`, [signal.id]);
    await telegramSend(msgTie(signal));
    return;
  }

  if (round.resultado === signal.cor) {
    const gale = Number(signal.gale || 0);
    const state = gale === 0 ? 'GREEN' : gale === 1 ? 'G1' : 'G2';
    await pool.query(`UPDATE bacbo_sinais SET estado = $1, resultado_final = $2 WHERE id = $3`, [state, round.resultado, signal.id]);
    const board = await getScoreboard();
    await telegramSend(msgGreen(signal, state) + formatScoreboard(board));
    return;
  }

  const nextGale = Number(signal.gale || 0) + 1;
  if (nextGale <= MAX_GALE) {
    await pool.query(`UPDATE bacbo_sinais SET gale = $1 WHERE id = $2`, [nextGale, signal.id]);
    await telegramSend(msgGale(signal, nextGale));
    return;
  }

  await pool.query(`UPDATE bacbo_sinais SET estado = 'LOSS', resultado_final = $1 WHERE id = $2`, [round.resultado, signal.id]);
  const board = await getScoreboard();
  await telegramSend(msgLoss(signal) + formatScoreboard(board));
}

async function tryCreateSignal(round) {
  const pending = await getPending();
  if (pending) {
    runtime.reason = `pending #${pending.id}`;
    return;
  }

  const reds = await redsToday();
  if (reds >= MAX_REDS_DAY) {
    runtime.reason = `reds limit ${reds}`;
    return;
  }

  const { rows: last } = await pool.query(`SELECT criado_em FROM bacbo_sinais ORDER BY criado_em DESC LIMIT 1`);
  if (last[0] && Date.now() - new Date(last[0].criado_em).getTime() < MIN_INTERVAL_MS) {
    runtime.reason = 'min interval';
    return;
  }

  const recent = await getRecent(22);
  const entry = detectBest(recent);
  if (!entry) {
    runtime.reason = 'no setup';
    return;
  }

  const { rows: already } = await pool.query(`SELECT 1 FROM bacbo_sinais WHERE resultado_id = $1 LIMIT 1`, [round.id]);
  if (already.length) {
    runtime.reason = 'round already used';
    return;
  }

  const { rows } = await pool.query(
    `INSERT INTO bacbo_sinais (cor, estado, gale, resultado_id, estrategia, nome_estrategia)
     VALUES ($1, 'PENDENTE', 0, $2, $3, $4) RETURNING *`,
    [entry.cor, round.id, entry.estrategia, entry.nome]
  );

  const signal = rows[0];
  runtime.lastSignal = { id: signal.id, cor: signal.cor, estrategia: entry.estrategia };
  runtime.reason = null;
  await telegramSend(msgEntry(entry));
  log('SIGNAL', { id: signal.id, color: entry.cor, strategy: entry.estrategia });
}

async function syncOnce() {
  if (!pool) return;
  try {
    await ensureSchema();
    const rounds = await fetchRounds();
    let newRounds = 0;

    for (const round of rounds) {
      const result = await pool.query(
        `INSERT INTO bacbo_rodadas (id, resultado, inicio, fim, pontos_jogador, pontos_banca)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
        [round.id, round.resultado, round.inicio, round.fim, round.pontos_jogador, round.pontos_banca]
      );
      if (result.rowCount === 0) continue;

      newRounds++;
      await resolveSignal(round);
      await tryCreateSignal(round);
    }

    if (newRounds === 0) {
      const pend = await getPending();
      if (pend && Date.now() - new Date(pend.criado_em).getTime() > 4 * 60 * 1000) {
        await pool.query(`UPDATE bacbo_sinais SET estado = 'CANCELADO' WHERE id = $1`, [pend.id]);
        await telegramSend(`⏳ CAPUNGA • Signal #${pend.id} expired\n🕒 ${angolaTime()}`);
        runtime.reason = 'signal expired';
      } else if (pend) {
        runtime.reason = `waiting #${pend.id}`;
      } else {
        runtime.reason = 'no new rounds';
      }
    }

    runtime.lastSync = new Date().toISOString();
    runtime.cycles++;
    runtime.lastError = null;
  } catch (e) {
    runtime.lastError = e.message;
    console.error('[SYNC]', e.message);
  }
}

/* ========== ROUTES ========== */

app.get('/', (req, res) => {
  res.json({ name: 'CAPUNGA DADOS — BAC BO', status: 'online', time: angolaTime() });
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'online',
    time: angolaTime(),
    reason: runtime.reason,
    lastSync: runtime.lastSync,
    cycles: runtime.cycles,
    lastError: runtime.lastError,
    telegramConfigured: Boolean(BOT_TOKEN && CHAT_ID)
  });
});

app.get('/status', async (req, res) => {
  let totalRounds = 0;
  let pending = 0;
  try {
    if (pool) {
      totalRounds = (await pool.query('SELECT COUNT(*)::int AS t FROM bacbo_rodadas')).rows[0].t;
      pending = (await pool.query(`SELECT COUNT(*)::int AS t FROM bacbo_sinais WHERE estado = 'PENDENTE'`)).rows[0].t;
    }
  } catch (_) {}

  res.json({
    name: 'CAPUNGA DADOS — BAC BO',
    status: 'online',
    startedAt: runtime.startedAt,
    cycles: runtime.cycles,
    reason: runtime.reason,
    lastSignal: runtime.lastSignal,
    totalRounds,
    pending,
    lastError: runtime.lastError,
    time: angolaTime()
  });
});

/* ========== START ========== */

async function start() {
  if (!DATABASE_URL) {
    console.error('DATABASE_URL not configured');
    process.exit(1);
  }
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('BOT_TOKEN or CHAT_ID not configured');
    process.exit(1);
  }

  await ensureSchema();
  console.log('[DB] Tables ready');

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[HTTP] CAPUNGA DADOS running on port ${PORT}`);
    console.log(`[TIME] ${angolaTime()}`);
  });

  await syncOnce();
  syncTimer = setInterval(syncOnce, SYNC_INTERVAL_MS);
  if (typeof syncTimer.unref === 'function') syncTimer.unref();
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('unhandledRejection', (e) => console.error('[UNHANDLED]', e));
process.on('uncaughtException', (e) => console.error('[UNCAUGHT]', e));

start().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});
