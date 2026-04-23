const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { RSI, MACD, EMA, ATR, ADX } = require('technicalindicators');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = '8604695024:AAEycHa9v4L2ZmOBxP20i9ZuBSmE1hNndxM';
const CHAT_ID = '1763009688';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// ============================================
// CONFIGURAÇÃO V5.0 - PROFISSIONAL COMPLETO
// ============================================

const CONFIG = {
  // Gestão de Risco Dinâmica
  riskPerTrade: 0.02,        // Base: 2%
  riskMin: 0.005,            // Mínimo: 0.5% (emergency)
  riskMax: 0.03,             // Máximo: 3% (boost)
  leverage: 10,
  initialBalance: 100,
  maxPositions: 3,
  maxExposure: 0.06,         // Máximo 6% exposição total
  
  // Score e Filtros
  minScore: 65,              // Reduzido de 70 para pegar mais sinais
  highConfidence: 85,
  atrMultiplier: 3.0,        // Stop mais largo (era 1.5)
  volumeMultiplier: 1.5,     // Volume mínimo (melhorado)
  minADX: 20,                // ADX mínimo para operar
  
  // Trailing Stop
  trailing: {
    enabled: true,
    breakeven: true,         // Move para breakeven em TP1
    trailingATR: 1.5,       // Trailing em TP2
    closeOnTP3: true        // Fecha tudo em TP3
  },
  
  // TP Parcial
  tpPartial: {
    enabled: true,
    tp1Percent: 50,          // 50% em TP1
    tp2Percent: 30,          // 30% em TP2
    tp3Percent: 20           // 20% em TP3
  },
  
  // Grupos de Correlação
  correlationGroups: {
    highcap: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'],
    layer1: ['SOLUSDT', 'AVAXUSDT', 'NEARUSDT', 'DOTUSDT'],
    defi: ['AAVEUSDT', 'UNIUSDT', 'COMPUSDT', 'SUSHIUSDT', 'CRVUSDT'],
    gaming: ['SANDUSDT', 'MANAUSDT', 'ENJUSDT', 'CHRUSDT', 'GALAUSDT', 'GMTUSDT', 'APEUSDT'],
    meme: ['SHIBUSDT', 'PEPEUSDT', 'DOGEUSDT'],
    others: ['ADAUSDT', 'XRPUSDT', 'MATICUSDT', 'LINKUSDT', 'LTCUSDT', 'ATOMUSDT', 
             'XLMUSDT', 'ALGOUSDT', 'VETUSDT', 'ICPUSDT', 'FILUSDT', 'CAKEUSDT', 
             'BNXUSDT', 'IOTAUSDT']
  },
  
  // Pares (37 verificados)
  pairs: [
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
    'ADAUSDT', 'AVAXUSDT', 'DOGEUSDT', 'DOTUSDT', 'MATICUSDT',
    'LINKUSDT', 'LTCUSDT', 'UNIUSDT', 'ATOMUSDT', 'XLMUSDT',
    'ALGOUSDT', 'VETUSDT', 'ICPUSDT', 'FILUSDT', 'NEARUSDT',
    'AAVEUSDT', 'COMPUSDT', 'SUSHIUSDT', 'CRVUSDT',
    'SANDUSDT', 'MANAUSDT', 'ENJUSDT', 'CHRUSDT', 'GALAUSDT',
    'GMTUSDT', 'APEUSDT', 'SHIBUSDT', 'PEPEUSDT',
    'CAKEUSDT', 'BNXUSDT', 'IOTAUSDT'
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
    winRate: 0,
    consecutiveWins: 0,
    consecutiveLosses: 0,
    maxDrawdown: 0
  },
  analysisCount: 0,
  logs: [],
  lastAnalysis: null,
  riskMode: 'normal' // normal | recovery | boost | emergency
};

// ============================================
// FUNÇÕES AUXILIARES
// ============================================

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

function formatPrice(price) {
  const p = parseFloat(price);
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(6);
  return p.toFixed(8);
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
      time: c[0], 
      open: parseFloat(c[1]), 
      high: parseFloat(c[2]),
      low: parseFloat(c[3]), 
      close: parseFloat(c[4]), 
      volume: parseFloat(c[5])
    }));
  } catch (error) {
    return null;
  }
}

// ============================================
// GESTÃO DE RISCO DINÂMICA
// ============================================

function calculateDynamicRisk() {
  const { consecutiveWins, consecutiveLosses } = state.stats;
  const drawdown = (CONFIG.initialBalance - state.balance) / CONFIG.initialBalance;
  
  // Emergency Mode: Drawdown > 10%
  if (drawdown > 0.10) {
    state.riskMode = 'emergency';
    addLog('⚠️ EMERGENCY MODE: Drawdown > 10%', 'warning');
    return CONFIG.riskMin; // 0.5%
  }
  
  // Recovery Mode: 2+ losses seguidas
  if (consecutiveLosses >= 2) {
    state.riskMode = 'recovery';
    addLog('📉 Recovery Mode: 2+ losses', 'warning');
    return CONFIG.riskPerTrade * 0.5; // 1%
  }
  
  // Boost Mode: 3+ wins seguidas
  if (consecutiveWins >= 3) {
    state.riskMode = 'boost';
    addLog('📈 Boost Mode: 3+ wins', 'success');
    return CONFIG.riskMax; // 3%
  }
  
  // Normal Mode
  state.riskMode = 'normal';
  return CONFIG.riskPerTrade; // 2%
}

