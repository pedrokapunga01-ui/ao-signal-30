'use strict';

/**
 * CAPUNGA DADOS — BAC BO (Horário Fixo 4min) - VERSÃO 3.1 ESTÁVEL
 *
 * Sinais obrigatórios nos minutos: 0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56
 *
 * Estratégias:
 *   TENDENCIA | ANTI_STREAK | PADRAO_3 | SCORE_FORTE | MOMENTUM | FALLBACK
 */

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
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const API_BACBO = process.env.API_BACBO || 'https://api-cs.casino.org/svc-evolution-game-events/api/bacbo';

function boolEnv(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['true', '1', 'yes', 'sim', 'on'].includes(String(value).trim().toLowerCase());
}
function intEnv(name, fallback, min, max) {
  const n = Number.parseInt(process.env[name], 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

const CONFIG = {
  sinaisAtivos: boolEnv(process.env.SINAIS_ATIVOS, true),
  maxGale: intEnv('MAX_GALE', 2, 0, 3),
  empateProtegido: boolEnv(process.env.EMPATE_PROTEGIDO, true),
  maxRedsDia: intEnv('MAX_REDS_DIA', 12, 1, 50),
  intervaloSyncMs: intEnv('INTERVALO_SYNC_MS', 7000, 5000, 60000),
  minutosAlvo: [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56]
};

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
  iniciadoEm: new Date().toISOString(),
  sincronizacaoEmCurso: false,
  ultimaSincronizacao: null,
  ultimaRodadaNova: null,
  ultimoIdNovo: null,
  ultimaHoraDaAPI: null,
  quantidadeAPI: 0,
  itensRecebidosAPI: 0,
  novosUltimoCiclo: 0,
  erroSincronizacao: null,
  ultimoSinal: null,
  ultimaMensagemTelegram: null,
  ultimoErroTelegram: null,
  ultimoHTTPAPI: null,
  ultimoErroAPI: null,
  ciclosSemNovos: 0,
  motivoSemSinal: null,
  ultimaEstrategia: null
};

let schemaPromise = null;
let server = null;
let syncTimer = null;
let scheduleTimer = null;

function log(tag, data) {
  console.log(`[${tag}]`, typeof data === 'string' ? data : JSON.stringify(data));
}

function horaAngola() {
  return new Intl.DateTimeFormat('pt-PT', {
    timeZone: 'Africa/Luanda',
    dateStyle: 'short',
    timeStyle: 'medium',
    hour12: false
  }).format(new Date());
}

// Hora actual em Angola de forma fiável
function getAngolaParts() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Luanda',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(new Date());
  const get = (type) => parts.find(p => p.type === type)?.value;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: Number(get('minute')),
    second: Number(get('second'))
  };
}

function corDisplay(cor) {
  if (cor === 'Banca') return '🔴 BANCA';
  if (cor === 'Jogador') return '🔵 JOGADOR';
  return String(cor || '');
}

