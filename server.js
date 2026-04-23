const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { RSI, EMA, ATR, ADX, MACD } = require('technicalindicators');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ENV
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// ================= CONFIG =================
const CONFIG = {
  pairs: ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT'],
  riskPerTrade: 0.02,
  maxDrawdown: 0.2,
  minADX: 20,
  minScore: 75,
  volumeMin: 1.5
};

// ================= STATE =================
let state = {
  balance: 1000,
  trades: [],
  wins: 0,
  losses: 0,
  drawdown: 0,
  lastTradeTime: {}
};

// ================= DATA =================
async function getCandles(symbol, interval, limit=200){
  try{
    const res = await axios.get('https://api.binance.com/api/v3/klines',{
      params:{symbol, interval, limit}
    });

    return res.data.map(c=>({
      open:+c[1], high:+c[2], low:+c[3],
      close:+c[4], volume:+c[5]
    }));
  }catch(e){
    return null;
  }
}

// ================= INDICATORS =================
function getIndicators(data){
  if(data.length < 50) return null;

  const closes = data.map(c=>c.close);
  const highs = data.map(c=>c.high);
  const lows = data.map(c=>c.low);

  return {
    rsi: RSI.calculate({values:closes,period:14}).pop(),
    ema20: EMA.calculate({values:closes,period:20}).pop(),
    ema50: EMA.calculate({values:closes,period:50}).pop(),
    atr: ATR.calculate({high:highs,low:lows,close:closes,period:14}).pop(),
    adx: ADX.calculate({high:highs,low:lows,close:closes,period:14}).pop(),
    macd: MACD.calculate({
      values: closes,
      fastPeriod:12,
      slowPeriod:26,
      signalPeriod:9
    }).pop()
  };
}

// ================= VOLUME =================
function volume(data){
  const last = data[data.length - 1];
  const avg = data.slice(-30).reduce((a,b)=>a+b.volume,0)/30;
  return last.volume / avg;
}

// ================= TREND =================
function trend(data){
  const last = data[data.length - 1];
  const prev = data[data.length - 2];

  if(last.close > prev.close) return 'bullish';
  if(last.close < prev.close) return 'bearish';
  return 'ranging';
}

// ================= BTC FILTER =================
async function btcTrend(){
  const btc = await getCandles('BTCUSDT','1h');
  if(!btc) return 'neutral';

  const last = btc[btc.length - 1];
  const ema = EMA.calculate({values:btc.map(c=>c.close),period:50}).pop();

  return last.close > ema ? 'bullish' : 'bearish';
}

// ================= ANALYSIS =================
async function analyze(symbol){
  const data15 = await getCandles(symbol,'15m');
  const data1h = await getCandles(symbol,'1h');

  if(!data15 || !data1h) return;

  const ind15 = getIndicators(data15);
  const ind1h = getIndicators(data1h);

  if(!ind15 || !ind1h) return;

  if(ind15.adx.adx < CONFIG.minADX) return;

  const vol = volume(data15);
  if(vol < CONFIG.volumeMin) return;

  const dir15 = trend(data15);
  const dir1h = trend(data1h);

  if(dir15 !== dir1h) return;

  const btcDir = await btcTrend();
  if(dir15 !== btcDir) return;

  let score = 0;

  if(ind15.rsi < 35 && dir15 === 'bullish') score += 20;
  if(ind15.rsi > 65 && dir15 === 'bearish') score += 20;

  if(ind15.macd && ind15.macd.MACD > ind15.macd.signal) score += 15;

  if(vol > 2) score += 20;

  if(score < CONFIG.minScore) return;

  const last = data15[data15.length - 1];
  const entry = last.close;
  const atr = ind15.atr;

  let stop, tp;

  if(dir15 === 'bullish'){
    stop = entry - atr * 2;
    tp = entry + (entry - stop) * 2;
  }else{
    stop = entry + atr * 2;
    tp = entry - (stop - entry) * 2;
  }

  const trade = {
    symbol,
    direction: dir15,
    entry,
    stop,
    tp,
    time: Date.now()
  };

  state.trades.push(trade);

  bot.sendMessage(CHAT_ID, `
🚀 V7 SIGNAL

${symbol} ${dir15}

Entrada: ${entry}
Stop: ${stop}
TP: ${tp}

Score: ${score}
Volume: ${vol.toFixed(2)}
`);
}

// ================= LOOP =================
async function run(){
  for(const pair of CONFIG.pairs){
    await analyze(pair);
  }
}

// ================= API =================
app.get('/stats',(req,res)=>{
  res.json({
    balance: state.balance,
    trades: state.trades.length,
    wins: state.wins,
    losses: state.losses
  });
});

app.get('/',(req,res)=>res.send('V7 ON'));

app.listen(PORT, ()=>{
  console.log('V7 rodando...');
  run();
  setInterval(run, 1000 * 60 * 5);
});