function canTakeNewTrade() {
  const activeTrades = state.pendingTrades.length;
  const totalExposure = activeTrades * calculateDynamicRisk();
  
  if (activeTrades >= CONFIG.maxPositions) {
    addLog(`Máximo de ${CONFIG.maxPositions} posições ativas`, 'warning');
    return false;
  }
  
  if (totalExposure >= CONFIG.maxExposure) {
    addLog(`Exposição máxima (${CONFIG.maxExposure * 100}%) atingida`, 'warning');
    return false;
  }
  
  return true;
}

// ============================================
// FILTRO DE CORRELAÇÃO
// ============================================

function findCorrelationGroup(symbol) {
  for (const [groupName, pairs] of Object.entries(CONFIG.correlationGroups)) {
    if (pairs.includes(symbol)) return groupName;
  }
  return null;
}

function hasActiveTradeInGroup(symbol, direction) {
  const group = findCorrelationGroup(symbol);
  if (!group) return false;
  
  return state.pendingTrades.some(trade => {
    const tradeGroup = findCorrelationGroup(trade.symbol);
    return tradeGroup === group && trade.direction === direction;
  });
}

// ============================================
// SESSION FILTERS (Horários Premium)
// ============================================

function getSessionScore() {
  const hour = new Date().getUTCHours();
  
  // Premium sessions (Alta volatilidade)
  if ((hour >= 9 && hour < 12) ||   // Europa
      (hour >= 13 && hour < 16) ||  // NY
      (hour >= 20 && hour < 22)) {  // Asia
    return 10;
  }
  
  // Dead zone (Baixo volume)
  if (hour >= 0 && hour < 6) {
    return -20;
  }
  
  return 0; // Horário normal
}

// ============================================
// ANÁLISE TÉCNICA COM DADOS REAIS
// ============================================

function calculateIndicators(data) {
  const closes = data.map(c => c.close);
  const highs = data.map(c => c.high);
  const lows = data.map(c => c.low);
  
  const rsi = RSI.calculate({ values: closes, period: 14 });
  const macd = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
  
  const ema20 = EMA.calculate({ values: closes, period: 20 });
  const ema50 = EMA.calculate({ values: closes, period: 50 });
  const ema200 = EMA.calculate({ values: closes, period: 200 });
  
  const atr = ATR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14
  });
  
  const adx = ADX.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14
  });
  
  return {
    rsi: rsi[rsi.length - 1],
    macd: macd[macd.length - 1],
    ema20: ema20[ema20.length - 1],
    ema50: ema50[ema50.length - 1],
    ema200: ema200[ema200.length - 1],
    atr: atr[atr.length - 1],
    adx: adx[adx.length - 1]
  };
}

// ============================================
// SMART MONEY CONCEPTS - DADOS REAIS
// ============================================

function findSwingPoints(candles, lookback = 5) {
  const highs = [];
  const lows = [];
  
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isSwingHigh = true;
    let isSwingLow = true;
    
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) {
        isSwingHigh = false;
      }
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) {
        isSwingLow = false;
      }
    }
    
    if (isSwingHigh) highs.push({ index: i, price: candles[i].high });
    if (isSwingLow) lows.push({ index: i, price: candles[i].low });
  }
  
  return { highs, lows };
}

function detectCHOCH(candles) {
  const swings = findSwingPoints(candles);
  const currentPrice = candles[0].close;
  
  // Bullish CHOCH: Rompe último swing high
  if (swings.highs.length > 0) {
    const lastHigh = swings.highs[0];
    if (currentPrice > lastHigh.price) {
      return { detected: true, type: 'bullish', level: lastHigh.price };
    }
  }
  
  // Bearish CHOCH: Rompe último swing low
  if (swings.lows.length > 0) {
    const lastLow = swings.lows[0];
    if (currentPrice < lastLow.price) {
      return { detected: true, type: 'bearish', level: lastLow.price };
    }
  }
  
  return { detected: false };
}

function detectBOS(candles) {
  const swings = findSwingPoints(candles);
  const currentPrice = candles[0].close;
  
  // Bullish BOS: Rompe high anterior
  if (swings.highs.length >= 2) {
    const prevHigh = swings.highs[1];
    if (currentPrice > prevHigh.price) {
      return { detected: true, type: 'bullish', level: prevHigh.price };
    }
  }
  
  // Bearish BOS: Rompe low anterior
  if (swings.lows.length >= 2) {
    const prevLow = swings.lows[1];
    if (currentPrice < prevLow.price) {
      return { detected: true, type: 'bearish', level: prevLow.price };
    }
  }
  
  return { detected: false };
}

