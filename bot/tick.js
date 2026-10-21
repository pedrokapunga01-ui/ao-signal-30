'use strict';

const axios = require('axios');
const { getSql } = require('./db');
const { enviar, horaAngola, corDisplay } = require('./telegram');

const API_BACBO = process.env.API_BACBO || 'https://api-cs.casino.org/svc-evolution-game-events/api/bacbo';
const MAX_GALE = Number(process.env.MAX_GALE || 2);
const INTERVALO_MINIMO_MS = Number(process.env.INTERVALO_MINIMO_MS || 55000);
const MAX_REDS_DIA = Number(process.env.MAX_REDS_DIA || 12);
const EMPATE_PROTEGIDO = (process.env.EMPATE_PROTEGIDO || 'true') === 'true';

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

function oposta(cor) {
  return cor === 'Banca' ? 'Jogador' : cor === 'Jogador' ? 'Banca' : null;
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

async function fetchRounds() {
  const res = await axios.get(API_BACBO, {
    timeout: 16000,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'CapungaDados/4.1'
    }
  });
  const items = extractItems(res.data);
  const map = new Map();
  for (const item of items) {
    const r = normalizeRound(item);
    if (r) map.set(r.id, r);
  }
  return [...map.values()].sort((a, b) => new Date(a.fim) - new Date(b.fim));
}

async function getRecent(limit = 20) {
  const sql = getSql();
  const { rows } = await sql.query(
    `SELECT * FROM bacbo_rodadas
     WHERE resultado IN ('Jogador','Banca')
     ORDER BY fim DESC, seq DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

async function getPendente() {
  const sql = getSql();
  const { rows } = await sql.query(
    `SELECT * FROM bacbo_sinais WHERE estado = 'PENDENTE' ORDER BY criado_em ASC LIMIT 1`
  );
  return rows[0] || null;
}

async function getPlacar() {
  const sql = getSql();
  const { rows } = await sql.query(`
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

  const recent = await sql.query(`
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
  const sql = getSql();
  const { rows } = await sql.query(`
    SELECT COUNT(*)::int AS total FROM bacbo_sinais
    WHERE estado = 'LOSS'
      AND criado_em >= date_trunc('day', NOW() AT TIME ZONE 'Africa/Luanda')
  `);
  return rows[0]?.total || 0;
}

async function resolver(round) {
  const sinal = await getPendente();
  if (!sinal) return;

  if (round.resultado === 'Empate') {
    if (!EMPATE_PROTEGIDO) return;
    const sql = getSql();
    await sql.query(`UPDATE bacbo_sinais SET empates = COALESCE(empates,0)+1 WHERE id = $1`, [sinal.id]);
    await enviar(msgEmpate(sinal));
    return;
  }

  if (round.resultado === sinal.cor) {
    const gale = Number(sinal.gale || 0);
    const estado = gale === 0 ? 'GREEN' : gale === 1 ? 'G1' : 'G2';
    const sql = getSql();
    await sql.query(
      `UPDATE bacbo_sinais SET estado = $1, resultado_final = $2 WHERE id = $3`,
      [estado, round.resultado, sinal.id]
    );
    const placar = await getPlacar();
    await enviar(msgGreen(sinal, estado) + formatPlacar(placar));
    return;
  }

  const proximoGale = Number(sinal.gale || 0) + 1;
  if (proximoGale <= MAX_GALE) {
    const sql = getSql();
    await sql.query(`UPDATE bacbo_sinais SET gale = $1 WHERE id = $2`, [proximoGale, sinal.id]);
    await enviar(msgGale(sinal, proximoGale));
    return;
  }

  const sql = getSql();
  await sql.query(
    `UPDATE bacbo_sinais SET estado = 'LOSS', resultado_final = $1 WHERE id = $2`,
    [round.resultado, sinal.id]
  );
  const placar = await getPlacar();
  await enviar(msgLoss(sinal) + formatPlacar(placar));
}

async function tentarCriar(round) {
  const pendente = await getPendente();
  if (pendente) return { motivo: `pendente #${pendente.id}` };

  const reds = await redsHoje();
  if (reds >= MAX_REDS_DIA) return { motivo: `limite reds ${reds}` };

  const sql = getSql();
  const { rows: ultimo } = await sql.query(
    `SELECT criado_em FROM bacbo_sinais ORDER BY criado_em DESC LIMIT 1`
  );
  if (ultimo[0] && Date.now() - new Date(ultimo[0].criado_em).getTime() < INTERVALO_MINIMO_MS) {
    return { motivo: 'intervalo mínimo' };
  }

  const recent = await getRecent(22);
  const entry = detectBest(recent);
  if (!entry) return { motivo: 'sem setup' };

  const { rows: ja } = await sql.query(
    `SELECT 1 FROM bacbo_sinais WHERE resultado_id = $1 LIMIT 1`,
    [round.id]
  );
  if (ja.length) return { motivo: 'rodada já usada' };

  const { rows } = await sql.query(
    `INSERT INTO bacbo_sinais (cor, estado, gale, resultado_id, estrategia, nome_estrategia)
     VALUES ($1, 'PENDENTE', 0, $2, $3, $4) RETURNING *`,
    [entry.cor, round.id, entry.estrategia, entry.nome]
  );

  const sinal = rows[0];
  await enviar(msgEntrada(entry));
  return { criado: true, sinal, entry };
}

async function tickAndSnapshot() {
  const sql = getSql();
  let motivo = 'ok';
  let erro = null;
  let novos = 0;
  let aberto = null;
  let entryUsada = null;

  try {
    const rounds = await fetchRounds();
    for (const round of rounds) {
      const result = await sql.query(
        `INSERT INTO bacbo_rodadas (id, resultado, inicio, fim, pontos_jogador, pontos_banca)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
        [round.id, round.resultado, round.inicio, round.fim, round.pontos_jogador, round.pontos_banca]
      );
      if (result.rowCount === 0) continue;

      novos++;
      await resolver(round);
      const res = await tentarCriar(round);
      if (res.criado) {
        entryUsada = res.entry;
        aberto = res.sinal;
      } else if (res.motivo) {
        motivo = res.motivo;
      }
    }

    if (novos === 0) {
      const pend = await getPendente();
      if (pend) {
        if (Date.now() - new Date(pend.criado_em).getTime() > 4 * 60 * 1000) {
          await sql.query(`UPDATE bacbo_sinais SET estado = 'CANCELADO' WHERE id = $1`, [pend.id]);
          await enviar(`⏳ CAPUNGA • Sinal #${pend.id} expirado\n🕒 ${horaAngola()}`);
          motivo = 'sinal expirado';
        } else {
          motivo = `aguardando #${pend.id}`;
        }
      } else {
        motivo = 'sem rodadas novas';
      }
    }
  } catch (e) {
    erro = e.message;
    motivo = 'erro';
    console.error('[TICK ERROR]', e);
  }

  const { rows: totalRodadas } = await sql.query(`SELECT COUNT(*)::int AS total FROM bacbo_rodadas`);
  const placar = await getPlacar().catch(() => null);

  return {
    sucesso: !erro,
    erro,
    hora: horaAngola(),
    motivo,
    motivoHumano: motivo,
    aoVivo: true,
    sincronizadoEm: new Date().toISOString(),
    aberto,
    entry: entryUsada,
    folha: placar,
    totais: {
      rodadas: totalRodadas[0]?.total || 0,
      novos
    }
  };
}

module.exports = { tickAndSnapshot };