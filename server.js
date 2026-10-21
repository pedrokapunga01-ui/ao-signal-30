
'use strict';

/**
 * CAPUNGA DADOS — BAC BO
 * Node.js + Express + PostgreSQL + Telegram
 *
 * Agenda: minutos 00, 05, 10, ..., 55.
 * Gale máximo: 2.
 * Empate: devolve/push, mantém a tentativa atual.
 *
 * Variáveis obrigatórias:
 * DATABASE_URL
 * BOT_TOKEN
 * CHAT_ID
 * INGEST_TOKEN
 *
 * Opcionais:
 * PORT=10000
 * MIN_AMOSTRA=20
 * JANELA_ANALISE=30
 * MIN_FREQUENCIA=0.55
 * TIME_ZONE=Africa/Luanda
 * DATABASE_SSL=false
 */

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '100kb' }));

const PORT = Number(process.env.PORT || 10000);
const DATABASE_URL = process.env.DATABASE_URL || '';
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || '';
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';

const MIN_AMOSTRA = Math.max(
  10, Math.min(500, Number(process.env.MIN_AMOSTRA || 20))
);

const JANELA_ANALISE = Math.max(
  MIN_AMOSTRA,
  Math.min(500, Number(process.env.JANELA_ANALISE || 30))
);

const MIN_FREQUENCIA = Math.max(
  0.50,
  Math.min(0.95, Number(process.env.MIN_FREQUENCIA || 0.55))
);

const TIME_ZONE = process.env.TIME_ZONE || 'Africa/Luanda';

const runtime = {
  iniciadoEm: new Date().toISOString(),
  ultimoErro: null,
  ultimaSincronizacao: null,
  ultimoAgendamento: null,
  ultimoSinal: null,
  telegramConfigurado: Boolean(BOT_TOKEN && CHAT_ID),
  baseDadosOK: false,
  ciclos: 0
};

let pool;
let server;
let timer;
let encerrando = false;
let cicloEmCurso = false;

function horaLocal(data = new Date()) {
  return new Intl.DateTimeFormat('pt-AO', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).format(data);
}

function chaveHorario(data = new Date()) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(data);

  const p = Object.fromEntries(
    partes.map(x => [x.type, x.value])
  );

  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function proximoHorario() {
  const agora = Date.now();
  const passo = 5 * 60 * 1000;
  return Math.floor(agora / passo + 1) * passo;
}

function esperarProximoHorario() {
  if (encerrando) return;

  const proximo = proximoHorario();
  const atraso = Math.max(250, proximo - Date.now());

  timer = setTimeout(async () => {
    try {
      await executarAgendamento();
    } catch (erro) {
      registarErro(erro);
    } finally {
      esperarProximoHorario();
    }
  }, atraso);
}

function registarErro(erro) {
  runtime.ultimoErro = erro.message || String(erro);
  console.error('[ERRO]', runtime.ultimoErro);
}

async function telegram(mensagem) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('[TELEGRAM DESATIVADO]', mensagem);
    return false;
  }

  const resposta = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: mensagem
      }),
      signal: AbortSignal.timeout(12000)
    }
  );

  const dados = await resposta.json();

  if (!resposta.ok || !dados.ok) {
    throw new Error(
      `Telegram: ${dados.description || resposta.status}`
    );
  }

  return true;
}

/* ================================================
   BASE DE DADOS
================================================ */