function detectFVG(candles) {
  // Fair Value Gap: Gap entre 3 velas consecutivas
  const gaps = [];
  
  for (let i = 0; i < candles.length - 3; i++) {
    const candle1 = candles[i];
    const candle2 = candles[i + 1];
    const candle3 = candles[i + 2];
    
    // Bullish FVG
    const bullishGap = candle3.low - candle1.high;
    if (bullishGap > 0 && bullishGap / candle2.close > 0.005) {
      gaps.push({ 
        type: 'bullish', 
        top: candle3.low, 
        bottom: candle1.high,
        size: bullishGap 
      });
    }
    
    // Bearish FVG
    const bearishGap = candle1.low - candle3.high;
    if (bearishGap > 0 && bearishGap / candle2.close > 0.005) {
      gaps.push({ 
        type: 'bearish', 
        top: candle1.low, 
        bottom: candle3.high,
        size: bearishGap 
      });
    }
  }
  
  return gaps.length > 0 ? gaps[0] : null;
}

function detectOrderBlock(candles) {
  // Order Block: Última vela antes de movimento forte
  for (let i = 1; i < Math.min(20, candles.length - 1); i++) {
    const moveSize = Math.abs(candles[i - 1].close - candles[0].close);
    const avgBody = (candles[0].close - candles[0].open);
    
    if (moveSize / candles[0].close > 0.02) { // Movimento > 2%
      return {
        detected: true,
        type: candles[i - 1].close > candles[i].close ? 'bullish' : 'bearish',
        high: candles[i].high,
        low: candles[i].low
      };
    }
  }
  
  return { detected: false };
}

// ============================================
// ANÁLISE DE ESTRUTURA
// ============================================

function analyzeMarketStructure(data) {
  const swings = findSwingPoints(data);
  
  // Bullish Structure: Higher Highs + Higher Lows
  let bullishStructure = true;
  for (let i = 0; i < Math.min(3, swings.highs.length - 1); i++) {
    if (swings.highs[i].price <= swings.highs[i + 1].price) {
      bullishStructure = false;
      break;
    }
  }
  
  // Bearish Structure: Lower Highs + Lower Lows
  let bearishStructure = true;
  for (let i = 0; i < Math.min(3, swings.lows.length - 1); i++) {
    if (swings.lows[i].price >= swings.lows[i + 1].price) {
      bearishStructure = false;
      break;
    }
  }
  
  let trend = 'ranging';
  if (bullishStructure && !bearishStructure) trend = 'bullish';
  if (bearishStructure && !bullishStructure) trend = 'bearish';
  
  const choch = detectCHOCH(data);
  const bos = detectBOS(data);
  
  return {
    trend,
    structure: bullishStructure ? 'HH/HL' : bearishStructure ? 'LH/LL' : 'Ranging',
    choch: choch.detected,
    chochType: choch.type,
    bos: bos.detected,
    bosType: bos.type
  };
}

// ============================================
// ANÁLISE DE VOLUME MELHORADA
// ============================================

function analyzeVolume(data) {
  const volumes = data.slice(0, 96).map(c => c.volume); // 24h
  const avgVolume = volumes.reduce((a, b) => a + b) / volumes.length;
  const currentVolume = data[0].volume;
  const ratio = currentVolume / avgVolume;
  
  // Volume Spike
  const spike = ratio > 2.0;
  
  // Volume Crescente (3 velas)
  const increasing = data[0].volume > data[1].volume && data[1].volume > data[2].volume;
  
  return {
    ratio,
    spike,
    increasing,
    avgVolume,
    currentVolume
  };
}

// ============================================
// ANÁLISE COMPLETA DE SÍMBOLO
// ============================================

