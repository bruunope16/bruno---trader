   const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { RSI, MACD, EMA, ATR } = require('technicalindicators');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = '8604695024:AAEycHa9v4L2ZmOBxP20i9ZuBSmE1hNndxM';
const CHAT_ID = '1763009688';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

const CONFIG = {
  riskPerTrade: 0.02,
  leverage: 10,
  initialBalance: 1000,
  maxPositions: 3,
  
  scoreWeights: {
    choch: 20, bos: 20, fibonacci: 10, orderBlock: 15, fvg: 15,
    liquidity: 20, emaTrend: 20, macd: 10, rsi: 10, sr: 10,
    volumeSpike: 15, trendAlignment: 20
  },
  
  minScore: 70,
  highConfidence: 85,
  atrMultiplier: 1.5,
  volumeMultiplier: 1.2,
  
  pairs: [
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
    'ADAUSDT', 'AVAXUSDT', 'DOGEUSDT', 'DOTUSDT', 'MATICUSDT',
    'LINKUSDT', 'LTCUSDT', 'UNIUSDT', 'ATOMUSDT', 'XLMUSDT',
    'NEARUSDT', 'ALGOUSDT', 'VETUSDT', 'ICPUSDT', 'FILUSDT',
    'AAVEUSDT', 'MKRUSDT', 'COMPUSDT', 'SUSHIUSDT', 'CRVUSDT',
    'YFIUSDT', '1INCHUSDT', 'SNXUSDT', 'UMAUSDT', 'BALUSDT',
    'ARBUSDT', 'OPUSDT', 'APTUSDT', 'SUIUSDT', 'INJUSDT',
    'FTMUSDT', 'HBARUSDT', 'EGLDUSDT', 'FLOWUSDT', 'ZENUSDT',
    'SANDUSDT', 'MANAUSDT', 'AXSUSDT', 'GMTUSDT', 'APEUSDT',
    'GALAUSDT', 'ENJUSDT', 'CHRUSDT', 'IMXUSDT', 'BLURUSDT',
    'CAKEUSDT', 'BNXUSDT', 'MDTUSDT', 'SFPUSDT', 'TKOUSDT',
    'SHIBUSDT', 'PEPEUSDT', 'FLOKIUSDT', 'BONKUSDT', 'WIFUSDT',
    'FETUSDT', 'RENDERUSDT', 'OCEANUSDT', 'AGIXUSDT', 'GRTUSDT',
    'XMRUSDT', 'ZECUSDT', 'DASHUSDT', 'SCRTUSDT',
    'RUNEUSDT', 'KAVAUSDT', 'BANDUSDT', 'ANKRUSDT', 'STORJUSDT',
    'IOTAUSDT', 'ZILUSDT', 'ONTUSDT', 'QTUMUSDT', 'BATUSDT',
    'ETHBTC', 'BNBBTC', 'ADABTC', 'DOTBTC', 'LINKBTC',
    'ARKMUSDT', 'TIAUSDT', 'PYTHUSDT', 'JUPUSDT', 'DYMUSDT',
    'PORTALUSDT', 'PIXELUSDT', 'STRKUSDT', 'WUSDT', 'ACEUSDT'
  ]
};

let state = {
  balance: CONFIG.initialBalance,
  signals: [],
  trades: [],
  pendingTrades: [],
  stats: { totalTrades: 0, wins: 0, losses: 0, totalProfit: 0, winRate: 0 },
  analysisCount: 0,
  logs: [],
  lastAnalysis: null
};

function addLog(message, type = 'info') {
  const log = { timestamp: new Date().toISOString(), message, type };
  state.logs.unshift(log);
  if (state.logs.length > 500) state.logs.pop();
  console.log(`[${type.toUpperCase()}] ${message}`);
}

async function sendTelegram(message) {
  try {
    await bot.sendMessage(CHAT_ID, message);
    addLog('Telegram enviado', 'success');
  } catch (error) {
    addLog(`Erro Telegram: ${error.message}`, 'error');
  }
}

