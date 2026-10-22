'use strict';

/**
 * CAPUNGA DADOS — BAC BO TELEGRAM SERVER (v5 - endurecido)
 *
 * - Não inventa sinais para cumprir frequência
 * - Não bloqueia por limite diário de REDs
 * - Na primeira sincronização importa histórico sem publicar sinais antigos
 * - Só resolve sinais com rodadas novas
 * - Análise de padrões é descritiva
 *
 * Variáveis obrigatórias:
 *   DATABASE_URL, BOT_TOKEN, CHAT_ID, ADMIN_TOKEN
 *
 * Opcionais:
 *   API_BACBO, SINAIS_ATIVOS, STREAK_MIN, MAX_GALE,
 *   EMPATE_PROTEGIDO, INTERVALO_MINIMO_MS, SINAL_EXPIRA_MIN,
 *   INTERVALO_SYNC_MS, TELEGRAM_PARSE_MODE, ALERT_WEBHOOK
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
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK || '';
const API_BACBO = process.env.API_BACBO ||
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
  intervaloMinimoMs: intEnv('INTERVALO_MINIMO_MS', 45000, 0, 3600000), // \~45s entre sinais (frequência média)
  sinalExpiraMin: intEnv('SINAL_EXPIRA_MIN', 12, 3, 180),
  intervaloSyncMs: intEnv('INTERVALO_SYNC_MS', 7000, 5000, 30000),
  telegramParseMode: process.env.TELEGRAM_PARSE_MODE || ''
};

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/i.test(DATABASE_URL)
        ? false
        : { rejectUnauthorized: false },
      max: 8,
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 12000
    })
  : null;

if (pool) {
  pool.on('error', (err) => {
    log('POOL_ERROR', err.message);
    runtime.erroSincronizacao = err.message;
  });
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
  errosConsecutivos: 0,
  motivoSemSinal: null,
  ultimaEstrategia: null,
  ultimaDuracaoSyncMs: null,
  gapDetectado: null
};

let schemaPromise = null;
let server = null;
let syncTimer = null;
let shuttingDown = false;

function log(tag, data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  console.log(`[\( {new Date().toISOString()}] [ \){tag}] ${payload}`);
}

function horaAngola() {
  return new Intl.DateTimeFormat('pt-PT', {
    timeZone: 'Africa/Luanda',
    dateStyle: 'short',
    timeStyle: 'medium',
    hour12: false
  }).format(new Date());
}

async function alertIndependent(msg) {
  log('ALERTA', msg);
  if (ALERT_WEBHOOK) {
    try {
      await axios.post(ALERT_WEBHOOK, {
        text: `[Capunga BacBo] ${msg}`,
        time: new Date().toISOString()
      }, { timeout: 8000 });
    } catch (e) {
      log('ALERT_WEBHOOK_FAIL', e.message);
    }
  }
}

function corDisplay(cor) {
  if (cor === 'Banca') return '🔴 BANCA';
  if (cor === 'Jogador') return '🔵 JOGADOR';
  if (cor === 'Empate') return '🟡 EMPATE';
  return String(cor || 'N/D');
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

  if (['player', 'jogador', 'playerwin', 'playerwins', 'playerwon', 'playerwinner', 'blue'].includes(s)) return 'Jogador';
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
  const r = (d.result && typeof d.result === 'object')
    ? d.result
    : (item?.result && typeof item.result === 'object' ? item.result : {});

  const status = String(d.status ?? d.estado ?? item?.status ?? item?.estado ?? '').toLowerCase();

  const inicio = validDate(
    d.startedAt ?? d.startTime ?? d.started_at ?? d.inicio ??
    item?.startedAt ?? item?.inicio
  );

  const fim = validDate(
    d.settledAt ?? d.endTime ?? d.endedAt ?? d.finishedAt ?? d.fim ??
    item?.settledAt ?? item?.fim
  );

  const rawOutcome =
    r.outcome ?? r.resultado ?? r.winner ??
    d.outcome ?? d.resultado ?? d.winner ??
    item?.outcome ?? item?.resultado ?? item?.winner ??
    (typeof d.result === 'string' ? d.result : null) ??
    (typeof item?.result === 'string' ? item.result : null);

  const resultado = normalizeOutcome(rawOutcome);

  const resolvida = [
    'resolved', 'settled', 'finished', 'complete', 'completed',
    'resolvido', 'concluido', 'finalizado'
  ].some(word => status.includes(word)) || Boolean(fim);

  const id = String(
    d.id ?? d.roundId ?? d.round_id ?? d.eventId ??
    item?.id ?? item?.roundId ?? item?.round_id ?? item?.eventId ?? ''
  ).trim();

  if (!id || !resultado || !resolvida || !fim) return null;

  const scoreJogador = Number(
    r.playerDice?.score ?? d.playerDice?.score ?? d.playerScore ??
    d.player_score ?? d.pontos_jogador
  );

  const scoreBanca = Number(
    r.bankerDice?.score ?? d.bankerDice?.score ?? d.bankerScore ??
    d.banker_score ?? d.pontos_banca
  );

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
    const payload = {
      chat_id: CHAT_ID,
      text: texto,
      disable_web_page_preview: true
    };
    if (CONFIG.telegramParseMode) payload.parse_mode = CONFIG.telegramParseMode;

    const response = await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      payload,
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
    runtime.ultimoErroTelegram = error.response?.data
      ? JSON.stringify(error.response.data)
      : error.message;
    log('TELEGRAM', runtime.ultimoErroTelegram);
    return false;
  }
}

async function ensureSchema() {
  if (!pool) throw new Error('DATABASE_URL não configurada');
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bacbo_resultados (
        id              TEXT PRIMARY KEY,
        resultado       TEXT NOT NULL,
        estado          TEXT NOT NULL DEFAULT 'Resolved',
        inicio          TIMESTAMPTZ,
        fim             TIMESTAMPTZ,
        pontos_jogador  INTEGER,
        pontos_banca    INTEGER,
        multiplicador   TEXT,
        guardado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        seq             BIGINT GENERATED ALWAYS AS IDENTITY
      )
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bacbo_fim ON bacbo_resultados (fim DESC NULLS LAST)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_bacbo_seq ON bacbo_resultados (seq DESC)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sinais (
        id              BIGSERIAL PRIMARY KEY,
        criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        cor             TEXT NOT NULL,
        estado          TEXT NOT NULL DEFAULT 'PENDENTE',
        gale            INTEGER NOT NULL DEFAULT 0,
        resultado_id    TEXT,
        resultado_final TEXT,
        empates         INTEGER NOT NULL DEFAULT 0,
        estrategia      TEXT,
        estrategia_nome TEXT,
        resolvido_em    TIMESTAMPTZ
      )
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sinais_estado ON sinais (estado)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sinais_criado ON sinais (criado_em DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sinais_resultado_id ON sinais (resultado_id)`);

    // Garante no máximo 1 sinal pendente
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sinais_um_pendente
      ON sinais ((estado))
      WHERE estado = 'PENDENTE'
    `);

    log('DB', { tabelasPreparadas: true });
  })();

  try {
    await schemaPromise;
  } catch (error) {
    schemaPromise = null;
    throw error;
  }
}

async function fetchRoundsWithRetry(maxAttempts = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await axios.get(API_BACBO, {
        timeout: 18000,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'CapungaDadosBot/5.0'
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

      const rounds = [...unique.values()].sort(
        (a, b) => new Date(a.fim) - new Date(b.fim)
      );

      runtime.itensRecebidosAPI = items.length;
      runtime.quantidadeAPI = rounds.length;
      runtime.ultimaHoraDaAPI = rounds.at(-1)?.fim || null;

      return rounds;
    } catch (err) {
      lastError = err;
      runtime.ultimoHTTPAPI = err.response?.status || null;
      runtime.ultimoErroAPI = err.message;

      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 700 * Math.pow(2, attempt - 1)));
      }
    }
  }

  throw lastError || new Error('Falha na API');
}

async function insertRound(round) {
  const result = await pool.query(
    `INSERT INTO bacbo_resultados
       (id, resultado, estado, inicio, fim, pontos_jogador, pontos_banca, multiplicador)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      round.id, round.resultado, round.estado, round.inicio, round.fim,
      round.pontos_jogador, round.pontos_banca, round.multiplicador
    ]
  );
  return result.rows.length > 0;
}

async function getLatestFromDB() {
  const result = await pool.query(`
    SELECT id, resultado, fim
    FROM bacbo_resultados
    ORDER BY fim DESC NULLS LAST, seq DESC
    LIMIT 1
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

/* ======================== ESTRATÉGIAS ======================== */