async function analyzeSymbol(symbol) {
  try {
    const data15m = await getCandlesticks(symbol, '15m', 200);
    const data1h = await getCandlesticks(symbol, '1h', 200);
    const data4h = await getCandlesticks(symbol, '4h', 200);
    
    if (!data15m || !data1h || !data4h) {
      return { valid: false, reason: 'Sem dados' };
    }
    
    const price = data15m[0].close;
    
    // Indicadores
    const ind15m = calculateIndicators(data15m);
    const ind1h = calculateIndicators(data1h);
    const ind4h = calculateIndicators(data4h);
    
    // FILTRO ADX - CRÍTICO
    if (ind15m.adx < CONFIG.minADX) {
      return { 
        valid: false, 
        reason: `Mercado lateral (ADX: ${ind15m.adx.toFixed(1)})` 
      };
    }
    
    // Estrutura de mercado
    const structure15m = analyzeMarketStructure(data15m);
    const structure1h = analyzeMarketStructure(data1h);
    const structure4h = analyzeMarketStructure(data4h);
    
    // Volume
    const volume = analyzeVolume(data15m);
    
    // FILTRO VOLUME - CRÍTICO
    if (volume.ratio < CONFIG.volumeMultiplier) {
      return { 
        valid: false, 
        reason: `Volume baixo (${volume.ratio.toFixed(2)}x)` 
      };
    }
    
    // SMC Detections
    const fvg = detectFVG(data15m);
    const orderBlock = detectOrderBlock(data15m);
    
    // ============================================
    // SCORE CALCULATION
    // ============================================
    
    let score = 0;
    const confluences = [];
    
    // CHOCH (20 pontos)
    if (structure15m.choch) {
      if (structure15m.chochType === 'bullish') {
        score += 20;
        confluences.push('CHOCH bullish');
      } else {
        score += 20;
        confluences.push('CHOCH bearish');
      }
    }
    
    // BOS (20 pontos)
    if (structure15m.bos) {
      if (structure15m.bosType === 'bullish') {
        score += 20;
        confluences.push('BOS bullish');
      } else {
        score += 20;
        confluences.push('BOS bearish');
      }
    }
    
    // FVG (15 pontos)
    if (fvg) {
      score += 15;
      confluences.push(`FVG ${fvg.type}`);
    }
    
    // Order Block (15 pontos)
    if (orderBlock.detected) {
      score += 15;
      confluences.push(`Order Block ${orderBlock.type}`);
    }
    
    // EMA Trend Multi-TF (20 pontos)
    const emaTrend15m = price > ind15m.ema20 && ind15m.ema20 > ind15m.ema50;
    const emaTrend1h = data1h[0].close > ind1h.ema20;
    
    if ((structure15m.trend === 'bullish' && emaTrend15m && emaTrend1h) ||
        (structure15m.trend === 'bearish' && !emaTrend15m && !emaTrend1h)) {
      score += 20;
      confluences.push('EMA Trend Multi-TF');
    }
    
    // MACD (10 pontos)
    if (ind15m.macd && ind15m.macd.MACD > ind15m.macd.signal && structure15m.trend === 'bullish') {
      score += 10;
      confluences.push('MACD Bullish');
    } else if (ind15m.macd && ind15m.macd.MACD < ind15m.macd.signal && structure15m.trend === 'bearish') {
      score += 10;
      confluences.push('MACD Bearish');
    }
    
    // RSI (10 pontos)
    if (ind15m.rsi < 40 && structure15m.trend === 'bullish') {
      score += 10;
      confluences.push('RSI Oversold');
    } else if (ind15m.rsi > 60 && structure15m.trend === 'bearish') {
      score += 10;
      confluences.push('RSI Overbought');
    }
    
    // Volume Spike (15 pontos)
    if (volume.spike && volume.increasing) {
      score += 15;
      confluences.push('Volume Spike Forte');
    } else if (volume.ratio > CONFIG.volumeMultiplier) {
      score += 10;
      confluences.push('Volume Alto');
    }
    
    // ADX Strength Bonus (10 pontos)
    if (ind15m.adx > 30) {
      score += 10;
      confluences.push(`ADX Forte (${ind15m.adx.toFixed(0)})`);
    }
    
    // Session Score
    const sessionScore = getSessionScore();
    score += sessionScore;
    if (sessionScore > 0) {
      confluences.push('Horário Premium');
    }
    
    // Trend Alignment Bonus (20 pontos)
    const trendAlignment = (structure15m.trend === structure1h.trend && structure1h.trend === structure4h.trend);
    if (trendAlignment) {
      score += 20;
      confluences.push(`Tendência ${structure15m.trend} alinhada 15m/1h/4h`);
    }
    
    // ============================================
    // FILTROS FINAIS
    // ============================================
    
    if (score < CONFIG.minScore) {
      return { valid: false, reason: `Score baixo: ${score}/${CONFIG.minScore}` };
    }
    
    if (confluences.length < 3) {
      return { valid: false, reason: `Poucas confluências: ${confluences.length}` };
    }
    
    // Verifica correlação
    const direction = structure15m.trend === 'bullish' ? 'LONG' : structure15m.trend === 'bearish' ? 'SHORT' : null;
    if (!direction) {
      return { valid: false, reason: 'Sem direção clara' };
    }
    
    if (hasActiveTradeInGroup(symbol, direction)) {
      return { valid: false, reason: 'Grupo já tem trade ativo' };
    }
    
    // Verifica sinais recentes
    const recentSignals = state.signals.slice(0, 20);
    const recentSame = recentSignals.find(s => s.symbol === symbol);
    if (recentSame) {
      const timeSince = Date.now() - new Date(recentSame.timestamp).getTime();
      const hoursSince = timeSince / (1000 * 60 * 60);
      if (hoursSince < 6) {
        return { valid: false, reason: `Sinal recente (${hoursSince.toFixed(1)}h)` };
      }
    }
    
    // ============================================
    // CALCULA ENTRADA E SAÍDAS
    // ============================================
    
    const entry = price;
    const atrValue = ind15m.atr;
    const atrStop = atrValue * CONFIG.atrMultiplier;
    
    let stop, tp1, tp2, tp3;
    
    if (direction === 'LONG') {
      stop = entry - atrStop;
      
      // Fibonacci Extensions
      const fibBase = entry - stop;
      tp1 = entry + (fibBase * 1.272);
      tp2 = entry + (fibBase * 1.618);
      tp3 = entry + (fibBase * 2.0);
    } else {
      stop = entry + atrStop;
      
      const fibBase = stop - entry;
      tp1 = entry - (fibBase * 1.272);
      tp2 = entry - (fibBase * 1.618);
      tp3 = entry - (fibBase * 2.0);
    }
    
    const rr = Math.abs(tp3 - entry) / Math.abs(entry - stop);
    
    if (Math.abs(entry - stop) / entry < 0.003) {
      return { valid: false, reason: 'Stop muito próximo' };
    }
    
    if (rr < 1.5) {
      return { valid: false, reason: `R:R baixo: ${rr.toFixed(2)}` };
    }
    
    if (direction === 'LONG' && tp3 <= entry) {
      return { valid: false, reason: 'TP3 inválido LONG' };
    }
    
    if (direction === 'SHORT' && tp3 >= entry) {
      return { valid: false, reason: 'TP3 inválido SHORT' };
    }
    
    const confidenceLevel = score >= CONFIG.highConfidence ? 'ALTA' : score >= CONFIG.minScore + 10 ? 'MEDIA' : 'BAIXA';
    
    return {
      valid: true,
      symbol,
      direction,
      entry: formatPrice(entry),
      stopLoss: formatPrice(stop),
      tp1: formatPrice(tp1),
      tp2: formatPrice(tp2),
      tp3: formatPrice(tp3),
      rr: rr.toFixed(2),
      confluences: confluences.join(' + '),
      confidenceLevel,
      score,
      structure: structure15m.structure,
      choch: structure15m.choch,
      bos: structure15m.bos,
      volumeRatio: volume.ratio.toFixed(2),
      atr: formatPrice(atrValue),
      adx: ind15m.adx.toFixed(1),
      timestamp: new Date().toISOString(),
      reachedTP1: false,
      reachedTP2: false,
      trailingActive: false
    };
    
  } catch (error) {
    return { valid: false, reason: error.message };
  }
}