function oposta(cor) {
  if (cor === 'Banca') return 'Jogador';
  if (cor === 'Jogador') return 'Banca';
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

function validDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function extractItems(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  const candidates = [
    body.data, body.results, body.items, body.resultados, body.rounds, body.events,
    body.data?.results, body.data?.items, body.data?.resultados, body.data?.rounds,
    body.data?.events, body.data?.data
  ];
  return candidates.find(Array.isArray) || [];
}

function normalizeRound(item) {
  const d = item?.data || item?.round || item || {};
  const r = d.result && typeof d.result === 'object' ? d.result
    : item?.result && typeof item.result === 'object' ? item.result : {};
  const status = String(d.status ?? d.estado ?? item?.status ?? item?.estado ?? '').toLowerCase();
  const inicio = validDate(d.startedAt ?? d.startTime ?? d.started_at ?? d.inicio ?? item?.startedAt ?? item?.inicio);
  const fim = validDate(d.settledAt ?? d.endTime ?? d.endedAt ?? d.finishedAt ?? d.fim ?? item?.settledAt ?? item?.fim);
  const rawOutcome =
    r.outcome ?? r.resultado ?? r.winner ?? d.outcome ?? d.resultado ?? d.winner ??
    item?.outcome ?? item?.resultado ?? item?.winner ??
    (typeof d.result === 'string' ? d.result : null) ??
    (typeof item?.result === 'string' ? item.result : null);
  const resultado = normalizeOutcome(rawOutcome);
  const resolvida = ['resolved', 'settled', 'finished', 'complete', 'completed', 'resolvido', 'concluido', 'finalizado']
    .some((w) => status.includes(w)) || Boolean(fim);
  const id = String(d.id ?? d.roundId ?? d.round_id ?? d.eventId ?? item?.id ?? item?.roundId ?? item?.round_id ?? item?.eventId ?? '').trim();
  if (!id || !resultado || !resolvida || !fim) return null;
  const scoreJogador = Number(r.playerDice?.score ?? d.playerDice?.score ?? d.playerScore ?? d.player_score ?? d.pontos_jogador);
  const scoreBanca = Number(r.bankerDice?.score ?? d.bankerDice?.score ?? d.bankerScore ?? d.banker_score ?? d.pontos_banca);
  return {
    id,
    resultado,
    estado: 'Resolved',
    inicio: inicio || fim,
    fim,
    pontos_jogador: Number.isFinite(scoreJogador) ? scoreJogador : null,
    pontos_banca: Number.isFinite(scoreBanca) ? scoreBanca : null
  };
}

async function telegramSend(texto) {
  if (!BOT_TOKEN || !CHAT_ID) {
    runtime.ultimoErroTelegram = 'BOT_TOKEN ou CHAT_ID não configurado';
    return false;
  }
  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: CHAT_ID, text: texto, disable_web_page_preview: true },
      { timeout: 15000 }
    );
    if (response.data?.ok === true) {
      runtime.ultimaMensagemTelegram = new Date().toISOString();
      runtime.ultimoErroTelegram = null;
      return true;
    }
    runtime.ultimoErroTelegram = JSON.stringify(response.data);
    return false;
  } catch (error) {
    runtime.ultimoErroTelegram = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    console.error('[TELEGRAM]', runtime.ultimoErroTelegram);
    return false;
  }
}