function streakLen(rows) {
  if (!rows.length) return 0;
  const color = rows[0].resultado;
  if (!['Jogador', 'Banca'].includes(color)) return 0;

  let n = 0;
  for (const row of rows) {
    if (row.resultado === color) n++;
    else break;
  }
  return n;
}

function stratRepeticao(rows) {
  const n = streakLen(rows);
  if (n < CONFIG.streakMin) return null;

  return {
    cor: rows[0].resultado,
    estrategia: 'REPETICAO',
    nome: `Repetição x${n}`,
    emoji: '🔁',
    prioridade: Math.min(90, 50 + n * 10)
  };
}

function stratQuebra(rows) {
  const n = streakLen(rows);
  if (n < CONFIG.streakMin + 1) return null;

  const cor = oposta(rows[0].resultado);
  if (!cor) return null;

  return {
    cor,
    estrategia: 'QUEBRA',
    nome: `Quebra x${n}`,
    emoji: '💥',
    prioridade: Math.min(88, 55 + n * 8)
  };
}

function stratSurf(rows) {
  if (rows.length < 4) return null;

  const a = rows[0].resultado;
  const b = rows[1].resultado;

  if (!['Jogador', 'Banca'].includes(a) || !['Jogador', 'Banca'].includes(b) || a === b) return null;

  for (let i = 0; i < 4; i++) {
    const expected = i % 2 === 0 ? a : b;
    if (rows[i]?.resultado !== expected) return null;
  }

  return {
    cor: b,
    estrategia: 'SURF',
    nome: 'Surf (alternância 4)',
    emoji: '🌊',
    prioridade: 78
  };
}

