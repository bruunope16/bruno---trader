const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { RSI, MACD, EMA } = require('technicalindicators');
const path = require('path');

// ========== CONFIGURAÇÕES ==========
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = '8604695024:AAEycHa9v4L2ZmOBxP20i9ZuBSmE1hNndxM';
const CHAT_ID = '1763009688';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// ========== CONFIGURAÇÃO SCALP PROFISSIONAL ==========
const CONFIG = {
  riskPerTrade: 0.02,
  leverage: 10,
  initialBalance: 1000,
  maxPositions: 3,
  
  // Fibonacci Levels
  fib: {
    stopBelow: 0.786,
    tp1: 1.272,
    tp2: 1.414,
    tp3: 1.618
  },
  
  // Confluências mínimas
  minConfluences: 4,  // Mínimo 4 confluências
  
  // Pares
  pairs: [
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT',
    'XRPUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT', 'MATICUSDT'
  ]
};

let state = {
  balance: CONFIG.initialBalance,
  signals: [],
  trades: [],
  pendingTrades: [],
  stats: {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    totalProfit: 0,
    winRate: 0
  },
  analysisCount: 0,
  logs: [],
  lastAnalysis: null
};

// ========== LOGS ==========
function addLog(message, type = 'info') {
  const log = { timestamp: new Date().toISOString(), message, type };
  state.logs.unshift(log);
  if (state.logs.length > 500) state.logs.pop();
  console.log(`[${type.toUpperCase()}] ${message}`);
}

// ========== TELEGRAM ==========
async function sendTelegram(message) {
  try {
    await bot.sendMessage(CHAT_ID, message);
    addLog('Telegram enviado', 'success');
  } catch (error) {
    addLog(`Erro Telegram: ${error.message}`, 'error');
  }
}

// ========== BINANCE API ==========
async function getCandlesticks(symbol, interval = '15m', limit = 200) {
  try {
    const url = `https://api.binance.us/api/v3/klines`;
    const response = await axios.get(url, {
      params: { symbol, interval, limit },
      timeout: 10000
    });
    
    if (!response.data || response.data.length === 0) {
      throw new Error('Sem dados');
    }
    
    return response.data.map(c => ({
      time: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5])
    }));
  } catch (error) {
    addLog(`${symbol}: Erro API - ${error.message}`, 'warning');
    return null;
  }
}

// ========== ESTRUTURA DE MERCADO ==========
function detectMarketStructure(candles) {
  const len = candles.length;
  const swings = [];
  
  // Detecta swing highs e lows
  for (let i = 5; i < len - 5; i++) {
    const current = candles[i];
    const before = candles.slice(i - 5, i);
    const after = candles.slice(i + 1, i + 6);
    
    // Swing High
    if (before.every(c => c.high < current.high) && after.every(c => c.high < current.high)) {
      swings.push({ index: i, type: 'high', price: current.high });
    }
    
    // Swing Low
    if (before.every(c => c.low > current.low) && after.every(c => c.low > current.low)) {
      swings.push({ index: i, type: 'low', price: current.low });
    }
  }
  
  if (swings.length < 4) return null;
  
  // Últimos 4 swings
  const recent = swings.slice(-4);
  
  // Detecta padrão
  let trend = null;
  let structure = null;
  let choch = false;
  let bos = false;
  
  const highs = recent.filter(s => s.type === 'high').map(s => s.price);
  const lows = recent.filter(s => s.type === 'low').map(s => s.price);
  
  // UPTREND: HH e HL
  if (highs.length >= 2 && lows.length >= 2) {
    if (highs[highs.length - 1] > highs[0] && lows[lows.length - 1] > lows[0]) {
      trend = 'bullish';
      structure = 'HH + HL';
    }
    // DOWNTREND: LH e LL
    else if (highs[highs.length - 1] < highs[0] && lows[lows.length - 1] < lows[0]) {
      trend = 'bearish';
      structure = 'LH + LL';
    }
  }
  
  // CHOCH: Mudança de caráter
  if (recent.length >= 3) {
    const last3 = recent.slice(-3);
    if (last3[0].type === 'high' && last3[1].type === 'low' && last3[2].type === 'high') {
      if (last3[2].price < last3[0].price) {
        choch = true;
        trend = 'bearish';
      }
    }
    if (last3[0].type === 'low' && last3[1].type === 'high' && last3[2].type === 'low') {
      if (last3[2].price > last3[0].price) {
        choch = true;
        trend = 'bullish';
      }
    }
  }
  
  // BOS: Break of Structure
  const currentPrice = candles[len - 1].close;
  if (trend === 'bullish' && highs.length >= 2 && currentPrice > Math.max(...highs)) {
    bos = true;
  }
  if (trend === 'bearish' && lows.length >= 2 && currentPrice < Math.min(...lows)) {
    bos = true;
  }
  
  return {
    trend,
    structure,
    choch,
    bos,
    swings: recent,
    lastHigh: Math.max(...highs),
    lastLow: Math.min(...lows)
  };
}

