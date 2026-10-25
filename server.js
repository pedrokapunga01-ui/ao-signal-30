'use strict';

/**
 * CAPUNGA DADOS — BAC BO (Multi-Estratégia) — v6.1 (auto-recuperação)
 *
 * Estratégias activas:
 *   1. REPETICAO  — após N da mesma cor, entra na mesma
 *   2. QUEBRA     — após N da mesma cor, entra na oposta
 *   3. SURF       — padrão alternado (A-B-A-B) → continua a onda
 *   4. DOIS_DOIS  — padrão 2+2 (JJBB / BBJJ) → próxima cor esperada
 *   5. FORCA      — força da mesa (dominância nos últimos 12)
 *   6. NUMERICA   — scores altos/baixos e diferença de pontos
 *
 * Novidades v6.1:
 *   - Catch-up: ao acordar, processa as rodadas perdidas em ordem cronológica
 *     e resolve o sinal pendente com as rodadas que saíram DEPOIS do sinal
 *     (não a partir do momento em que o servidor acordou).
 *   - Expiração do sinal pelo relógio das rodadas (não pelo relógio do servidor).
 *   - Não cria sinais novos em rodadas antigas (só em rodadas frescas).
 *   - Keep-alive automático (auto-ping) + sync disparado por qualquer pedido HTTP.
 *   - Servidor abre a porta primeiro (evita falha de deploy) e tenta de novo se a BD falhar.
 *   - Dia do placar/limite de reds calculado no fuso de Angola (Africa/Luanda).
 *
 * Env:
 *   DATABASE_URL, BOT_TOKEN, CHAT_ID, ADMIN_TOKEN
 *   SINAIS_ATIVOS=true STREAK_MIN=3 MAX_GALE=2
 *   EMPATE_PROTEGIDO=true MAX_REDS_DIA=10
 *   INTERVALO_MINIMO_MS=40000 SINAL_EXPIRA_MIN=10 INTERVALO_SYNC_MS=8000
 *   RODADA_FRESCA_SEG=150 KEEPALIVE_MS=600000 SELF_URL=(opcional) PG_SSL=true
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
const SELF_URL = process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL || '';
const API_BACBO =
  process.env.API_BACBO ||
  'https://api-cs.casino.org/svc-evolution-game-events/api/bacbo';

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
  streakMin: intEnv('STREAK_MIN', 3, 2, 12),
  maxGale: intEnv('MAX_GALE', 2, 0, 3),
  empateProtegido: boolEnv(process.env.EMPATE_PROTEGIDO, true),
  maxRedsDia: intEnv('MAX_REDS_DIA', 10, 1, 50),
  intervaloMinimoMs: intEnv('INTERVALO_MINIMO_MS', 40000, 15000, 3600000),
  sinalExpiraMin: intEnv('SINAL_EXPIRA_MIN', 10, 3, 60),
  intervaloSyncMs: intEnv('INTERVALO_SYNC_MS', 8000, 5000, 60000),
  rodadaFrescaMs: intEnv('RODADA_FRESCA_SEG', 150, 30, 900) * 1000,
  keepAliveMs: intEnv('KEEPALIVE_MS', 600000, 60000, 840000)
};

// Início do dia no fuso de Angola, como timestamptz (corrige o desvio de 1h)
const INICIO_DIA = `(date_trunc('day', NOW() AT TIME ZONE 'Africa/Luanda') AT TIME ZONE 'Africa/Luanda')`;

const usaSSL = !/localhost|127\.0\.0\.1/i.test(DATABASE_URL) && boolEnv(process.env.PG_SSL, true);

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: usaSSL ? { rejectUnauthorized: false } : false,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000
    })
  : null;

if (pool) {
  pool.on('error', (e) => console.error('[POOL]', e.message));
}

const runtime = {
  iniciadoEm: new Date().toISOString(),
  sincronizacaoEmCurso: false,
  sincronizacaoInicialConcluida: false,
  ultimaSincronizacao: null,
  ultimaRodadaNova: null,
  ultimoIdNovo: null,
  ultimaHoraDaAPI: null,
  quantidadeAPI: 0,
  itensRecebidosAPI: 0,
  duplicadosUltimoCiclo: 0,
  novosUltimoCiclo: 0,
  erroSincronizacao: null,
  ultimoSinal: null,
  ultimaMensagemTelegram: null,
  ultimoErroTelegram: null,
  ultimoHTTPAPI: null,
  ultimoErroAPI: null,
  ultimaRodadaDB: null,
  ultimoIdDB: null,
  ciclosSemNovos: 0,
  motivoSemSinal: null,
  ultimaEstrategia: null,
  rodadasRecuperadas: 0,
  ultimoKeepAlive: null
};

let schemaPromise = null;
let server = null;
let syncTimer = null;
let keepAliveTimer = null;

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

function corDisplay(cor) {
  if (cor === 'Banca') return '🔴 VERMELHO 🔴';
  if (cor === 'Jogador') return '🔵 AZUL 🔵';
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
  if (['player','jogador','playerwin','playerwins','playerwon','playerwinner'].includes(s)) return 'Jogador';
  if (['banker','banca','bankerwin','bankerwins','bankerwon','bankerwinner','red','vermelho'].includes(s)) return 'Banca';
  if (['tie','draw','empate','equal','push','tied'].includes(s)) return 'Empate';
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
  const resolvida = ['resolved','settled','finished','complete','completed','resolvido','concluido','finalizado']
    .some((w) => status.includes(w)) || Boolean(fim);
  const id = String(d.id ?? d.roundId ?? d.round_id ?? d.eventId ?? item?.id ?? item?.roundId ?? item?.round_id ?? item?.eventId ?? '').trim();
  if (!id || !resultado || !resolvida || !fim) return null;
  const scoreJogador = Number(r.playerDice?.score ?? d.playerDice?.score ?? d.playerScore ?? d.player_score ?? d.pontos_jogador);
  const scoreBanca = Number(r.bankerDice?.score ?? d.bankerDice?.score ?? d.bankerScore ?? d.banker_score ?? d.pontos_banca);
  const multiplicador = r.multiplier ?? d.multiplier ?? d.multiplicador ?? null;
  return {
    id,
    resultado,
    estado: 'Resolved',
    inicio: inicio || fim,
    fim,
    pontos_jogador: Number.isFinite(scoreJogador) ? scoreJogador : null,
    pontos_banca: Number.isFinite(scoreBanca) ? scoreBanca : null,
    multiplicador: multiplicador == null ? null : String(multiplicador)
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
        estrategia TEXT
      )
    `);
    await pool.query(`ALTER TABLE sinais ADD COLUMN IF NOT EXISTS estrategia TEXT`);
    // Hora da rodada que gerou o sinal — base do catch-up após dormir
    await pool.query(`ALTER TABLE sinais ADD COLUMN IF NOT EXISTS rodada_fim TIMESTAMPTZ`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sinais_estado ON sinais (estado)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sinais_criado ON sinais (criado_em DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sinais_loss_dia ON sinais (criado_em) WHERE estado = 'LOSS'`);
    log('DB', { tabelasPreparadas: true });
  })();
  try { await schemaPromise; } catch (e) { schemaPromise = null; throw e; }
}

async function fetchRounds() {
  try {
    const response = await axios.get(API_BACBO, {
      timeout: 20000,
      headers: { Accept: 'application/json', 'User-Agent': 'CapungaDadosBot/1.0' }
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
    runtime.ultimoErroAPI = error.message || String(error);
    runtime.ultimoHTTPAPI = error.response?.status || null;
    throw error;
  }
}

async function insertRound(round) {
  const result = await pool.query(
    `INSERT INTO bacbo_resultados (id, resultado, estado, inicio, fim, pontos_jogador, pontos_banca, multiplicador)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING RETURNING id`,
    [round.id, round.resultado, round.estado, round.inicio, round.fim, round.pontos_jogador, round.pontos_banca, round.multiplicador]
  );
  return result.rows.length > 0;
}

async function getLatestFromDB() {
  const result = await pool.query(`
    SELECT id, resultado, fim FROM bacbo_resultados
    ORDER BY fim DESC NULLS LAST, seq DESC LIMIT 1
  `);
  return result.rows[0] || null;
}

async function getRecentOutcomes(limit = 40) {
  const result = await pool.query(
    `SELECT id, resultado, fim, pontos_jogador, pontos_banca, multiplicador
     FROM bacbo_resultados
     WHERE resultado IN ('Jogador', 'Banca')
     ORDER BY fim DESC NULLS LAST, seq DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

async function getRecentAll(limit = 40) {
  const result = await pool.query(
    `SELECT id, resultado, fim, pontos_jogador, pontos_banca, multiplicador
     FROM bacbo_resultados
     ORDER BY fim DESC NULLS LAST, seq DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/* ========== ESTRATÉGIAS (inalteradas) ========== */

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

