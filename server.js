 const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { RSI, MACD, BollingerBands, EMA, ATR } = require('technicalindicators');
const path = require('path');

// ========== CONFIGURAÇÕES ==========
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = '8604695024:AAEycHa9v4L2ZmOBxP20i9ZuBSmE1hNndxM';
const CHAT_ID = '1763009688';

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
  minVolume24h: 10000000,    // 10M USD mínimo (ajustado)
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
  pendingTrades: [], // Novos trades aguardando resultado
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

// ========== TRACKING DE RESULTADOS ==========
async function checkTradeResults() {
  try {
    if (state.pendingTrades.length === 0) return;
    
    addLog(`Verificando ${state.pendingTrades.length} trades pendentes...`, 'info');
    
    for (let i = state.pendingTrades.length - 1; i >= 0; i--) {
      const trade = state.pendingTrades[i];
      
      // Verifica se já passou tempo suficiente (4 horas)
      const timeSince = Date.now() - new Date(trade.timestamp).getTime();
      const hoursSince = timeSince / (1000 * 60 * 60);
      
      if (hoursSince < 4) continue; // Ainda não passou 4h
      
      // Busca preço atual
      const candles = await getCandlesticks(trade.symbol, '1h', 1);
      if (!candles || candles.length === 0) continue;
      
      const currentPrice = candles[0].close;
      const entry = parseFloat(trade.entry);
      const stop = parseFloat(trade.stopLoss);
      const tp1 = parseFloat(trade.tp1);
      const tp2 = parseFloat(trade.tp2);
      
      let result = null;
      
      if (trade.direction === 'LONG') {
        // Verifica se bateu TP2
        if (currentPrice >= tp2) {
          result = {
            outcome: 'WIN',
            exit: tp2,
            profit: ((tp2 - entry) / entry) * 100,
            level: 'TP2'
          };
        }
        // Verifica se bateu TP1
        else if (currentPrice >= tp1) {
          result = {
            outcome: 'WIN',
            exit: tp1,
            profit: ((tp1 - entry) / entry) * 100,
            level: 'TP1'
          };
        }
        // Verifica se bateu Stop
        else if (currentPrice <= stop) {
          result = {
            outcome: 'LOSS',
            exit: stop,
            profit: ((stop - entry) / entry) * 100,
            level: 'STOP'
          };
        }
        // Ainda em andamento
        else {
          result = {
            outcome: 'NEUTRAL',
            exit: currentPrice,
            profit: ((currentPrice - entry) / entry) * 100,
            level: 'EM ANDAMENTO'
          };
        }
      } else { // SHORT
        // Verifica se bateu TP2
        if (currentPrice <= tp2) {
          result = {
            outcome: 'WIN',
            exit: tp2,
            profit: ((entry - tp2) / entry) * 100,
            level: 'TP2'
          };
        }
        // Verifica se bateu TP1
        else if (currentPrice <= tp1) {
          result = {
            outcome: 'WIN',
            exit: tp1,
            profit: ((entry - tp1) / entry) * 100,
            level: 'TP1'
          };
        }
        // Verifica se bateu Stop
        else if (currentPrice >= stop) {
          result = {
            outcome: 'LOSS',
            exit: stop,
            profit: ((entry - stop) / entry) * 100,
            level: 'STOP'
          };
        }
        // Ainda em andamento
        else {
          result = {
            outcome: 'NEUTRAL',
            exit: currentPrice,
            profit: ((entry - currentPrice) / entry) * 100,
            level: 'EM ANDAMENTO'
          };
        }
      }
      
      // Se bateu TP ou STOP, finaliza trade
      if (result.outcome === 'WIN' || result.outcome === 'LOSS') {
        const completedTrade = {
          ...trade,
          ...result,
          closedAt: new Date().toISOString(),
          duration: hoursSince.toFixed(1) + 'h'
        };
        
        // Atualiza estatísticas
        state.stats.totalTrades++;
        
        if (result.outcome === 'WIN') {
          state.stats.wins++;
          const profitValue = (state.balance * CONFIG.riskPerTrade) * (result.profit / 100) * CONFIG.leverage;
          state.stats.totalProfit += profitValue;
          state.balance += profitValue;
        } else {
          state.stats.losses++;
          const lossValue = (state.balance * CONFIG.riskPerTrade);
          state.stats.totalProfit -= lossValue;
          state.balance -= lossValue;
        }
        
        state.stats.winRate = state.stats.totalTrades > 0 
          ? ((state.stats.wins / state.stats.totalTrades) * 100).toFixed(1)
          : 0;
        
        // Salva trade finalizado
        state.trades.unshift(completedTrade);
        state.trades = state.trades.slice(0, 50);
        
        // Remove de pendentes
        state.pendingTrades.splice(i, 1);
        
        // Notifica resultado
        const emoji = result.outcome === 'WIN' ? '🟢' : '🔴';
        const resultText = result.outcome === 'WIN' ? 'GREEN' : 'RED';
        
        const message = `${emoji} ${resultText}!

Par: ${trade.symbol} ${trade.direction}
Entrada: $${trade.entry}
Saida: ${result.level} $${result.exit.toFixed(2)}
Profit: ${result.profit > 0 ? '+' : ''}${result.profit.toFixed(2)}%

Duracao: ${completedTrade.duration}
Score: ${trade.score}/100

Banca: R$ ${state.balance.toFixed(2)}
Win Rate: ${state.stats.winRate}%

${new Date().toLocaleTimeString('pt-BR')}`;
        
        await sendTelegram(message);
        addLog(`${emoji} ${trade.symbol}: ${resultText} (${result.profit.toFixed(2)}%)`, result.outcome === 'WIN' ? 'success' : 'error');
      }
      // Se ainda em andamento após 4h, fecha neutro
      else if (hoursSince >= 4) {
        addLog(`${trade.symbol}: Fechando neutro após 4h (${result.profit.toFixed(2)}%)`, 'info');
        state.pendingTrades.splice(i, 1);
      }
    }
    
  } catch (error) {
    addLog(`Erro ao verificar resultados: ${error.message}`, 'error');
  }
}