// ========== FIBONACCI ==========
function calculateFibonacci(candles, marketStructure) {
  if (!marketStructure || !marketStructure.trend) return null;
  
  const { trend, lastHigh, lastLow } = marketStructure;
  const diff = lastHigh - lastLow;
  
  let fib = {};
  
  if (trend === 'bullish') {
    // Retração de um movimento de alta
    fib = {
      level_0: lastHigh,
      level_236: lastHigh - (diff * 0.236),
      level_382: lastHigh - (diff * 0.382),
      level_500: lastHigh - (diff * 0.500),
      level_618: lastHigh - (diff * 0.618),
      level_786: lastHigh - (diff * 0.786),
      // Extensões
      ext_1272: lastHigh + (diff * 0.272),
      ext_1414: lastHigh + (diff * 0.414),
      ext_1618: lastHigh + (diff * 0.618)
    };
  } else {
    // Retração de um movimento de baixa
    fib = {
      level_0: lastLow,
      level_236: lastLow + (diff * 0.236),
      level_382: lastLow + (diff * 0.382),
      level_500: lastLow + (diff * 0.500),
      level_618: lastLow + (diff * 0.618),
      level_786: lastLow + (diff * 0.786),
      // Extensões
      ext_1272: lastLow - (diff * 0.272),
      ext_1414: lastLow - (diff * 0.414),
      ext_1618: lastLow - (diff * 0.618)
    };
  }
  
  return fib;
}

// ========== ORDER BLOCK ==========
function detectOrderBlock(candles) {
  const last10 = candles.slice(-10);
  let orderBlocks = [];
  
  for (let i = 0; i < last10.length - 1; i++) {
    const current = last10[i];
    const next = last10[i + 1];
    const body = Math.abs(current.close - current.open);
    const avgBody = last10.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / 10;
    
    // Bullish OB: vela bearish forte seguida de movimento bullish
    if (body > avgBody * 1.5 && current.close < current.open && next.close > next.open) {
      orderBlocks.push({
        type: 'bullish',
        zone: [current.low, current.high],
        strength: body / avgBody
      });
    }
    
    // Bearish OB: vela bullish forte seguida de movimento bearish  
    if (body > avgBody * 1.5 && current.close > current.open && next.close < next.open) {
      orderBlocks.push({
        type: 'bearish',
        zone: [current.low, current.high],
        strength: body / avgBody
      });
    }
  }
  
  return orderBlocks.length > 0 ? orderBlocks[orderBlocks.length - 1] : null;
}

// ========== FAIR VALUE GAP ==========
function detectFVG(candles) {
  const last5 = candles.slice(-5);
  
  for (let i = 0; i < last5.length - 2; i++) {
    const first = last5[i];
    const middle = last5[i + 1];
    const third = last5[i + 2];
    
    // Bullish FVG
    if (third.low > first.high) {
      return {
        type: 'bullish',
        gap: third.low - first.high,
        zone: [first.high, third.low]
      };
    }
    
    // Bearish FVG
    if (third.high < first.low) {
      return {
        type: 'bearish',
        gap: first.low - third.high,
        zone: [third.high, first.low]
      };
    }
  }
  
  return null;
}

// ========== LIQUIDITY ==========
function detectLiquidity(candles, marketStructure) {
  if (!marketStructure) return null;
  
  const { swings } = marketStructure;
  const currentPrice = candles[candles.length - 1].close;
  
  // Liquidez acima de swing highs
  const aboveLiquidity = swings
    .filter(s => s.type === 'high' && s.price > currentPrice)
    .map(s => s.price);
  
  // Liquidez abaixo de swing lows
  const belowLiquidity = swings
    .filter(s => s.type === 'low' && s.price < currentPrice)
    .map(s => s.price);
  
  let captured = null;
  
  // Verifica se capturou liquidez recentemente
  const recent10 = candles.slice(-10);
  const recentHigh = Math.max(...recent10.map(c => c.high));
  const recentLow = Math.min(...recent10.map(c => c.low));
  
  if (aboveLiquidity.some(liq => recentHigh >= liq)) {
    captured = 'above';
  }
  if (belowLiquidity.some(liq => recentLow <= liq)) {
    captured = 'below';
  }
  
  return { above: aboveLiquidity, below: belowLiquidity, captured };
}

