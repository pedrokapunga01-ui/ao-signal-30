import express from 'express';
import pg from 'pg';
import { timingSafeEqual } from 'node:crypto';

const { Pool } = pg;
const app = express();
const PORT = Number(process.env.PORT || 10000);
const DATABASE_URL = process.env.DATABASE_URL;
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID || process.env.TELEGRAM_CHAT_ID;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const INTERVAL = '5m';
const BAR_MS = 5 * 60_000;
const POLL_MS = 15_000;
const FIVE_MIN_LIMIT = 800;
const HOURLY_LIMIT = 100;
const MARKET_DATA_PROVIDER = 'Bybit Linear USDT perpetuals';
const MAX_HOLD_BARS = 12;
const STOP_ATR = 1.0;
const TARGET_ATR = 1.5;
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30_000,
}) : null;
let loopBusy = false;
let lastSuccessfulCycle = null;
let lastError = null;
let marketDataBlockedUntil = 0;

if (!pool) throw new Error('DATABASE_URL é obrigatório.');
if (!BOT_TOKEN || !CHAT_ID) throw new Error('BOT_TOKEN e CHAT_ID são obrigatórios.');
if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN é obrigatório para proteger as rotas privadas.');

function requireAdmin(req, res, next) {
  const provided = req.get('x-admin-token') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(provided || '');
  const b = Buffer.from(ADMIN_TOKEN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ error: 'Não autorizado.' });
  next();
}

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS signals (
    id BIGSERIAL PRIMARY KEY,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('LONG','SHORT')),
    strategy TEXT NOT NULL,
    signal_candle_ms BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reference_price NUMERIC NOT NULL,
    entry_ms BIGINT NOT NULL,
    entry_price NUMERIC,
    stop_price NUMERIC,
    target_price NUMERIC,
    atr NUMERIC NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE',
    result TEXT,
    result_reason TEXT,
    exit_price NUMERIC,
    exit_candle_ms BIGINT,
    bars_held INTEGER NOT NULL DEFAULT 0,
    UNIQUE(symbol, signal_candle_ms)
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS signals_status_symbol_idx ON signals(symbol,status)');
  await pool.query(`CREATE TABLE IF NOT EXISTS telegram_outbox (
    id BIGSERIAL PRIMARY KEY,
    signal_id BIGINT NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
    event_key TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    sent_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    UNIQUE(signal_id,event_key)
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS telegram_outbox_pending_idx ON telegram_outbox(sent_at,id)');
  await pool.query("UPDATE signals SET status='CANCELLED',result='CANCELLED',result_reason='SOURCE_SWITCH_TO_BYBIT_UNRESOLVED' WHERE status='ACTIVE' AND strategy NOT LIKE 'BYBIT_LINEAR:%'");
}

async function fetchMarket(symbol) {
  if (Date.now() < marketDataBlockedUntil) throw new Error(`Bybit cooldown ativo até ${new Date(marketDataBlockedUntil).toISOString()}`);
  const load = async (interval,limit) => {
    const params = new URLSearchParams({ category:'linear', symbol, interval, limit:String(limit) });
    const url = `https://api.bybit.com/v5/market/kline?${params}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      if ([403,418,429].includes(response.status)) {
        const retryAfterMs = Number(response.headers.get('retry-after')) * 1000;
        const fallbackMs = response.status === 403 || response.status === 418 ? 10 * 60_000 : 60_000;
        marketDataBlockedUntil = Math.max(marketDataBlockedUntil, Date.now() + Math.max(fallbackMs, Number.isFinite(retryAfterMs) ? retryAfterMs : 0));
      }
      throw new Error(`Bybit API HTTP ${response.status} (${symbol}/${interval})`);
    }
    const payload = await response.json();
    if (Number(payload.retCode) !== 0) {
      if (Number(payload.retCode) === 10006) marketDataBlockedUntil = Math.max(marketDataBlockedUntil, Date.now() + 60_000);
      throw new Error(`Bybit API ${payload.retCode}: ${payload.retMsg || 'erro de mercado'} (${symbol}/${interval})`);
    }
    const rows = payload.result?.list;
    if (!Array.isArray(rows)) throw new Error(`Resposta de candles inválida (${symbol}/${interval})`);
    const intervalMs = interval === '5' ? BAR_MS : 60 * 60_000;
    return rows.map(r => {
      const openTime=Number(r[0]);
      return { openTime, open:Number(r[1]), high:Number(r[2]), low:Number(r[3]), close:Number(r[4]), volume:Number(r[5]), closeTime:openTime+intervalMs-1 };
    }).sort((a,b)=>a.openTime-b.openTime);
  };
  const [bars,hourBars] = await Promise.all([load('5',FIVE_MIN_LIMIT),load('60',HOURLY_LIMIT)]);
  const now = Date.now();
  return { closed:bars.filter(b => b.closeTime < now - 750), hourly:hourBars.filter(b => b.closeTime < now - 750), forming:bars.find(b => b.closeTime >= now - 750) || null };
}

