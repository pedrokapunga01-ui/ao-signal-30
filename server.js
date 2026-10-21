'use strict';

/**
 * CAPUNGA DADOS — BAC BO · GALE 2 · SLOTS 3MIN · FINAL 100%
 *
 * - Sinais em slots fixos de 3 em 3 minutos (minuto 00, 03, 06, 09… de cada hora)
 * - Gale máximo: 2
 * - Análise multi-camada + consenso + bónus de mesa
 * - Empate = GREEN e fecha
 * - Mensagens curtas + placar minimalista
 * - Apaga mensagem de Gale quando sai resultado
 * - Timing baseado em relógio absoluto (Africa/Luanda)
 * - Keep-alive e endpoints para pinger externo
 *
 * Env obrigatórios:
 *   DATABASE_URL, BOT_TOKEN, CHAT_ID, ADMIN_TOKEN
 *
 * Env opcionais:
 *   API_BACBO
 *   INTERVALO_SYNC_MS=6000
 *   KEEP_ALIVE_MS=90000
 *   KEEP_ALIVE_URL / RENDER_EXTERNAL_URL
 *   MIN_PRIORIDADE=72
 *   CONSENSO_MIN=1
 *   SINAL_EXPIRA_MIN=6
 *   SLOT_JANELA_MS=110000
 *   SINAIS_ATIVOS=true
 *   EMPATE_PROTEGIDO=true
 *
 * Aviso: Bac Bo é jogo de azar. Nenhum código garante 100% de acerto.
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
const API_BACBO =
  process.env.API_BACBO ||
  'https://api-cs.casino.org/svc-evolution-game-events/api/bacbo';

function boolEnv(v, fb = false) {
  if (v === undefined || v === '') return fb;
  return ['true', '1', 'yes', 'sim', 'on'].includes(String(v).trim().toLowerCase());
}

function intEnv(name, fb, min, max) {
  const n = Number.parseInt(process.env[name], 10);
  if (!Number.isFinite(n)) return fb;
  return Math.max(min, Math.min(max, n));
}

const CONFIG = {
  sinaisAtivos: boolEnv(process.env.SINAIS_ATIVOS, true),
  maxGale: 2,
  empateProtegido: boolEnv(process.env.EMPATE_PROTEGIDO, true),
  sinalExpiraMin: intEnv('SINAL_EXPIRA_MIN', 6, 3, 20),
  intervaloSyncMs: intEnv('INTERVALO_SYNC_MS', 6000, 4000, 30000),
  keepAliveMs: intEnv('KEEP_ALIVE_MS', 90000, 30000, 300000),
  consensoMin: intEnv('CONSENSO_MIN', 1, 1, 5),
  minPrioridade: intEnv('MIN_PRIORIDADE', 72, 0, 100),
  slotJanelaMs: intEnv('SLOT_JANELA_MS', 110000, 45000, 170000),
  keepAliveUrl: process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || ''
};

/* ===================== TEMPO ABSOLUTO (LUANDA) ===================== */

const TZ = 'Africa/Luanda';

function agoraLuanda() {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: TZ })
  );
}

function horaAngola() {
  return new Intl.DateTimeFormat('pt-PT', {
    timeZone: TZ,
    dateStyle: 'short',
    timeStyle: 'medium',
    hour12: false
  }).format(new Date());
}

function obterSlotAtual() {
  const now = agoraLuanda();
  const min = now.getMinutes();
  const slotMin = Math.floor(min / 3) * 3;
  const slotStart = new Date(now);
  slotStart.setMinutes(slotMin, 0, 0);
  const elapsed = now.getTime() - slotStart.getTime();

  if (elapsed < 0 || elapsed > CONFIG.slotJanelaMs) return null;

  const y = slotStart.getFullYear();
  const m = String(slotStart.getMonth() + 1).padStart(2, '0');
  const d = String(slotStart.getDate()).padStart(2, '0');
  const h = String(slotStart.getHours()).padStart(2, '0');
  const mi = String(slotMin).padStart(2, '0');

  return `${y}-${m}-${d} ${h}:${mi}`;
}