function stratDoisDois(rows) {
  if (rows.length < 4) return null;
  const r = rows.map(x => x.resultado);

  if (
    r[0] === r[1] &&
    r[2] === r[3] &&
    r[0] !== r[2] &&
    ['Jogador', 'Banca'].includes(r[0])
  ) {
    return {
      cor: r[0],
      estrategia: 'DOIS_DOIS',
      nome: '2+2 (blocos completos)',
      emoji: '♟️',
      prioridade: 82
    };
  }

  if (
    r[0] !== r[1] &&
    r[1] === r[2] &&
    ['Jogador', 'Banca'].includes(r[0]) &&
    ['Jogador', 'Banca'].includes(r[1])
  ) {
    return {
      cor: r[0],
      estrategia: 'DOIS_DOIS',
      nome: '2+2 (possível fecho)',
      emoji: '♟️',
      prioridade: 75
    };
  }

  return null;
}

function stratForca(rows) {
  const sample = rows.slice(0, 12).filter(r => ['Jogador', 'Banca'].includes(r.resultado));
  if (sample.length < 8) return null;

  let j = 0, b = 0;
  for (const row of sample) {
    if (row.resultado === 'Jogador') j++;
    else b++;
  }

  const total = j + b;
  const pctJ = j / total;
  const pctB = b / total;

  if (pctB >= 0.65) {
    return {
      cor: 'Banca',
      estrategia: 'FORCA',
      nome: `Força da mesa Banca ${Math.round(pctB * 100)}%`,
      emoji: '💪',
      prioridade: 72
    };
  }

  if (pctJ >= 0.65) {
    return {
      cor: 'Jogador',
      estrategia: 'FORCA',
      nome: `Força da mesa Jogador ${Math.round(pctJ * 100)}%`,
      emoji: '💪',
      prioridade: 72
    };
  }

  return null;
}

function stratNumerica(rows) {
  if (rows.length < 3) return null;

  const last = rows[0];
  const pj = Number(last.pontos_jogador);
  const pb = Number(last.pontos_banca);

  if (Number.isFinite(pj) && Number.isFinite(pb)) {
    if (last.resultado === 'Jogador' && pj >= 10 && pj > pb) {
      return {
        cor: 'Jogador',
        estrategia: 'NUMERICA',
        nome: `Numérica: Jogador \( {pj}- \){pb}`,
        emoji: '🔢',
        prioridade: 68
      };
    }
    if (last.resultado === 'Banca' && pb >= 10 && pb > pj) {
      return {
        cor: 'Banca',
        estrategia: 'NUMERICA',
        nome: `Numérica: Banca \( {pb}- \){pj}`,
        emoji: '🔢',
        prioridade: 68
      };
    }
  }

  let sameColorWithLargeDiff = true;
  let dominantColor = null;

  for (let i = 0; i < 3; i++) {
    const row = rows[i];
    const a = Number(row.pontos_jogador);
    const b = Number(row.pontos_banca);

    if (
      !Number.isFinite(a) || !Number.isFinite(b) ||
      Math.abs(a - b) < 4 ||
      !['Jogador', 'Banca'].includes(row.resultado)
    ) {
      sameColorWithLargeDiff = false;
      break;
    }

    if (!dominantColor) dominantColor = row.resultado;
    else if (row.resultado !== dominantColor) sameColorWithLargeDiff = false;
  }

  if (sameColorWithLargeDiff && dominantColor) {
    return {
      cor: dominantColor,
      estrategia: 'NUMERICA',
      nome: 'Numérica: diferença ≥4 em 3 rodadas',
      emoji: '🔢',
      prioridade: 70
    };
  }

  if (rows.length >= 2) {
    const w0 = rows[0];
    const w1 = rows[1];

    if (w0.resultado === w1.resultado && ['Jogador', 'Banca'].includes(w0.resultado)) {
      const s0 = w0.resultado === 'Jogador' ? Number(w0.pontos_jogador) : Number(w0.pontos_banca);
      const s1 = w1.resultado === 'Jogador' ? Number(w1.pontos_jogador) : Number(w1.pontos_banca);

      if (Number.isFinite(s0) && Number.isFinite(s1) && s0 <= 5 && s1 <= 5) {
        return {
          cor: oposta(w0.resultado),
          estrategia: 'NUMERICA',
          nome: 'Numérica: duas vitórias de pontuação baixa',
          emoji: '🔢',
          prioridade: 65
        };
      }
    }
  }

  return null;
}

function detectBestEntry(rows) {
  if (!rows || rows.length < 2) return null;

  const candidates = [
    stratRepeticao(rows),
    stratQuebra(rows),
    stratDoisDois(rows),
    stratSurf(rows),
    stratForca(rows),
    stratNumerica(rows)
  ].filter(Boolean);

  if (!candidates.length) return null;

  const order = {
    REPETICAO: 6,
    QUEBRA: 5,
    DOIS_DOIS: 4,
    SURF: 3,
    FORCA: 2,
    NUMERICA: 1
  };

  candidates.sort((a, b) => {
    if (b.prioridade !== a.prioridade) return b.prioridade - a.prioridade;
    return (order[b.estrategia] || 0) - (order[a.estrategia] || 0);
  });

  return candidates[0];
}

/* ======================== PLACAR / MENSAGENS ======================== */