async function ensureSchema() {
  if (!pool) throw new Error('DATABASE_URL não configurada');
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bacbo_resultados (
        id TEXT PRIMARY KEY,
        resultado TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'Resolved',
        inicio TIMESTAMPTZ,
        fim TIMESTAMPTZ,
        pontos_jogador INTEGER,
        pontos_banca INTEGER,
        multiplicador TEXT,
        guardado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        seq BIGSERIAL
      )
    `);
    await pool.query(`ALTER TABLE bacbo_resultados ADD COLUMN IF NOT EXISTS seq BIGSERIAL`);
    await pool.query(`ALTER TABLE bacbo_resultados ADD COLUMN IF NOT EXISTS guardado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bacbo_fim ON bacbo_resultados (fim DESC)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sinais (
        id BIGSERIAL PRIMARY KEY,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        cor TEXT NOT NULL,
        estado TEXT NOT NULL DEFAULT 'PENDENTE',
        gale INTEGER NOT NULL DEFAULT 0,
        resultado_id TEXT,
        resultado_final TEXT,
        empates INTEGER NOT NULL DEFAULT 0,
        estrategia TEXT,
        slot TEXT
      )
    `);
    await pool.query(`ALTER TABLE sinais ADD COLUMN IF NOT EXISTS estrategia TEXT`);
    await pool.query(`ALTER TABLE sinais ADD COLUMN IF NOT EXISTS slot TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sinais_estado ON sinais (estado)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sinais_criado ON sinais (criado_em DESC)`);

    // Tabela de controlo de slots (sobrevive a reinícios)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS slots_usados (
        slot TEXT PRIMARY KEY,
        usado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    log('DB', { tabelasPreparadas: true });
  })();
  try {
    await schemaPromise;
  } catch (e) {
    schemaPromise = null;
    throw e;
  }
}

async function fetchRounds() {
  const maxAttempts = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await axios.get(API_BACBO, {
        timeout: 18000,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; CapungaDadosBot/3.1)',
          'Cache-Control': 'no-cache'
        }
      });
      runtime.ultimoHTTPAPI = response.status;
      runtime.ultimoErroAPI = null;
      const items = extractItems(response.data);
      const unique = new Map();
      for (const item of items) {
        const round = normalizeRound(item);
        if (round) unique.set(round.id, round);
      }
      const rounds = [...unique.values()].sort((a, b) => new Date(a.fim) - new Date(b.fim));
      runtime.itensRecebidosAPI = items.length;
      runtime.quantidadeAPI = rounds.length;
      runtime.ultimaHoraDaAPI = rounds.at(-1)?.fim || null;
      return rounds;
    } catch (error) {
      lastError = error;
      runtime.ultimoErroAPI = error.message || String(error);
      runtime.ultimoHTTPAPI = error.response?.status || null;
      console.warn(`[API] Tentativa \( {attempt}/ \){maxAttempts} falhou:`, error.message);
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastError;
}

async function insertRound(round) {
  const result = await pool.query(
    `INSERT INTO bacbo_resultados (id, resultado, estado, inicio, fim, pontos_jogador, pontos_banca)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING RETURNING id`,
    [round.id, round.resultado, round.estado, round.inicio, round.fim, round.pontos_jogador, round.pontos_banca]
  );
  return result.rows.length > 0;
}

async function getRecentOutcomes(limit = 25) {
  const result = await pool.query(
    `SELECT id, resultado, fim, pontos_jogador, pontos_banca
     FROM bacbo_resultados
     WHERE resultado IN ('Jogador', 'Banca')
     ORDER BY fim DESC NULLS LAST, seq DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/* ========== ESTRATÉGIAS ========== */

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

function stratTendencia(rows) {
  const sample = rows.slice(0, 10);
  if (sample.length < 7) return null;
  let j = 0, b = 0;
  for (const r of sample) {
    if (r.resultado === 'Jogador') j++;
    else b++;
  }
  const total = j + b;
  if (b / total >= 0.65) return { cor: 'Banca', estrategia: 'TENDENCIA', nome: `Tendência Banca ${Math.round((b / total) * 100)}%`, emoji: '📈', prioridade: 85 };
  if (j / total >= 0.65) return { cor: 'Jogador', estrategia: 'TENDENCIA', nome: `Tendência Jogador ${Math.round((j / total) * 100)}%`, emoji: '📈', prioridade: 85 };
  return null;
}

function stratAntiStreak(rows) {
  const n = streakLen(rows);
  if (n < 3) return null;
  const cor = oposta(rows[0].resultado);
  if (!cor) return null;
  return { cor, estrategia: 'ANTI_STREAK', nome: `Anti-Streak x${n}`, emoji: '🔄', prioridade: Math.min(92, 72 + n * 5) };
}

function stratPadrao3(rows) {
  if (rows.length < 3) return null;
  const a = rows[0].resultado;
  const b = rows[1].resultado;
  const c = rows[2].resultado;
  if (![a, b, c].every(x => ['Jogador', 'Banca'].includes(x))) return null;

  if (a === b && b === c) return { cor: oposta(a), estrategia: 'PADRAO_3', nome: 'Padrão AAA → Virada', emoji: '🎯', prioridade: 83 };
  if (a === c && a !== b) return { cor: a, estrategia: 'PADRAO_3', nome: 'Padrão ABA → Continua', emoji: '🎯', prioridade: 79 };
  if (a === b && a !== c) return { cor: a, estrategia: 'PADRAO_3', nome: 'Padrão AAB → Continua', emoji: '🎯', prioridade: 77 };
  return null;
}

function stratScoreForte(rows) {
  if (rows.length < 1) return null;
  const last = rows[0];
  const pj = Number(last.pontos_jogador);
  const pb = Number(last.pontos_banca);
  if (!Number.isFinite(pj) || !Number.isFinite(pb)) return null;

  if (last.resultado === 'Jogador' && pj >= 9 && pj - pb >= 3) {
    return { cor: 'Jogador', estrategia: 'SCORE_FORTE', nome: `Score Forte J(${pj})`, emoji: '💪', prioridade: 81 };
  }
  if (last.resultado === 'Banca' && pb >= 9 && pb - pj >= 3) {
    return { cor: 'Banca', estrategia: 'SCORE_FORTE', nome: `Score Forte B(${pb})`, emoji: '💪', prioridade: 81 };
  }
  return null;
}

function stratMomentum(rows) {
  const sample = rows.slice(0, 5);
  if (sample.length < 5) return null;
  let j = 0, b = 0;
  for (const r of sample) {
    if (r.resultado === 'Jogador') j++;
    else b++;
  }
  if (b >= 4) return { cor: 'Banca', estrategia: 'MOMENTUM', nome: 'Momentum Banca', emoji: '⚡', prioridade: 75 };
  if (j >= 4) return { cor: 'Jogador', estrategia: 'MOMENTUM', nome: 'Momentum Jogador', emoji: '⚡', prioridade: 75 };
  return null;
}

function stratFallback(rows) {
  if (!rows.length) return { cor: 'Banca', estrategia: 'FALLBACK', nome: 'Fallback Banca', emoji: '🎲', prioridade: 40 };
  const ultima = rows[0].resultado;
  if (['Jogador', 'Banca'].includes(ultima)) {
    return { cor: ultima, estrategia: 'FALLBACK', nome: 'Segue Última', emoji: '🎲', prioridade: 40 };
  }
  return { cor: 'Banca', estrategia: 'FALLBACK', nome: 'Fallback Banca', emoji: '🎲', prioridade: 40 };
}

function detectBestEntry(rows) {
  const candidatos = [
    stratAntiStreak(rows),
    stratTendencia(rows),
    stratPadrao3(rows),
    stratScoreForte(rows),
    stratMomentum(rows),
    stratFallback(rows)
  ].filter(Boolean);

  candidatos.sort((a, b) => b.prioridade - a.prioridade);
  return candidatos[0];
}

/* ========== FUNÇÕES DE SINAL ========== */

async function redsToday() {
  const result = await pool.query(`
    SELECT COUNT(*)::int AS total FROM sinais
    WHERE estado = 'LOSS'
      AND criado_em >= date_trunc('day', NOW() AT TIME ZONE 'Africa/Luanda')
  `);
  return result.rows[0]?.total || 0;
}

async function getPlacarDia() {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE estado = 'GREEN')::int AS green,
      COUNT(*) FILTER (WHERE estado = 'G1')::int AS g1,
      COUNT(*) FILTER (WHERE estado = 'G2')::int AS g2,
      COUNT(*) FILTER (WHERE estado = 'LOSS')::int AS loss,
      COALESCE(SUM(empates), 0)::int AS empates
    FROM sinais
    WHERE criado_em >= date_trunc('day', NOW() AT TIME ZONE 'Africa/Luanda')
      AND estado IN ('GREEN', 'G1', 'G2', 'LOSS')
  `);
  const s = result.rows[0] || { green: 0, g1: 0, g2: 0, loss: 0, empates: 0 };
  const acertos = (s.green || 0) + (s.g1 || 0) + (s.g2 || 0);
  const finalizados = acertos + (s.loss || 0);
  const percent = finalizados > 0 ? Number(((acertos / finalizados) * 100).toFixed(1)) : 100;

  const recent = await pool.query(`
    SELECT estado FROM sinais
    WHERE criado_em >= date_trunc('day', NOW() AT TIME ZONE 'Africa/Luanda')
      AND estado IN ('GREEN', 'G1', 'G2', 'LOSS')
    ORDER BY criado_em DESC, id DESC LIMIT 40
  `);
  let greensSeguidos = 0;
  for (const row of recent.rows) {
    if (['GREEN', 'G1', 'G2'].includes(row.estado)) greensSeguidos++;
    else break;
  }
  return { green: s.green || 0, g1: s.g1 || 0, g2: s.g2 || 0, empates: s.empates || 0, loss: s.loss || 0, percent, greensSeguidos };
}

function formatPlacar(p) {
  return [
    '',
    '────────────────────',
    '🏆  CAPUNGA PLACAR  🏆',
    '────────────────────',
    `✅ GREEN  ${p.green}     ⚡ G1  ${p.g1}`,
    `🔥 G2     ${p.g2}     🟡 Emp  ${p.empates}`,
    `❌ LOSS   ${p.loss}`,
    `📊 Assertividade: ${p.percent}%`,
    `🚀 Sequência: ${p.greensSeguidos}`,
    '────────────────────'
  ].join('\n');
}

async function getPendingSignal() {
  const result = await pool.query(`
    SELECT * FROM sinais WHERE estado = 'PENDENTE'
    ORDER BY criado_em ASC, id ASC LIMIT 1
  `);
  return result.rows[0] || null;
}

async function expireOldPending() {
  // Expira qualquer sinal pendente com mais de 3 minutos e 40 segundos
  const result = await pool.query(`
    UPDATE sinais
    SET estado = 'CANCELADO'
    WHERE estado = 'PENDENTE'
      AND criado_em < NOW() - INTERVAL '3 minutes 40 seconds'
    RETURNING id
  `);
  for (const row of result.rows) {
    await telegramSend([
      '⏳  CAPUNGA • Sinal Expirado',
      `Sinal #${row.id} foi cancelado automaticamente`,
      `🕒 ${horaAngola()}`
    ].join('\n'));
    log('SINAL EXPIRADO', { id: row.id });
  }
}