function slotKeyFromDate(iso) {
  if (!iso) return null;

  const d = new Date(
    new Date(iso).toLocaleString('en-US', { timeZone: TZ })
  );

  const min = d.getMinutes();
  const slotMin = Math.floor(min / 3) * 3;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(slotMin).padStart(2, '0');

  return `${y}-${m}-${day} ${h}:${mi}`;
}

/* ===================== ANÁLISE AVANÇADA ===================== */

const OPOSTO = { Banca: 'Jogador', Jogador: 'Banca' };

function decisivos(hist) {
  return hist.filter((r) => r === 'Banca' || r === 'Jogador');
}

function sequencia(dec) {
  if (!dec.length) return { cor: null, tamanho: 0 };

  let n = 1;
  while (n < dec.length && dec[n] === dec[0]) n++;

  return { cor: dec[0], tamanho: n };
}

function contar(dec, n) {
  const s = dec.slice(0, n);
  const banca = s.filter((x) => x === 'Banca').length;

  return {
    n: s.length,
    banca,
    jogador: s.length - banca,
    pctBanca: s.length ? banca / s.length : 0.5
  };
}

function zProp(k, n, p0 = 0.5) {
  return n ? (k / n - p0) / Math.sqrt((p0 * (1 - p0)) / n) : 0;
}

function taxaAlt(dec, n) {
  const s = dec.slice(0, n);
  if (s.length < 2) return 0.5;

  let t = 0;
  for (let i = 1; i < s.length; i++) {
    if (s[i] !== s[i - 1]) t++;
  }

  return t / (s.length - 1);
}

function analisarMesa(hist) {
  const dec = decisivos(hist);
  const seq = sequencia(dec);
  const c8 = contar(dec, 8);
  const c12 = contar(dec, 12);
  const c20 = contar(dec, 20);
  const c50 = contar(dec, 50);
  const c100 = contar(dec, 100);
  const alt12 = taxaAlt(dec, 12);
  const alt20 = taxaAlt(dec, 20);

  let viesMedio = null;

  if (c20.n >= 16) {
    if (c20.pctBanca >= 0.6) viesMedio = 'Banca';
    else if (c20.pctBanca <= 0.4) viesMedio = 'Jogador';
  }

  let viesLongo = null;

  if (c50.n >= 40) {
    const z = zProp(c50.banca, c50.n);
    if (Math.abs(z) >= 1.45) {
      viesLongo = z > 0 ? 'Banca' : 'Jogador';
    }
  }

  if (!viesLongo && c100.n >= 70) {
    const z = zProp(c100.banca, c100.n);
    if (Math.abs(z) >= 1.35) {
      viesLongo = z > 0 ? 'Banca' : 'Jogador';
    }
  }

  const modo =
    alt20 >= 0.58 ? 'alternante' : alt20 <= 0.36 ? 'streak' : 'misto';

  return {
    dec,
    seq,
    c8,
    c12,
    c20,
    c50,
    c100,
    alt12,
    alt20,
    viesMedio,
    viesLongo,
    modo,
    amostra: dec.length
  };
}

function bonusMesa(cor, mesa) {
  let b = 0;

  if (mesa.viesMedio === cor) b += 11;
  if (mesa.viesLongo === cor) b += 13;
  if (mesa.viesMedio && mesa.viesMedio !== cor) b -= 9;
  if (mesa.viesLongo && mesa.viesLongo !== cor) b -= 6;

  if (mesa.modo === 'streak' && mesa.seq.cor === cor && mesa.seq.tamanho >= 3) {
    b += 9;
  }

  if (mesa.modo === 'alternante' && mesa.seq.cor && OPOSTO[mesa.seq.cor] === cor) {
    b += 9;
  }

  if (mesa.c12.n >= 10) {
    const dom = mesa.c12.banca > mesa.c12.jogador ? 'Banca' : 'Jogador';
    if (dom === cor && Math.abs(mesa.c12.banca - mesa.c12.jogador) >= 4) b += 8;
  }

  if (mesa.alt12 <= 0.28 && mesa.seq.cor === cor) b += 6;

  return b;
}

