const express = require('express');
const Binance = require('node-binance-api');
const TelegramBot = require('node-telegram-bot-api');
const { RSI, MACD, BollingerBands, EMA, ATR } = require('technicalindicators');
const path = require('path');

// ========== CONFIGURAÇÕES ==========
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = '8604695024:AAEycHa9v4L2ZmOBxP20i9ZuBSmE1hNndxM';
const CHAT_ID = '1763009688';

// Binance API (sem chaves = dados públicos)
const binance = new Binance();

// Telegram Bot
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// ========== CONFIGURAÇÃO DO ROBÔ ==========
const CONFIG = {
  // Gestão de Risco
  riskPerTrade: 0.02,        // 2% por trade (SEGURO!)
  leverage: 10,
  stopLossATR: 1.5,          // Stop baseado em ATR
  tp1Percent: 1.5,           // TP1: 1.5% (50% da posição)
  tp2Percent: 3.0,           // TP2: 3.0% (50% restante)
  initialBalance: 1000,
  maxPositions: 5,           // Máximo 5 posições simultâneas
  
  // Filtros
  minVolume24h: 50000000,    // 50M USD mínimo
  minRSI: 30,                // RSI mínimo (oversold)
  maxRSI: 70,                // RSI máximo (overbought)
  
  // Timeframes
  mainTimeframe: '1h',       // Timeframe principal
  confirmTimeframe: '15m',   // Timeframe de confirmação
  
  // Pares para analisar
  pairs: [
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT',
    'XRPUSDT', 'DOGEUSDT', 'MATICUSDT', 'DOTUSDT', 'AVAXUSDT',
    'LINKUSDT', 'UNIUSDT', 'ATOMUSDT', 'LTCUSDT', 'NEARUSDT'
  ]
};

// Estado global
let state = {
  balance: CONFIG.initialBalance,
  signals: [],
  trades: [],
  stats: {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    totalProfit: 0,
    winRate: 0,
    profitFactor: 0
  },
  marketData: {},
  analysisCount: 0,
  logs: [],
  lastAnalysis: null
};

// ========== SISTEMA DE LOGS ==========
function addLog(message, type = 'info') {
  const log = {
    timestamp: new Date().toISOString(),
    message,
    type
  };
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

// ========== BINANCE - DADOS REAIS ==========
async function getCandlesticks(symbol, interval = '1h', limit = 100) {
  try {
    const candles = await binance.candlesticks(symbol, interval, false, { limit });
    
    return candles.map(c => ({
      time: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5])
    }));
  } catch (error) {
    addLog(`Erro ao buscar velas ${symbol}: ${error.message}`, 'error');
    return null;
  }
}

// ========== INDICADORES TÉCNICOS ==========
function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  
  // RSI
  const rsi = RSI.calculate({ values: closes, period: 14 });
  const currentRSI = rsi[rsi.length - 1];
  
  // MACD
  const macd = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
  const currentMACD = macd[macd.length - 1];
  
  // Bollinger Bands
  const bb = BollingerBands.calculate({
    period: 20,
    values: closes,
    stdDev: 2
  });
  const currentBB = bb[bb.length - 1];
  
  // EMA 20 e 50
  const ema20 = EMA.calculate({ period: 20, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  
  // ATR (Average True Range)
  const atr = ATR.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: 14
  });
  const currentATR = atr[atr.length - 1];
  
  return {
    rsi: currentRSI,
    macd: currentMACD,
    bb: currentBB,
    ema20: ema20[ema20.length - 1],
    ema50: ema50[ema50.length - 1],
    atr: currentATR,
    price: closes[closes.length - 1]
  };
}

// ========== SMART MONEY CONCEPTS ==========
function detectOrderBlock(candles) {
  const last5 = candles.slice(-5);
  
  // Order Block de baixa: vela grande de alta seguida de queda
  for (let i = 0; i < last5.length - 1; i++) {
    const current = last5[i];
    const next = last5[i + 1];
    const body = Math.abs(current.close - current.open);
    const avgBody = last5.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / 5;
    
    if (body > avgBody * 1.5 && current.close > current.open && next.close < next.open) {
      return { type: 'bearish', strength: body / avgBody };
    }
  }
  
  // Order Block de alta: vela grande de baixa seguida de alta
  for (let i = 0; i < last5.length - 1; i++) {
    const current = last5[i];
    const next = last5[i + 1];
    const body = Math.abs(current.close - current.open);
    const avgBody = last5.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / 5;
    
    if (body > avgBody * 1.5 && current.close < current.open && next.close > next.open) {
      return { type: 'bullish', strength: body / avgBody };
    }
  }
  
  return null;
}

