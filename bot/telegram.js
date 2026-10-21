'use strict';

const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const CHAT_ID = process.env.CHAT_ID || '';

function telegramConfigurado() {
  return Boolean(BOT_TOKEN && CHAT_ID);
}

async function enviar(texto) {
  if (!telegramConfigurado()) return false;

  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id: CHAT_ID,
        text: texto,
        disable_web_page_preview: true
      },
      { timeout: 14000 }
    );
    return res.data?.ok === true;
  } catch (erro) {
    console.error('[TELEGRAM]', erro.response?.data || erro.message);
    return false;
  }
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
  return cor;
}

module.exports = { telegramConfigurado, enviar, horaAngola, corDisplay };