async function getPlacarDia() {
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE estado = 'GREEN')::int AS green,
      COUNT(*) FILTER (WHERE estado = 'G1')::int AS g1,
      COUNT(*) FILTER (WHERE estado = 'G2')::int AS g2,
      COUNT(*) FILTER (WHERE estado = 'LOSS')::int AS loss,
      COALESCE(SUM(empates), 0)::int AS empates,
      COUNT(*) FILTER (WHERE estado = 'PENDENTE')::int AS pendentes,
      COUNT(*) FILTER (WHERE estado = 'CANCELADO')::int AS cancelados
    FROM sinais
    WHERE criado_em >= date_trunc('day', NOW() AT TIME ZONE 'Africa/Luanda')
                     AT TIME ZONE 'Africa/Luanda'
  `);

  const s = result.rows[0] || {};
  const green = Number(s.green || 0);
  const g1 = Number(s.g1 || 0);
  const g2 = Number(s.g2 || 0);
  const loss = Number(s.loss || 0);
  const wins = green + g1 + g2;
  const closed = wins + loss;
  const percent = closed > 0 ? Number(((wins / closed) * 100).toFixed(1)) : 0;

  const recent = await pool.query(`
    SELECT estado FROM sinais
    WHERE criado_em >= date_trunc('day', NOW() AT TIME ZONE 'Africa/Luanda')
                     AT TIME ZONE 'Africa/Luanda'
      AND estado IN ('GREEN', 'G1', 'G2', 'LOSS')
    ORDER BY criado_em DESC, id DESC
    LIMIT 50
  `);

  let greensSeguidos = 0;
  for (const row of recent.rows) {
    if (['GREEN', 'G1', 'G2'].includes(row.estado)) greensSeguidos++;
    else break;
  }

  return {
    totalSinais: closed + Number(s.pendentes || 0) + Number(s.cancelados || 0),
    green, g1, g2,
    empates: Number(s.empates || 0),
    loss,
    pendentes: Number(s.pendentes || 0),
    cancelados: Number(s.cancelados || 0),
    finalizados: closed,
    acertos: wins,
    percent,
    greensSeguidos
  };
}

function formatPlacar(p) {
  return [
    '',
    '┏━━━━━━━━━━━━━━━━━━━━┓',
    '📊 PLACAR DO DIA',
    '┗━━━━━━━━━━━━━━━━━━━━┛',
    `🎯 Sinais registados: ${p.totalSinais}`,
    `✅ Green directo: ${p.green}`,
    `⚡ Green G1: ${p.g1}`,
    `🔥 Green G2: ${p.g2}`,
    `🟡 Empates protegidos: ${p.empates}`,
    `❌ Reds: ${p.loss}`,
    `⏳ Pendentes: ${p.pendentes}`,
    `📈 Taxa de acerto: ${p.percent}%`,
    `🏁 Greens seguidos: ${p.greensSeguidos}`,
    '━━━━━━━━━━━━━━━━━━━━'
  ].join('\n');
}

async function getPendingSignal() {
  const result = await pool.query(`
    SELECT * FROM sinais
    WHERE estado = 'PENDENTE'
    ORDER BY criado_em ASC, id ASC
    LIMIT 1
  `);
  return result.rows[0] || null;
}

async function expirePendingSignal(signal) {
  if (!signal) return false;

  const age = Date.now() - new Date(signal.criado_em).getTime();
  if (age < CONFIG.sinalExpiraMin * 60000) return false;

  await pool.query(
    `UPDATE sinais
     SET estado = 'CANCELADO', resolvido_em = NOW()
     WHERE id = $1 AND estado = 'PENDENTE'`,
    [signal.id]
  );

  await telegramSend([
    '⏰ SINAL CANCELADO POR EXPIRAÇÃO',
    `🆔 Sinal #${signal.id}`,
    `🎯 Entrada: ${corDisplay(signal.cor)}`,
    `🕒 ${horaAngola()}`
  ].join('\n'));

  log('SINAL EXPIRADO', { id: signal.id });
  return true;
}

function msgNovoSinal(entry, signalId) {
  return [
    '╔════════════════════╗',
    '🎲 CAPUNGA DADOS · BAC BO',
    '╚════════════════════╝',
    '🚨 NOVO SINAL REGISTADO',
    '━━━━━━━━━━━━━━━━━━━━',
    `🆔 Sinal #${signalId}`,
    `🎯 Entrada: ${corDisplay(entry.cor)}`,
    `${entry.emoji} Estratégia: ${entry.nome}`,
    `🛡️ Proteção: ${CONFIG.empateProtegido ? 'Empate protegido' : 'Sem proteção de empate'}`,
    `🔁 Gales máximos: ${CONFIG.maxGale}`,
    `🕒 Hora Angola: ${horaAngola()}`,
    '━━━━━━━━━━━━━━━━━━━━',
    '⚠️ Padrões históricos não garantem o próximo resultado.'
  ].join('\n');
}

function msgResultadoGreen(signal, state) {
  const title = state === 'GREEN'
    ? '✅ GREEN DIRECTO'
    : state === 'G1' ? '⚡ GREEN NO GALE 1' : '🔥 GREEN NO GALE 2';

  return [
    '╔════════════════════╗',
    '📋 RESULTADO DO SINAL',
    '╚════════════════════╝',
    title,
    `🆔 Sinal #${signal.id}`,
    `🎯 Entrada: ${corDisplay(signal.cor)}`,
    `🧠 Estratégia: ${signal.estrategia_nome || signal.estrategia || 'N/D'}`,
    `🐓 Gales usados: ${Number(signal.gale || 0)}`,
    `🕒 ${horaAngola()}`
  ].join('\n');
}