async function getCandlesticks(symbol, interval = '15m', limit = 200) {
  try {
    const url = `https://api.binance.us/api/v3/klines`;
    const response = await axios.get(url, {
      params: { symbol, interval, limit },
      timeout: 10000
    });
    
    if (!response.data || response.data.length === 0) throw new Error('Sem dados');
    
    return response.data.map(c => ({
      time: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]),
      low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5])
    }));
  } catch (error) {
    return null;
  }
}

function formatPrice(price) {
  if (price >= 1000) return price.toFixed(2);
  if (price >= 100) return price.toFixed(3);
  if (price >= 10) return price.toFixed(4);
  if (price >= 1) return price.toFixed(5);
  if (price >= 0.1) return price.toFixed(6);
  if (price >= 0.01) return price.toFixed(7);
  return price.toFixed(8);
}

function detectMarketStructure(candles) {
  const len = candles.length;
  const swings = [];
  
  for (let i = 5; i < len - 5; i++) {
    const current = candles[i];
    const before = candles.slice(i - 5, i);
    const after = candles.slice(i + 1, i + 6);
    
    if (before.every(c => c.high < current.high) && after.every(c => c.high < current.high)) {
      swings.push({ index: i, type: 'high', price: current.high });
    }
    
    if (before.every(c => c.low > current.low) && after.every(c => c.low > current.low)) {
      swings.push({ index: i, type: 'low', price: current.low });
    }
  }
  
  if (swings.length < 4) return null;
  
  const recent = swings.slice(-4);
  let trend = null, structure = null, choch = false, bos = false;
  
  const highs = recent.filter(s => s.type === 'high').map(s => s.price);
  const lows = recent.filter(s => s.type === 'low').map(s => s.price);
  
  if (highs.length >= 2 && lows.length >= 2) {
    if (highs[highs.length - 1] > highs[0] && lows[lows.length - 1] > lows[0]) {
      trend = 'bullish';
      structure = 'HH + HL';
    }
    else if (highs[highs.length - 1] < highs[0] && lows[lows.length - 1] < lows[0]) {
      trend = 'bearish';
      structure = 'LH + LL';
    }
  }
  
  if (recent.length >= 3) {
    const last3 = recent.slice(-3);
    if (last3[0].type === 'high' && last3[1].type === 'low' && last3[2].type === 'high') {
      if (last3[2].price < last3[0].price) { choch = true; trend = 'bearish'; }
    }
    if (last3[0].type === 'low' && last3[1].type === 'high' && last3[2].type === 'low') {
      if (last3[2].price > last3[0].price) { choch = true; trend = 'bullish'; }
    }
  }
  
  const currentPrice = candles[len - 1].close;
  if (trend === 'bullish' && highs.length >= 2 && currentPrice > Math.max(...highs)) bos = true;
  if (trend === 'bearish' && lows.length >= 2 && currentPrice < Math.min(...lows)) bos = true;
  
  return { trend, structure, choch, bos, swings: recent, lastHigh: Math.max(...highs), lastLow: Math.min(...lows) };
}

function calculateFibonacci(candles, marketStructure) {
  if (!marketStructure || !marketStructure.trend) return null;
  
  const { trend, lastHigh, lastLow } = marketStructure;
  const diff = lastHigh - lastLow;
  
  if (diff / lastLow < 0.01) return null;
  
  let fib = {};
  
  if (trend === 'bullish') {
    fib = {
      level_0: lastHigh, level_236: lastHigh - (diff * 0.236), level_382: lastHigh - (diff * 0.382),
      level_500: lastHigh - (diff * 0.500), level_618: lastHigh - (diff * 0.618), level_786: lastHigh - (diff * 0.786),
      ext_1272: lastHigh + (diff * 0.272), ext_1414: lastHigh + (diff * 0.414), ext_1618: lastHigh + (diff * 0.618)
    };
  } else {
    fib = {
      level_0: lastLow, level_236: lastLow + (diff * 0.236), level_382: lastLow + (diff * 0.382),
      level_500: lastLow + (diff * 0.500), level_618: lastLow + (diff * 0.618), level_786: lastLow + (diff * 0.786),
      ext_1272: lastLow - (diff * 0.272), ext_1414: lastLow - (diff * 0.414), ext_1618: lastLow - (diff * 0.618)
    };
  }
  
  return fib;
}