function ema(values, period) {
  if (values.length < period) return NaN;
  const alpha = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i=period; i<values.length; i++) value += alpha * (values[i] - value);
  return value;
}

function calcRsi(values, period=14) {
  if (values.length <= period) return NaN;
  let gain=0, loss=0;
  for (let i=1; i<=period; i++) { const d=values[i]-values[i-1]; gain+=Math.max(d,0); loss+=Math.max(-d,0); }
  gain/=period; loss/=period;
  for (let i=period+1; i<values.length; i++) { const d=values[i]-values[i-1]; gain=(gain*(period-1)+Math.max(d,0))/period; loss=(loss*(period-1)+Math.max(-d,0))/period; }
  return loss === 0 ? 100 : 100 - 100/(1+gain/loss);
}

function calcAtr(candles, period=14) {
  if (candles.length <= period) return NaN;
  const tr=[];
  for (let i=1; i<candles.length; i++) tr.push(Math.max(candles[i].high-candles[i].low, Math.abs(candles[i].high-candles[i-1].close), Math.abs(candles[i].low-candles[i-1].close)));
  let value=tr.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for (let i=period; i<tr.length; i++) value=(value*(period-1)+tr[i])/period;
  return value;
}

function getCandidate(candles,hourly) {
  if (candles.length < 750) return null;
  if (hourly.length < 55) return null;
  const closes=candles.map(c=>c.close), hcloses=hourly.map(c=>c.close), last=candles.at(-1);
  const hFast=ema(hcloses,20), hSlow=ema(hcloses,50), hLast=hcloses.at(-1);
  const fast=ema(closes,20), slow=ema(closes,50), rsi=calcRsi(closes,14), atr=calcAtr(candles,14);
  const volumes=candles.slice(-21,-1).map(c=>c.volume), avgVol=volumes.reduce((a,b)=>a+b,0)/volumes.length;
  if (![hFast,hSlow,hLast,fast,slow,rsi,atr,avgVol].every(Number.isFinite) || atr<=0 || avgVol<=0) return null;
  const volumeOkay=last.volume>=avgVol*0.8;
  const long=hFast>hSlow && hLast>hFast && fast>slow && last.low<=fast+0.20*atr && last.close>fast && rsi>=48 && rsi<=64 && last.close>last.open && volumeOkay;
  const short=hFast<hSlow && hLast<hFast && fast<slow && last.high>=fast-0.20*atr && last.close<fast && rsi>=36 && rsi<=52 && last.close<last.open && volumeOkay;
  if (!long && !short) return null;
  const mid=long?56:44;
  const score=Math.abs(hFast/hSlow-1)*10_000+Math.abs(fast/slow-1)*10_000+Math.max(0,last.volume/avgVol-0.8)*5+(1-Math.abs(rsi-mid)/10);
  return { side:long?'LONG':'SHORT', candle:last, atr, score, strategy:'BYBIT_LINEAR: tendência 1h EMA20/50 + pullback 5m EMA20/50 + RSI14 + confirmação de candle + volume' };
}

const fmt = n => Number(n).toLocaleString('en-US',{maximumSignificantDigits:9});
function signalMessage(symbol,candidate,entry,stop,target) {
  const sideLabel=candidate.side==='LONG'?'COMPRA / LONG':'VENDA / SHORT';
  return `⚡ CAPUNGA TRADING ⚡\n━━━━━━━━━━━━━━━━━━\n🧪 ALERTA PAPER — ${sideLabel}\n\nAtivo: ${symbol}\nMercado de referência: Bybit Linear USDT Perpetual\nTimeframe: 5 minutos\nEntrada simulada: ${fmt(entry)}\nAlvo: ${fmt(target)}\nStop: ${fmt(stop)}\nValidade máxima: 60 minutos\nTentativas: 1 — sem Gale\n\nConfluência: tendência 1h + pullback 5m + RSI + volume.\n\n⛔ Dados da Bybit; não representam a Binance. O backtest preliminar da lógica em candles Binance foi negativo; a versão com Bybit ainda não foi validada. Somente para paper testing; não usar dinheiro real nem tratar como recomendação.`;
}