// ============================================
// TRAILING STOP + BREAKEVEN
// ============================================

async function checkTradeResults() {
  if (state.pendingTrades.length === 0) return;
  
  for (let i = state.pendingTrades.length - 1; i >= 0; i--) {
    const trade = state.pendingTrades[i];
    const timeSince = Date.now() - new Date(trade.timestamp).getTime();
    const hoursSince = timeSince / (1000 * 60 * 60);
    
    if (hoursSince < 0.5) continue; // Aguarda 30min mínimo
    
    const candles = await getCandlesticks(trade.symbol, '15m', 1);
    if (!candles) continue;
    
    const currentPrice = candles[0].close;
    const entry = parseFloat(trade.entry);
    let stop = parseFloat(trade.stopLoss);
    const tp1 = parseFloat(trade.tp1);
    const tp2 = parseFloat(trade.tp2);
    const tp3 = parseFloat(trade.tp3);
    const atr = parseFloat(trade.atr);
    
    // ============================================
    // TRAILING STOP LOGIC
    // ============================================
    
    if (trade.direction === 'LONG') {
      // TP1 batido: Move stop para breakeven
      if (currentPrice >= tp1 && !trade.reachedTP1 && CONFIG.trailing.breakeven) {
        trade.stopLoss = formatPrice(entry);
        trade.reachedTP1 = true;
        addLog(`${trade.symbol}: TP1 atingido! Stop → Breakeven`, 'success');
        await sendTelegram(`🟢 ${trade.symbol} LONG\n\nTP1 atingido!\nStop movido para breakeven: $${formatPrice(entry)}`);
      }
      
      // TP2 batido: Ativa trailing stop
      if (currentPrice >= tp2 && trade.reachedTP1 && !trade.trailingActive) {
        trade.trailingActive = true;
        addLog(`${trade.symbol}: TP2 atingido! Trailing stop ativo`, 'success');
      }
      
      // Trailing stop ativo
      if (trade.trailingActive) {
        const trailingStop = currentPrice - (atr * CONFIG.trailing.trailingATR);
        if (trailingStop > parseFloat(trade.stopLoss)) {
          trade.stopLoss = formatPrice(trailingStop);
          addLog(`${trade.symbol}: Trailing stop → $${formatPrice(trailingStop)}`, 'info');
        }
        stop = parseFloat(trade.stopLoss);
      }
      
      // TP3 batido: Fecha tudo
      if (currentPrice >= tp3 && CONFIG.trailing.closeOnTP3) {
        closeTradeWithResult(trade, i, {
          outcome: 'WIN',
          exit: tp3,
          level: 'TP3',
          profit: ((tp3 - entry) / entry) * 100,
          duration: hoursSince.toFixed(1) + 'h'
        });
        continue;
      }
      
      // Checa stop e TPs
      if (currentPrice <= stop) {
        closeTradeWithResult(trade, i, {
          outcome: 'LOSS',
          exit: stop,
          level: 'STOP',
          profit: ((stop - entry) / entry) * 100,
          duration: hoursSince.toFixed(1) + 'h'
        });
      } else if (currentPrice >= tp2 && !trade.trailingActive) {
        closeTradeWithResult(trade, i, {
          outcome: 'WIN',
          exit: tp2,
          level: 'TP2',
          profit: ((tp2 - entry) / entry) * 100,
          duration: hoursSince.toFixed(1) + 'h'
        });
      } else if (currentPrice >= tp1 && !trade.reachedTP1) {
        closeTradeWithResult(trade, i, {
          outcome: 'WIN',
          exit: tp1,
          level: 'TP1',
          profit: ((tp1 - entry) / entry) * 100,
          duration: hoursSince.toFixed(1) + 'h'
        });
      }
      
    } else { // SHORT
      if (currentPrice <= tp1 && !trade.reachedTP1 && CONFIG.trailing.breakeven) {
        trade.stopLoss = formatPrice(entry);
        trade.reachedTP1 = true;
        addLog(`${trade.symbol}: TP1 atingido! Stop → Breakeven`, 'success');
        await sendTelegram(`🟢 ${trade.symbol} SHORT\n\nTP1 atingido!\nStop movido para breakeven: $${formatPrice(entry)}`);
      }
      
      if (currentPrice <= tp2 && trade.reachedTP1 && !trade.trailingActive) {
        trade.trailingActive = true;
        addLog(`${trade.symbol}: TP2 atingido! Trailing stop ativo`, 'success');
      }
      
      if (trade.trailingActive) {
        const trailingStop = currentPrice + (atr * CONFIG.trailing.trailingATR);
        if (trailingStop < parseFloat(trade.stopLoss)) {
          trade.stopLoss = formatPrice(trailingStop);
          addLog(`${trade.symbol}: Trailing stop → $${formatPrice(trailingStop)}`, 'info');
        }
        stop = parseFloat(trade.stopLoss);
      }
      
      if (currentPrice <= tp3 && CONFIG.trailing.closeOnTP3) {
        closeTradeWithResult(trade, i, {
          outcome: 'WIN',
          exit: tp3,
          level: 'TP3',
          profit: ((entry - tp3) / entry) * 100,
          duration: hoursSince.toFixed(1) + 'h'
        });
        continue;
      }
      
      if (currentPrice >= stop) {
        closeTradeWithResult(trade, i, {
          outcome: 'LOSS',
          exit: stop,
          level: 'STOP',
          profit: ((entry - stop) / entry) * 100,
          duration: hoursSince.toFixed(1) + 'h'
        });
      } else if (currentPrice <= tp2 && !trade.trailingActive) {
        closeTradeWithResult(trade, i, {
          outcome: 'WIN',
          exit: tp2,
          level: 'TP2',
          profit: ((entry - tp2) / entry) * 100,
          duration: hoursSince.toFixed(1) + 'h'
        });
      } else if (currentPrice <= tp1 && !trade.reachedTP1) {
        closeTradeWithResult(trade, i, {
          outcome: 'WIN',
          exit: tp1,
          level: 'TP1',
          profit: ((entry - tp1) / entry) * 100,
          duration: hoursSince.toFixed(1) + 'h'
        });
      }
    }
  }
}