function detectFVG(candles) {
  const last3 = candles.slice(-3);
  if (last3.length < 3) return null;
  
  const [first, middle, third] = last3;
  
  // FVG de alta: gap entre low da 3ª e high da 1ª
  if (third.low > first.high) {
    return {
      type: 'bullish',
      gap: third.low - first.high,
      zone: [first.high, third.low]
    };
  }
  
  // FVG de baixa: gap entre high da 3ª e low da 1ª
  if (third.high < first.low) {
    return {
      type: 'bearish',
      gap: first.low - third.high,
      zone: [third.high, first.low]
    };
  }
  
  return null;
}

// ========== ANÁLISE COMPLETA ==========
async function analyzeSymbol(symbol) {
  try {
    // Pega candlesticks
    const candles1h = await getCandlesticks(symbol, '1h', 100);
    const candles15m = await getCandlesticks(symbol, '15m', 50);
    
    if (!candles1h || !candles15m) {
      return { valid: false, reason: 'Erro ao buscar dados' };
    }
    
    // Calcula indicadores
    const ind1h = calculateIndicators(candles1h);
    const ind15m = calculateIndicators(candles15m);
    
    // Volume 24h
    const volume24h = candles1h.slice(-24).reduce((sum, c) => sum + c.volume * c.close, 0);
    
    // Filtro de volume
    if (volume24h < CONFIG.minVolume24h) {
      return { valid: false, reason: `Volume baixo: ${(volume24h/1000000).toFixed(0)}M` };
    }
    
    // Detecta padrões SMC
    const orderBlock = detectOrderBlock(candles1h);
    const fvg = detectFVG(candles1h);
    
    // Sistema de pontuação
    let score = 0;
    let signals = [];
    
    // RSI (oversold/overbought)
    if (ind1h.rsi < 35) {
      score += 25;
      signals.push('RSI Oversold');
    } else if (ind1h.rsi > 65) {
      score += 25;
      signals.push('RSI Overbought');
    }
    
    // MACD cruzamento
    if (ind1h.macd && ind1h.macd.MACD > ind1h.macd.signal && ind1h.macd.MACD > 0) {
      score += 20;
      signals.push('MACD Bullish');
    } else if (ind1h.macd && ind1h.macd.MACD < ind1h.macd.signal && ind1h.macd.MACD < 0) {
      score += 20;
      signals.push('MACD Bearish');
    }
    
    // EMA trend
    if (ind1h.price > ind1h.ema20 && ind1h.ema20 > ind1h.ema50) {
      score += 15;
      signals.push('EMA Uptrend');
    } else if (ind1h.price < ind1h.ema20 && ind1h.ema20 < ind1h.ema50) {
      score += 15;
      signals.push('EMA Downtrend');
    }
    
    // Bollinger Bands
    if (ind1h.bb && ind1h.price < ind1h.bb.lower) {
      score += 15;
      signals.push('BB Oversold');
    } else if (ind1h.bb && ind1h.price > ind1h.bb.upper) {
      score += 15;
      signals.push('BB Overbought');
    }
    
    // Order Block
    if (orderBlock) {
      score += Math.round(orderBlock.strength * 10);
      signals.push(`OB ${orderBlock.type}`);
    }
    
    // FVG
    if (fvg) {
      score += 10;
      signals.push(`FVG ${fvg.type}`);
    }
    
    // Confirmação 15min
    if (ind15m.rsi < 35 && ind1h.rsi < 40) {
      score += 10;
      signals.push('15m Confirma');
    }
    
    // Filtro mínimo: 60 pontos
    if (score < 60) {
      return { valid: false, reason: `Score baixo: ${score}/100` };
    }
    
    // Determina direção
    const isBullish = (ind1h.rsi < 40 || (ind1h.macd && ind1h.macd.MACD > ind1h.macd.signal) || 
                       (orderBlock && orderBlock.type === 'bullish') || ind1h.price > ind1h.ema20);
    
    const direction = isBullish ? 'LONG' : 'SHORT';
    const entry = ind1h.price;
    
    // Stop Loss baseado em ATR
    const stopDistance = ind1h.atr * CONFIG.stopLossATR;
    const stopLoss = isBullish ? entry - stopDistance : entry + stopDistance;
    
    // Take Profits
    const tp1Distance = (entry * CONFIG.tp1Percent) / 100;
    const tp2Distance = (entry * CONFIG.tp2Percent) / 100;
    
    const tp1 = isBullish ? entry + tp1Distance : entry - tp1Distance;
    const tp2 = isBullish ? entry + tp2Distance : entry - tp2Distance;
    
    // R:R
    const risk = Math.abs(entry - stopLoss);
    const reward = Math.abs(entry - tp2);
    const rr = (reward / risk).toFixed(2);
    
    return {
      valid: true,
      symbol,
      direction,
      entry: entry.toFixed(2),
      stopLoss: stopLoss.toFixed(2),
      tp1: tp1.toFixed(2),
      tp2: tp2.toFixed(2),
      score,
      signals: signals.join(' + '),
      rsi: ind1h.rsi.toFixed(1),
      atr: ind1h.atr.toFixed(2),
      rr,
      volume24h: (volume24h / 1000000).toFixed(0) + 'M',
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    addLog(`Erro ao analisar ${symbol}: ${error.message}`, 'error');
    return { valid: false, reason: error.message };
  }
}

// ========== ANÁLISE DO MERCADO ==========
async function analyzeMarket() {
  try {
    state.analysisCount++;
    addLog(`Iniciando analise #${state.analysisCount}...`, 'info');
    
    const results = [];
    
    // Analisa cada par
    for (const symbol of CONFIG.pairs) {
      addLog(`Analisando ${symbol}...`, 'info');
      const result = await analyzeSymbol(symbol);
      
      if (result.valid) {
        results.push(result);
        addLog(`${symbol}: SINAL! Score ${result.score}`, 'success');
      } else {
        addLog(`${symbol}: ${result.reason}`, 'warning');
      }
      
      // Delay para não sobrecarregar API
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    // Ordena por score
    results.sort((a, b) => b.score - a.score);
    
    // Pega os 3 melhores
    const topSignals = results.slice(0, 3);
    
    if (topSignals.length > 0) {
      // Salva sinais
      topSignals.forEach(signal => {
        state.signals.unshift(signal);
      });
      state.signals = state.signals.slice(0, 20);
      
      // Notifica no Telegram
      for (const signal of topSignals) {
        const message = `SINAL PROFISSIONAL DETECTADO!

Par: ${signal.symbol}
Direcao: ${signal.direction}

Entrada: $${signal.entry}
Stop Loss: $${signal.stopLoss}
TP1 (50%): $${signal.tp1}
TP2 (50%): $${signal.tp2}

R:R: 1:${signal.rr}
Score: ${signal.score}/100
RSI: ${signal.rsi}
ATR: ${signal.atr}

Confirmacoes: ${signal.signals}
Volume 24h: ${signal.volume24h}

Posicao sugerida: R$ ${(state.balance * CONFIG.riskPerTrade).toFixed(2)} (2% da banca)

${new Date().toLocaleTimeString('pt-BR')}`;
        
        await sendTelegram(message);
      }
      
      addLog(`${topSignals.length} sinais encontrados!`, 'success');
    } else {
      addLog('Nenhum sinal encontrado neste ciclo', 'info');
    }
    
    state.lastAnalysis = new Date();
    
  } catch (error) {
    addLog(`Erro critico: ${error.message}`, 'error');
  }
}

// ========== SERVIDOR EXPRESS ==========
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Endpoints
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    version: '2.0.0',
    uptime: process.uptime(),
    analysisCount: state.analysisCount,
    signalsCount: state.signals.length,
    lastAnalysis: state.lastAnalysis,
    stats: state.stats,
    config: {
      risk: CONFIG.riskPerTrade * 100 + '%',
      pairs: CONFIG.pairs.length
    }
  });
});