function resultMessage(row,result,reason,exit) {
  const title=result==='GREEN'?'✅ GREEN':'❌ LOSS';
  return `⚡ CAPUNGA TRADING ⚡\n━━━━━━━━━━━━━━━━━━\n${title} — ${row.symbol} ${row.side}\nMercado de referência: Bybit Linear USDT Perpetual\nResultado simulado: ${result}\nMotivo: ${reason}\nSaída de referência: ${fmt(exit)}\nTentativas: 1 — sem Gale\n\nHistórico teórico baseado em candles; não representa execução real.`;
}

async function telegram(text) {
  const response=await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:CHAT_ID,text,disable_web_page_preview:true}),signal:AbortSignal.timeout(10_000)});
  const body=await response.json().catch(()=>({}));
  if (!response.ok || !body.ok) throw new Error(`Telegram sendMessage falhou: ${body.description||response.status}`);
}

async function dispatchOutbox() {
  const pending=await pool.query('SELECT id,message FROM telegram_outbox WHERE sent_at IS NULL ORDER BY id LIMIT 20');
  for (const item of pending.rows) {
    try {
      await telegram(item.message);
      await pool.query('UPDATE telegram_outbox SET sent_at=NOW(),attempts=attempts+1,last_error=NULL WHERE id=$1',[item.id]);
    } catch(error) {
      const msg=String(error.message).slice(0,500);
      await pool.query('UPDATE telegram_outbox SET attempts=attempts+1,last_error=$2 WHERE id=$1',[item.id,msg]);
      lastError=`Telegram: ${msg}`;
      break;
    }
  }
}

async function createSignal(symbol,candidate,formingBar) {
  const c=candidate.candle;
  const entryTime=c.openTime+BAR_MS;
  // Do not publish a stale signal if the expected next 5m candle is already gone.
  if (!formingBar || formingBar.openTime!==entryTime) return;
  const entry=formingBar.open;
  const sign=candidate.side==='LONG'?1:-1;
  const stop=entry-sign*STOP_ATR*candidate.atr;
  const target=entry+sign*TARGET_ATR*candidate.atr;
  const client=await pool.connect();
  let signalId=null;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)',[64280511]);
    const recent=await client.query("SELECT created_at FROM signals ORDER BY id DESC LIMIT 1");
    if (recent.rowCount && Date.now()-new Date(recent.rows[0].created_at).getTime()<BAR_MS) { await client.query('ROLLBACK'); return; }
    const active=await client.query("SELECT 1 FROM signals WHERE symbol=$1 AND status IN ('WAITING_ENTRY','ACTIVE') LIMIT 1",[symbol]);
    if (active.rowCount) { await client.query('ROLLBACK'); return; }
    const insert=await client.query(`INSERT INTO signals(symbol,side,strategy,signal_candle_ms,reference_price,entry_ms,entry_price,stop_price,target_price,atr,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTIVE') ON CONFLICT(symbol,signal_candle_ms) DO NOTHING RETURNING id`,
      [symbol,candidate.side,candidate.strategy,c.openTime,c.close,entryTime,entry,stop,target,candidate.atr]);
    if (!insert.rowCount) { await client.query('ROLLBACK'); return; }
    signalId=insert.rows[0].id;
    const message=signalMessage(symbol,candidate,entry,stop,target);
    await client.query('INSERT INTO telegram_outbox(signal_id,event_key,message) VALUES($1,$2,$3)',[signalId,'signal',message]);
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
  finally { client.release(); }
}

async function resolveSignals(symbol,candles) {
  const pending=await pool.query("SELECT * FROM signals WHERE symbol=$1 AND status='ACTIVE' ORDER BY id",[symbol]);
  for (const row of pending.rows) {
    const entryMs=Number(row.entry_ms);
    const bars=candles.filter(c=>c.openTime>=entryMs);
    for (const bar of bars) {
      const stopHit=row.side==='LONG'?bar.low<=Number(row.stop_price):bar.high>=Number(row.stop_price);
      const targetHit=row.side==='LONG'?bar.high>=Number(row.target_price):bar.low<=Number(row.target_price);
      let result=null,reason=null,exit=null;
      // If both levels occur in one OHLC bar, conservatively assume stop first.
      if (stopHit) { result='LOSS'; reason=targetHit?'STOP_AND_TARGET_SAME_BAR_STOP_ASSUMED':'STOP'; exit=Number(row.stop_price); }
      else if (targetHit) { result='GREEN'; reason='TARGET'; exit=Number(row.target_price); }
      else {
        const held=Math.floor((bar.openTime-entryMs)/BAR_MS)+1;
        if (held>=MAX_HOLD_BARS) { result='LOSS'; reason='TIME_LIMIT_WITHOUT_TARGET'; exit=bar.close; }
        else continue;
      }
      const held=Math.floor((bar.openTime-entryMs)/BAR_MS)+1;
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        const changed=await client.query("UPDATE signals SET status=$1,result=$1,result_reason=$2,exit_price=$3,exit_candle_ms=$4,bars_held=$5 WHERE id=$6 AND status='ACTIVE' RETURNING id",[result,reason,exit,bar.openTime,held,row.id]);
        if (changed.rowCount) await client.query('INSERT INTO telegram_outbox(signal_id,event_key,message) VALUES($1,$2,$3) ON CONFLICT(signal_id,event_key) DO NOTHING',[row.id,'result',resultMessage(row,result,reason,exit)]);
        await client.query('COMMIT');
      } catch(error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
      finally { client.release(); }
      break;
    }
  }
}