/** Lógicas selectivas — pensadas para GREEN / G1 / G2 */
const LOGICAS = [
  {
    id: 'SURF4',
    p: 93,
    avaliar(dec) {
      const s = sequencia(dec);
      if (s.tamanho === 4 && dec.length > 4 && dec[4] !== s.cor) {
        return { cor: s.cor };
      }
      return null;
    }
  },
  {
    id: 'PAD22',
    p: 95,
    avaliar(dec) {
      if (dec.length < 4) return null;
      const [a, b, c, d] = dec;
      if (a === b && c === d && a !== c) return { cor: a };
      return null;
    }
  },
  {
    id: 'DUPLO22',
    p: 97,
    avaliar(dec) {
      if (dec.length < 6) return null;
      const [a, b, c, d, e, f] = dec;
      if (a === b && e === f && a === e && c === d && a !== c) {
        return { cor: a };
      }
      return null;
    }
  },
  {
    id: 'ALT5',
    p: 91,
    avaliar(dec) {
      const s = dec.slice(0, 5);
      if (s.length < 5) return null;

      for (let i = 1; i < 5; i++) {
        if (s[i] === s[i - 1]) return null;
      }

      return { cor: OPOSTO[s[0]] };
    }
  },
  {
    id: 'ALT6',
    p: 94,
    avaliar(dec) {
      const s = dec.slice(0, 6);
      if (s.length < 6) return null;

      for (let i = 1; i < 6; i++) {
        if (s[i] === s[i - 1]) return null;
      }

      return { cor: OPOSTO[s[0]] };
    }
  },
  {
    id: 'STREAK4',
    p: 92,
    avaliar(dec) {
      const s = sequencia(dec);
      if (s.tamanho === 4 || s.tamanho === 5) return { cor: s.cor };
      return null;
    }
  },
  {
    id: 'STREAK6',
    p: 88,
    avaliar(dec) {
      const s = sequencia(dec);
      if (s.tamanho >= 6 && s.tamanho <= 8) return { cor: s.cor };
      return null;
    }
  },
  {
    id: 'QUEBRA8',
    p: 74,
    avaliar(dec) {
      const s = sequencia(dec);
      if (s.tamanho >= 8) return { cor: OPOSTO[s.cor] };
      return null;
    }
  },
  {
    id: 'MAIORIA12',
    p: 84,
    avaliar(dec) {
      const c = contar(dec, 12);
      if (c.n < 12 || Math.abs(c.banca - c.jogador) < 5) return null;

      const cor = c.banca > c.jogador ? 'Banca' : 'Jogador';
      const s = sequencia(dec);

      if (s.cor && s.cor !== cor && s.tamanho >= 2) return null;

      return { cor };
    }
  },
  {
    id: 'PRESSAO5',
    p: 86,
    avaliar(dec) {
      if (dec.length < 5) return null;

      const s = dec.slice(0, 5);
      const b = s.filter((x) => x === 'Banca').length;

      if (b >= 4) return { cor: 'Banca' };
      if (b <= 1) return { cor: 'Jogador' };

      return null;
    }
  },
  {
    id: 'FLUXO50',
    p: 82,
    avaliar(dec, mesa) {
      if (!mesa.viesLongo || mesa.c50.n < 45) return null;

      const s = sequencia(dec);
      if (s.cor && s.cor !== mesa.viesLongo && s.tamanho >= 3) return null;

      return { cor: mesa.viesLongo };
    }
  },
  {
    id: 'MOMENTUM8',
    p: 80,
    avaliar(dec) {
      const c = contar(dec, 8);
      if (c.n < 8) return null;

      if (c.banca >= 6) return { cor: 'Banca' };
      if (c.jogador >= 6) return { cor: 'Jogador' };

      return null;
    }
  },
  {
    id: 'SLOT_STREAK',
    p: 70,
    slotOnly: true,
    avaliar(dec) {
      const s = sequencia(dec);
      if (s.cor && s.tamanho >= 2) return { cor: s.cor };
      return null;
    }
  },
  {
    id: 'SLOT_MAIORIA',
    p: 68,
    slotOnly: true,
    avaliar(dec) {
      const c = contar(dec, 6);
      if (c.n < 4) return null;
      return { cor: c.banca >= c.jogador ? 'Banca' : 'Jogador' };
    }
  }
];