/** 1) REPETIÇÃO — N iguais → mesma cor */
function stratRepeticao(rows) {
  const n = streakLen(rows);
  if (n < CONFIG.streakMin) return null;
  const cor = rows[0].resultado;
  // Prioridade sobe com o tamanho do streak (3=70, 4=80, 5+=90)
  const prioridade = Math.min(90, 50 + n * 10);
  return {
    cor,
    estrategia: 'REPETICAO',
    nome: `Repetição x${n}`,
    emoji: '🔁',
    prioridade
  };
}

/** 2) QUEBRA — streak longo → cor oposta */
function stratQuebra(rows) {
  const n = streakLen(rows);
  // Quebra a partir de 4 (mais selectivo que repetição)
  if (n < CONFIG.streakMin + 1) return null;
  const cor = oposta(rows[0].resultado);
  if (!cor) return null;
  const prioridade = Math.min(88, 55 + n * 8);
  return {
    cor,
    estrategia: 'QUEBRA',
    nome: `Quebra x${n}`,
    emoji: '💥',
    prioridade
  };
}

/** 3) SURF — alternância A-B-A-B */
function stratSurf(rows) {
  if (rows.length < 4) return null;
  const a = rows[0].resultado;
  const b = rows[1].resultado;
  if (!['Jogador', 'Banca'].includes(a) || !['Jogador', 'Banca'].includes(b)) return null;
  if (a === b) return null;
  // Precisa de pelo menos 4 alternados: a b a b
  for (let i = 0; i < 4; i++) {
    const expected = i % 2 === 0 ? a : b;
    if (rows[i]?.resultado !== expected) return null;
  }
  // Mais recente primeiro: [0]=a, [1]=b, [2]=a, [3]=b → alternância continua → próxima = b
  const cor = b;
  return {
    cor,
    estrategia: 'SURF',
    nome: 'Surf (alternado)',
    emoji: '🌊',
    prioridade: 78
  };
}