function msgResultadoLoss(signal) {
  return [
    '╔════════════════════╗',
    '📋 RESULTADO DO SINAL',
    '╚════════════════════╝',
    '❌ RED FINAL',
    `🆔 Sinal #${signal.id}`,
    `🎯 Entrada: ${corDisplay(signal.cor)}`,
    `🧠 Estratégia: ${signal.estrategia_nome || signal.estrategia || 'N/D'}`,
    `🐓 Gales usados: \( {Number(signal.gale || 0)}/ \){CONFIG.maxGale}`,
    `🕒 ${horaAngola()}`
  ].join('\n');
}

function msgGale(signal, nextGale) {
  return [
    '╔════════════════════╗',
    `🐓 GALE ${nextGale}`,
    '╚════════════════════╝',
    `🆔 Sinal #${signal.id}`,
    `🎯 Manter entrada: ${corDisplay(signal.cor)}`,
    `🧠 Estratégia: ${signal.estrategia_nome || signal.estrategia || 'N/D'}`,
    `🕒 ${horaAngola()}`
  ].join('\n');
}

function msgEmpate(signal) {
  return [
    '╔════════════════════╗',
    '🟡 EMPATE PROTEGIDO',
    '━━━━━━━━━━━━━━━━━━━━',
    `🆔 Sinal #${signal.id} continua pendente`,
    `🎯 Entrada: ${corDisplay(signal.cor)}`,
    `🟡 Empates registados: ${Number(signal.empates || 0) + 1}`,
    `🕒 ${horaAngola()}`
  ].join('\n');
}

async function maybeCreateSignal(round) {
  if (!CONFIG.sinaisAtivos) {
    runtime.motivoSemSinal = 'sinais_desativados';
    return;
  }

  if (!['Jogador', 'Banca'].includes(round.resultado)) {
    runtime.motivoSemSinal = 'resultado_empate';
    return;
  }

  const pending = await getPendingSignal();
  if (pending && !(await expirePendingSignal(pending))) {
    runtime.motivoSemSinal = `sinal_pendente_#${pending.id}`;
    return;
  }

  const lastResult = await pool.query(`
    SELECT criado_em FROM sinais
    WHERE estado <> 'CANCELADO'
    ORDER BY criado_em DESC, id DESC
    LIMIT 1
  `);

  const last = lastResult.rows[0];
  if (
    last?.criado_em &&
    Date.now() - new Date(last.criado_em).getTime() < CONFIG.intervaloMinimoMs
  ) {
    runtime.motivoSemSinal = 'intervalo_minimo';
    return;
  }

  const rows = await getRecentOutcomes(30);
  const entry = detectBestEntry(rows);

  if (!entry) {
    const recent = rows.slice(0, 6).map(r => r.resultado[0]).join('');
    runtime.motivoSemSinal = `sem_setup[${recent}]`;
    return;
  }

  // Não criar mais de um sinal baseado na mesma rodada
  const used = await pool.query(
    `SELECT 1 FROM sinais WHERE resultado_id = $1 LIMIT 1`,
    [round.id]
  );
  if (used.rows.length) {
    runtime.motivoSemSinal = 'rodada_ja_usada';
    return;
  }

  const inserted = await pool.query(
    `INSERT INTO sinais
       (cor, estado, gale, resultado_id, empates, estrategia, estrategia_nome)
     VALUES ($1, 'PENDENTE', 0, $2, 0, $3, $4)
     RETURNING *`,
    [entry.cor, round.id, entry.estrategia, entry.nome]
  );

  const signal = inserted.rows[0];

  runtime.ultimoSinal = {
    id: signal.id,
    cor: signal.cor,
    estado: signal.estado,
    criado_em: signal.criado_em,
    estrategia: signal.estrategia,
    estrategia_nome: signal.estrategia_nome
  };
  runtime.ultimaEstrategia = entry;
  runtime.motivoSemSinal = null;

  const sent = await telegramSend(msgNovoSinal(entry, signal.id));
  if (!sent) log('AVISO', { sinalCriado: signal.id, telegramEnviado: false });

  log('SINAL CRIADO', { id: signal.id, cor: entry.cor, estrategia: entry.estrategia });
}