async function closeTradeWithResult(trade, index, result) {
  const completed = { ...trade, ...result, closedAt: new Date().toISOString() };
  
  state.stats.totalTrades++;
  
  if (result.outcome === 'WIN') {
    state.stats.wins++;
    state.stats.consecutiveWins++;
    state.stats.consecutiveLosses = 0;
    
    const profitValue = (state.balance * calculateDynamicRisk()) * (result.profit / 100) * CONFIG.leverage;
    state.stats.totalProfit += profitValue;
    state.balance += profitValue;
  } else {
    state.stats.losses++;
    state.stats.consecutiveLosses++;
    state.stats.consecutiveWins = 0;
    
    const lossValue = state.balance * calculateDynamicRisk();
    state.stats.totalProfit -= lossValue;
    state.balance -= lossValue;
  }
  
  // Atualiza drawdown
  const currentDrawdown = (CONFIG.initialBalance - state.balance) / CONFIG.initialBalance;
  if (currentDrawdown > state.stats.maxDrawdown) {
    state.stats.maxDrawdown = currentDrawdown;
  }
  
  state.stats.winRate = ((state.stats.wins / state.stats.totalTrades) * 100).toFixed(1);
  state.trades.unshift(completed);
  state.pendingTrades.splice(index, 1);
  
  const emoji = result.outcome === 'WIN' ? '🟢' : '🔴';
  const outcomeText = result.outcome === 'WIN' ? 'GREEN ✅' : 'RED ❌';
  const profitSign = result.profit > 0 ? '+' : '';
  
  const msg = `${emoji} RESULTADO ${outcomeText}

━━━━━━━━━━━━━━━━━━

📊 Trade: ${trade.symbol} ${trade.direction}
💰 Entrada: $${trade.entry}
🎯 Saída: ${result.level} $${formatPrice(result.exit)}

━━━━━━━━━━━━━━━━━━

💵 Resultado:
${result.outcome === 'WIN' ? '✅' : '❌'} Profit: ${profitSign}${result.profit.toFixed(2)}%
⏱ Duração: ${result.duration}
📊 Score: ${trade.score}/100

━━━━━━━━━━━━━━━━━━

📈 Estatísticas Atualizadas:

💰 Banca: R$ ${state.balance.toFixed(2)}
📊 Total Trades: ${state.stats.totalTrades}
✅ Wins: ${state.stats.wins}
❌ Losses: ${state.stats.losses}
📈 Win Rate: ${state.stats.winRate}%
📉 Drawdown Máx: ${(state.stats.maxDrawdown * 100).toFixed(1)}%

🎯 Modo: ${state.riskMode.toUpperCase()}
💵 Risco Atual: ${(calculateDynamicRisk() * 100).toFixed(1)}%

━━━━━━━━━━━━━━━━━━

📅 ${new Date().toLocaleDateString('pt-BR')}
🕐 ${new Date().toLocaleTimeString('pt-BR')}

━━━━━━━━━━━━━━━━━━

🤖 Bruno Trader Pro V5.0`;
  
  await sendTelegram(msg);
  addLog(`${emoji} ${trade.symbol}: ${result.outcome} (${profitSign}${result.profit.toFixed(2)}%)`, result.outcome === 'WIN' ? 'success' : 'error');
}

// ============================================
// ANÁLISE DE MERCADO
// ============================================