function decidir(hist, opcoes = {}) {
  const minP = Number(opcoes.minPrioridade) || CONFIG.minPrioridade;
  const consensoMin = Math.max(1, Number(opcoes.consensoMin) || CONFIG.consensoMin);
  const forcarSlot = Boolean(opcoes.forcarSlot);

  const mesa = analisarMesa(hist);
  const dec = mesa.dec;

  if (dec.length < 3) return null;

  const limiar = forcarSlot ? 55 : minP;
  const cons = forcarSlot ? 1 : consensoMin;

  const candidatos = [];

  for (const L of LOGICAS) {
    if (L.slotOnly && !forcarSlot) continue;

    const r = L.avaliar(dec, mesa);
    if (!r || !r.cor) continue;

    const bonus = bonusMesa(r.cor, mesa);
    const score = L.p + bonus;

    if (score < limiar) continue;

    candidatos.push({ id: L.id, cor: r.cor, score, bonus });
  }

  if (!candidatos.length) return null;

  const peso = { Banca: 0, Jogador: 0 };
  const votos = { Banca: 0, Jogador: 0 };

  for (const c of candidatos) {
    peso[c.cor] += c.score;
    votos[c.cor]++;
  }

  let cor = null;

  if (peso.Banca > peso.Jogador) cor = 'Banca';
  else if (peso.Jogador > peso.Banca) cor = 'Jogador';
  else return null;

  if (votos[cor] < cons) return null;

  const apoio = candidatos
    .filter((c) => c.cor === cor)
    .sort((a, b) => b.score - a.score);

  const top = apoio[0];

  if (!forcarSlot && top.bonus < 3 && top.score < minP + 5) return null;

  return {
    cor,
    confianca: Math.min(99, Math.round(top.score)),
    forcarSlot,
    votos: votos[cor],
    _ids: apoio.map((c) => c.id).join('+'),
    mesa: {
      modo: mesa.modo,
      viesMedio: mesa.viesMedio,
      viesLongo: mesa.viesLongo,
      amostra: mesa.amostra
    }
  };
}

function forcarEntradaSlot(hist) {
  const dec = decisivos(hist);
  if (dec.length < 1) return null;

  const s = sequencia(dec);

  if (s.cor && s.tamanho >= 2) {
    return {
      cor: s.cor,
      confianca: 58,
      forcarSlot: true,
      votos: 1,
      _ids: 'FORCA_STREAK',
      mesa: { modo: 'forcar', amostra: dec.length }
    };
  }

  const c = contar(dec, 5);

  if (c.n >= 3) {
    const cor = c.banca >= c.jogador ? 'Banca' : 'Jogador';

    return {
      cor,
      confianca: 55,
      forcarSlot: true,
      votos: 1,
      _ids: 'FORCA_MAIORIA',
      mesa: { modo: 'forcar', amostra: dec.length }
    };
  }

  return {
    cor: dec[0],
    confianca: 52,
    forcarSlot: true,
    votos: 1,
    _ids: 'FORCA_ULTIMA',
    mesa: { modo: 'forcar', amostra: dec.length }
  };
}

/* ===================== APP / RUNTIME ===================== */

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/i.test(DATABASE_URL)
        ? false
        : { rejectUnauthorized: false },
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
  duplicadosUltimoCiclo: 0,
  novosUltimoCiclo: 0,
  erroSincronizacao: null,
  ultimoSinal: null,
  ultimoSlotUsado: null,
  ultimaMensagemTelegram: null,
  ultimoErroTelegram: null,
  ultimoHTTPAPI: null,
  ultimoErroAPI: null,
  ciclosSemNovos: 0,
  motivoSemSinal: null,
  ultimaAnalise: null,
  rodadasDesdeSinal: 0,
  publicUrl: CONFIG.keepAliveUrl || null,
  ultimoKeepAlive: null,
  ultimoSinalEm: null,
  ultimoGaleMsgIds: []
};

let schemaPromise = null;
let server = null;
let syncTimer = null;
let keepAliveTimer = null;