function msgNovoSinal(entry, slot) {
  return [
    '🎯  CAPUNGA DADOS  🎯',
    '━━━━━━━━━━━━━━━━━━',
    '🔔  NOVA ENTRADA CONFIRMADA',
    '━━━━━━━━━━━━━━━━━━',
    '',
    `➡️  ${corDisplay(entry.cor)}`,
    '',
    `${entry.emoji}  Estratégia: ${entry.nome}`,
    `🛡️  Proteção: EMPATE`,
    `🐓  Gale máximo: ${CONFIG.maxGale}`,
    '',
    `⏱️  Slot: ${slot}`,
    `🕒  ${horaAngola()}`,
    '━━━━━━━━━━━━━━━━━━',
    '💎 Gestão de banca obrigatória'
  ].join('\n');
}

function msgResultadoGreen(signal, state) {
  let titulo;
  if (state === 'GREEN') titulo = '✅  GREEN SEM GALE';
  else if (state === 'G1') titulo = '⚡  GREEN NO GALE 1';
  else titulo = '🔥  GREEN NO GALE 2';

  return [
    '🎯  CAPUNGA DADOS  🎯',
    '────────────────────',
    titulo,
    '────────────────────',
    `➡️  Entrada: ${corDisplay(signal.cor)}`,
    `📌  ${signal.estrategia || '—'}`,
    `🔢  Sinal #${signal.id}`,
    `🕒  ${horaAngola()}`
  ].join('\n');
}