async function analyzeMarket() {
  try {
    state.analysisCount++;
    state.lastAnalysis = new Date().toISOString();
    addLog(`=== Análise #${state.analysisCount} (${CONFIG.pairs.length} pares) | Modo: ${state.riskMode.toUpperCase()} ===`, 'info');
    
    // Verifica se pode abrir novos trades
    if (!canTakeNewTrade()) {
      addLog('Não pode abrir novos trades agora', 'warning');
      return;
    }
    
    const results = [];
    
    for (const symbol of CONFIG.pairs) {
      const result = await analyzeSymbol(symbol);
      
      if (result.valid) {
        results.push(result);
        addLog(`${symbol}: SETUP! Score ${result.score}/100 ADX ${result.adx}`, 'success');
      } else {
        addLog(`${symbol}: ${result.reason}`, 'info');
      }
    }
    
    // Ordena por score
    results.sort((a, b) => b.score - a.score);
    
    const topSignals = results.slice(0, 3);
    
    if (topSignals.length > 0) {
      const signal = topSignals[0];
      state.signals.unshift(signal);
      state.signals = state.signals.slice(0, 20);
      
      // Calcula zona de entrada
      const entryPrice = parseFloat(signal.entry);
      const zoneMin = formatPrice(entryPrice * 0.997);
      const zoneMax = formatPrice(entryPrice * 1.003);
      
      // Calcula percentuais
      const stopPrice = parseFloat(signal.stopLoss);
      const tp1Price = parseFloat(signal.tp1);
      const tp2Price = parseFloat(signal.tp2);
      const tp3Price = parseFloat(signal.tp3);
      
      const riskPercent = (((stopPrice - entryPrice) / entryPrice) * 100).toFixed(2);
      const tp1Percent = (((tp1Price - entryPrice) / entryPrice) * 100).toFixed(1);
      const tp2Percent = (((tp2Price - entryPrice) / entryPrice) * 100).toFixed(1);
      const tp3Percent = (((tp3Price - entryPrice) / entryPrice) * 100).toFixed(1);
      
      // Barra de força
      const scorePercent = Math.round((signal.score / 100) * 10);
      const greenBars = '🟩'.repeat(scorePercent);
      const grayBars = '⬜'.repeat(10 - scorePercent);
      
      const trendText = signal.direction === 'LONG' ? 'Alta' : 'Baixa';
      const volumeText = signal.volumeRatio >= 2 ? 'Forte' : signal.volumeRatio >= 1.5 ? 'Médio' : 'Fraco';
      const forceText = signal.score >= 85 ? 'Forte' : signal.score >= 70 ? 'Média' : 'Fraca';
      
      const message = `🚨 FUTURES SIGNAL V5.0 | ${signal.symbol}

📈 Direção: ${signal.direction}
⚡ Alavancagem: ${CONFIG.leverage}x
🎯 Score: ${signal.score}/100
📊 ADX: ${signal.adx} (Tendência ${signal.adx > 30 ? 'Forte' : 'Média'})

━━━━━━━━━━━━━━━━━━

📡 Exchange: Binance Futures
⏱ Timeframe: 15m
📊 Tipo: Scalping Profissional V5.0
⏳ Duração Estimada: 2h — 6h

━━━━━━━━━━━━━━━━━━

💰 Entrada: ${signal.entry}
📍 Zona: ${zoneMin} — ${zoneMax}

🛑 Stop Loss: ${signal.stopLoss}
⚠️ Risco: ${riskPercent}%
📏 ATR: ${signal.atr}

━━━━━━━━━━━━━━━━━━

🎯 Take Profits

🥇 TP1: ${signal.tp1} (${tp1Percent > 0 ? '+' : ''}${tp1Percent}%)
🥈 TP2: ${signal.tp2} (${tp2Percent > 0 ? '+' : ''}${tp2Percent}%)
🥉 TP3: ${signal.tp3} (${tp3Percent > 0 ? '+' : ''}${tp3Percent}%)

━━━━━━━━━━━━━━━━━━

📊 Risk / Reward
📉 Risco: ${Math.abs(parseFloat(riskPercent))}%
📈 Retorno Máx: ${Math.abs(parseFloat(tp3Percent))}%
⚖️ RR: 1:${signal.rr}

━━━━━━━━━━━━━━━━━━

✨ Proteções V5.0

✅ Breakeven em TP1
✅ Trailing Stop em TP2
✅ Fechamento automático TP3
⚡ ADX Filter Ativo
🎯 Correlação Filtrada
💰 Risco Dinâmico: ${(calculateDynamicRisk() * 100).toFixed(1)}%
🔥 Modo: ${state.riskMode.toUpperCase()}

━━━━━━━━━━━━━━━━━━

📊 Dados do Trade

📊 Tendência: ${trendText}
📈 Volume: ${volumeText} (${signal.volumeRatio}x)
⚡ Força: ${forceText}
🔥 Estrutura: ${signal.structure}

━━━━━━━━━━━━━━━━━━

📊 Força do Sinal
${greenBars}${grayBars} ${signal.score}%

━━━━━━━━━━━━━━━━━━

✅ Confluências Detectadas:
${signal.confluences}

━━━━━━━━━━━━━━━━━━

📅 Data: ${new Date().toLocaleDateString('pt-BR')}
🕐 Horário: ${new Date().toLocaleTimeString('pt-BR')} (UTC-3)

━━━━━━━━━━━━━━━━━━

🤖 Bruno Trader Pro V5.0
🚀 Sistema Profissional Completo
📊 Dados Reais + Trailing Stop
⚡ ADX Filter + Risco Dinâmico
📡 Binance Futures`;
      
      await sendTelegram(message);
      state.pendingTrades.push(signal);
      
      addLog(`SINAL: ${signal.symbol} ${signal.direction} (${signal.score}/100) ADX: ${signal.adx}`, 'success');
    } else {
      addLog('Nenhum setup de alta qualidade encontrado', 'info');
    }
    
  } catch (error) {
    addLog(`Erro na análise: ${error.message}`, 'error');
  }
}

