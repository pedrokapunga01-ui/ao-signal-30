'use strict';

const { getSql } = require('./db');

async function migrate() {
  const sql = getSql();

  await sql.query(`
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
  await sql.query(`CREATE INDEX IF NOT EXISTS idx_bacbo_rodadas_fim ON bacbo_rodadas (fim DESC)`);

  await sql.query(`
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
  await sql.query(`CREATE INDEX IF NOT EXISTS idx_sinais_estado ON bacbo_sinais (estado)`);
  await sql.query(`CREATE INDEX IF NOT EXISTS idx_sinais_criado ON bacbo_sinais (criado_em DESC)`);
}

module.exports = { migrate };