function log(tag, data) {
  console.log(`[${tag}]`, typeof data === 'string' ? data : JSON.stringify(data));
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

  if (['player', 'jogador', 'playerwin', 'playerwins', 'playerwon', 'playerwinner'].includes(s)) {
    return 'Jogador';
  }

  if (['banker', 'banca', 'bankerwin', 'bankerwins', 'bankerwon', 'bankerwinner', 'red', 'vermelho'].includes(s)) {
    return 'Banca';
  }

  if (['tie', 'draw', 'empate', 'equal', 'push', 'tied'].includes(s)) {
    return 'Empate';
  }

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
    body.data,
    body.results,
    body.items,
    body.resultados,
    body.rounds,
    body.events,
    body.data?.results,
    body.data?.items,
    body.data?.resultados,
    body.data?.rounds,
    body.data?.events,
    body.data?.data
  ];

  return candidates.find(Array.isArray) || [];
}

function normalizeRound(item) {
  const d = item?.data || item?.round || item || {};

  const r =
    d.result && typeof d.result === 'object' ? d.result
      : item?.result && typeof item.result === 'object' ? item.result
        : {};

  const status = String(
    d.status ?? d.estado ?? item?.status ?? item?.estado ?? ''
  ).toLowerCase();

  const inicio = validDate(
    d.startedAt ?? d.startTime ?? d.started_at ?? d.inicio ??
    item?.startedAt ?? item?.inicio
  );

  const fim = validDate(
    d.settledAt ?? d.endTime ?? d.endedAt ?? d.finishedAt ??
    d.fim ?? item?.settledAt ?? item?.fim
  );

  const rawOutcome =
    r.outcome ?? r.resultado ?? r.winner ??
    d.outcome ?? d.resultado ?? d.winner ??
    item?.outcome ?? item?.resultado ?? item?.winner ??
    (typeof d.result === 'string' ? d.result : null) ??
    (typeof item?.result === 'string' ? item.result : null);

  const resultado = normalizeOutcome(rawOutcome);

  const resolvida =
    ['resolved', 'settled', 'finished', 'complete', 'completed', 'resolvido', 'concluido', 'finalizado']
      .some((w) => status.includes(w)) || Boolean(fim);

  const id = String(
    d.id ?? d.roundId ?? d.round_id ?? d.eventId ??
    item?.id ?? item?.roundId ?? item?.round_id ?? item?.eventId ?? ''
  ).trim();

  if (!id || !resultado || !resolvida || !fim) return null;

  return {
    id,
    resultado,
    estado: 'Resolved',
    inicio: inicio || fim,
    fim,
    pontos_jogador: null,
    pontos_banca: null,
    multiplicador: null
  };
}

/* ===================== TELEGRAM ===================== */

async function telegramSend(texto) {
  if (!BOT_TOKEN || !CHAT_ID) {
    runtime.ultimoErroTelegram = 'BOT_TOKEN ou CHAT_ID em falta';
    return null;
  }

  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: CHAT_ID,
        text: texto,
        disable_web_page_preview: true
      },
      { timeout: 15000 }
    );

    if (response.data?.ok === true) {
      runtime.ultimaMensagemTelegram = new Date().toISOString();
      runtime.ultimoErroTelegram = null;
      return response.data.result?.message_id ?? true;
    }

    runtime.ultimoErroTelegram = JSON.stringify(response.data);
    return null;
  } catch (error) {
    runtime.ultimoErroTelegram = error.response?.data
      ? JSON.stringify(error.response.data)
      : error.message;

    console.error('[TELEGRAM]', runtime.ultimoErroTelegram);
    return null;
  }
}

async function telegramDelete(messageId) {
  if (!BOT_TOKEN || !CHAT_ID || !messageId || messageId === true) return false;

  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`,
      { chat_id: CHAT_ID, message_id: messageId },
      { timeout: 10000 }
    );

    return true;
  } catch (_) {
    return false;
  }
}

async function limparGaleMsgs() {
  const ids = [...runtime.ultimoGaleMsgIds];
  runtime.ultimoGaleMsgIds = [];

  for (const id of ids) {
    await telegramDelete(id);
  }
}

/* ===================== DATABASE ===================== */

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
        slot_key TEXT UNIQUE
      )
    `);

    await pool.query(`ALTER TABLE sinais ADD COLUMN IF NOT EXISTS estrategia TEXT`);
    await pool.query(`ALTER TABLE sinais ADD COLUMN IF NOT EXISTS slot_key TEXT`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sinais_slot ON sinais (slot_key)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sinais_estado ON sinais (estado)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_sinais_criado ON sinais (criado_em DESC)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS slots_usados (
        slot_key TEXT PRIMARY KEY,
        sinal_id BIGINT,
        usado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    log('DB', { ok: true });
  })();

  try {
    await schemaPromise;
  } catch (e) {
    schemaPromise = null;
    throw e;
  }
}