function detectOrderBlock(candles) {
  const last10 = candles.slice(-10);
  let orderBlocks = [];
  
  for (let i = 0; i < last10.length - 1; i++) {
    const current = last10[i];
    const next = last10[i + 1];
    const body = Math.abs(current.close - current.open);
    const avgBody = last10.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / 10;
    
    if (body > avgBody * 1.5 && current.close < current.open && next.close > next.open) {
      orderBlocks.push({ type: 'bullish', zone: [current.low, current.high], strength: body / avgBody });
    }
    
    if (body > avgBody * 1.5 && current.close > current.open && next.close < next.open) {
      orderBlocks.push({ type: 'bearish', zone: [current.low, current.high], strength: body / avgBody });
    }
  }
  
  return orderBlocks.length > 0 ? orderBlocks[orderBlocks.length - 1] : null;
}

function detectFVG(candles) {
  const last5 = candles.slice(-5);
  
  for (let i = 0; i < last5.length - 2; i++) {
    const first = last5[i];
    const third = last5[i + 2];
    
    if (third.low > first.high) return { type: 'bullish', gap: third.low - first.high, zone: [first.high, third.low] };
    if (third.high < first.low) return { type: 'bearish', gap: first.low - third.high, zone: [third.high, first.low] };
  }
  
  return null;
}

function detectLiquidity(candles, marketStructure) {
  if (!marketStructure) return null;
  
  const { swings } = marketStructure;
  const currentPrice = candles[candles.length - 1].close;
  
  const aboveLiquidity = swings.filter(s => s.type === 'high' && s.price > currentPrice).map(s => s.price);
  const belowLiquidity = swings.filter(s => s.type === 'low' && s.price < currentPrice).map(s => s.price);
  
  let captured = null;
  const recent10 = candles.slice(-10);
  const recentHigh = Math.max(...recent10.map(c => c.high));
  const recentLow = Math.min(...recent10.map(c => c.low));
  
  if (aboveLiquidity.some(liq => recentHigh >= liq)) captured = 'above';
  if (belowLiquidity.some(liq => recentLow <= liq)) captured = 'below';
  
  return { above: aboveLiquidity, below: belowLiquidity, captured };
}

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  
  const rsi = RSI.calculate({ values: closes, period: 14 });
  const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
  const ema20 = EMA.calculate({ period: 20, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const ema200 = EMA.calculate({ period: 200, values: closes });
  const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  
  return {
    rsi: rsi[rsi.length - 1], macd: macd[macd.length - 1],
    ema20: ema20[ema20.length - 1], ema50: ema50[ema50.length - 1],
    ema200: ema200[ema200.length - 1], atr: atr[atr.length - 1], price: closes[closes.length - 1]
  };
}

function analyzeVolume(candles) {
  const volumes = candles.map(c => c.volume);
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const currentVolume = volumes[volumes.length - 1];
  
  const volumeSpike = currentVolume > avgVolume * CONFIG.volumeMultiplier;
  const last3Vol = volumes.slice(-3);
  const volumeIncreasing = last3Vol[2] > last3Vol[1] && last3Vol[1] > last3Vol[0];
  
  return { current: currentVolume, average: avgVolume, ratio: currentVolume / avgVolume, spike: volumeSpike, increasing: volumeIncreasing };
}

function detectSR(candles) {
  const currentPrice = candles[candles.length - 1].close;
  const levels = [];
  const tolerance = currentPrice * 0.002;
  
  for (let i = 0; i < candles.length - 20; i++) {
    const testPrice = candles[i].high;
    const touches = candles.filter(c => Math.abs(c.high - testPrice) < tolerance || Math.abs(c.low - testPrice) < tolerance).length;
    
    if (touches >= 3) levels.push({ price: testPrice, touches, type: 'resistance' });
  }
  
  const unique = levels.filter((level, index, self) => index === self.findIndex(l => Math.abs(l.price - level.price) < tolerance));
  const nearest = unique.sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice))[0];
  
  return nearest || null;
}

