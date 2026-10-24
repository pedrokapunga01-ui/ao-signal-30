'use strict';

/**
 * CAPUNGA DADOS — BAC BO · v8 (sem Gale)
 *
 * Entrada única por sinal. O motor testa ~130 hipóteses no histórico (treino/validação,
 * correção FDR) e, no modo ESTRITO, só emite quando uma hipótese PROVA vantagem estatística.
 * Em dados aleatórios isso significa, na maior parte do tempo, NENHUM sinal — é o comportamento
 * correto: não há sinal "garantido" no Bac Bo.
 *
 * Variáveis: BOT_TOKEN, CHAT_ID (obrigatórias p/ enviar) · DATABASE_URL (recomendada: sem ela
 * o histórico perde-se a cada reinício e o motor volta a "aprender") · ADMIN_TOKEN · ADMIN_CHAT_ID
 * MODO (ESTRITO|LIVRE) · INTERVALO_SINAL_MS · MAX_SINAIS_HORA · EMPATE_CONTA_GREEN · ALPHA_FDR
 * MIN_TREINO · MIN_VALIDACAO · RESUMO_DIARIO · … (ver src/config.js)
 */

const CFG = require('./src/config');
const { log } = require('./src/util');
const store = require('./src/store');
const sync = require('./src/sync');
const { criarApp } = require('./src/http');

let servidor = null;
let encerrando = false;

async function iniciar() {
  await store.iniciar();

  servidor = criarApp().listen(CFG.port, '0.0.0.0', () =>
    log('START', { versao: 'v8-sem-gale', porta: CFG.port, modo: CFG.modo, intervaloMs: CFG.intervaloSinalMs })
  );

  sync.recalcular(true); // com o histórico vindo do banco (se houver)
  const primeira = await sync.syncOnce();
  log('PRIMEIRA_SYNC', primeira);
  sync.agendar();
}

async function encerrar() {
  if (encerrando) return;
  encerrando = true;
  sync.parar();
  if (servidor) await new Promise((r) => servidor.close(r));
  await store.fechar();
  process.exit(0);
}

process.on('unhandledRejection', (e) => log('UNHANDLED_REJECTION', String(e)));
process.on('uncaughtException', (e) => log('UNCAUGHT_EXCEPTION', e.message || String(e)));
process.on('SIGTERM', () => encerrar().catch(() => process.exit(1)));
process.on('SIGINT', () => encerrar().catch(() => process.exit(1)));

iniciar().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});