async function prepararBase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bacbo_resultados (
      id BIGSERIAL PRIMARY KEY,
      resultado TEXT NOT NULL
        CHECK (resultado IN ('RED', 'BLUE', 'TIE')),
      origem TEXT NOT NULL DEFAULT 'ingest',
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bacbo_sinais (
      id BIGSERIAL PRIMARY KEY,
      horario TEXT NOT NULL UNIQUE,
      cor TEXT NOT NULL CHECK (cor IN ('RED', 'BLUE')),
      gale INTEGER NOT NULL DEFAULT 0,
      estado TEXT NOT NULL DEFAULT 'ABERTO'
        CHECK (estado IN ('ABERTO', 'GREEN', 'LOSS', 'CANCELADO')),
      frequencia NUMERIC(6,4),
      amostra INTEGER NOT NULL DEFAULT 0,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      fechado_em TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_resultados_data
      ON bacbo_resultados (criado_em DESC);

    CREATE INDEX IF NOT EXISTS idx_sinais_estado
      ON bacbo_sinais (estado, criado_em DESC);
  `);

  runtime.baseDadosOK = true;
  console.log('[DB] Tabelas verificadas');
}

/* ================================================
   ANÁLISE ESTATÍSTICA SIMPLES
================================================ */

async function analisarHistorico() {
  const resultado = await pool.query(
    `SELECT resultado
     FROM bacbo_resultados
     WHERE resultado IN ('RED', 'BLUE')
     ORDER BY id DESC
     LIMIT $1`,
    [JANELA_ANALISE]
  );

  const historico = resultado.rows.map(x => x.resultado);
  const total = historico.length;

  if (total < MIN_AMOSTRA) {
    return {
      aprovado: false,
      motivo: 'Amostra insuficiente',
      amostra: total
    };
  }

  const reds = historico.filter(x => x === 'RED').length;
  const blues = total - reds;

  const cor = reds >= blues ? 'RED' : 'BLUE';
  const quantidade = Math.max(reds, blues);
  const frequencia = quantidade / total;

  if (frequencia < MIN_FREQUENCIA) {
    return {
      aprovado: false,
      motivo: 'Frequência mínima não atingida',
      amostra: total,
      frequencia
    };
  }

  return {
    aprovado: true,
    cor,
    amostra: total,
    frequencia
  };
}

/* ================================================
   LIQUIDAÇÃO DE SINAIS
================================================ */

async function liquidarResultado(resultado) {
  const aberto = await pool.query(
    `SELECT *
     FROM bacbo_sinais
     WHERE estado = 'ABERTO'
     ORDER BY id ASC
     LIMIT 1
     FOR UPDATE`
  );

  if (!aberto.rows.length) return null;

  const sinal = aberto.rows[0];

  // Empate: devolve; não avança o Gale.
  if (resultado === 'TIE') {
    return {
      tipo: 'TIE',
      sinal,
      gale: sinal.gale
    };
  }

  if (resultado === sinal.cor) {
    await pool.query(
      `UPDATE bacbo_sinais
       SET estado = 'GREEN', fechado_em = NOW()
       WHERE id = $1`,
      [sinal.id]
    );

    return {
      tipo: 'GREEN',
      sinal,
      gale: sinal.gale
    };
  }

  if (sinal.gale < 2) {
    const proximoGale = sinal.gale + 1;

    await pool.query(
      `UPDATE bacbo_sinais
       SET gale = $2
       WHERE id = $1`,
      [sinal.id, proximoGale]
    );

    return {
      tipo: 'GALE',
      sinal: { ...sinal, gale: proximoGale },
      gale: proximoGale
    };
  }

  await pool.query(
    `UPDATE bacbo_sinais
     SET estado = 'LOSS', fechado_em = NOW()
     WHERE id = $1`,
    [sinal.id]
  );

  return {
    tipo: 'LOSS',
    sinal,
    gale: 2
  };
}

/* ================================================
   RECEÇÃO DE RESULTADOS REAIS
================================================ */

app.post('/api/result', async (req, res) => {
  if (!INGEST_TOKEN) {
    return res.status(503).json({
      sucesso: false,
      erro: 'INGEST_TOKEN não configurado'
    });
  }

  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    || req.body.token;

  if (token !== INGEST_TOKEN) {
    return res.status(401).json({
      sucesso: false,
      erro: 'Token inválido'
    });
  }

  const resultado = String(req.body.resultado || '')
    .trim()
    .toUpperCase();

  if (!['RED', 'BLUE', 'TIE'].includes(resultado)) {
    return res.status(400).json({
      sucesso: false,
      erro: 'resultado deve ser RED, BLUE ou TIE'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO bacbo_resultados (resultado)
       VALUES ($1)`,
      [resultado]
    );

    // Bloqueia liquidações concorrentes.
    const abertos = await client.query(
      `SELECT *
       FROM bacbo_sinais
       WHERE estado = 'ABERTO'
       ORDER BY id ASC
       LIMIT 1
       FOR UPDATE`
    );

    let liquidacao = null;

    if (abertos.rows.length) {
      const sinal = abertos.rows[0];

      if (resultado === 'TIE') {
        liquidacao = { tipo: 'TIE', sinal };
      } else if (resultado === sinal.cor) {
        await client.query(
          `UPDATE bacbo_sinais
           SET estado = 'GREEN', fechado_em = NOW()
           WHERE id = $1`,
          [sinal.id]
        );
        liquidacao = { tipo: 'GREEN', sinal };
      } else if (sinal.gale < 2) {
        const gale = sinal.gale + 1;

        await client.query(
          `UPDATE bacbo_sinais SET gale = $2 WHERE id = $1`,
          [sinal.id, gale]
        );

        liquidacao = {
          tipo: 'GALE',
          sinal: { ...sinal, gale }
        };
      } else {
        await client.query(
          `UPDATE bacbo_sinais
           SET estado = 'LOSS', fechado_em = NOW()
           WHERE id = $1`,
          [sinal.id]
        );
        liquidacao = { tipo: 'LOSS', sinal };
      }
    }

    await client.query('COMMIT');

    runtime.ultimaSincronizacao = new Date().toISOString();

    if (liquidacao) {
      const s = liquidacao.sinal;
      let mensagem;

      if (liquidacao.tipo === 'GREEN') {
        mensagem = `✅ GREEN — CAPUNGA DADOS\nSinal: ${s.cor}\nResolvido no Gale ${s.gale}.`;
      } else if (liquidacao.tipo === 'GALE') {
        mensagem = `⚠️ GALE ${s.gale}\nSinal original: ${s.cor}\nAguardar o próximo resultado real.`;
      } else if (liquidacao.tipo === 'LOSS') {
        mensagem = `❌ LOSS\nSinal original: ${s.cor}\nGale máximo 2 atingido.`;
      } else {
        mensagem = `➖ EMPATE / DEVOLUÇÃO\nSinal: ${s.cor}\nManter a tentativa Gale ${s.gale}.`;
      }

      telegram(mensagem).catch(registarErro);
    }

    res.json({
      sucesso: true,
      resultado,
      liquidacao: liquidacao?.tipo || 'SEM_SINAL_ABERTO',
      hora: horaLocal()
    });
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => {});
    registarErro(erro);

    res.status(500).json({
      sucesso: false,
      erro: 'Falha ao guardar o resultado'
    });
  } finally {
    client.release();
  }
});

