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
const INTERVALO_MINIMO_MS = Number(process.env.INTERVALO_MINIMO_MS || 55000);
const MAX_REDS_DIA = Number(process.env.MAX_REDS_DIA || 12);
const EMPATE_PROTEGIDO = (process.env.EMPATE_PROTEGIDO || 'true') === 'true';
const INTERVALO_SYNC_MS = Number(process.env.INTERVALO_SYNC_MS || 7000);

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
  ciclos: 0,
  ultimoErro: null,
  ultimaSincronizacao: null,
  motivo: 'iniciando',
  ultimoSinal: null
};

let syncTimer = null;

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

async function telegramSend(texto) {
  if (!BOT_TOKEN || !CHAT_ID) return false;
  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: CHAT_ID, text: texto, disable_web_page_preview: true },
      { timeout: 14000 }
    );
    return res.data?.ok === true;
  } catch (e) {
    console.error('[TELEGRAM]', e.response?.data || e.message);
    return false;
  }
}

async function ensureSchema() {
  if (!pool) throw new Error('DATABASE_URL não configurada');
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
    headers: { Accept: 'application/json', 'User-Agent': 'CapungaDados/4.2' }
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

async function getPendente() {
  const { rows } = await pool.query(
    `SELECT * FROM bacbo_sinais WHERE estado = 'PENDENTE' ORDER BY criado_em ASC LIMIT 1`
  );
  return rows[0] || null;
}

async function getPlacar() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE estado = 'GREEN')::int AS green,
      COUNT(*) FILTER (WHERE estado = 'G1')::int AS g1,
      COUNT(*) FILTER (WHERE estado = 'G2')::int AS g2,
      COUNT(*) FILTER (WHERE estado = 'LOSS')::int AS loss,
      COALESCE(SUM(empates),0)::int AS empates
    FROM bacbo_sinais
    WHERE criado_em >= date_trunc('day', NOW() AT TIME ZONE 'Africa/Luanda')
      AND estado IN ('GREEN','G1','G2','LOSS')
  `);
  const s = rows[0] || { green: 0, g1: 0, g2: 0, loss: 0, empates: 0 };
  const acertos = s.green + s.g1 + s.g2;
  const total = acertos + s.loss;
  const percent = total > 0 ? Number(((acertos / total) * 100).toFixed(1)) : 100;

  const recent = await pool.query(`
    SELECT estado FROM bacbo_sinais
    WHERE criado_em >= date_trunc('day', NOW() AT TIME ZONE 'Africa/Luanda')
      AND estado IN ('GREEN','G1','G2','LOSS')
    ORDER BY criado_em DESC LIMIT 30
  `);
  let seq = 0;
  for (const r of recent.rows) {
    if (['GREEN', 'G1', 'G2'].includes(r.estado)) seq++;
    else break;
  }
  return { ...s, percent, seq };
}

async function redsHoje() {
  const { rows } = await pool.query(`
    SELECT COUNT(*)::int AS total FROM bacbo_sinais
    WHERE estado = 'LOSS'
      AND criado_em >= date_trunc('day', NOW() AT TIME ZONE 'Africa/Luanda')
  `);
  return rows[0]?.total || 0;
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

function stratAntiStreak(rows) {
  const n = streakLen(rows);
  if (n < 3) return null;
  const cor = oposta(rows[0].resultado);
  if (!cor) return null;
  return { cor, estrategia: 'ANTI_STREAK', nome: `Anti-Streak x${n}`, emoji: '🔄', prioridade: Math.min(93, 70 + n * 6) };
}

function stratTendencia(rows) {
  const sample = rows.slice(0, 10);
  if (sample.length < 8) return null;
  let j = 0, b = 0;
  for (const r of sample) {
    if (r.resultado === 'Jogador') j++;
    else b++;
  }
  const total = j + b;
  if (b / total >= 0.65) return { cor: 'Banca', estrategia: 'TENDENCIA', nome: `Tendência Banca ${Math.round(b / total * 100)}%`, emoji: '📈', prioridade: 86 };
  if (j / total >= 0.65) return { cor: 'Jogador', estrategia: 'TENDENCIA', nome: `Tendência Jogador ${Math.round(j / total * 100)}%`, emoji: '📈', prioridade: 86 };
  return null;
}

function stratPadrao(rows) {
  if (rows.length < 3) return null;
  const [a, b, c] = rows.map(r => r.resultado);
  if (![a, b, c].every(x => ['Jogador', 'Banca'].includes(x))) return null;
  if (a === b && b === c) return { cor: oposta(a), estrategia: 'PADRAO', nome: 'Padrão AAA → Virada', emoji: '🎯', prioridade: 84 };
  if (a === c && a !== b) return { cor: a, estrategia: 'PADRAO', nome: 'Padrão ABA', emoji: '🎯', prioridade: 78 };
  if (a === b && a !== c) return { cor: a, estrategia: 'PADRAO', nome: 'Padrão AAB', emoji: '🎯', prioridade: 76 };
  return null;
}

function stratScore(rows) {
  if (!rows.length) return null;
  const last = rows[0];
  const pj = Number(last.pontos_jogador);
  const pb = Number(last.pontos_banca);
  if (!Number.isFinite(pj) || !Number.isFinite(pb)) return null;
  if (last.resultado === 'Jogador' && pj >= 9 && pj - pb >= 3) {
    return { cor: 'Jogador', estrategia: 'SCORE', nome: `Score Forte J(${pj})`, emoji: '💪', prioridade: 80 };
  }
  if (last.resultado === 'Banca' && pb >= 9 && pb - pj >= 3) {
    return { cor: 'Banca', estrategia: 'SCORE', nome: `Score Forte B(${pb})`, emoji: '💪', prioridade: 80 };
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
  if (b >= 4) return { cor: 'Banca', estrategia: 'MOMENTUM', nome: 'Momentum Banca', emoji: '⚡', prioridade: 74 };
  if (j >= 4) return { cor: 'Jogador', estrategia: 'MOMENTUM', nome: 'Momentum Jogador', emoji: '⚡', prioridade: 74 };
  return null;
}

function detectBest(rows) {
  const candidatos = [
    stratAntiStreak(rows),
    stratTendencia(rows),
    stratPadrao(rows),
    stratScore(rows),
    stratMomentum(rows)
  ].filter(Boolean);
  if (!candidatos.length) return null;
  candidatos.sort((a, b) => b.prioridade - a.prioridade);
  return candidatos[0];
}

/* ========== MENSAGENS ========== */

function msgEntrada(entry) {
  return [
    '🎯  CAPUNGA DADOS  🎯',
    '━━━━━━━━━━━━━━━━━━',
    '🔔  NOVA ENTRADA',
    '━━━━━━━━━━━━━━━━━━',
    '',
    `➡️  ${corDisplay(entry.cor)}`,
    '',
    `${entry.emoji}  ${entry.nome}`,
    `🛡️  Proteção EMPATE`,
    `🐓  Gale até ${MAX_GALE}`,
    '',
    `🕒  ${horaAngola()}`,
    '━━━━━━━━━━━━━━━━━━',
    '💎 Gestão de banca'
  ].join('\n');
}

function msgGreen(sinal, estado) {
  const titulo = estado === 'GREEN' ? '✅  GREEN SEM GALE' : estado === 'G1' ? '⚡  GREEN GALE 1' : '🔥  GREEN GALE 2';
  return [
    '🎯  CAPUNGA DADOS  🎯',
    '────────────────────',
    titulo,
    '────────────────────',
    `➡️  ${corDisplay(sinal.cor)}`,
    `📌  ${sinal.nome_estrategia || sinal.estrategia}`,
    `🔢  #${sinal.id}`,
    `🕒  ${horaAngola()}`
  ].join('\n');
}