function formatarSinal(s) {
  const cor = s.cor === 'Banca' ? '🔴 BANCA' : '🔵 JOGADOR';

  return `🎯 CAPUNGA DADOS — BAC BO

ENTRADA: ${cor}
Proteção: Gale 2
Prioridade do padrão: ${s.confianca}%
Estratégia: ${s._ids}
Hora Angola: ${horaAngola()}

⚠️ Percentagem é uma pontuação heurística, não garantia de resultado.`;
}

function formatarGale(s, gale) {
  const cor = s.cor === 'Banca' ? '🔴 BANCA' : '🔵 JOGADOR';

  return `♻️ GALE ${gale}
Entrada: ${cor}
CAPUNGA DADOS — BAC BO`;
}

function formatarFecho(estado, s, rodada) {
  const rotulo =
    estado === 'GREEN' ? '✅ GREEN'
      : estado === 'LOSS' ? '❌ LOSS'
        : '✅ GREEN (EMPATE PROTEGIDO)';

  return `${rotulo}
Entrada: ${s.cor}
Resultado: ${rodada.resultado}
Gales usados: ${s.gale}
CAPUNGA DADOS — BAC BO`;
}

async function obterHistorico(limit = 120) {
  const r = await pool.query(
    `SELECT id, resultado, inicio, fim, seq
     FROM bacbo_resultados
     ORDER BY fim DESC NULLS LAST, seq DESC
     LIMIT $1`,
    [limit]
  );

  return r.rows;
}

async function guardarRodada(rodada) {
  const r = await pool.query(
    `INSERT INTO bacbo_resultados
      (id,resultado,estado,inicio,fim,pontos_jogador,pontos_banca,multiplicador)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(id) DO NOTHING
     RETURNING id`,
    [
      rodada.id,
      rodada.resultado,
      rodada.estado,
      rodada.inicio,
      rodada.fim,
      rodada.pontos_jogador,
      rodada.pontos_banca,
      rodada.multiplicador
    ]
  );

  return r.rowCount > 0;
}

async function buscarAPI() {
  const response = await axios.get(API_BACBO, {
    timeout: 12000,
    headers: {
      accept: 'application/json',
      'user-agent': 'CapungaDados/1.0'
    }
  });

  runtime.ultimoHTTPAPI = response.status;

  const items = extractItems(response.data);
  runtime.itensRecebidosAPI = items.length;

  const rounds = items.map(normalizeRound).filter(Boolean);
  rounds.sort((a, b) => new Date(a.fim) - new Date(b.fim));

  runtime.quantidadeAPI = rounds.length;
  runtime.ultimaHoraDaAPI = new Date().toISOString();
  runtime.ultimoErroAPI = null;

  return rounds;
}

async function processarResultado(rodada) {
  const pendente = await pool.query(
    `SELECT *
     FROM sinais
     WHERE estado='PENDENTE' AND criado_em < $1
     ORDER BY id ASC
     LIMIT 1`,
    [rodada.fim]
  );

  if (!pendente.rows.length) return;

  const s = pendente.rows[0];
  if (s.resultado_id && s.resultado_id === rodada.id) return;

  if (rodada.resultado === 'Empate' && CONFIG.empateProtegido) {
    await pool.query(
      `UPDATE sinais
       SET estado='GREEN', resultado_id=$2, resultado_final=$3, empates=empates+1
       WHERE id=$1`,
      [s.id, rodada.id, rodada.resultado]
    );

    await telegramSend(formatarFecho('EMPATE', s, rodada));
    await limparGaleMsgs();
    return;
  }

  if (rodada.resultado === s.cor) {
    await pool.query(
      `UPDATE sinais
       SET estado='GREEN', resultado_id=$2, resultado_final=$3
       WHERE id=$1`,
      [s.id, rodada.id, rodada.resultado]
    );

    await telegramSend(formatarFecho('GREEN', s, rodada));
    await limparGaleMsgs();
    return;
  }

  const nextGale = Number(s.gale) + 1;

  if (nextGale <= CONFIG.maxGale) {
    await pool.query(
      `UPDATE sinais
       SET gale=$2, resultado_id=$3, resultado_final=$4
       WHERE id=$1`,
      [s.id, nextGale, rodada.id, rodada.resultado]
    );

    const msgId = await telegramSend(formatarGale(s, nextGale));
    if (msgId && msgId !== true) runtime.ultimoGaleMsgIds.push(msgId);

    return;
  }

  await pool.query(
    `UPDATE sinais
     SET estado='LOSS', resultado_id=$2, resultado_final=$3
     WHERE id=$1`,
    [s.id, rodada.id, rodada.resultado]
  );

  await telegramSend(formatarFecho('LOSS', s, rodada));
  await limparGaleMsgs();
}

