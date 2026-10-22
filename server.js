'use strict';

/**
 * CAPUNGA DADOS — BAC BO (Multi-Estratégia) v2
 *
 * Estratégias activas:
 *   1. REPETICAO  — após N da mesma cor, entra na mesma
 *   2. QUEBRA     — após N da mesma cor, entra na oposta
 *   3. SURF       — padrão alternado (A-B-A-B) → continua a onda
 *   4. DOIS_DOIS  — padrão 2+2 (JJBB / BBJJ) → próxima cor esperada
 *   5. FORCA      — força da mesa (dominância nos últimos 12)
 *   6. NUMERICA   — scores altos/baixos e diferença de pontos
 *
 * O robô avalia todas e escolhe a melhor oportunidade (maior prioridade).
 * Opera 24/7 sem limite de reds. Gera sinal sempre que houver setup válido.
 *
 * Env obrigatórios:
 *   DATABASE_URL, BOT_TOKEN, CHAT_ID
 *
 * Env opcionais:
 *   ADMIN_TOKEN
 *   SINAIS_ATIVOS=true
 *   STREAK_MIN=3
 *   MAX_GALE=2
 *   EMPATE_PROTEGIDO=true
 *   INTERVALO_MINIMO_MS=35000
 *   SINAL_EXPIRA_MIN=8
 *   INTERVALO_SYNC_MS=7000
 *   API_BACBO=https://api-cs.casino.org/svc-evolution-game-events/api/bacbo
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
  // SEM LIMITE DE REDS — removido de propósito para operar 24/7
  intervaloMinimoMs: intEnv('INTERVALO_MINIMO_MS', 35000, 15000, 300000),
  sinalExpiraMin: intEnv('SINAL_EXPIRA_MIN', 8, 3, 60),
  intervaloSyncMs: intEnv('INTERVALO_SYNC_MS', 7000, 5000, 60000)
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
  ultimoSinalCriadoEm: null
};

let schemaPromise = null;
let server = null;
let syncTimer = null;

/* ========== UTILITÁRIOS ========== */

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
  if (cor === 'Banca') return '🔴 VERMELHO (Banca)';
  if (cor === 'Jogador') return '🔵 AZUL (Jogador)';
  return String(cor || '');
}

function corCurta(cor) {
  if (cor === 'Banca') return '🔴';
  if (cor === 'Jogador') return '🔵';
  return '🟡';
}

function
... 