function msgLoss(sinal) {
  return [
    '🎯  CAPUNGA DADOS  🎯',
    '────────────────────',
    '❌  LOSS FINAL',
    '────────────────────',
    `➡️  ${corDisplay(sinal.cor)}`,
    `🐓  Gale \( {sinal.gale}/ \){MAX_GALE}`,
    `🔢  #${sinal.id}`,
    `🕒  ${horaAngola()}`
  ].join('\n');
}

function msgGale(sinal, gale) {
  return [
    '🎯  CAPUNGA DADOS  🎯',
    '────────────────────',
    `🐓  GALE ${gale}`,
    '────────────────────',
    `➡️  Mantém ${corDisplay(sinal.cor)}`,
    `🔢  #${sinal.id}`,
    `🕒  ${horaAngola()}`
  ].join('\n');
}

function msgEmpate(sinal) {
  return [
    '🎯  CAPUNGA DADOS  🎯',
    '────────────────────',
    '🟡  EMPATE PROTEGIDO',
    '────────────────────',
    `Sinal #${sinal.id} continua`,
    `➡️  ${corDisplay(sinal.cor)}`,
    `🕒  ${horaAngola()}`
  ].join('\n');
}

function formatPlacar(p) {
  return [
    '',
    '────────────────────',
    '🏆  CAPUNGA PLACAR  🏆',
    '────────────────────',
    `✅ GREEN  ${p.green}   ⚡ G1  ${p.g1}`,
    `🔥 G2     ${p.g2}   🟡 Emp ${p.empates}`,
    `❌ LOSS   ${p.loss}`,
    `📊 ${p.percent}%  |  🚀 Seq ${p.seq}`,
    '────────────────────'
  ].join('\n');
}