/** 4) 2P2B / 2J2B — blocos de 2 */
function stratDoisDois(rows) {
  if (rows.length < 4) return null;
  const r = rows.map((x) => x.resultado);
  // Detectar fim de bloco de 2: últimas 2 iguais, anteriores 2 opostas iguais
  if (r[0] === r[1] && r[2] === r[3] && r[0] !== r[2]) {
    const cor = r[0];
    return {
      cor,
      estrategia: 'DOIS_DOIS',
      nome: '2+2 (bloco)',
      emoji: '♟️',
      prioridade: 82
    };
  }
  // Quase bloco: só 1 da nova cor depois de 2 da outra (JJ B) → completa o 2
  if (rows.length >= 3 && r[0] !== r[1] && r[1] === r[2] && ['Jogador','Banca'].includes(r[0])) {
    const cor = r[0]; // completa o par
    return {
      cor,
      estrategia: 'DOIS_DOIS',
      nome: '2+2 (completa par)',
      emoji: '♟️',
      prioridade: 75
    };
  }
  return null;
}

/** 5) FORÇA DA MESA — dominância últimos 12 */
function stratForca(rows) {
  const sample = rows.slice(0, 12).filter((r) => ['Jogador', 'Banca'].includes(r.resultado));
  if (sample.length < 8) return null;
  let j = 0, b = 0;
  for (const r of sample) {
    if (r.resultado === 'Jogador') j++;
    else b++;
  }
  const total = j + b;
  const pctJ = j / total;
  const pctB = b / total;
  // Dominância clara ≥ 65%
  if (pctB >= 0.65) {
    return {
      cor: 'Banca',
      estrategia: 'FORCA',
      nome: `Força Mesa Banca ${Math.round(pctB * 100)}%`,
      emoji: '💪',
      prioridade: 72
    };
  }
  if (pctJ >= 0.65) {
    return {
      cor: 'Jogador',
      estrategia: 'FORCA',
      nome: `Força Mesa Jogador ${Math.round(pctJ * 100)}%`,
      emoji: '💪',
      prioridade: 72
    };
  }
  return null;
}

/** 6) NUMÉRICA — scores e diferenças */
function stratNumerica(rows) {
  if (rows.length < 3) return null;
  const last = rows[0];
  const pj = Number(last.pontos_jogador);
  const pb = Number(last.pontos_banca);
  if (!Number.isFinite(pj) || !Number.isFinite(pb)) return null;

  // Vitória com score muito alto (≥10) → tendência de continuação da cor vencedora
  if (last.resultado === 'Jogador' && pj >= 10 && pj > pb) {
    return {
      cor: 'Jogador',
      estrategia: 'NUMERICA',
      nome: `Numérica Alta J(${pj})`,
      emoji: '🔢',
      prioridade: 68
    };
  }
  if (last.resultado === 'Banca' && pb >= 10 && pb > pj) {
    return {
      cor: 'Banca',
      estrategia: 'NUMERICA',
      nome: `Numérica Alta B(${pb})`,
      emoji: '🔢',
      prioridade: 68
    };
  }

  // Últimas 3 todas com diferença ≥ 4 → força da cor dominante recente
  let diffsOk = true;
  let corDom = null;
  for (let i = 0; i < 3; i++) {
    const r = rows[i];
    const a = Number(r.pontos_jogador);
    const c = Number(r.pontos_banca);
    if (!Number.isFinite(a) || !Number.isFinite(c) || Math.abs(a - c) < 4) {
      diffsOk = false;
      break;
    }
    if (!corDom) corDom = r.resultado;
    else if (r.resultado !== corDom) diffsOk = false;
  }
  if (diffsOk && corDom) {
    return {
      cor: corDom,
      estrategia: 'NUMERICA',
      nome: 'Numérica Diff≥4 x3',
      emoji: '🔢',
      prioridade: 70
    };
  }

  // Após 2 vitórias com score baixo do vencedor (≤5) → possível virada
  if (rows.length >= 2) {
    const w0 = rows[0];
    const w1 = rows[1];
    if (w0.resultado === w1.resultado && ['Jogador','Banca'].includes(w0.resultado)) {
      const s0 = w0.resultado === 'Jogador' ? Number(w0.pontos_jogador) : Number(w0.pontos_banca);
      const s1 = w1.resultado === 'Jogador' ? Number(w1.pontos_jogador) : Number(w1.pontos_banca);
      if (s0 <= 5 && s1 <= 5) {
        const cor = oposta(w0.resultado);
        return {
          cor,
          estrategia: 'NUMERICA',
          nome: 'Numérica Virada Baixa',
          emoji: '🔢',
          prioridade: 65
        };
      }
    }
  }
  return null;
}