function msgResultadoLoss(signal) {
  return [
    '🎯  CAPUNGA DADOS  🎯',
    '────────────────────',
    '❌  LOSS FINAL',
    '────────────────────',
    `➡️  Entrada: ${corDisplay(signal.cor)}`,
    `🐓  Gale: \( {signal.gale || 0}/ \){CONFIG.maxGale}`,
    `🔢  Sinal #${signal.id}`,
    `🕒  ${horaAngola()}`
  ].join('\n');
}

function msgGale(signal, nextGale) {
  return [
    '🎯  CAPUNGA DADOS  🎯',
    '────────────────────',
    `🐓  GALE ${nextGale} ATIVADO`,
    '────────────────────',
    `➡️  Mantém: ${corDisplay(signal.cor)}`,
    `🔢  Sinal #${signal.id}`,
    `🕒  ${horaAngola()}`
  ].join('\n');
}

function msgEmpate(signal) {
  return [
    '🎯  CAPUNGA DADOS  🎯',
    '────────────────────',
    '🟡  EMPATE PROTEGIDO',
    '────────────────────',
    `Sinal #${signal.id} continua ativo`,
    `➡️  ${corDisplay(signal.cor)}`,
    `🕒  ${horaAngola()}`
  ].join('\n');
}

/* ========== CONTROLO DE SLOT PERSISTENTE ========== */

async function slotJaUsado(slot) {
  const result = await pool.query(`SELECT 1 FROM slots_usados WHERE slot = $1`, [slot]);
  return result.rows.length > 0;
}

async function marcarSlotUsado(slot) {
  await pool.query(
    `INSERT INTO slots_usados (slot) VALUES ($1) ON CONFLICT (slot) DO NOTHING`,
    [slot]
  );
}