async function talvezCriarSinal() {
  if (!CONFIG.sinaisAtivos) {
    runtime.motivoSemSinal = 'sinais_desativados';
    return;
  }

  const slot = obterSlotAtual();

  if (!slot) {
    runtime.motivoSemSinal = 'fora_da_janela_do_slot';
    return;
  }

  const aberto = await pool.query(
    `SELECT id FROM sinais WHERE estado='PENDENTE' LIMIT 1`
  );

  if (aberto.rows.length) {
    runtime.motivoSemSinal = 'sinal_anterior_pendente';
    return;
  }

  const usado = await pool.query(
    `SELECT slot_key FROM slots_usados WHERE slot_key=$1`,
    [slot]
  );

  if (usado.rows.length) {
    runtime.motivoSemSinal = 'slot_ja_usado';
    return;
  }

  const histRows = await obterHistorico(120);
  const hist = histRows.map((r) => r.resultado);

  const choice = decidir(hist);
  const signal = choice || forcarEntradaSlot(hist);

  if (!signal) {
    runtime.motivoSemSinal = 'historico_insuficiente';
    return;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const claimed = await client.query(
      `INSERT INTO slots_usados(slot_key,sinal_id)
       VALUES($1,NULL)
       ON CONFLICT(slot_key) DO NOTHING
       RETURNING slot_key`,
      [slot]
    );

    if (!claimed.rows.length) {
      await client.query('ROLLBACK');
      runtime.motivoSemSinal = 'slot_ja_usado';
      return;
    }

    const inserted = await client.query(
      `INSERT INTO sinais(cor,estado,gale,estrategia,slot_key)
       VALUES($1,'PENDENTE',0,$2,$3)
       RETURNING *`,
      [signal.cor, signal._ids, slot]
    );

    const row = inserted.rows[0];

    await client.query(
      `UPDATE slots_usados SET sinal_id=$2 WHERE slot_key=$1`,
      [slot, row.id]
    );

    await client.query('COMMIT');

    runtime.ultimoSinal = signal;
    runtime.ultimoSlotUsado = slot;
    runtime.ultimoSinalEm = new Date().toISOString();
    runtime.motivoSemSinal = null;

    await telegramSend(formatarSinal(signal));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function sincronizar() {
  if (runtime.sincronizacaoEmCurso) return;

  runtime.sincronizacaoEmCurso = true;
  runtime.ultimaSincronizacao = new Date().toISOString();

  try {
    await ensureSchema();

    const rounds = await buscarAPI();
    let novos = 0;

    for (const rodada of rounds) {
      const isNew = await guardarRodada(rodada);

      if (isNew) {
        novos++;
        runtime.ultimaRodadaNova = rodada.fim;
        runtime.ultimoIdNovo = rodada.id;

        await processarResultado(rodada);
      }
    }

    runtime.novosUltimoCiclo = novos;
    runtime.duplicadosUltimoCiclo = Math.max(0, rounds.length - novos);
    runtime.ciclosSemNovos = novos ? 0 : runtime.ciclosSemNovos + 1;
    runtime.erroSincronizacao = null;

    await talvezCriarSinal();
  } catch (e) {
    runtime.erroSincronizacao = e.message || String(e);
    runtime.ultimoErroAPI = runtime.erroSincronizacao;

    log('SYNC_ERROR', runtime.erroSincronizacao);
  } finally {
    runtime.sincronizacaoEmCurso = false;
  }
}

function autenticarAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({
      ok: false,
      erro: 'ADMIN_TOKEN não configurado'
    });
  }

  const got = String(req.headers['x-admin-token'] || req.query.token || '');

  if (got !== ADMIN_TOKEN) {
    return res.status(401).json({
      ok: false,
      erro: 'não autorizado'
    });
  }

  next();
}