async function resolvePending(round) {
  const signal = await getPendingSignal();
  if (!signal) return;
  if (String(signal.resultado_id) === String(round.id)) return;
  if (await expirePendingSignal(signal)) return;

  if (round.resultado === 'Empate') {
    if (!CONFIG.empateProtegido) return;

    const updated = await pool.query(
      `UPDATE sinais
       SET empates = COALESCE(empates, 0) + 1
       WHERE id = $1 AND estado = 'PENDENTE'
       RETURNING *`,
      [signal.id]
    );

    if (updated.rows[0]) await telegramSend(msgEmpate(updated.rows[0]));
    return;
  }

  if (round.resultado === signal.cor) {
    const galeNum = Number(signal.gale || 0);
    const state = galeNum === 0 ? 'GREEN' : galeNum === 1 ? 'G1' : 'G2';

    const updated = await pool.query(
      `UPDATE sinais
       SET estado = $1, resultado_final = $2, resolvido_em = NOW()
       WHERE id = $3 AND estado = 'PENDENTE'
       RETURNING *`,
      [state, round.resultado, signal.id]
    );

    if (updated.rows[0]) {
      const placar = await getPlacarDia();
      await telegramSend(msgResultadoGreen(updated.rows[0], state) + formatPlacar(placar));
      log('SINAL RESOLVIDO', { id: signal.id, estado: state });
    }
    return;
  }

  const nextGale = Number(signal.gale || 0) + 1;

  if (nextGale <= CONFIG.maxGale) {
    const updated = await pool.query(
      `UPDATE sinais SET gale = $1
       WHERE id = $2 AND estado = 'PENDENTE'
       RETURNING *`,
      [nextGale, signal.id]
    );

    if (updated.rows[0]) {
      await telegramSend(msgGale(updated.rows[0], nextGale));
      log('GALE', { id: signal.id, gale: nextGale });
    }
    return;
  }

  const updated = await pool.query(
    `UPDATE sinais
     SET estado = 'LOSS', resultado_final = $1, resolvido_em = NOW()
     WHERE id = $2 AND estado = 'PENDENTE'
     RETURNING *`,
    [round.resultado, signal.id]
  );

  if (updated.rows[0]) {
    const placar = await getPlacarDia();
    await telegramSend(msgResultadoLoss(updated.rows[0]) + formatPlacar(placar));
    log('SINAL RED', { id: signal.id });
  }
}

/**
 * Fluxo principal de sincronização
 */
async function syncOnce() {
  if (!pool) throw new Error('DATABASE_URL não configurada');
  if (runtime.sincronizacaoEmCurso || shuttingDown) {
    return { sucesso: false, ignorada: true };
  }

  runtime.sincronizacaoEmCurso = true;
  const started = Date.now();

  try {
    await ensureSchema();

    const countBefore = await pool.query(`SELECT COUNT(*)::int AS total FROM bacbo_resultados`);
    const hadHistory = Number(countBefore.rows[0].total) > 0;

    const rounds = await fetchRoundsWithRetry();

    // Detecção de gap
    if (runtime.ultimaSincronizacao && rounds.length > 0) {
      const oldestInBatch = new Date(rounds[0].fim).getTime();
      const lastSync = new Date(runtime.ultimaSincronizacao).getTime();
      const gapMs = oldestInBatch - lastSync;
      if (gapMs > 3 * 60 * 1000) {
        runtime.gapDetectado = { gapMs, oldestInBatch: rounds[0].fim };
        await alertIndependent(`Possível perda de rodadas (gap \~${Math.round(gapMs / 1000)}s)`);
      } else {
        runtime.gapDetectado = null;
      }
    }

    let inserted = 0;
    let duplicates = 0;
    let evaluated = 0;
    let lastNew = null;

    for (const round of rounds) {
      const saved = await insertRound(round);

      if (!saved) {
        duplicates++;
        continue;
      }

      inserted++;
      lastNew = round;

      // Só avalia sinais depois da base histórica existir
      if (hadHistory) {
        await resolvePending(round);
        await maybeCreateSignal(round);
        evaluated++;
      }
    }

    if (!hadHistory && inserted > 0) {
      log('BASE HISTÓRICA CRIADA', {
        importados: inserted,
        sinaisAntigosPublicados: false
      });
      runtime.motivoSemSinal = 'a_inicializar_base_historica';
    } else if (inserted === 0) {
      runtime.ciclosSemNovos += 1;
      const pending = await getPendingSignal();
      if (pending) await expirePendingSignal(pending);
      if (!runtime.motivoSemSinal) runtime.motivoSemSinal = 'a_aguardar_nova_rodada_da_api';
    } else {
      runtime.ciclosSemNovos = 0;
    }

    const latest = await getLatestFromDB();

    runtime.ultimaRodadaDB = latest?.fim || null;
    runtime.ultimoIdDB = latest?.id || null;
    runtime.sincronizacaoInicialConcluida = true;
    runtime.ultimaSincronizacao = new Date().toISOString();
    runtime.duplicadosUltimoCiclo = duplicates;
    runtime.novosUltimoCiclo = inserted;
    runtime.erroSincronizacao = null;
    runtime.errosConsecutivos = 0;
    runtime.ultimaDuracaoSyncMs = Date.now() - started;

    if (lastNew) {
      runtime.ultimaRodadaNova = new Date().toISOString();
      runtime.ultimoIdNovo = lastNew.id;
    }

    const summary = {
      recebidos: rounds.length,
      novosGuardados: inserted,
      duplicados,
      sinaisAvaliados: evaluated,
      motivoSemSinal: runtime.motivoSemSinal,
      ultimaEstrategia: runtime.ultimaEstrategia?.estrategia || null,
      ciclosSemNovos: runtime.ciclosSemNovos,
      duracaoMs: runtime.ultimaDuracaoSyncMs,
      horaAngola: horaAngola()
    };

    if (inserted > 0 || runtime.ciclosSemNovos % 10 === 0) {
      log('SINCRONIZACAO', summary);
    }

    return { sucesso: true, ...summary };
  } catch (error) {
    runtime.erroSincronizacao = error.message || String(error);
    runtime.ultimaDuracaoSyncMs = Date.now() - started;
    runtime.errosConsecutivos++;

    log('ERRO SINCRONIZACAO', runtime.erroSincronizacao);

    if (runtime.errosConsecutivos >= 3) {
      await alertIndependent(`3+ erros consecutivos: ${runtime.erroSincronizacao}`);
    }

    return { sucesso: false, erro: runtime.erroSincronizacao };
  } finally {
    runtime.sincronizacaoEmCurso = false;
  }
}