async function tryCreateScheduledSignal() {
  if (!CONFIG.sinaisAtivos) {
    runtime.motivoSemSinal = 'sinais_desativados';
    return;
  }

  const parts = getAngolaParts();
  const min = parts.minute;
  const sec = parts.second;

  // Só tenta nos primeiros 25 segundos do minuto alvo
  if (!CONFIG.minutosAlvo.includes(min) || sec > 25) {
    return;
  }

  const slot = `\( {parts.year}- \){parts.month}-\( {parts.day}T \){parts.hour.padStart(2, '0')}:${String(min).padStart(2, '0')}`;

  // Já usou este slot? (agora é na base de dados)
  if (await slotJaUsado(slot)) {
    return;
  }

  // Expira sinais antigos primeiro
  await expireOldPending();

  const pending = await getPendingSignal();
  if (pending) {
    runtime.motivoSemSinal = `pendente_#${pending.id}`;
    return;
  }

  const reds = await redsToday();
  if (reds >= CONFIG.maxRedsDia) {
    runtime.motivoSemSinal = `limite_reds_${reds}`;
    return;
  }

  const rows = await getRecentOutcomes(25);
  const entry = detectBestEntry(rows);

  // Marca o slot ANTES de enviar (evita race condition)
  await marcarSlotUsado(slot);

  const result = await pool.query(
    `INSERT INTO sinais (cor, estado, gale, empates, estrategia, slot)
     VALUES ($1, 'PENDENTE', 0, 0, $2, $3) RETURNING *`,
    [entry.cor, entry.estrategia, slot]
  );
  const signal = result.rows[0];

  runtime.ultimoSinal = {
    id: signal.id,
    cor: signal.cor,
    estrategia: entry.estrategia,
    slot
  };
  runtime.ultimaEstrategia = entry;
  runtime.motivoSemSinal = null;

  await telegramSend(msgNovoSinal(entry, slot));
  log('SINAL AGENDADO', { id: signal.id, cor: entry.cor, estrategia: entry.estrategia, slot });
}

async function resolvePending(round) {
  const signal = await getPendingSignal();
  if (!signal) return;

  if (round.resultado === 'Empate') {
    if (!CONFIG.empateProtegido) return;
    await pool.query(`UPDATE sinais SET empates = COALESCE(empates, 0) + 1 WHERE id = $1 AND estado = 'PENDENTE'`, [signal.id]);
    await telegramSend(msgEmpate(signal));
    return;
  }

  if (round.resultado === signal.cor) {
    const galeNum = Number(signal.gale || 0);
    let state = 'GREEN';
    if (galeNum === 1) state = 'G1';
    else if (galeNum >= 2) state = 'G2';

    await pool.query(`UPDATE sinais SET estado = $1, resultado_final = $2 WHERE id = $3 AND estado = 'PENDENTE'`, [
      state, round.resultado, signal.id
    ]);
    const placar = await getPlacarDia();
    await telegramSend(msgResultadoGreen(signal, state) + formatPlacar(placar));
    log('SINAL RESOLVIDO', { id: signal.id, estado: state });
    return;
  }

  const nextGale = Number(signal.gale || 0) + 1;
  if (nextGale <= CONFIG.maxGale) {
    await pool.query(`UPDATE sinais SET gale = $1 WHERE id = $2 AND estado = 'PENDENTE'`, [nextGale, signal.id]);
    await telegramSend(msgGale(signal, nextGale));
    log('GALE', { id: signal.id, gale: nextGale });
    return;
  }

  await pool.query(`UPDATE sinais SET estado = 'LOSS', resultado_final = $1 WHERE id = $2 AND estado = 'PENDENTE'`, [
    round.resultado, signal.id
  ]);
  const placar = await getPlacarDia();
  await telegramSend(msgResultadoLoss(signal) + formatPlacar(placar));
  log('SINAL LOSS', { id: signal.id });
}