/* ================================================
   AGENDAMENTO DE 5 EM 5 MINUTOS
================================================ */

async function executarAgendamento() {
  if (encerrando || cicloEmCurso) return;

  cicloEmCurso = true;

  try {
    const horario = chaveHorario();

    if (runtime.ultimoAgendamento === horario) return;
    runtime.ultimoAgendamento = horario;
    runtime.ciclos++;

    const aberto = await pool.query(
      `SELECT id FROM bacbo_sinais
       WHERE estado = 'ABERTO'
       LIMIT 1`
    );

    if (aberto.rows.length) {
      console.log('[AGENDA] Existe sinal aberto; novo sinal ignorado.');
      return;
    }

    const analise = await analisarHistorico();

    if (!analise.aprovado) {
      console.log('[SEM SINAL]', analise.motivo, analise.amostra);
      return;
    }

    const frequencia = Number(analise.frequencia.toFixed(4));

    const inserido = await pool.query(
      `INSERT INTO bacbo_sinais
        (horario, cor, gale, estado, frequencia, amostra)
       VALUES ($1, $2, 0, 'ABERTO', $3, $4)
       ON CONFLICT (horario) DO NOTHING
       RETURNING *`,
      [horario, analise.cor, frequencia, analise.amostra]
    );

    if (!inserido.rows.length) return;

    const sinal = inserido.rows[0];
    runtime.ultimoSinal = sinal;

    const mensagem =
      `🎲 CAPUNGA DADOS — BAC BO\n\n` +
      `🕒 Horário: ${horario} (${TIME_ZONE})\n` +
      `🎯 Sinal: ${sinal.cor}\n` +
      `🔁 Gale máximo: 2\n` +
      `➖ Empate: devolve\n` +
      `📊 Frequência histórica: ${(frequencia * 100).toFixed(1)}%\n` +
      `📚 Amostra: ${analise.amostra} resultados\n\n` +
      `⚠️ Frequência passada não garante o próximo resultado.`;

    await telegram(mensagem);

    console.log('[SINAL]', horario, sinal.cor);
  } catch (erro) {
    registarErro(erro);
  } finally {
    cicloEmCurso = false;
  }
}