app.get('/api/signals', (req, res) => {
  res.json({
    signals: state.signals.slice(0, 10),
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
  res.json(state.stats);
});

app.get('/health', (req, res) => {
  res.send('OK');
});

// ========== INICIALIZAÇÃO ==========
app.listen(PORT, async () => {
  addLog('========================================', 'success');
  addLog('BRUNO TRADER PRO V2.0 INICIADO!', 'success');
  addLog('========================================', 'success');
  addLog(`Porta: ${PORT}`, 'info');
  addLog(`Pares: ${CONFIG.pairs.length}`, 'info');
  addLog(`Risco: ${CONFIG.riskPerTrade * 100}%`, 'info');
  addLog(`Leverage: ${CONFIG.leverage}x`, 'info');
  
  await sendTelegram(`BRUNO TRADER PRO V2.0 INICIADO!

Analise Tecnica REAL ativada:
- Binance API (dados reais)
- RSI, MACD, Bollinger Bands
- EMA 20/50
- Order Blocks
- Fair Value Gaps

Gestao de Risco:
- 2% por trade
- TP parcial (50% TP1, 50% TP2)
- Stop baseado em ATR

${CONFIG.pairs.length} pares sendo monitorados

Sistema 100% profissional!

${new Date().toLocaleString('pt-BR')}`);
  
  // Primeira análise após 10s
  setTimeout(() => {
    addLog('Iniciando primeira analise...', 'info');
    analyzeMarket();
  }, 10000);
  
  // Análise a cada 15 minutos
  setInterval(analyzeMarket, 900000);
});

process.on('unhandledRejection', (error) => {
  addLog(`Erro: ${error.message}`, 'error');
});

  