/* ========== LÓGICA ========== */

async function resolver(round) {
  const sinal = await getPendente();
  if (!sinal) return;

  if (round.resultado === 'Empate') {
    if (!EMPATE_PROTEGIDO) return;
    await pool.query(`UPDATE bacbo_sinais SET empates = COALESCE(empates,0)+1 WHERE id = $1`, [sinal.id]);
    await telegramSend(msgEmpate(sinal));
    return;
  }

  if (round.resultado === sinal.cor) {
    const gale = Number(sinal.gale || 0);
    const estado = gale === 0 ? 'GREEN' : gale === 1 ? 'G1' : 'G2';
    await pool.query(`UPDATE bacbo_sinais SET estado = $1, resultado_final = $2 WHERE id = $3`, [estado, round.resultado, sinal.id]);
    const placar = await getPlacar();
    await telegramSend(msgGreen(sinal, estado) + formatPlacar(placar));
    return;
  }

  const proximoGale = Number(sinal.gale || 0) + 1;
  if (proximoGale <= MAX_GALE) {
    await pool.query(`UPDATE bacbo_sinais SET gale = $1 WHERE id = $2`, [proximoGale, sinal.id]);
    await telegramSend(msgGale(sinal, proximoGale));
    return;
  }

  await pool.query(`UPDATE bacbo_sinais SET estado = 'LOSS', resultado_final = $1 WHERE id = $2`, [round.resultado, sinal.id]);
  const placar = await getPlacar();
  await telegramSend(msgLoss(sinal) + formatPlacar(placar));
}

async function tentarCriar(round) {
  const pendente = await getPendente();
  if (pendente) {
    runtime.motivo = `pendente #${pendente.id}`;
    return;
  }

  const reds = await redsHoje();
  if (reds >= MAX_REDS_DIA) {
    runtime.motivo = `limite reds ${reds}`;
    return;
  }

  const { rows: ultimo } = await pool.query(`SELECT criado_em FROM bacbo_sinais ORDER BY criado_em DESC LIMIT 1`);
  if (ultimo[0] && Date.now() - new Date(ultimo[0].criado_em).getTime() < INTERVALO_MINIMO_MS) {
    runtime.motivo = 'intervalo mínimo';
    return;
  }

  const recent = await getRecent(22);
  const entry = detectBest(recent);
  if (!entry) {
    runtime.motivo = 'sem setup';
    return;
  }

  const { rows: ja } = await pool.query(`SELECT 1 FROM bacbo_sinais WHERE resultado_id = $1 LIMIT 1`, [round.id]);
  if (ja.length) {
    runtime.motivo = 'rodada já usada';
    return;
  }

  const { rows } = await pool.query(
    `INSERT INTO bacbo_sinais (cor, estado, gale, resultado_id, estrategia, nome_estrategia)
     VALUES ($1, 'PENDENTE', 0, $2, $3, $4) RETURNING *`,
    [entry.cor, round.id, entry.estrategia, entry.nome]
  );

  const sinal = rows[0];
  runtime.ultimoSinal = { id: sinal.id, cor: sinal.cor, estrategia: entry.estrategia };
  runtime.motivo = null;
  await telegramSend(msgEntrada(entry));
  log('SINAL', { id: sinal.id, cor: entry.cor, estrategia: entry.estrategia });
}