/* ================================================
   ROTAS DE ESTADO
================================================ */

app.get('/', (_req, res) => {
  res.json({
    nome: 'CAPUNGA DADOS — BAC BO',
    estado: 'online',
    hora: horaLocal()
  });
});

app.get('/health', (_req, res) => {
  res.json({
    sucesso: true,
    estado: encerrando ? 'encerrando' : 'online',
    baseDadosOK: runtime.baseDadosOK,
    telegramConfigurado: runtime.telegramConfigurado,
    ultimaSincronizacao: runtime.ultimaSincronizacao,
    ultimoAgendamento: runtime.ultimoAgendamento,
    ultimoErro: runtime.ultimoErro,
    hora: horaLocal()
  });
});

app.get('/status', async (_req, res) => {
  try {
    const totais = await pool.query(
      `SELECT estado, COUNT(*)::int AS quantidade
       FROM bacbo_sinais
       GROUP BY estado`
    );

    const resultados = await pool.query(
      `SELECT resultado, COUNT(*)::int AS quantidade
       FROM bacbo_resultados
       GROUP BY resultado`
    );

    res.json({
      nome: 'CAPUNGA DADOS — BAC BO',
      estado: 'online',
      iniciadoEm: runtime.iniciadoEm,
      ciclos: runtime.ciclos,
      ultimoSinal: runtime.ultimoSinal,
      totaisSinais: totais.rows,
      totaisResultados: resultados.rows,
      ultimoErro: runtime.ultimoErro
    });
  } catch (erro) {
    registarErro(erro);
    res.status(500).json({
      sucesso: false,
      erro: 'Falha ao consultar estado'
    });
  }
});

app.get('/api/painel', async (_req, res) => {
  try {
    const sinais = await pool.query(
      `SELECT * FROM bacbo_sinais
       ORDER BY id DESC LIMIT 50`
    );

    res.json({
      sucesso: true,
      hora: horaLocal(),
      sinais: sinais.rows
    });
  } catch (erro) {
    registarErro(erro);
    res.status(500).json({ sucesso: false });
  }
});

/* ================================================
   ARRANQUE E ENCERRAMENTO
================================================ */

async function iniciar() {
  if (!DATABASE_URL) {
    throw new Error('Configura DATABASE_URL no Render.');
  }

  if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error('Configura BOT_TOKEN e CHAT_ID no Render.');
  }

  if (!INGEST_TOKEN) {
    throw new Error('Configura INGEST_TOKEN no Render.');
  }

  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false'
      ? false
      : { rejectUnauthorized: false },
    max: 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000
  });

  pool.on('error', erro => {
    registarErro(erro);
  });

  await prepararBase();

  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[HTTP] Porta ${PORT}`);
    console.log(`[AGENDA] De 5 em 5 minutos — ${TIME_ZONE}`);
  });

  esperarProximoHorario();
}

async function encerrar() {
  if (encerrando) return;
  encerrando = true;

  if (timer) clearTimeout(timer);

  if (server) {
    await new Promise(resolve => server.close(resolve));
  }

  if (pool) {
    await pool.end().catch(() => {});
  }

  console.log('[BOT] Encerrado com segurança');
}

process.once('SIGTERM', () => {
  encerrar().catch(registarErro);
});

process.once('SIGINT', () => {
  encerrar().catch(registarErro);
});

process.on('unhandledRejection', registarErro);

iniciar().catch(erro => {
  registarErro(erro);
  process.exitCode = 1;
});