/* ===================== ROTAS HTTP ===================== */

app.get('/', (_req, res) => {
  res.status(200).send('CAPUNGA DADOS — BAC BO ativo');
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'capunga-dados-bacbo',
    time: new Date().toISOString()
  });
});

app.get('/status', async (_req, res) => {
  let dbOk = false;

  try {
    if (pool) {
      await pool.query('SELECT 1');
      dbOk = true;
    }
  } catch (_) {}

  res.json({
    ok: Boolean(pool && dbOk),
    db: dbOk,
    config: {
      sinaisAtivos: CONFIG.sinaisAtivos,
      maxGale: CONFIG.maxGale,
      empateProtegido: CONFIG.empateProtegido,
      intervaloSyncMs: CONFIG.intervaloSyncMs,
      minPrioridade: CONFIG.minPrioridade,
      consensoMin: CONFIG.consensoMin
    },
    runtime
  });
});

app.post('/sync', autenticarAdmin, async (_req, res) => {
  await sincronizar();
  res.json({ ok: !runtime.erroSincronizacao, runtime });
});

app.post('/ingest', autenticarAdmin, async (req, res) => {
  try {
    await ensureSchema();

    const items = extractItems(req.body);
    const rounds = items.map(normalizeRound).filter(Boolean);

    let inserted = 0;

    for (const round of rounds) {
      if (await guardarRodada(round)) inserted++;
    }

    res.json({
      ok: true,
      recebidos: items.length,
      válidos: rounds.length,
      novos: inserted
    });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.get('/resultados', async (req, res) => {
  try {
    await ensureSchema();

    const limit = Math.min(
      200,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 30)
    );

    const r = await pool.query(
      `SELECT id,resultado,inicio,fim
       FROM bacbo_resultados
       ORDER BY fim DESC NULLS LAST,seq DESC
       LIMIT $1`,
      [limit]
    );

    res.json({ ok: true, resultados: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.get('/sinais', async (req, res) => {
  try {
    await ensureSchema();

    const limit = Math.min(
      200,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 30)
    );

    const r = await pool.query(
      `SELECT id,criado_em,cor,estado,gale,resultado_final,estrategia,slot_key
       FROM sinais
       ORDER BY id DESC
       LIMIT $1`,
      [limit]
    );

    res.json({ ok: true, sinais: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

async function keepAlive() {
  if (!CONFIG.keepAliveUrl) return;

  try {
    await axios.get(
      `${CONFIG.keepAliveUrl.replace(/\/$/, '')}/health`,
      { timeout: 10000 }
    );

    runtime.ultimoKeepAlive = new Date().toISOString();
  } catch (e) {
    log('KEEP_ALIVE', e.message);
  }
}

async function start() {
  if (!DATABASE_URL) {
    log(
      'CONFIG',
      'DATABASE_URL em falta; servidor inicia, mas as funções de dados não estarão disponíveis.'
    );
  }

  server = app.listen(PORT, () => {
    log('START', {
      port: PORT,
      timezone: TZ,
      api: API_BACBO
    });
  });

  if (pool) {
    try {
      await ensureSchema();
    } catch (e) {
      runtime.erroSincronizacao = `DB: ${e.message}`;
      log('DB_ERROR', e.message);
    }

    await sincronizar();

    syncTimer = setInterval(sincronizar, CONFIG.intervaloSyncMs);
    keepAliveTimer = setInterval(keepAlive, CONFIG.keepAliveMs);
  }
}

async function shutdown(signal) {
  log('SHUTDOWN', signal);

  if (syncTimer) clearInterval(syncTimer);
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  if (server) server.close();
  if (pool) await pool.end().catch(() => {});

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((e) => {
  log('FATAL', e.stack || e.message);
  process.exitCode = 1;
});