async function syncOnce() {
  if (!pool) return;
  try {
    await ensureSchema();
    const rounds = await fetchRounds();
    let novos = 0;

    for (const round of rounds) {
      const result = await pool.query(
        `INSERT INTO bacbo_rodadas (id, resultado, inicio, fim, pontos_jogador, pontos_banca)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
        [round.id, round.resultado, round.inicio, round.fim, round.pontos_jogador, round.pontos_banca]
      );
      if (result.rowCount === 0) continue;

      novos++;
      await resolver(round);
      await tentarCriar(round);
    }

    if (novos === 0) {
      const pend = await getPendente();
      if (pend && Date.now() - new Date(pend.criado_em).getTime() > 4 * 60 * 1000) {
        await pool.query(`UPDATE bacbo_sinais SET estado = 'CANCELADO' WHERE id = $1`, [pend.id]);
        await telegramSend(`⏳ CAPUNGA • Sinal #${pend.id} expirado\n🕒 ${horaAngola()}`);
        runtime.motivo = 'sinal expirado';
      } else if (pend) {
        runtime.motivo = `aguardando #${pend.id}`;
      } else {
        runtime.motivo = 'sem rodadas novas';
      }
    }

    runtime.ultimaSincronizacao = new Date().toISOString();
    runtime.ciclos++;
    runtime.ultimoErro = null;
  } catch (e) {
    runtime.ultimoErro = e.message;
    console.error('[SYNC]', e.message);
  }
}

/* ========== ROTAS ========== */

app.get('/', (req, res) => {
  res.json({ nome: 'CAPUNGA DADOS — BAC BO', estado: 'online', hora: horaAngola() });
});

app.get('/health', (req, res) => {
  res.json({
    sucesso: true,
    estado: 'online',
    hora: horaAngola(),
    motivo: runtime.motivo,
    ultimaSincronizacao: runtime.ultimaSincronizacao,
    ciclos: runtime.ciclos,
    ultimoErro: runtime.ultimoErro,
    telegramConfigurado: Boolean(BOT_TOKEN && CHAT_ID)
  });
});

app.get('/status', async (req, res) => {
  let totalRodadas = 0;
  let pendentes = 0;
  try {
    if (pool) {
      totalRodadas = (await pool.query('SELECT COUNT(*)::int AS t FROM bacbo_rodadas')).rows[0].t;
      pendentes = (await pool.query(`SELECT COUNT(*)::int AS t FROM bacbo_sinais WHERE estado = 'PENDENTE'`)).rows[0].t;
    }
  } catch (_) {}

  res.json({
    nome: 'CAPUNGA DADOS — BAC BO',
    estado: 'online',
    iniciadoEm: runtime.iniciadoEm,
    ciclos: runtime.ciclos,
    motivo: runtime.motivo,
    ultimoSinal: runtime.ultimoSinal,
    totalRodadas,
    pendentes,
    ultimoErro: runtime.ultimoErro,
    hora: horaAngola()
  });
});

/* ========== START ========== */

async function start() {
  if (!DATABASE_URL) {
    console.error('DATABASE_URL não configurada');
    process.exit(1);
  }
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error('BOT_TOKEN ou CHAT_ID não configurados');
    process.exit(1);
  }

  await ensureSchema();
  console.log('[DB] Tabelas prontas');

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[HTTP] CAPUNGA DADOS na porta ${PORT}`);
    console.log(`[HORA] ${horaAngola()}`);
  });

  await syncOnce();
  syncTimer = setInterval(syncOnce, INTERVALO_SYNC_MS);
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