// ============================================
// API REST
// ============================================

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    version: '5.0.0 - Professional Complete',
    uptime: process.uptime(),
    analysisCount: state.analysisCount,
    signalsCount: state.signals.length,
    pendingTrades: state.pendingTrades.length,
    lastAnalysis: state.lastAnalysis,
    stats: state.stats,
    riskMode: state.riskMode,
    currentRisk: calculateDynamicRisk(),
    config: {
      style: 'Scalp Profissional V5.0',
      features: [
        'Trailing Stop Inteligente',
        'Breakeven Automático',
        'ADX Filter',
        'Volume Real',
        'Risco Dinâmico',
        'Correlação Filtrada',
        'Session Filters',
        'CHOCH/BOS/FVG Reais',
        'Multi-Timeframe'
      ],
      timeframes: '15m + 1h + 4h',
      minScore: CONFIG.minScore,
      minADX: CONFIG.minADX,
      pairs: CONFIG.pairs.length,
      atrStop: 'ATR × ' + CONFIG.atrMultiplier,
      maxPositions: CONFIG.maxPositions
    }
  });
});

app.get('/api/signals', (req, res) => {
  res.json({ 
    signals: state.signals.slice(0, 20), 
    total: state.signals.length 
  });
});

app.get('/api/logs', (req, res) => {
  res.json({ 
    logs: state.logs.slice(0, 100), 
    count: state.logs.length 
  });
});

app.get('/api/stats', (req, res) => {
  res.json({
    stats: state.stats,
    balance: state.balance,
    riskMode: state.riskMode,
    currentRisk: calculateDynamicRisk(),
    activeTrades: state.pendingTrades
  });
});

app.get('/health', (req, res) => res.send('OK'));

// ============================================
// STARTUP
// ============================================

app.listen(PORT, async () => {
  addLog('========================================', 'success');
  addLog('BRUNO TRADER PROFESSIONAL V5.0', 'success');
  addLog('========================================', 'success');
  addLog(`Pares: ${CONFIG.pairs.length}`, 'info');
  addLog(`Features: Trailing Stop, ADX, Volume Real`, 'info');
  addLog(`Risco Dinâmico, Correlação, Sessions`, 'info');
  addLog(`CHOCH/BOS/FVG com dados REAIS`, 'info');
  addLog(`Score mínimo: ${CONFIG.minScore}/100`, 'info');
  addLog(`ADX mínimo: ${CONFIG.minADX}`, 'info');
  addLog(`Stop: ATR × ${CONFIG.atrMultiplier}`, 'info');
  
  await sendTelegram(`🚀 BRUNO TRADER PRO V5.0

SISTEMA PROFISSIONAL COMPLETO ATIVADO!

✅ 37 pares verificados Binance.US
✅ Multi-timeframe (15m/1h/4h)
✅ Score ponderado (min ${CONFIG.minScore}/100)
✅ Stop ATR × ${CONFIG.atrMultiplier}

🆕 NOVIDADES V5.0:

✨ Trailing Stop Inteligente
   - Breakeven em TP1
   - Trailing em TP2
   - Auto-close TP3

⚡ ADX Filter (min ${CONFIG.minADX})
   - Evita mercados laterais
   - Só opera tendências

📊 Volume Real Melhorado
   - Análise 24h
   - Spike detection
   - Crescente confirmado

💰 Gestão de Risco Dinâmica
   - Normal: 2%
   - Recovery: 1% (2+ losses)
   - Boost: 3% (3+ wins)
   - Emergency: 0.5% (DD > 10%)

🎯 Filtro de Correlação
   - 1 trade por grupo
   - Diversificação real

🕐 Session Filters
   - Horários premium
   - Evita dead zones

📈 CHOCH/BOS/FVG REAIS
   - Swing points reais
   - Estrutura calculada
   - Sem simulação!

Modo: ${state.riskMode.toUpperCase()}
Risco Atual: ${(calculateDynamicRisk() * 100).toFixed(1)}%

Sistema institucional completo!

${new Date().toLocaleString('pt-BR')}`);
  
  setTimeout(() => { 
    addLog('Primeira análise V5.0...', 'info'); 
    analyzeMarket(); 
  }, 10000);
  
  // Análise a cada 15min
  setInterval(analyzeMarket, 900000);
  
  // Check trades a cada 1min
  setInterval(checkTradeResults, 60000);
});

process.on('unhandledRejection', (error) => { 
  addLog(`Erro: ${error.message}`, 'error'); 
});
