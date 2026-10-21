'use strict';

const { Pool } = require('pg');

let pool = null;

function getSql() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL não definida');

    pool = new Pool({
      connectionString: url,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: 6,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000
    });
  }
  return pool;
}

async function closeDb() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getSql, closeDb };