/* ======================== ROTAS ======================== */

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ sucesso: false, erro: 'ADMIN_TOKEN não configurado' });
  }
  if (req.get('x-admin-token') !== ADMIN_TOKEN) {
    return res.status(401).json({ sucesso: false, erro: 'Token inválido' });
  }
  next();
}

app.get('/', (_req, res) => {
  res.json({
    nome: 'Capunga Dados — BAC BO Telegram',
    estado: 'online',
    horaAngola: horaAngola(),
    estrategia: ['REPETICAO', 'QUEBRA', 'SURF', 'DOIS_DOIS', 'FORCA', 'NUMERICA'],
    modo: 'sinais apenas quando existe configuração elegível',
    rotas: ['/health', '/diagnostico', '/resultados', '/sinais', '/estatisticas']
  });
});

app.get('/health', (_req, res) => {
  res.json({
    sucesso: true,
    estado: 'online',
    horaAngola: horaAngola(),
    iniciadoEm: runtime.iniciadoEm,
    ultimaSincronizacao: runtime.ultimaSincronizacao,
    ultimaRodadaNova: runtime.ultimaRodadaNova,
    ultimoIdNovo: runtime.ultimoIdNovo,
    novosUltimoCiclo: runtime.novosUltimoCiclo,
    ciclosSemNovos: runtime.ciclosSemNovos,
    motivoSemSinal: runtime.motivoSemSinal,
    erroSincronizacao: runtime.erroSincronizacao,
    ultimoErroAPI: runtime.ultimoErroAPI,
    ultimoErroTelegram: runtime.ultimoErroTelegram,
    ultimaDuracaoSyncMs: runtime.ultimaDuracaoSyncMs,
    ultimaEstrategia: runtime.ultimaEstrategia,
    gapDetectado: runtime.gapDetectado
  });
});

app.get('/diagnostico', async (_req, res) => {
  let ultimoResultadoDB = null;
  let totalResultados = 0;
  let totalSinais = 0;
  let pendentes = 0;
  let recentes = [];

  try {
    if (pool) {
      await ensureSchema();

      const r1 = await pool.query(`
        SELECT id, resultado, fim, pontos_jogador, pontos_banca
        FROM bacbo_resultados
        ORDER BY fim DESC NULLS LAST, seq DESC LIMIT 1
      `);
      ultimoResultadoDB = r1.rows[0] || null;

      totalResultados = Number((await pool.query('SELECT COUNT(*)::int AS total FROM bacbo_resultados')).rows[0].total);
      totalSinais = Number((await pool.query('SELECT COUNT(*)::int AS total FROM sinais')).rows[0].total);
      pendentes = Number((await pool.query(`SELECT COUNT(*)::int AS total FROM sinais WHERE estado = 'PENDENTE'`)).rows[0].total);

      recentes = (await pool.query(`
        SELECT resultado, pontos_jogador, pontos_banca, fim
        FROM bacbo_resultados
        WHERE resultado IN ('Jogador','Banca','Empate')
        ORDER BY fim DESC NULLS LAST, seq DESC LIMIT 12
      `)).rows;
    }
  } catch (error) {
    runtime.erroSincronizacao = runtime.erroSincronizacao || error.message;
  }

  res.json({
    sucesso: true,
    nome: 'Capunga Dados — BAC BO Telegram',
    iniciadoEm: runtime.iniciadoEm,
    horaAngola: horaAngola(),
    telegramConfigurado: Boolean(BOT_TOKEN && CHAT_ID),
    databaseConfigurada: Boolean(DATABASE_URL),
    httpAPI: runtime.ultimoHTTPAPI,
    erroAPI: runtime.ultimoErroAPI,
    ultimaSincronizacao: runtime.ultimaSincronizacao,
    ultimaRodadaNova: runtime.ultimaRodadaNova,
    novosUltimoCiclo: runtime.novosUltimoCiclo,
    ciclosSemNovos: runtime.ciclosSemNovos,
    motivoSemSinal: runtime.motivoSemSinal,
    ultimoSinal: runtime.ultimoSinal,
    ultimaEstrategia: runtime.ultimaEstrategia,
    ultimosResultados: recentes,
    baseDados: { totalResultados, totalSinais, pendentes, ultimoResultadoDB },
    configuracao: CONFIG
  });
});

