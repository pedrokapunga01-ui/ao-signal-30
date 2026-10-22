
/**
 * Dados AO — Bac Bo Telegram Bot
 * Regista resultados e apresenta estatísticas descritivas.
 */
'use strict';

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('Erro: configura TELEGRAM_BOT_TOKEN no ficheiro .env');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'results.json');
const VALID = new Set(['P', 'B', 'T']);

function loadResults() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, '[]', 'utf8');
  }

  try {
    const data = JSON.parse(
      fs.readFileSync(DATA_FILE, 'utf8')
    );

    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error('Erro ao ler resultados:', error.message);
    return [];
  }
}

let results = loadResults();

function saveResults() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const temporaryFile = DATA_FILE + '.tmp';

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(results, null, 2),
    'utf8'
  );

  fs.renameSync(temporaryFile, DATA_FILE);
}

function getUserResults(chatId) {
  return results.filter(
    item => String(item.chatId) === String(chatId)
  );
}

function percentage(value, total) {
  return total
    ? ((value / total) * 100).toFixed(1) + '%'
    : '0.0%';
}

function outcomeName(value) {
  return {
    P: 'Player',
    B: 'Banker',
    T: 'Empate'
  }[value] || value;
}

function helpText() {
  return [
    '🎲 DADOS AO — BAC BO',
    '',
    'Comandos disponíveis:',
    '/start — iniciar o bot',
    '/help — ver ajuda',
    '/status — total de registos',
    '/registar P — registar Player',
    '/registar B — registar Banker',
    '/registar T — registar Empate',
    '/historico — últimos 10 resultados',
    '/estatisticas — consultar estatísticas',
    '/apagar — apagar o teu histórico',
    '',
    'Nota: estatísticas passadas não garantem resultados futuros.',
    'Aposta não é investimento.'
  ].join('\n');
}

bot.onText(/^\/start(?:@\w+)?$/, async msg => {
  await bot.sendMessage(
    msg.chat.id,
    'Bem-vindo ao Dados AO — Bac Bo! 🎲\n\n' +
    'Regista resultados e consulta estatísticas descritivas.\n' +
    'Escreve /help para começar.'
  );
});

bot.onText(/^\/help(?:@\w+)?$/, msg => {
  bot.sendMessage(msg.chat.id, helpText());
});

bot.onText(/^\/status(?:@\w+)?$/, msg => {
  const own = getUserResults(msg.chat.id);

  bot.sendMessage(
    msg.chat.id,
    `Tens ${own.length} resultado(s) registado(s).`
  );
});

bot.onText(
  /^\/registar(?:@\w+)?(?:\s+([PpBbTt]))?(?:\s+([PpBbTt]))?\s*$/,
  (msg, match) => {
    const values = [match[1], match[2]]
      .filter(Boolean)
      .map(value => value.toUpperCase());

    if (values.length === 0) {
      return bot.sendMessage(
        msg.chat.id,
        'Usa /registar P, /registar B ou /registar T.'
      );
    }

    for (const value of values) {
      if (!VALID.has(value)) {
        return bot.sendMessage(
          msg.chat.id,
          'Resultado inválido. Usa P, B ou T.'
        );
      }

      results.push({
        id: `${Date.now()}-${Math.random()
          .toString(36).slice(2, 8)}`,
        chatId: String(msg.chat.id),
        outcome: value,
        createdAt: new Date().toISOString()
      });
    }

    saveResults();

    bot.sendMessage(
      msg.chat.id,
      'Registado(s): ' +
      values.map(outcomeName).join(', ') +
      '\nConsulta /estatisticas para ver o resumo.'
    );
  }
);

bot.onText(/^\/historico(?:@\w+)?$/, msg => {
  const own = getUserResults(msg.chat.id).slice(-10);

  if (own.length === 0) {
    return bot.sendMessage(
      msg.chat.id,
      'Ainda não existem resultados registados.'
    );
  }

  const lines = own.map((item, index) => {
    const date = new Date(item.createdAt)
      .toLocaleString('pt-PT');

    return `${index + 1}. ${outcomeName(item.outcome)} — ${date}`;
  });

  bot.sendMessage(
    msg.chat.id,
    '📋 Últimos resultados:\n\n' + lines.join('\n')
  );
});

bot.onText(/^\/estatisticas(?:@\w+)?$/, msg => {
  const own = getUserResults(msg.chat.id);
  const total = own.length;

  const counts = { P: 0, B: 0, T: 0 };

  for (const item of own) {
    if (counts[item.outcome] !== undefined) {
      counts[item.outcome]++;
    }
  }

  const report = [
    '📊 ESTATÍSTICAS BAC BO',
    '',
    `Total: ${total}`,
    `Player: ${counts.P} (${percentage(counts.P, total)})`,
    `Banker: ${counts.B} (${percentage(counts.B, total)})`,
    `Empate: ${counts.T} (${percentage(counts.T, total)})`,
    '',
    'Os dados representam apenas os resultados registados.',
    'Não constituem uma previsão da próxima ronda.'
  ].join('\n');

  bot.sendMessage(msg.chat.id, report);
});

bot.onText(/^\/apagar(?:@\w+)?$/, msg => {
  bot.sendMessage(
    msg.chat.id,
    'Desejas apagar o teu histórico?',
    {
      reply_markup: {
        inline_keyboard: [[
          {
            text: 'Confirmar',
            callback_data: 'delete_history'
          },
          {
            text: 'Cancelar',
            callback_data: 'cancel_delete'
          }
        ]]
      }
    }
  );
});

bot.on('callback_query', query => {
  const chatId = query.message?.chat?.id;

  if (!chatId) {
    return bot.answerCallbackQuery(query.id);
  }

  if (query.data === 'delete_history') {
    const previousCount = results.length;

    results = results.filter(
      item => String(item.chatId) !== String(chatId)
    );

    saveResults();

    bot.answerCallbackQuery(query.id, {
      text: 'Histórico apagado.'
    });

    bot.editMessageText(
      `Histórico apagado. Registos removidos: ${
        previousCount - results.length
      }.`,
      {
        chat_id: chatId,
        message_id: query.message.message_id
      }
    );
  } else if (query.data === 'cancel_delete') {
    bot.answerCallbackQuery(query.id, {
      text: 'Operação cancelada.'
    });

    bot.editMessageText(
      'Operação cancelada.',
      {
        chat_id: chatId,
        message_id: query.message.message_id
      }
    );
  }
});

bot.on('polling_error', error => {
  console.error('Erro Telegram:', error.message);
});

bot.on('error', error => {
  console.error('Erro do bot:', error.message);
});

console.log('Dados AO Bac Bo Bot iniciado.');