// ========== INDICADORES TÉCNICOS ==========
function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);
  
  const rsi = RSI.calculate({ values: closes, period: 14 });
  const macd = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9
  });
  const ema20 = EMA.calculate({ period: 20, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const ema200 = EMA.calculate({ period: 200, values: closes });
  
  return {
    rsi: rsi[rsi.length - 1],
    macd: macd[macd.length - 1],
    ema20: ema20[ema20.length - 1],
    ema50: ema50[ema50.length - 1],
    ema200: ema200[ema200.length - 1],
    price: closes[closes.length - 1]
  };
}

// ========== SUPPORT & RESISTANCE ==========
function detectSR(candles) {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const currentPrice = candles[candles.length - 1].close;
  
  // Encontra níveis que foram testados múltiplas vezes
  const levels = [];
  const tolerance = currentPrice * 0.002; // 0.2% tolerance
  
  for (let i = 0; i < candles.length - 20; i++) {
    const testPrice = candles[i].high;
    const touches = candles.filter(c => 
      Math.abs(c.high - testPrice) < tolerance || 
      Math.abs(c.low - testPrice) < tolerance
    ).length;
    
    if (touches >= 3) {
      levels.push({ price: testPrice, touches, type: 'resistance' });
    }
  }
  
  // Remove duplicados
  const unique = levels.filter((level, index, self) =>
    index === self.findIndex(l => Math.abs(l.price - level.price) < tolerance)
  );
  
  // Encontra o mais próximo
  const nearest = unique.sort((a, b) => 
    Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice)
  )[0];
  
  return nearest || null;
}