/**
 * Avalia todas as estratégias e devolve a de maior prioridade.
 * Se empate, prefere REPETICAO > QUEBRA > DOIS_DOIS > SURF > FORCA > NUMERICA
 */
function detectBestEntry(rows) {
  if (!rows || rows.length < 2) return null;

  const candidatos = [
    stratRepeticao(rows),
    stratQuebra(rows),
    stratDoisDois(rows),
    stratSurf(rows),
    stratForca(rows),
    stratNumerica(rows)
  ].filter(Boolean);

  if (!candidatos.length) return null;

  const ordem = {
    REPETICAO: 6,
    QUEBRA: 5,
    DOIS_DOIS: 4,
    SURF: 3,
    FORCA: 2,
    NUMERICA: 1
  };

  candidatos.sort((a, b) => {
    if (b.prioridade !== a.prioridade) return b.prioridade - a.prioridade;
    return (ordem[b.estrategia] || 0) - (ordem[a.estrategia] || 0);
  });

  return candidatos[0];
}

/* ========== PLACAR / SINAIS ========== */

async function redsToday() {
  const result = await pool.query(`
    SELECT COUNT(*)::int AS total FROM sinais
    WHERE estado = 'LOSS'
      AND criado_em >= ${INICIO_DIA}
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
    WHERE criado_em >= ${INICIO_DIA}
      AND estado IN ('GREEN', 'G1', 'G2', 'LOSS')
  `);
  const s = result.rows[0] || { green: 0, g1: 0, g2: 0, loss: 0, empates: 0 };
  const acertos = (s.green || 0) + (s.g1 || 0) + (s.g2 || 0);
  const finalizados = acertos + (s.loss || 0);
  const percent = finalizados > 0 ? Number(((acertos / finalizados) * 100).toFixed(1)) : 100;
  const recent = await pool.query(`
    SELECT estado FROM sinais
    WHERE criado_em >= ${INICIO_DIA}
      AND estado IN ('GREEN', 'G1', 'G2', 'LOSS')
    ORDER BY criado_em DESC, id DESC LIMIT 50
  `);
  let greensSeguidos = 0;
  for (const row of recent.rows) {
    if (['GREEN', 'G1', 'G2'].includes(row.estado)) greensSeguidos++;
    else break;
  }
  return { green: s.green||0, g1: s.g1||0, g2: s.g2||0, empates: s.empates||0, loss: s.loss||0, percent, greensSeguidos };
}

function formatPlacar(p) {
  return [
    '',
    '════════════════════',
    '🏆 CAPUNGA PLACAR 🏆',
    '════════════════════',
    `✅ GREEN: ${p.green}   |  ⚡ G1: ${p.g1}`,
    `🔥 G2: ${p.g2}      |  🟡 Empates: ${p.empates}`,
    `❌ LOSS: ${p.loss}`,
    `📊 Assertividade: ${p.percent}%`,
    `🚀 Sequência: ${p.greensSeguidos} green(s)`,
    '════════════════════'
  ].join('\n');
}

async function getPendingSignal() {
  const result = await pool.query(`
    SELECT * FROM sinais WHERE estado = 'PENDENTE'
    ORDER BY criado_em ASC, id ASC LIMIT 1
  `);
  return result.rows[0] || null;
}

/** Momento (ms) da rodada que gerou o sinal; cai para criado_em em sinais antigos */
function baseTimeMs(signal) {
  return new Date(signal.rodada_fim || signal.criado_em).getTime();
}

/**
 * Expira o sinal usando o relógio das RODADAS (refMs = fim da rodada em análise),
 * não o relógio do servidor — assim dormir não cancela sinais pendentes.
 */