app.get('/resultados', async (req, res) => {
  try {
    await ensureSchema();
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 500);

    const result = await pool.query(`
      SELECT id, resultado, estado, inicio, fim, pontos_jogador, pontos_banca, multiplicador, guardado_em
      FROM bacbo_resultados
      ORDER BY fim DESC NULLS LAST, seq DESC
      LIMIT $1
    `, [limit]);

    res.json({ sucesso: true, total: result.rows.length, resultados: result.rows });
  } catch (error) {
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

app.get('/sinais', async (req, res) => {
  try {
    await ensureSchema();
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 500);

    const result = await pool.query(`
      SELECT * FROM sinais
      ORDER BY criado_em DESC, id DESC
      LIMIT $1
    `, [limit]);

    res.json({ sucesso: true, total: result.rows.length, sinais: result.rows });
  } catch (error) {
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

app.get('/estatisticas', async (_req, res) => {
  try {
    await ensureSchema();

    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE estado = 'GREEN')::int AS green,
        COUNT(*) FILTER (WHERE estado = 'G1')::int AS g1,
        COUNT(*) FILTER (WHERE estado = 'G2')::int AS g2,
        COUNT(*) FILTER (WHERE estado = 'LOSS')::int AS loss,
        COUNT(*) FILTER (WHERE estado = 'PENDENTE')::int AS pendentes,
        COUNT(*) FILTER (WHERE estado = 'CANCELADO')::int AS cancelados,
        COALESCE(SUM(empates), 0)::int AS empates
      FROM sinais
    `);

    const stats = result.rows[0];
    const wins = Number(stats.green || 0) + Number(stats.g1 || 0) + Number(stats.g2 || 0);
    const finalized = wins + Number(stats.loss || 0);
    const rate = finalized > 0 ? Number(((wins / finalized) * 100).toFixed(1)) : null;

    const byStrategy = (await pool.query(`
      SELECT
        COALESCE(estrategia, 'DESCONHECIDA') AS estrategia,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE estado = 'GREEN')::int AS green,
        COUNT(*) FILTER (WHERE estado = 'G1')::int AS g1,
        COUNT(*) FILTER (WHERE estado = 'G2')::int AS g2,
        COUNT(*) FILTER (WHERE estado = 'LOSS')::int AS reds,
        COUNT(*) FILTER (WHERE estado IN ('GREEN','G1','G2'))::int AS acertos
      FROM sinais
      GROUP BY 1
      ORDER BY total DESC
    `)).rows;

    const placarDia = await getPlacarDia();

    res.json({
      sucesso: true,
      estatisticas: {
        ...stats,
        greens: wins,
        finalizados: finalized,
        taxaAcertoPercent: rate
      },
      porEstrategia: byStrategy,
      placarDia,
      horaAngola: horaAngola()
    });
  } catch (error) {
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

app.post('/db/preparar', requireAdmin, async (_req, res) => {
  try {
    await ensureSchema();
    res.json({ sucesso: true, mensagem: 'Tabelas preparadas' });
  } catch (error) {
    res.status(500).json({ sucesso: false, erro: error.message });
  }
});

app.post('/db/sincronizar', requireAdmin, async (_req, res) => {
  try {
    const result = await syncOnce();
    res.status(result.sucesso ? 200 : 500).json(result);
  } catch (error) {
    res.status(500).json({ sucesso: false, erro: error.message || String(error) });
  }
});

app.post('/telegram/teste', requireAdmin, async (_req, res) => {
  const sent = await telegramSend([
    '╔════════════════════╗',
    '🎲 CAPUNGA DADOS · BAC BO',
    '╚════════════════════╝',
    '✅ Teste de ligação Telegram concluído.',
    `🕒 ${horaAngola()}`
  ].join('\n'));

  res.status(sent ? 200 : 502).json({
    sucesso: sent,
    erro: runtime.ultimoErroTelegram
  });
});

app.use((req, res) => {
  res.status(404).json({
    sucesso: false,
    erro: 'Rota não encontrada',
    caminho: req.path
  });
});

/* ======================== LIFECYCLE ======================== */

async function start() {
  if (!DATABASE_URL) throw new Error('DATABASE_URL não configurada no Render');

  await ensureSchema();

  server = app.listen(PORT, '0.0.0.0', () => {
    log('START', {
      nome: 'CAPUNGA DADOS — BAC BO TELEGRAM v5',
      porta: PORT,
      horaAngola: horaAngola(),
      sinaisAtivos: CONFIG.sinaisAtivos,
      streakMin: CONFIG.streakMin,
      maxGale: CONFIG.maxGale,
      intervaloSyncMs: CONFIG.intervaloSyncMs,
      intervaloMinimoMs: CONFIG.intervaloMinimoMs
    });
  });

  const initial = await syncOnce();
  if (!initial.sucesso) log('PRIMEIRA SYNC COM ERRO', initial.erro || initial);
  else log('PRIMEIRA SYNC', {
    recebidos: initial.recebidos,
    novos: initial.novosGuardados,
    motivoSemSinal: initial.motivoSemSinal
  });

  syncTimer = setInterval(async () => {
    if (runtime.sincronizacaoEmCurso || shuttingDown) return;
    await syncOnce();
  }, CONFIG.intervaloSyncMs);

  if (typeof syncTimer.unref === 'function') syncTimer.unref();
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  if (syncTimer) clearInterval(syncTimer);
  if (server) await new Promise(resolve => server.close(resolve));
  if (pool) await pool.end();

  process.exit(0);
}

process.on('unhandledRejection', (reason) => {
  log('UNHANDLED REJECTION', String(reason));
});

process.on('uncaughtException', (error) => {
  log('UNCAUGHT EXCEPTION', error.message || String(error));
});

process.on('SIGTERM', () => shutdown().catch(() => process.exit(1)));
process.on('SIGINT', () => shutdown().catch(() => process.exit(1)));

start().catch((error) => {
  console.error('[FATAL]', error);
  process.exit(1);
});