// ========== BINANCE.US + COINGECKO HÍBRIDO ==========
async function getCandlesticks(symbol, interval = '1h', limit = 100) {
  try {
    // TENTA BINANCE.US PRIMEIRO
    const url = `https://api.binance.us/api/v3/klines`;
    const response = await axios.get(url, {
      params: {
        symbol: symbol,
        interval: interval,
        limit: limit
      },
      timeout: 10000
    });
    
    if (!response.data || response.data.length === 0) {
      throw new Error('Sem dados');
    }
    
    addLog(`${symbol}: ${response.data.length} velas recebidas (Binance.US)`, 'success');
    
    return response.data.map(candle => ({
      time: candle[0],
      open: parseFloat(candle[1]),
      high: parseFloat(candle[2]),
      low: parseFloat(candle[3]),
      close: parseFloat(candle[4]),
      volume: parseFloat(candle[5])
    }));
  } catch (error) {
    // SE BINANCE.US FALHAR, USA COINGECKO
    addLog(`${symbol}: Binance.US falhou, tentando CoinGecko...`, 'warning');
    return await getCandlesticksFromCoinGecko(symbol, limit);
  }
}

async function getCandlesticksFromCoinGecko(symbol, limit = 100) {
  try {
    // Converte símbolo: BTCUSDT -> bitcoin
    const coinMap = {
      'BTCUSDT': 'bitcoin',
      'ETHUSDT': 'ethereum',
      'BNBUSDT': 'binancecoin',
      'SOLUSDT': 'solana',
      'ADAUSDT': 'cardano',
      'XRPUSDT': 'ripple',
      'DOGEUSDT': 'dogecoin',
      'MATICUSDT': 'matic-network',
      'DOTUSDT': 'polkadot',
      'AVAXUSDT': 'avalanche-2',
      'LINKUSDT': 'chainlink',
      'UNIUSDT': 'uniswap',
      'ATOMUSDT': 'cosmos',
      'LTCUSDT': 'litecoin',
      'NEARUSDT': 'near'
    };
    
    const coinId = coinMap[symbol];
    if (!coinId) {
      throw new Error('Moeda não mapeada');
    }
    
    const days = Math.ceil(limit / 24); // 1h candles
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart`;
    
    const response = await axios.get(url, {
      params: {
        vs_currency: 'usd',
        days: days,
        interval: 'hourly'
      },
      timeout: 10000
    });
    
    if (!response.data || !response.data.prices) {
      throw new Error('Sem dados CoinGecko');
    }
    
    // Converte formato CoinGecko para candlesticks
    const prices = response.data.prices.slice(-limit);
    const volumes = response.data.total_volumes.slice(-limit);
    
    const candles = prices.map((price, i) => {
      const close = price[1];
      const volume = volumes[i] ? volumes[i][1] : 0;
      
      // Simula OHLC a partir do preço (aproximação)
      const variance = close * 0.002; // 0.2% de variância
      
      return {
        time: price[0],
        open: close - variance,
        high: close + variance,
        low: close - variance,
        close: close,
        volume: volume
      };
    });
    
    addLog(`${symbol}: ${candles.length} velas recebidas (CoinGecko)`, 'success');
    return candles;
    
  } catch (error) {
    addLog(`${symbol}: CoinGecko também falhou - ${error.message}`, 'error');
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
    
    // Volume 24h (apenas informativo, não bloqueia)
    const volume24h = candles1h.slice(-24).reduce((sum, c) => sum + (c.volume * c.close), 0);
    const volumeStr = volume24h > 1000000 ? `${(volume24h/1000000).toFixed(0)}M` : 'N/A';
    
    addLog(`${symbol}: Vol 24h = ${volumeStr}`, 'info');
    
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
    
    // Filtro mínimo: 65 pontos (score mais rigoroso)
    if (score < 65) {
      return { valid: false, reason: `Score baixo: ${score}/100` };
    }
    
    // ANTI-DUPLICAÇÃO: Verifica se já enviou sinal deste par recentemente
    const recentSignals = state.signals.slice(0, 20);
    const recentSame = recentSignals.find(s => s.symbol === symbol);
    if (recentSame) {
      const timeSince = Date.now() - new Date(recentSame.timestamp).getTime();
      const hoursSince = timeSince / (1000 * 60 * 60);
      
      if (hoursSince < 4) { // 4 horas de intervalo mínimo
        return { valid: false, reason: `${symbol} sinal recente (${hoursSince.toFixed(1)}h atrás)` };
      }
      
      // Verifica se preço mudou pelo menos 1%
      const priceDiff = Math.abs(ind1h.price - parseFloat(recentSame.entry)) / parseFloat(recentSame.entry);
      if (priceDiff < 0.01) { // 1% de variação mínima
        return { valid: false, reason: `${symbol} preço similar ao último sinal` };
      }
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
      volume24h: volumeStr,
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
    
    // Pega APENAS O MELHOR (1 sinal por ciclo)
    const topSignals = results.slice(0, 1);
    
    if (topSignals.length > 0) {
      // Salva sinal
      const bestSignal = topSignals[0];
      state.signals.unshift(bestSignal);
      state.signals = state.signals.slice(0, 20);
      
      // Notifica no Telegram
      const message = `SINAL PROFISSIONAL DETECTADO!

Par: ${bestSignal.symbol}
Direcao: ${bestSignal.direction}

Entrada: $${bestSignal.entry}
Stop Loss: $${bestSignal.stopLoss}
TP1 (50%): $${bestSignal.tp1}
TP2 (50%): $${bestSignal.tp2}

R:R: 1:${bestSignal.rr}
Score: ${bestSignal.score}/100
RSI: ${bestSignal.rsi}
ATR: ${bestSignal.atr}

Confirmacoes: ${bestSignal.signals}
Volume 24h: ${bestSignal.volume24h}

Posicao sugerida: R$ ${(state.balance * CONFIG.riskPerTrade).toFixed(2)} (2% da banca)

${new Date().toLocaleTimeString('pt-BR')}`;
      
      await sendTelegram(message);
      
      // Adiciona aos trades pendentes para tracking
      state.pendingTrades.push(bestSignal);
      
      addLog(`MELHOR SINAL: ${bestSignal.symbol} ${bestSignal.direction} (Score: ${bestSignal.score})`, 'success');
      addLog(`Trade adicionado para tracking (${state.pendingTrades.length} pendentes)`, 'info');
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
  
  // Verifica resultados de trades a cada 30 minutos
  setInterval(checkTradeResults, 1800000);
  addLog('Sistema de tracking ativado (verifica a cada 30min)', 'success');
});

process.on('unhandledRejection', (error) => {
  addLog(`Erro: ${error.message}`, 'error');
});

  