async function expirePendingSignal(signal, refMs) {
  if (!signal) return false;
  const ref = Number.isFinite(refMs) ? refMs : Date.now();
  const age = ref - baseTimeMs(signal);
  if (age < CONFIG.sinalExpiraMin * 60000) return false;
  const upd = await pool.query(`UPDATE sinais SET estado = 'CANCELADO' WHERE id = $1 AND estado = 'PENDENTE'`, [signal.id]);
  if (upd.rowCount > 0) {
    await telegramSend(['⏰ Sinal expirado', `Sinal #${signal.id}`, `🕒 ${horaAngola()}`].join('\n'));
    log('SINAL EXPIRADO', { id: signal.id });
  }
  return true;
}

function msgNovoSinal(entry) {
  return [
    '🎲🇺🇸 CAPUNGA DADOS 🇺🇸🎲',
    '━━━━━━━━━━━━━━━━━━━━',
    '🚨⚡ ENTRADA CONFIRMADA ⚡🚨',
    '━━━━━━━━━━━━━━━━━━━━',
    `🎯 Cor: ${corDisplay(entry.cor)}`,
    `${entry.emoji} Estratégia: ${entry.nome}`,
    '🛡️ Proteção: 🟡 EMPATE',
    `🐓 Gale máximo: ${CONFIG.maxGale}`,
    '💎 Gestão de banca obrigatória',
    `🕒 ${horaAngola()}`,
    '━━━━━━━━━━━━━━━━━━━━'
  ].join('\n');
}

function msgResultadoGreen(signal, state) {
  let titulo;
  if (state === 'GREEN') titulo = '✅🏆 GREEENNN 🏆✅\n✨ Sem Gale ✨';
  else if (state === 'G1') titulo = '⚡🏆 GREEN G1 🏆⚡\n🐓 Gale 1';
  else titulo = '🔥🏆 GREEN G2 🏆🔥\n🐓 Gale 2';
  const est = signal.estrategia ? `\n📌 ${signal.estrategia}` : '';
  return [
    '🎲🇺🇸 CAPUNGA DADOS 🇺🇸🎲',
    '📋 RESULTADO DO SINAL',
    titulo,
    `🎯 Entrada: ${corDisplay(signal.cor)}`,
    `🔢 Sinal #${signal.id}${est}`,
    `🕒 ${horaAngola()}`
  ].join('\n');
}

function msgResultadoLoss(signal) {
  return [
    '🎲🇺🇸 CAPUNGA DADOS 🇺🇸🎲',
    '📋 RESULTADO DO SINAL',
    '❌💔 LOSS FINAL 💔❌',
    `🎯 Entrada: ${corDisplay(signal.cor)}`,
    `🐓 Gale: ${signal.gale || 0}/${CONFIG.maxGale}`,
    `🔢 Sinal #${signal.id}`,
    `🕒 ${horaAngola()}`
  ].join('\n');
}

function msgGale(signal, nextGale) {
  return [
    '🎲🇺🇸 CAPUNGA DADOS 🇺🇸🎲',
    `🐓⚡ GALE ${nextGale} ⚡🐓`,
    `🎯 Mantém: ${corDisplay(signal.cor)}`,
    `🔢 Sinal #${signal.id}`,
    `🕒 ${horaAngola()}`
  ].join('\n');
}

function msgEmpate(signal) {
  return [
    '🎲🇺🇸 CAPUNGA DADOS 🇺🇸🎲',
    '🟡🤝 EMPATE PROTEGIDO 🤝🟡',
    `🔢 Sinal #${signal.id} segue pendente`,
    `🎯 ${corDisplay(signal.cor)}`,
    `🕒 ${horaAngola()}`
  ].join('\n');
}

async function maybeCreateSignal(round) {
  if (!CONFIG.sinaisAtivos) {
    runtime.motivoSemSinal = 'sinais_desativados';
    return;
  }
  if (!['Jogador', 'Banca'].includes(round.resultado)) {
    runtime.motivoSemSinal = 'rodada_empate';
    return;
  }

  const roundMs = new Date(round.fim).getTime();

  const pending = await getPendingSignal();
  if (pending) {
    if (!(await expirePendingSignal(pending, roundMs))) {
      runtime.motivoSemSinal = `pendente_#${pending.id}`;
      return;
    }
  }

  // Catch-up: rodadas antigas (perdidas durante o sono) só alimentam o histórico
  // e resolvem sinais pendentes — nunca geram sinais novos fora de tempo.
  if (Date.now() - roundMs > CONFIG.rodadaFrescaMs) {
    runtime.motivoSemSinal = 'rodada_antiga_catchup';
    return;
  }

  const reds = await redsToday();
  if (reds >= CONFIG.maxRedsDia) {
    runtime.motivoSemSinal = `limite_reds_${reds}`;
    return;
  }

  const lastResult = await pool.query(`SELECT criado_em FROM sinais ORDER BY criado_em DESC, id DESC LIMIT 1`);
  const last = lastResult.rows[0];
  if (last?.criado_em && Date.now() - new Date(last.criado_em).getTime() < CONFIG.intervaloMinimoMs) {
    runtime.motivoSemSinal = 'intervalo_minimo';
    return;
  }

  const rows = await getRecentOutcomes(30);
  const entry = detectBestEntry(rows);
  if (!entry) {
    const recent = rows.slice(0, 6).map((r) => r.resultado[0]).join('');
    runtime.motivoSemSinal = `sem_setup[${recent}]`;
    return;
  }

  const jaUsada = await pool.query(`SELECT 1 FROM sinais WHERE resultado_id = $1 LIMIT 1`, [round.id]);
  if (jaUsada.rows.length > 0) {
    runtime.motivoSemSinal = 'rodada_ja_usada';
    return;
  }

  const result = await pool.query(
    `INSERT INTO sinais (cor, estado, gale, resultado_id, empates, estrategia, rodada_fim)
     VALUES ($1, 'PENDENTE', 0, $2, 0, $3, $4) RETURNING *`,
    [entry.cor, round.id, entry.estrategia, round.fim]
  );
  const signal = result.rows[0];
  runtime.ultimoSinal = { id: signal.id, cor: signal.cor, estado: signal.estado, criado_em: signal.criado_em, estrategia: entry.estrategia };
  runtime.ultimaEstrategia = entry;
  runtime.motivoSemSinal = null;

  await telegramSend(msgNovoSinal(entry));
  log('SINAL CRIADO', { id: signal.id, cor: entry.cor, estrategia: entry.estrategia, nome: entry.nome });
}