async function analyzeSymbol(symbol) {
  try {
    const candles15m = await getCandlesticks(symbol, '15m', 200);
    const candles1h = await getCandlesticks(symbol, '1h', 200);
    const candles4h = await getCandlesticks(symbol, '4h', 100);
    
    if (!candles15m || !candles1h || !candles4h) return { valid: false, reason: 'Sem dados' };
    
    const structure15m = detectMarketStructure(candles15m);
    const structure1h = detectMarketStructure(candles1h);
    const structure4h = detectMarketStructure(candles4h);
    
    if (!structure15m || !structure15m.trend) return { valid: false, reason: 'Sem estrutura 15m' };
    
    const ind15m = calculateIndicators(candles15m);
    const ind1h = calculateIndicators(candles1h);
    const ind4h = calculateIndicators(candles4h);
    
    const volume = analyzeVolume(candles15m);
    const fib = calculateFibonacci(candles15m, structure15m);
    if (!fib) return { valid: false, reason: 'Fibonacci inválido' };
    
    const ob = detectOrderBlock(candles15m);
    const fvg = detectFVG(candles15m);
    const liq = detectLiquidity(candles15m, structure15m);
    const sr = detectSR(candles15m);
    
    const confluences = [];
    let score = 0;
    
    if (structure15m.choch) { confluences.push(`CHOCH ${structure15m.trend}`); score += CONFIG.scoreWeights.choch; }
    if (structure15m.bos) { confluences.push(`BOS ${structure15m.trend}`); score += CONFIG.scoreWeights.bos; }
    
    const price = ind15m.price;
    const fibDistance618 = Math.abs(price - fib.level_618) / price;
    const fibDistance786 = Math.abs(price - fib.level_786) / price;
    
    if (fibDistance618 < 0.003 || fibDistance786 < 0.003) {
      confluences.push('Fibonacci 0.618/0.786');
      score += CONFIG.scoreWeights.fibonacci;
    }
    
    if (ob && ob.type === structure15m.trend) { confluences.push(`Order Block ${ob.type}`); score += CONFIG.scoreWeights.orderBlock; }
    if (fvg && fvg.type === structure15m.trend) { confluences.push(`FVG ${fvg.type}`); score += CONFIG.scoreWeights.fvg; }
    if (liq && liq.captured) { confluences.push(`Liquidez ${liq.captured}`); score += CONFIG.scoreWeights.liquidity; }
    
    const emaTrend15m = ind15m.price > ind15m.ema20 && ind15m.ema20 > ind15m.ema50;
    const emaTrend1h = ind1h.price > ind1h.ema20 && ind1h.ema20 > ind1h.ema50;
    
    if (structure15m.trend === 'bullish' && emaTrend15m && emaTrend1h) {
      confluences.push('EMA Uptrend Multi-TF');
      score += CONFIG.scoreWeights.emaTrend;
    }
    if (structure15m.trend === 'bearish' && !emaTrend15m && !emaTrend1h) {
      confluences.push('EMA Downtrend Multi-TF');
      score += CONFIG.scoreWeights.emaTrend;
    }
    
    if (ind15m.macd && ind15m.macd.MACD > ind15m.macd.signal && structure15m.trend === 'bullish') {
      confluences.push('MACD Bullish');
      score += CONFIG.scoreWeights.macd;
    }
    if (ind15m.macd && ind15m.macd.MACD < ind15m.macd.signal && structure15m.trend === 'bearish') {
      confluences.push('MACD Bearish');
      score += CONFIG.scoreWeights.macd;
    }
    
    if (ind15m.rsi < 40 && structure15m.trend === 'bullish') { confluences.push('RSI Oversold'); score += CONFIG.scoreWeights.rsi; }
    if (ind15m.rsi > 60 && structure15m.trend === 'bearish') { confluences.push('RSI Overbought'); score += CONFIG.scoreWeights.rsi; }
    
    if (sr) { confluences.push('S/R'); score += CONFIG.scoreWeights.sr; }
    
    if (volume.spike && volume.increasing) { confluences.push('Volume Spike'); score += CONFIG.scoreWeights.volumeSpike; }
    
    const trendAlignment = (structure15m.trend === structure1h.trend && structure1h.trend === structure4h.trend);
    
    if (trendAlignment) {
      confluences.push(`Tendência ${structure15m.trend} alinhada 15m/1h/4h`);
      score += CONFIG.scoreWeights.trendAlignment;
    } else {
      return { valid: false, reason: `Tendências desalinhadas (15m:${structure15m.trend} 1h:${structure1h.trend})` };
    }
    
    if (score < CONFIG.minScore) return { valid: false, reason: `Score baixo: ${score}/${CONFIG.minScore}` };
    
    const recentSignals = state.signals.slice(0, 20);
    const recentSame = recentSignals.find(s => s.symbol === symbol);
    if (recentSame) {
      const timeSince = Date.now() - new Date(recentSame.timestamp).getTime();
      const hoursSince = timeSince / (1000 * 60 * 60);
      
      if (hoursSince < 6) return { valid: false, reason: `Sinal recente (${hoursSince.toFixed(1)}h)` };
    }
    
    const direction = structure15m.trend === 'bullish' ? 'LONG' : 'SHORT';
    const entry = price;
    
    const atrValue = ind15m.atr;
    const atrStop = atrValue * CONFIG.atrMultiplier;
    
    let stop, tp1, tp2, tp3;
    
    if (direction === 'LONG') {
      stop = entry - atrStop;
      tp1 = fib.ext_1272;
      tp2 = fib.ext_1414;
      tp3 = fib.ext_1618;
    } else {
      stop = entry + atrStop;
      tp1 = fib.ext_1272;
      tp2 = fib.ext_1414;
      tp3 = fib.ext_1618;
    }
    
    const rr = Math.abs(tp3 - entry) / Math.abs(entry - stop);
    
    if (Math.abs(entry - stop) / entry < 0.005) return { valid: false, reason: 'Stop muito próximo' };
    if (rr < 1.5) return { valid: false, reason: `R:R baixo: ${rr.toFixed(2)}` };
    if (direction === 'LONG' && tp3 <= entry) return { valid: false, reason: 'TP3 inválido LONG' };
    if (direction === 'SHORT' && tp3 >= entry) return { valid: false, reason: 'TP3 inválido SHORT' };
    
    const confidenceLevel = score >= CONFIG.highConfidence ? 'ALTA' : 'MEDIA';
    
    return {
      valid: true, symbol, direction,
      entry: formatPrice(entry), stopLoss: formatPrice(stop),
      tp1: formatPrice(tp1), tp2: formatPrice(tp2), tp3: formatPrice(tp3),
      rr: rr.toFixed(2), confluences: confluences.join(' + '),
      confidenceLevel, score, structure: structure15m.structure,
      choch: structure15m.choch, bos: structure15m.bos,
      volumeRatio: volume.ratio.toFixed(2), atr: formatPrice(atrValue),
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    return { valid: false, reason: error.message };
  }
}

async function analyzeMarket() {
  try {
    state.analysisCount++;
    addLog(`=== Analise #${state.analysisCount} (${CONFIG.pairs.length} pares) ===`, 'info');
    
    const results = [];
    
    for (const symbol of CONFIG.pairs) {
      const result = await analyzeSymbol(symbol);
      
      if (result.valid) {
        results.push(result);
        addLog(`${symbol}: SETUP! Score ${result.score}`, 'success');
      } else {
        addLog(`${symbol}: ${result.reason}`, 'warning');
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    results.sort((a, b) => b.score - a.score);
    const topSignals = results.slice(0, 1);
    
    if (topSignals.length > 0) {
      const signal = topSignals[0];
      state.signals.unshift(signal);
      state.signals = state.signals.slice(0, 20);
      
      const message = `🎯 SINAL PROFISSIONAL V4.0

Par: ${signal.symbol}
Direcao: ${signal.direction}

Entrada: $${signal.entry}
Stop Loss: $${signal.stopLoss} (ATR ${signal.atr})
TP1: $${signal.tp1}
TP2: $${signal.tp2}
TP3: $${signal.tp3}

R:R: 1:${signal.rr}
Score: ${signal.score}/100
Confianca: ${signal.confidenceLevel}

Volume: ${signal.volumeRatio}x média

Confluencias:
${signal.confluences}

${signal.choch ? '✅ CHOCH confirmado!' : ''}
${signal.bos ? '✅ BOS confirmado!' : ''}

Timeframe: 15m (confirmado 1h + 4h)
Estilo: Scalp Profissional

${new Date().toLocaleTimeString('pt-BR')}`;
      
      await sendTelegram(message);
      state.pendingTrades.push(signal);
      
      addLog(`SINAL: ${signal.symbol} ${signal.direction} (${signal.score}/100)`, 'success');
    } else {
      addLog('Nenhum setup de alta qualidade encontrado', 'info');
    }
    
    state.lastAnalysis = new Date();
    
  } catch (error) {
    addLog(`Erro: ${error.message}`, 'error');
  }
}

async function checkTradeResults() {
  if (state.pendingTrades.length === 0) return;
  
  for (let i = state.pendingTrades.length - 1; i >= 0; i--) {
    const trade = state.pendingTrades[i];
    const timeSince = Date.now() - new Date(trade.timestamp).getTime();
    const hoursSince = timeSince / (1000 * 60 * 60);
    
    if (hoursSince < 2) continue;
    
    const candles = await getCandlesticks(trade.symbol, '15m', 1);
    if (!candles) continue;
    
    const currentPrice = candles[0].close;
    const entry = parseFloat(trade.entry);
    const stop = parseFloat(trade.stopLoss);
    const tp1 = parseFloat(trade.tp1);
    const tp2 = parseFloat(trade.tp2);
    const tp3 = parseFloat(trade.tp3);
    
    let result = null;
    
    if (trade.direction === 'LONG') {
      if (currentPrice >= tp3) result = { outcome: 'WIN', exit: tp3, level: 'TP3', profit: ((tp3 - entry) / entry) * 100 };
      else if (currentPrice >= tp2) result = { outcome: 'WIN', exit: tp2, level: 'TP2', profit: ((tp2 - entry) / entry) * 100 };
      else if (currentPrice >= tp1) result = { outcome: 'WIN', exit: tp1, level: 'TP1', profit: ((tp1 - entry) / entry) * 100 };
      else if (currentPrice <= stop) result = { outcome: 'LOSS', exit: stop, level: 'STOP', profit: ((stop - entry) / entry) * 100 };
    } else {
      if (currentPrice <= tp3) result = { outcome: 'WIN', exit: tp3, level: 'TP3', profit: ((entry - tp3) / entry) * 100 };
      else if (currentPrice <= tp2) result = { outcome: 'WIN', exit: tp2, level: 'TP2', profit: ((entry - tp2) / entry) * 100 };
      else if (currentPrice <= tp1) result = { outcome: 'WIN', exit: tp1, level: 'TP1', profit: ((entry - tp1) / entry) * 100 };
      else if (currentPrice >= stop) result = { outcome: 'LOSS', exit: stop, level: 'STOP', profit: ((entry - stop) / entry) * 100 };
    }
    
    if (result && (result.outcome === 'WIN' || result.outcome === 'LOSS')) {
      const completed = { ...trade, ...result, closedAt: new Date().toISOString(), duration: hoursSince.toFixed(1) + 'h' };
      
      state.stats.totalTrades++;
      if (result.outcome === 'WIN') {
        state.stats.wins++;
        const profitValue = (state.balance * CONFIG.riskPerTrade) * (result.profit / 100) * CONFIG.leverage;
        state.stats.totalProfit += profitValue;
        state.balance += profitValue;
      } else {
        state.stats.losses++;
        const lossValue = state.balance * CONFIG.riskPerTrade;
        state.stats.totalProfit -= lossValue;
        state.balance -= lossValue;
      }
      
      state.stats.winRate = ((state.stats.wins / state.stats.totalTrades) * 100).toFixed(1);
      state.trades.unshift(completed);
      state.pendingTrades.splice(i, 1);
      
      const emoji = result.outcome === 'WIN' ? '🟢' : '🔴';
      const msg = `${emoji} ${result.outcome}!

Par: ${trade.symbol} ${trade.direction}
Entrada: $${trade.entry}
Saida: ${result.level} $${formatPrice(result.exit)}
Profit: ${result.profit > 0 ? '+' : ''}${result.profit.toFixed(2)}%

Score: ${trade.score}/100
Duracao: ${completed.duration}

Banca: R$ ${state.balance.toFixed(2)}
Win Rate: ${state.stats.winRate}%

${new Date().toLocaleTimeString('pt-BR')}`;
      
      await sendTelegram(msg);
      addLog(`${emoji} ${trade.symbol}: ${result.outcome}`, result.outcome === 'WIN' ? 'success' : 'error');
    }
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online', version: '4.0.0 - Professional', uptime: process.uptime(),
    analysisCount: state.analysisCount, signalsCount: state.signals.length,
    pendingTrades: state.pendingTrades.length, lastAnalysis: state.lastAnalysis,
    stats: state.stats,
    config: {
      style: 'Scalp Profissional Multi-TF', timeframes: '15m + 1h + 4h',
      minScore: CONFIG.minScore, pairs: CONFIG.pairs.length,
      atrStop: 'ATR × ' + CONFIG.atrMultiplier
    }
  });
});

app.get('/api/signals', (req, res) => {
  res.json({ signals: state.signals.slice(0, 10), total: state.signals.length });
});

app.get('/api/logs', (req, res) => {
  res.json({ logs: state.logs.slice(0, 100), count: state.logs.length });
});

app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, async () => {
  addLog('========================================', 'success');
  addLog('BRUNO TRADER PROFESSIONAL V4.0', 'success');
  addLog('========================================', 'success');
  addLog(`Pares: ${CONFIG.pairs.length}`, 'info');
  addLog(`Timeframes: 15m + 1h + 4h`, 'info');
  addLog(`Score minimo: ${CONFIG.minScore}/100`, 'info');
  addLog(`Stop: ATR × ${CONFIG.atrMultiplier}`, 'info');
  
  await sendTelegram(`🚀 BRUNO TRADER PRO V4.0

SISTEMA PROFISSIONAL ATIVADO!

✅ 100 pares monitorados
✅ Multi-timeframe (15m/1h/4h)
✅ Score ponderado (min 70/100)
✅ ATR stops dinâmicos
✅ Filtro de volume
✅ Fibonacci profissional
✅ SMC completo

Confluencias obrigatorias:
- Tendencia alinhada 3 TFs
- Volume > ${CONFIG.volumeMultiplier}x média
- Score >= ${CONFIG.minScore}/100
- R:R >= 1.5

Sistema institucional!

${new Date().toLocaleString('pt-BR')}`);
  
  setTimeout(() => { addLog('Primeira analise...', 'info'); analyzeMarket(); }, 10000);
  
  setInterval(analyzeMarket, 900000);
  setInterval(checkTradeResults, 1800000);
});

process.on('unhandledRejection', (error) => { addLog(`Erro: ${error.message}`, 'error'); });