async function processSymbol(symbol) {
  const {closed,hourly,forming}=await fetchMarket(symbol);
  if (closed.length<750 || hourly.length<55) throw new Error(`Dados insuficientes para tendência multi-timeframe (${symbol})`);
  await resolveSignals(symbol,closed);
  const candidate=getCandidate(closed,hourly);
  return candidate?{symbol,candidate,forming}:null;
}

async function tick() {
  if (loopBusy || Date.now() < marketDataBlockedUntil) return;
  loopBusy=true;
  try {
    const candidates=[];
    for (const symbol of SYMBOLS) {
      try { const item=await processSymbol(symbol); if (item) candidates.push(item); }
      catch(error) { lastError=`${symbol}: ${error.message}`; console.error(lastError); if (Date.now() < marketDataBlockedUntil) break; }
    }
    candidates.sort((a,b)=>b.candidate.score-a.candidate.score);
    if (candidates.length) await createSignal(candidates[0].symbol,candidates[0].candidate,candidates[0].forming);
    await dispatchOutbox();
    lastSuccessfulCycle=new Date().toISOString();
  } finally { loopBusy=false; }
}

app.get('/health',async (_req,res)=>{
  try { await pool.query('SELECT 1'); res.json({status:'ok',product:'Capunga Trading paper signal generator',market:MARKET_DATA_PROVIDER+' public data',symbols:SYMBOLS,timeframe:INTERVAL,signal_cap:'one per 5m globally; no minimum',validation:'preliminary Binance-data backtest was negative; Bybit-source performance is not yet tested; paper testing only',last_cycle:lastSuccessfulCycle,last_error:lastError}); }
  catch { res.status(503).json({status:'degraded',database:'unavailable'}); }
});

app.get('/stats',requireAdmin,async (_req,res)=>{
  try {
    const {rows}=await pool.query(`SELECT symbol,COUNT(*)::int AS total,COUNT(*) FILTER(WHERE result='GREEN')::int AS green,COUNT(*) FILTER(WHERE result='LOSS')::int AS loss,COUNT(*) FILTER(WHERE status='ACTIVE')::int AS active,COUNT(*) FILTER(WHERE status='CANCELLED')::int AS cancelled,ROUND(100.0*COUNT(*) FILTER(WHERE result='GREEN')/NULLIF(COUNT(*) FILTER(WHERE result IN ('GREEN','LOSS')),0),2) AS observed_green_pct FROM signals GROUP BY symbol ORDER BY symbol`);
    res.json({notice:'Resultados simulados; sinais abertos da fonte antiga foram cancelados na migração e não contam como green/loss. Custos e funding não estão incorporados; a regra preliminar em Binance foi negativa fora da amostra.',stats:rows});
  } catch { res.status(500).json({error:'Falha ao consultar estatísticas.'}); }
});

app.get('/history',requireAdmin,async (req,res)=>{
  const limit=Math.min(200,Math.max(1,Number(req.query.limit||50)));
  try { const {rows}=await pool.query('SELECT id,symbol,side,strategy,created_at,reference_price,entry_price,stop_price,target_price,status,result,result_reason,exit_price,bars_held FROM signals ORDER BY id DESC LIMIT $1',[limit]); res.json(rows); }
  catch { res.status(500).json({error:'Falha ao consultar histórico.'}); }
});

await initDb();
app.listen(PORT,'0.0.0.0',()=>console.log(`Capunga Trading — fonte=${MARKET_DATA_PROVIDER}; intervalo de decisão 5m; teto global 1 sinal/5m; ativos=${SYMBOLS.join(',')}`));
await tick();
setInterval(tick,POLL_MS);