async function resolvePending(round) {
  const signal = await getPendingSignal();
  if (!signal) return;
  if (String(signal.resultado_id) === String(round.id)) return;

  const roundMs = new Date(round.fim).getTime();

  // Só conta rodadas que saíram DEPOIS do sinal (momento em que foi gerado)
  if (Number.isFinite(roundMs) && roundMs <= baseTimeMs(signal)) return;

  if (await expirePendingSignal(signal, roundMs)) return;

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
    await pool.query(`UPDATE sinais SET estado = $1, resultado_final = $2 WHERE id = $3 AND estado = 'PENDENTE'`, [state, round.resultado, signal.id]);
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

  await pool.query(`UPDATE sinais SET estado = 'LOSS', resultado_final = $1 WHERE id = $2 AND estado = 'PENDENTE'`, [round.resultado, signal.id]);
  const placar = await getPlacarDia();
  await telegramSend(msgResultadoLoss(signal) + formatPlacar(placar));
  log('SINAL LOSS', { id: signal.id });
}

async function syncOnce() {
  if (!pool) return { sucesso: false, erro: 'DATABASE_URL não configurada' };
  if (runtime.sincronizacaoEmCurso) return { sucesso: false, ignorada: true };
  runtime.sincronizacaoEmCurso = true;
  try {
    await ensureSchema();
    const latestDB = await getLatestFromDB();
    runtime.ultimaRodadaDB = latestDB?.fim || null;
    runtime.ultimoIdDB = latestDB?.id || null;
    const count = await pool.query('SELECT COUNT(*)::int AS total FROM bacbo_resultados');
    const hadHistory = count.rows[0].total > 0;
    const rounds = await fetchRounds();
    let inserted = 0, duplicates = 0, evaluated = 0, recovered = 0, lastNew = null;
    for (const round of rounds) {
      const saved = await insertRound(round);
      if (!saved) { duplicates++; continue; }
      inserted++;
      lastNew = round;
      if (Date.now() - new Date(round.fim).getTime() > CONFIG.rodadaFrescaMs) recovered++;
      if (hadHistory) {
        // Ordem cronológica: primeiro resolve o sinal pendente com esta rodada,
        // depois (só se for rodada fresca) avalia novo sinal.
        await resolvePending(round);
        await maybeCreateSignal(round);
        evaluated++;
      }
    }
    runtime.sincronizacaoInicialConcluida = true;
    runtime.ultimaSincronizacao = new Date().toISOString();
    runtime.duplicadosUltimoCiclo = duplicates;
    runtime.novosUltimoCiclo = inserted;
    runtime.erroSincronizacao = null;
    if (hadHistory) runtime.rodadasRecuperadas += recovered;
    if (lastNew) {
      runtime.ultimaRodadaNova = new Date().toISOString();
      runtime.ultimoIdNovo = lastNew.id;
      runtime.ciclosSemNovos = 0;
    } else {
      runtime.ciclosSemNovos = (runtime.ciclosSemNovos || 0) + 1;
    }
    const summary = {
      recebidos: rounds.length,
      novosGuardados: inserted,
      recuperadasAtrasadas: hadHistory ? recovered : 0,
      duplicados: duplicates,
      sinaisAvaliados: evaluated,
      motivoSemSinal: runtime.motivoSemSinal,
      ultimaEstrategia: runtime.ultimaEstrategia?.estrategia || null,
      ciclosSemNovos: runtime.ciclosSemNovos,
      horaAngola: horaAngola()
    };
    if (inserted > 0 || runtime.ciclosSemNovos % 8 === 0) log('SINCRONIZACAO', summary);
    return { sucesso: true, ...summary };
  } catch (error) {
    runtime.erroSincronizacao = error.message || String(error);
    console.error('[ERRO SINCRONIZACAO]', error.message);
    return { sucesso: false, erro: runtime.erroSincronizacao };
  } finally {
    runtime.sincronizacaoEmCurso = false;
  }
}