// ========== ANÁLISE COMPLETA ==========
async function analyzeSymbol(symbol) {
  try {
    const candles = await getCandlesticks(symbol, '15m', 200);
    if (!candles) return { valid: false, reason: 'Sem dados' };
    
    // Estrutura de mercado
    const structure = detectMarketStructure(candles);
    if (!structure || !structure.trend) {
      return { valid: false, reason: 'Sem estrutura clara' };
    }
    
    // Fibonacci
    const fib = calculateFibonacci(candles, structure);
    if (!fib) return { valid: false, reason: 'Fibonacci inválido' };
    
    // Indicadores
    const ind = calculateIndicators(candles);
    
    // Order Block
    const ob = detectOrderBlock(candles);
    
    // Fair Value Gap
    const fvg = detectFVG(candles);
    
    // Liquidity
    const liq = detectLiquidity(candles, structure);
    
    // Support/Resistance
    const sr = detectSR(candles);
    
    // SISTEMA DE CONFLUÊNCIAS
    const confluences = [];
    let confidence = 0;
    
    // 1. Estrutura (peso 2)
    if (structure.choch) {
      confluences.push(`CHOCH ${structure.trend}`);
      confidence += 2;
    }
    if (structure.bos) {
      confluences.push(`BOS ${structure.trend}`);
      confidence += 2;
    }
    if (structure.structure) {
      confluences.push(structure.structure);
      confidence += 1;
    }
    
    // 2. Fibonacci (peso 2)
    const price = ind.price;
    const fibDistance618 = Math.abs(price - fib.level_618) / price;
    const fibDistance786 = Math.abs(price - fib.level_786) / price;
    
    if (fibDistance618 < 0.003 || fibDistance786 < 0.003) {
      confluences.push('Fibonacci 0.618/0.786');
      confidence += 2;
    }
    
    // 3. Order Block (peso 2)
    if (ob && ob.type === structure.trend) {
      confluences.push(`Order Block ${ob.type}`);
      confidence += 2;
    }
    
    // 4. Fair Value Gap (peso 1)
    if (fvg && fvg.type === structure.trend) {
      confluences.push(`FVG ${fvg.type}`);
      confidence += 1;
    }
    
    // 5. Liquidity (peso 2)
    if (liq && liq.captured) {
      confluences.push(`Liquidez capturada (${liq.captured})`);
      confidence += 2;
    }
    
    // 6. EMA Trend (peso 1)
    if (structure.trend === 'bullish' && ind.price > ind.ema20 && ind.ema20 > ind.ema50) {
      confluences.push('EMA Uptrend');
      confidence += 1;
    }
    if (structure.trend === 'bearish' && ind.price < ind.ema20 && ind.ema20 < ind.ema50) {
      confluences.push('EMA Downtrend');
      confidence += 1;
    }
    
    // 7. MACD (peso 1)
    if (ind.macd && ind.macd.MACD > ind.macd.signal && structure.trend === 'bullish') {
      confluences.push('MACD Bullish');
      confidence += 1;
    }
    if (ind.macd && ind.macd.MACD < ind.macd.signal && structure.trend === 'bearish') {
      confluences.push('MACD Bearish');
      confidence += 1;
    }
    
    // 8. RSI (peso 1)
    if (ind.rsi < 40 && structure.trend === 'bullish') {
      confluences.push('RSI Oversold');
      confidence += 1;
    }
    if (ind.rsi > 60 && structure.trend === 'bearish') {
      confluences.push('RSI Overbought');
      confidence += 1;
    }
    
    // 9. Support/Resistance (peso 1)
    if (sr) {
      confluences.push(`S/R em ${sr.price.toFixed(2)}`);
      confidence += 1;
    }
    
    // FILTRO: Mínimo 4 confluências
    if (confluences.length < CONFIG.minConfluences) {
      return { valid: false, reason: `Poucas confluências: ${confluences.length}/4` };
    }
    
    // ANTI-DUPLICAÇÃO
    const recentSignals = state.signals.slice(0, 20);
    const recentSame = recentSignals.find(s => s.symbol === symbol);
    if (recentSame) {
      const timeSince = Date.now() - new Date(recentSame.timestamp).getTime();
      const hoursSince = timeSince / (1000 * 60 * 60);
      
      if (hoursSince < 6) {
        return { valid: false, reason: `Sinal recente (${hoursSince.toFixed(1)}h)` };
      }
    }
    
    // DEFINIR ENTRADA E TARGETS COM FIBONACCI
    const direction = structure.trend === 'bullish' ? 'LONG' : 'SHORT';
    const entry = price;
    
    let stop, tp1, tp2, tp3;
    
    if (direction === 'LONG') {
      stop = fib.level_786 * 0.998; // Abaixo do 0.786
      tp1 = fib.ext_1272;
      tp2 = fib.ext_1414;
      tp3 = fib.ext_1618;
    } else {
      stop = fib.level_786 * 1.002; // Acima do 0.786
      tp1 = fib.ext_1272;
      tp2 = fib.ext_1414;
      tp3 = fib.ext_1618;
    }
    
    const rr = Math.abs(tp3 - entry) / Math.abs(entry - stop);
    
    // Nível de confiança
    let confidenceLevel;
    if (confidence >= 8) confidenceLevel = 'ALTA';
    else if (confidence >= 6) confidenceLevel = 'MEDIA';
    else confidenceLevel = 'BAIXA';
    
    // Só envia se confiança ALTA ou MEDIA
    if (confidenceLevel === 'BAIXA') {
      return { valid: false, reason: 'Confiança baixa' };
    }
    
    return {
      valid: true,
      symbol,
      direction,
      entry: entry.toFixed(2),
      stopLoss: stop.toFixed(2),
      tp1: tp1.toFixed(2),
      tp2: tp2.toFixed(2),
      tp3: tp3.toFixed(2),
      rr: rr.toFixed(2),
      confluences: confluences.join(' + '),
      confidenceLevel,
      confidenceScore: confidence,
      structure: structure.structure,
      choch: structure.choch,
      bos: structure.bos,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    addLog(`Erro ${symbol}: ${error.message}`, 'error');
    return { valid: false, reason: error.message };
  }
}

// ========== ANÁLISE DO MERCADO ==========
async function analyzeMarket() {
  try {
    state.analysisCount++;
    addLog(`=== Analise Scalp #${state.analysisCount} ===`, 'info');
    
    const results = [];
    
    for (const symbol of CONFIG.pairs) {
      addLog(`${symbol}...`, 'info');
      const result = await analyzeSymbol(symbol);
      
      if (result.valid) {
        results.push(result);
        addLog(`${symbol}: SETUP! Confianca ${result.confidenceLevel}`, 'success');
      } else {
        addLog(`${symbol}: ${result.reason}`, 'warning');
      }
      
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    
    results.sort((a, b) => b.confidenceScore - a.confidenceScore);
    
    const topSignals = results.slice(0, 1); // Apenas o melhor
    
    if (topSignals.length > 0) {
      const signal = topSignals[0];
      state.signals.unshift(signal);
      state.signals = state.signals.slice(0, 20);
      
      const message = `🎯 SINAL SCALP PROFISSIONAL

Par: ${signal.symbol}
Direcao: ${signal.direction}

Entrada: $${signal.entry}
Stop Loss: $${signal.stopLoss}
TP1: $${signal.tp1}
TP2: $${signal.tp2}
TP3: $${signal.tp3}

R:R: 1:${signal.rr}
Confianca: ${signal.confidenceLevel}

Confluencias:
${signal.confluences}

${signal.choch ? 'CHOCH detectado!' : ''}
${signal.bos ? 'BOS confirmado!' : ''}

Timeframe: 15min
Estilo: Scalp Estruturado

${new Date().toLocaleTimeString('pt-BR')}`;
      
      await sendTelegram(message);
      state.pendingTrades.push(signal);
      
      addLog(`SINAL ENVIADO: ${signal.symbol} ${signal.direction} (${signal.confidenceLevel})`, 'success');
    } else {
      addLog('Nenhum setup encontrado', 'info');
    }
    
    state.lastAnalysis = new Date();
    
  } catch (error) {
    addLog(`Erro: ${error.message}`, 'error');
  }
}

// ========== TRACKING ==========
async function checkTradeResults() {
  if (state.pendingTrades.length === 0) return;
  
  for (let i = state.pendingTrades.length - 1; i >= 0; i--) {
    const trade = state.pendingTrades[i];
    const timeSince = Date.now() - new Date(trade.timestamp).getTime();
    const hoursSince = timeSince / (1000 * 60 * 60);
    
    if (hoursSince < 2) continue; // Aguarda pelo menos 2h
    
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
Saida: ${result.level} $${result.exit.toFixed(2)}
Profit: ${result.profit > 0 ? '+' : ''}${result.profit.toFixed(2)}%

Duracao: ${completed.duration}
Confianca: ${trade.confidenceLevel}

Banca: R$ ${state.balance.toFixed(2)}
Win Rate: ${state.stats.winRate}%

${new Date().toLocaleTimeString('pt-BR')}`;
      
      await sendTelegram(msg);
      addLog(`${emoji} ${trade.symbol}: ${result.outcome}`, result.outcome === 'WIN' ? 'success' : 'error');
    }
  }
}

// ========== SERVIDOR EXPRESS ==========
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    version: '3.0.0 - Scalp Pro',
    uptime: process.uptime(),
    analysisCount: state.analysisCount,
    signalsCount: state.signals.length,
    pendingTrades: state.pendingTrades.length,
    lastAnalysis: state.lastAnalysis,
    stats: state.stats,
    config: {
      style: 'Scalp Estruturado',
      timeframe: '15min',
      confluences: CONFIG.minConfluences,
      pairs: CONFIG.pairs.length
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

// ========== INICIALIZAÇÃO ==========
app.listen(PORT, async () => {
  addLog('========================================', 'success');
  addLog('BRUNO TRADER SCALP PRO V3.0', 'success');
  addLog('========================================', 'success');
  addLog(`Timeframe: 15min`, 'info');
  addLog(`Estilo: Scalp Estruturado`, 'info');
  addLog(`Confluencias minimas: ${CONFIG.minConfluences}`, 'info');
  addLog(`Pares: ${CONFIG.pairs.length}`, 'info');
  
  await sendTelegram(`🚀 BRUNO TRADER SCALP PRO V3.0

Estilo: Scalp Estruturado
Timeframe: 15 minutos

Confluencias:
- Estrutura (CHOCH/BOS)
- Fibonacci 0.618/0.786
- Order Block
- Fair Value Gap
- Liquidez
- Support/Resistance
- EMA Trend
- MACD + RSI

Minimo 4 confluencias por sinal
Fibonacci Stops (abaixo 0.786)
TP1: 1.272 | TP2: 1.414 | TP3: 1.618

Sistema SMC Completo Ativado!

${new Date().toLocaleString('pt-BR')}`);
  
  setTimeout(() => {
    addLog('Primeira analise...', 'info');
    analyzeMarket();
  }, 10000);
  
  setInterval(analyzeMarket, 900000); // 15min
  setInterval(checkTradeResults, 1800000); // 30min
});

process.on('unhandledRejection', (error) => {
  addLog(`Erro: ${error.message}`, 'error');
});