async function syncOnce() {
  if (!pool) throw new Error('DATABASE_URL não configurada');
  if (runtime.sincronizacaoEmCurso) return { sucesso: false, ignorada: true };
  runtime.sincronizacaoEmCurso = true;
  try {
    await ensureSchema();
    const rounds = await fetchRounds();
    let inserted = 0;
    let lastNew = null;

    for (const round of rounds) {
      const saved = await insertRound(round);
      if (!saved) continue;
      inserted++;
      lastNew = round;
      await resolvePending(round);
    }

    runtime.ultimaSincronizacao = new Date().toISOString();
    runtime.novosUltimoCiclo = inserted;
    runtime.erroSincronizacao = null;

    if (lastNew) {
      runtime.ultimaRodadaNova = new Date().toISOString();
      runtime.ultimoIdNovo = lastNew.id;
      runtime.ciclosSemNovos = 0;
    } else {
      runtime.ciclosSemNovos = (runtime.ciclosSemNovos || 0) + 1;
    }

    // Tenta gerar sinal no horário certo
    await tryCreateScheduledSignal();

    return { sucesso: true, novos: inserted };
  } catch (error) {
    runtime.erroSincronizacao = error.message || String(error);
    console.error('[ERRO SYNC]', error.message);
    return { sucesso: false, erro: runtime.erroSincronizacao };
  } finally {
    runtime.sincronizacaoEmCurso = false;
  }
}

/* ========== ROTAS ========== */

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ sucesso: false, erro: 'ADMIN_TOKEN não configurado' });
  if (req.get('x-admin-token') !== ADMIN_TOKEN) return res.status(401).json({ sucesso: false, erro: 'Token inválido' });
  next();
}

app.get('/', (req, res) => {
  res.json({
    nome: 'Capunga Dados — Horário Fixo 4min (v3.1)',
    estado: 'online',
    horaAngola: horaAngola(),
    minutosAlvo: CONFIG.minutosAlvo
  });
});

app.get('/health', (req, res) => {
  res.json({
    sucesso: true,
    estado: 'online',
    horaAngola: horaAngola(),
    motivoSemSinal: runtime.motivoSemSinal,
    ultimaEstrategia: runtime.ultimaEstrategia,
    ultimoSinal: runtime.ultimoSinal
  });
});

app.get('/diagnostico', async (req, res) => {
  let totalResultados = 0, totalSinais = 0, pendentes = 0, recentes = [];
  try {
    if (pool) {
      await ensureSchema();
      totalResultados = (await pool.query('SELECT COUNT(*)::int AS total FROM bacbo_resultados')).rows[0].total;
      totalSinais = (await pool.query('SELECT COUNT(*)::int AS total FROM sinais')).rows[0].total;
      pendentes = (await pool.query(`SELECT COUNT(*)::int AS total FROM sinais WHERE estado = 'PENDENTE'`)).rows[0].total;
      recentes = (await pool.query(
        `SELECT resultado, pontos_jogador, pontos_banca FROM bacbo_resultados
         WHERE resultado IN ('Jogador','Banca') ORDER BY fim DESC NULLS LAST, seq DESC LIMIT 10`
      )).rows;
    }
  } catch (_) {}
  res.json({
    sucesso: true,
    nome: 'Capunga Dados — Horário Fixo 4min v3.1',
    iniciadoEm: runtime.iniciadoEm,
    horaAngola: horaAngola(),
    telegramConfigurado: Boolean(BOT_TOKEN && CHAT_ID),
    httpAPI: runtime.ultimoHTTPAPI,
    erroAPI: runtime.ultimoErroAPI,
    ultimaSincronizacao: runtime.ultimaSincronizacao,
    motivoSemSinal: runtime.motivoSemSinal,
    ultimoSinal: runtime.ultimoSinal,
    ultimaEstrategia: runtime.ultimaEstrategia,
    ultimosResultados: recentes,
    baseDados: { totalResultados, totalSinais, pendentes },
    configuracao: CONFIG
  });
});