/* ========== AUTOMAÇÃO / ACORDAR ========== */

// Qualquer pedido HTTP (ex.: ping externo) dispara sync se estiver atrasado
app.use((req, res, next) => {
  if (pool && !runtime.sincronizacaoEmCurso) {
    const ultima = runtime.ultimaSincronizacao ? Date.parse(runtime.ultimaSincronizacao) : 0;
    if (Date.now() - ultima > CONFIG.intervaloSyncMs * 3) {
      syncOnce().catch(() => {});
    }
  }
  next();
});

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(503).json({ sucesso: false, erro: 'ADMIN_TOKEN não configurado' });
  if (req.get('x-admin-token') !== ADMIN_TOKEN) return res.status(401).json({ sucesso: false, erro: 'Token inválido' });
  next();
}

app.get('/', (req, res) => {
  res.json({
    nome: 'Capunga Dados Multi-Estratégia',
    estado: 'online',
    horaAngola: horaAngola(),
    estrategias: ['REPETICAO', 'QUEBRA', 'SURF', 'DOIS_DOIS', 'FORCA', 'NUMERICA'],
    rotas: ['/health', '/diagnostico', '/resultados', '/sinais', '/estatisticas']
  });
});

app.get('/health', (req, res) => {
  res.json({
    sucesso: true,
    estado: 'online',
    horaAngola: horaAngola(),
    ultimaSincronizacao: runtime.ultimaSincronizacao,
    novosUltimoCiclo: runtime.novosUltimoCiclo,
    ciclosSemNovos: runtime.ciclosSemNovos,
    rodadasRecuperadas: runtime.rodadasRecuperadas,
    motivoSemSinal: runtime.motivoSemSinal,
    ultimaEstrategia: runtime.ultimaEstrategia
  });
});

app.get('/diagnostico', async (req, res) => {
  let ultimoResultadoDB = null, totalResultados = 0, totalSinais = 0, pendentes = 0, recentes = [];
  try {
    if (pool) {
      await ensureSchema();
      const r1 = await pool.query(`SELECT id, resultado, fim, pontos_jogador, pontos_banca FROM bacbo_resultados ORDER BY fim DESC NULLS LAST, seq DESC LIMIT 1`);
      ultimoResultadoDB = r1.rows[0] || null;
      totalResultados = (await pool.query('SELECT COUNT(*)::int AS total FROM bacbo_resultados')).rows[0].total;
      totalSinais = (await pool.query('SELECT COUNT(*)::int AS total FROM sinais')).rows[0].total;
      pendentes = (await pool.query(`SELECT COUNT(*)::int AS total FROM sinais WHERE estado = 'PENDENTE'`)).rows[0].total;
      recentes = (await pool.query(`SELECT resultado, pontos_jogador, pontos_banca FROM bacbo_resultados WHERE resultado IN ('Jogador','Banca') ORDER BY fim DESC NULLS LAST, seq DESC LIMIT 12`)).rows;
    }
  } catch (_) {}
  res.json({
    sucesso: true,
    nome: 'Capunga Dados Multi-Estratégia',
    iniciadoEm: runtime.iniciadoEm,
    horaAngola: horaAngola(),
    telegramConfigurado: Boolean(BOT_TOKEN && CHAT_ID),
    httpAPI: runtime.ultimoHTTPAPI,
    erroAPI: runtime.ultimoErroAPI,
    erroSincronizacao: runtime.erroSincronizacao,
    ultimaSincronizacao: runtime.ultimaSincronizacao,
    novosUltimoCiclo: runtime.novosUltimoCiclo,
    ciclosSemNovos: runtime.ciclosSemNovos,
    rodadasRecuperadas: runtime.rodadasRecuperadas,
    ultimoKeepAlive: runtime.ultimoKeepAlive,
    motivoSemSinal: runtime.motivoSemSinal,
    ultimoSinal: runtime.ultimoSinal,
    ultimaEstrategia: runtime.ultimaEstrategia,
    ultimosResultados: recentes,
    baseDados: { totalResultados, totalSinais, pendentes, ultimoResultadoDB },
    configuracao: CONFIG,
    estrategiasActivas: ['REPETICAO', 'QUEBRA', 'SURF', 'DOIS_DOIS', 'FORCA', 'NUMERICA']
  });
});

app.get('/resultados', async (req, res) => {
  try {
    await ensureSchema();
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 500);
    const result = await pool.query(
      `SELECT id, resultado, estado, inicio, fim, pontos_jogador, pontos_banca, multiplicador, guardado_em
       FROM bacbo_resultados ORDER BY fim DESC NULLS LAST, seq DESC LIMIT $1`, [limit]
    );
    res.json({ sucesso: true, total: result.rows.length, resultados: result.rows });
  } catch (error) {
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

app.get('/sinais', async (req, res) => {
  try {
    await ensureSchema();
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 500);
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
        COUNT(*) FILTER (WHERE estado = 'PENDENTE')::int AS pendentes,
        COUNT(*) FILTER (WHERE estado = 'CANCELADO')::int AS cancelados
      FROM sinais
    `);
    const stats = result.rows[0];
    const acertos = (stats.green||0)+(stats.g1||0)+(stats.g2||0);
    const finalizados = acertos + (stats.loss||0);
    const taxa = finalizados > 0 ? Number(((acertos/finalizados)*100).toFixed(1)) : null;
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

app.post('/db/preparar', requireAdmin, async (req, res) => {
  try {
    await ensureSchema();
    res.json({ sucesso: true, mensagem: 'Tabelas preparadas' });
  } catch (error) {
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

app.post('/db/sincronizar', requireAdmin, async (req, res) => {
  try {
    const result = await syncOnce();
    res.status(result.sucesso ? 200 : 500).json(result);
  } catch (error) {
    res.status(500).json({ sucesso: false, erro: error.message || String(error) });
  }
});

app.post('/telegram/teste', requireAdmin, async (req, res) => {
  const enviado = await telegramSend(['🎲🇺🇸 CAPUNGA DADOS 🇺🇸🎲', '✅ Teste OK — Multi-estratégia activa', `🕒 ${horaAngola()}`].join('\n'));
  res.status(enviado ? 200 : 502).json({ sucesso: enviado, erro: runtime.ultimoErroTelegram });
});

app.use((req, res) => {
  res.status(404).json({ sucesso: false, erro: 'Rota não encontrada', caminho: req.path });
});

function startKeepAlive() {
  if (!SELF_URL) {
    log('KEEPALIVE', 'SELF_URL/RENDER_EXTERNAL_URL ausente — use um ping externo (UptimeRobot) em /health');
    return;
  }
  const alvo = `${SELF_URL.replace(/\/+$/, '')}/health`;
  keepAliveTimer = setInterval(async () => {
    try {
      await axios.get(alvo, { timeout: 15000 });
      runtime.ultimoKeepAlive = new Date().toISOString();
    } catch (e) {
      console.error('[KEEPALIVE]', e.message);
    }
  }, CONFIG.keepAliveMs);
  if (typeof keepAliveTimer.unref === 'function') keepAliveTimer.unref();
  log('KEEPALIVE', { alvo, cadaMs: CONFIG.keepAliveMs });
}

async function start() {
  // 1) Abre a porta primeiro — o Render só marca o deploy como saudável assim
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log('======================================');
    console.log('CAPUNGA DADOS — MULTI-ESTRATÉGIA v6.1');
    console.log(`Porta: ${PORT} | Angola: ${horaAngola()}`);
    console.log(`Sinais: ${CONFIG.sinaisAtivos} | Streak: ${CONFIG.streakMin} | Gale: ${CONFIG.maxGale}`);
    console.log('Estratégias: REPETICAO QUEBRA SURF DOIS_DOIS FORCA NUMERICA');
    console.log('======================================');
  });

  if (!DATABASE_URL) {
    console.error('[AVISO] DATABASE_URL não configurada — servidor online mas sem sincronização');
  }

  // 2) Prepara BD (com nova tentativa automática se falhar)
  try {
    await ensureSchema();
  } catch (e) {
    console.error('[DB] falha ao preparar tabelas, nova tentativa no próximo ciclo:', e.message);
  }

  // 3) Catch-up imediato: recupera tudo o que aconteceu enquanto dormia
  const initial = await syncOnce();
  if (!initial.sucesso) console.error('[PRIMEIRA SYNC]', initial.erro);
  else log('PRIMEIRA SYNC', { recebidos: initial.recebidos, novos: initial.novosGuardados, recuperadas: initial.recuperadasAtrasadas });

  // 4) Ciclo contínuo
  syncTimer = setInterval(async () => {
    if (runtime.sincronizacaoEmCurso) return;
    try { await syncOnce(); } catch (err) { console.error('[SYNC]', err.message); }
  }, CONFIG.intervaloSyncMs);

  // 5) Keep-alive automático
  startKeepAlive();
}

process.on('unhandledRejection', (r) => console.error('[UNHANDLED]', r));
process.on('uncaughtException', (e) => console.error('[UNCAUGHT]', e));

async function shutdown() {
  if (syncTimer) clearInterval(syncTimer);
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  if (server) await new Promise((r) => server.close(r));
  if (pool) await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown().catch(() => process.exit(1)));
process.on('SIGINT', () => shutdown().catch(() => process.exit(1)));
start().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