app.get('/sinais', async (req, res) => {
  try {
    await ensureSchema();
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 40, 1), 300);
    const result = await pool.query(`SELECT * FROM sinais ORDER BY criado_em DESC, id DESC LIMIT $1`, [limit]);
    res.json({ sucesso: true, total: result.rows.length, sinais: result.rows });
  } catch (error) {
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

app.get('/estatisticas', async (req, res) => {
  try {
    await ensureSchema();
    const result = await pool.query(`
      SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE estado = 'GREEN')::int AS green,
        COUNT(*) FILTER (WHERE estado = 'G1')::int AS g1,
        COUNT(*) FILTER (WHERE estado = 'G2')::int AS g2,
        COUNT(*) FILTER (WHERE estado = 'LOSS')::int AS loss,
        COUNT(*) FILTER (WHERE estado = 'PENDENTE')::int AS pendentes
      FROM sinais
    `);
    const stats = result.rows[0];
    const acertos = (stats.green || 0) + (stats.g1 || 0) + (stats.g2 || 0);
    const finalizados = acertos + (stats.loss || 0);
    const taxa = finalizados > 0 ? Number(((acertos / finalizados) * 100).toFixed(1)) : null;

    let porEstrategia = [];
    try {
      porEstrategia = (await pool.query(`
        SELECT COALESCE(estrategia,'DESCONHECIDA') AS estrategia,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE estado IN ('GREEN','G1','G2'))::int AS acertos,
          COUNT(*) FILTER (WHERE estado = 'LOSS')::int AS loss
        FROM sinais WHERE estado IN ('GREEN','G1','G2','LOSS')
        GROUP BY 1 ORDER BY total DESC
      `)).rows;
    } catch (_) {}

    let placarDia = null;
    try { placarDia = await getPlacarDia(); } catch (_) {}

    res.json({
      sucesso: true,
      estatisticas: { ...stats, finalizados, acertos, taxaAcertoPercent: taxa },
      porEstrategia,
      placarDia,
      horaAngola: horaAngola()
    });
  } catch (error) {
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

app.post('/db/sincronizar', requireAdmin, async (req, res) => {
  try {
    const result = await syncOnce();
    res.status(result.sucesso ? 200 : 500).json(result);
  } catch (error) {
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

app.post('/telegram/teste', requireAdmin, async (req, res) => {
  const enviado = await telegramSend([
    '🎯  CAPUNGA DADOS  🎯',
    '✅ Teste OK — v3.1 Horário Fixo',
    `🕒 ${horaAngola()}`
  ].join('\n'));
  res.status(enviado ? 200 : 502).json({ sucesso: enviado, erro: runtime.ultimoErroTelegram });
});

app.use((req, res) => {
  res.status(404).json({ sucesso: false, erro: 'Rota não encontrada' });
});

/* ========== START ========== */

async function start() {
  if (!DATABASE_URL) throw new Error('DATABASE_URL não configurada');
  await ensureSchema();

  server = app.listen(PORT, '0.0.0.0', () => {
    console.log('==============================================');
    console.log('CAPUNGA DADOS — HORÁRIO FIXO 4min (v3.1)');
    console.log(`Porta: ${PORT} | Angola: ${horaAngola()}`);
    console.log(`Minutos: ${CONFIG.minutosAlvo.join(', ')}`);
    console.log('==============================================');
  });

  // Sync inicial
  await syncOnce();

  // Sync de resultados a cada 7 segundos
  syncTimer = setInterval(async () => {
    if (runtime.sincronizacaoEmCurso) return;
    try { await syncOnce(); } catch (err) { console.error('[SYNC]', err.message); }
  }, CONFIG.intervaloSyncMs);

  // Verificador de horário a cada 6 segundos (mais preciso)
  scheduleTimer = setInterval(async () => {
    try {
      await tryCreateScheduledSignal();
    } catch (err) {
      console.error('[SCHEDULE]', err.message);
    }
  }, 6000);

  if (typeof syncTimer.unref === 'function') syncTimer.unref();
  if (typeof scheduleTimer.unref === 'function') scheduleTimer.unref();
}

process.on('unhandledRejection', (r) => console.error('[UNHANDLED]', r));
process.on('uncaughtException', (e) => console.error('[UNCAUGHT]', e));

async function shutdown() {
  if (syncTimer) clearInterval(syncTimer);
  if (scheduleTimer) clearInterval(scheduleTimer);
  if (server) await new Promise(r => server.close(r));
  if (pool) await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown().catch(() => process.exit(1)));
process.on('SIGINT', () => shutdown().catch(() => process.exit(1)));

start().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});