const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { RSI, MACD, EMA, ATR, ADX } = require('technicalindicators');
const path = require('path');

const PORT = process.env.PORT || 3000;

// 🔒 SEGURANÇA: Usar variáveis de ambiente
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8604695024:AAEycHa9v4L2ZmOBxP20i9ZuBSmE1hNndxM';
const CHAT_ID = process.env.CHAT_ID || '1763009688';           // Privado (só Bruno)
const GROUP_ID = process.env.GROUP_ID || '-1003957383242';     // Grupo (Bruno + Pai)

// Validação crítica
if (!TELEGRAM_TOKEN || !CHAT_ID) {
  console.error('❌ ERRO CRÍTICO: TELEGRAM_TOKEN e CHAT_ID são obrigatórios');
  console.error('Configure no Render: Dashboard → Environment → Add Variable');
  process.exit(1);
}

// Aviso se estiver usando fallback (token hardcoded)
if (!process.env.TELEGRAM_TOKEN) {
  console.warn('⚠️ ATENÇÃO: Usando TELEGRAM_TOKEN do código (fallback)');
  console.warn('⚠️ Recomendado: configurar TELEGRAM_TOKEN no Render → Environment');
}
if (!process.env.CHAT_ID) {
  console.warn('⚠️ ATENÇÃO: Usando CHAT_ID do código (fallback)');
}
if (!process.env.GROUP_ID) {
  console.warn('⚠️ ATENÇÃO: Usando GROUP_ID do código (fallback)');
}

console.log(`📱 Telegram configurado:`);
console.log(`   Privado (Bruno): ${CHAT_ID}`);
console.log(`   Grupo (Bruno+Pai): ${GROUP_ID}`);

const bot = new TelegramBot(TELEGRAM_TOKEN, { 
  polling: {
    interval: 1000,        // verifica novas mensagens a cada 1 segundo
    autoStart: true,
    params: {
      timeout: 10
    }
  }
});

// Tratamento de erros do polling
bot.on('polling_error', (error) => {
  console.error('❌ Polling error:', error.message);
});

console.log(`✅ Bot Telegram em modo POLLING (recebe comandos /status, /trade, etc)`);

const CONFIG = {
  riskPerTrade: 0.02,
  leverage: 10,
  initialBalance: 1000,
  maxPositions: 3,
  maxExposure: 0.06,
  
  // 🆕 V6.0 - DAY TRADE CONFIG
  minADX: 20,
  volumeMultiplier: 1.2,
  
  // ❌ V6.0: Trailing/Breakeven REMOVIDOS (você opera manual)
  trailing: {
    enabled: false,       // 🆕 V6.0: DESATIVADO (gestão manual)
    breakeven: false,
    trailingATR: 1.5,
    closeOnTP3: false
  },
  
  // 🆕 V6.0: Grupos de Correlação (mantém)
  correlationGroups: {
    highcap: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'],
    layer1: ['SOLUSDT', 'AVAXUSDT', 'NEARUSDT', 'DOTUSDT'],
    defi: ['AAVEUSDT', 'UNIUSDT', 'COMPUSDT', 'SUSHIUSDT', 'CRVUSDT'],
    gaming: ['SANDUSDT', 'MANAUSDT', 'ENJUSDT', 'GALAUSDT', 'APEUSDT'],
    meme: ['SHIBUSDT', 'PEPEUSDT', 'DOGEUSDT'],
    others: ['ADAUSDT', 'XRPUSDT', 'MATICUSDT', 'LINKUSDT', 'LTCUSDT', 'ATOMUSDT', 
             'XLMUSDT', 'ALGOUSDT', 'VETUSDT', 'ICPUSDT', 'FILUSDT', 'CAKEUSDT', 
             'IOTAUSDT']
  },
  
  // 🆕 V6.0: STOP POR CATEGORIA (volatilidade do ativo)
  stopByCategory: {
    blueChips: {
      pairs: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'],
      atrMultiplier: 4.0,
      label: '🔵 Blue Chip'
    },
    alts: {
      pairs: ['SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 
              'MATICUSDT', 'LINKUSDT', 'LTCUSDT', 'UNIUSDT', 'ATOMUSDT',
              'XLMUSDT', 'ALGOUSDT', 'VETUSDT', 'ICPUSDT', 'FILUSDT', 
              'NEARUSDT', 'AAVEUSDT', 'COMPUSDT', 'SUSHIUSDT', 'CRVUSDT'],
      atrMultiplier: 4.5,
      label: '🟢 Alt'
    },
    memecoins: {
      pairs: ['DOGEUSDT', 'SHIBUSDT', 'PEPEUSDT', 'SANDUSDT', 'MANAUSDT', 
              'ENJUSDT', 'GALAUSDT', 'APEUSDT', 'CAKEUSDT', 'IOTAUSDT'],
      atrMultiplier: 5.0,
      label: '🟡 Memecoin/Smallcap'
    }
  },
  
  scoreWeights: {
    choch: 20, bos: 20, fibonacci: 10, orderBlock: 15, fvg: 15,
    liquidity: 20, emaTrend: 20, macd: 10, rsi: 10, sr: 10,
    volumeSpike: 15, trendAlignment: 20, adxBonus: 10,
    btcAlignment: 25  // 🆕 V6.0: Penalidade -25 se contra BTC
  },
  
  minScore: 65,
  highConfidence: 85,
  atrMultiplier: 3.0,  // ⚠️ FALLBACK (se par não estiver em categoria)
  
  // 🆕 V6.0: TPs FIXOS (Day Trade)
  tpFixed: {
    tp1: 0.7,   // 0.7%
    tp2: 1.5,   // 1.5%
    tp3: 2.5    // 2.5%
  },
  
  // 🆕 V6.2: TPs REDUZIDOS para entrada AGRESSIVA (4h contra)
  tpAggressive: {
    tp1: 0.5,   // 0.5%
    tp2: 1.0,   // 1.0%
    tp3: 1.5    // 1.5%
  },
  
  // 🆕 V6.2: SISTEMA DE PESOS POR TIMEFRAME
  // 4h = contexto (peso leve), 1h = direção (peso alto), 15m = setup (peso máximo)
  tfWeights: {
    enabled: true,
    h4: {
      aligned: 10,      // 4h alinhado: +10
      opposite: -8,     // 4h contra: -8
      neutral: 0        // 4h lateral: 0
    },
    h1: {
      aligned: 25,      // 1h alinhado: +25
      opposite: -25     // 1h contra: -25 (peso alto)
    },
    m15: {
      strong: 30,       // 15m setup forte: +30
      medium: 10,       // 15m setup médio: +10
      weak: -30         // 15m setup ruim: -30
    }
  },
  
  // 🆕 V6.2: NÍVEIS DE ENTRADA
  entryLevels: {
    enabled: true,
    premium: {
      label: '⭐ PREMIUM',
      description: '4h + 1h + 15m alinhados',
      minTFScore: 60,           // 4h(+10) + 1h(+25) + 15m(+30) = +65
      tps: 'normal'             // TPs normais
    },
    normal: {
      label: '✅ NORMAL',
      description: '1h + 15m alinhados (4h neutro)',
      minTFScore: 45,           // 1h(+25) + 15m(+30) = +55
      tps: 'normal'             // TPs normais
    },
    aggressive: {
      label: '⚡ AGRESSIVO',
      description: '1h + 15m alinhados (4h contra)',
      minTFScore: 35,           // 1h(+25) + 15m(+30) - 8 = +47
      tps: 'aggressive'         // TPs reduzidos!
    }
    // Score TF < 35 = REJEITADO
  },
  
  // 🆕 V6.0: Distribuição manual (você executa)
  tpPartial: {
    enabled: true,
    tp1Percent: 40,    // 40% sai TP1
    tp2Percent: 40,    // 40% sai TP2
    tp3Percent: 20     // 20% runner
  },
  
  // 🆕 V6.0: BTC FILTER
  btcFilter: {
    enabled: true,
    timeframe: '4h',
    penaltyContra: 25,        // -25 score se contra BTC
    threshold: 0.3            // 0.3% de movimento mínimo para considerar tendência
  },
  
  // 🆕 V6.0: Trade Tracking (acompanha sem operar)
  tradeTracking: {
    enabled: true,
    timeoutHours: 8,          // Para acompanhar após 8h
    checkInterval: 60         // Verifica TP a cada 60 segundos
  },
  
  // 🆕 V6.0: Volatility Alert
  volatilityAlert: {
    enabled: true,
    btcThreshold: 2.0,        // BTC mexe >2% em 1h = alerta
    cooldownMinutes: 60       // Não repete alerta antes de 1h
  },
  
  // 🆕 V6.0: Daily Summary
  dailySummary: {
    enabled: true,
    hour: 22,                 // 22h BR
    timezone: 'America/Sao_Paulo'
  },
  
  pairs: [
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
    'ADAUSDT', 'AVAXUSDT', 'DOGEUSDT', 'DOTUSDT', 'MATICUSDT',
    'LINKUSDT', 'LTCUSDT', 'UNIUSDT', 'ATOMUSDT', 'XLMUSDT',
    'ALGOUSDT', 'VETUSDT', 'ICPUSDT', 'FILUSDT', 'NEARUSDT',
    'AAVEUSDT', 'COMPUSDT', 'SUSHIUSDT', 'CRVUSDT',
    'SANDUSDT', 'MANAUSDT', 'ENJUSDT', 'GALAUSDT', 'APEUSDT',
    'SHIBUSDT', 'PEPEUSDT',
    'CAKEUSDT', 'IOTAUSDT'
  ]
};

let state = {
  balance: CONFIG.initialBalance,
  signals: [],
  trades: [],
  pendingTrades: [],
  
  // 🆕 V6.0: Trades manuais (você marca)
  manualTrades: [],
  manualStats: {
    total: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    tp1Hits: 0,
    tp2Hits: 0,
    tp3Hits: 0,
    winRate: 0,
    totalProfit: 0
  },
  
  // 🆕 V6.0: Trades em acompanhamento (não opera, só monitora)
  trackedTrades: [],   // [{ id, symbol, entry, stop, tps, direction, startTime, tpsHit: [], notified }]
  
  // 🆕 V6.0: BTC tracking
  btcStatus: {
    direction: 'unknown',  // 'up', 'down', 'lateral', 'unknown'
    change4h: 0,
    lastUpdate: null,
    lastVolatilityAlert: null
  },
  
  // 🆕 V6.0: Sistema de aprendizado
  learning: {
    bySymbol: {},  // { BTCUSDT: { trades: 10, wins: 6, winRate: 60, scoreAdjust: +5 } }
    enabled: true
  },
  
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
  trailingStops: {},
  riskMode: 'normal',
  lastSignalTime: null,
  signalsByDate: {}
};

// ============================================
// 💾 PERSISTÊNCIA DE ESTADO
// ============================================

const STATE_FILE = process.env.STATE_FILE || './bot-state.json';

function saveState() {
  try {
    const toSave = {
      balance: state.balance,
      signals: state.signals.slice(0, 50),
      trades: state.trades.slice(0, 200),
      pendingTrades: state.pendingTrades,
      stats: state.stats,
      analysisCount: state.analysisCount,
      riskMode: state.riskMode,
      lastSignalTime: state.lastSignalTime,
      signalsByDate: state.signalsByDate,
      // 🆕 V6.0: Salva novos campos
      manualTrades: state.manualTrades.slice(-200),
      manualStats: state.manualStats,
      trackedTrades: state.trackedTrades,
      learning: state.learning,
      btcStatus: state.btcStatus,
      lastSave: new Date().toISOString()
    };
    
    const fsModule = require('fs');
    fsModule.writeFileSync(STATE_FILE, JSON.stringify(toSave, null, 2));
  } catch (error) {
    console.error('Erro ao salvar estado:', error.message);
  }
}

function loadState() {
  try {
    const fsModule = require('fs');
    if (fsModule.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fsModule.readFileSync(STATE_FILE, 'utf8'));
      
      state.balance = saved.balance || CONFIG.initialBalance;
      state.signals = saved.signals || [];
      state.trades = saved.trades || [];
      state.pendingTrades = saved.pendingTrades || [];
      state.stats = { ...state.stats, ...saved.stats };
      state.analysisCount = saved.analysisCount || 0;
      state.riskMode = saved.riskMode || 'normal';
      state.lastSignalTime = saved.lastSignalTime || null;
      state.signalsByDate = saved.signalsByDate || {};
      // 🆕 V6.0: Carrega novos campos
      state.manualTrades = saved.manualTrades || [];
      state.manualStats = { ...state.manualStats, ...(saved.manualStats || {}) };
      state.trackedTrades = saved.trackedTrades || [];
      state.learning = { ...state.learning, ...(saved.learning || {}) };
      state.btcStatus = { ...state.btcStatus, ...(saved.btcStatus || {}) };
      
      console.log(`✅ Estado carregado: ${state.stats.totalTrades} trades, balance $${state.balance.toFixed(2)}`);
      return true;
    }
  } catch (error) {
    console.error('Erro ao carregar estado:', error.message);
  }
  return false;
}

// Carrega estado no startup
loadState();

// Salva estado automaticamente a cada 30 segundos
setInterval(saveState, 30000);

// 🆕 Limpa contador diário antigo (mantém só últimos 7 dias)
setInterval(() => {
  if (!state.signalsByDate) return;
  
  const seteDiasAtras = new Date();
  seteDiasAtras.setDate(seteDiasAtras.getDate() - 7);
  const cutoff = seteDiasAtras.toISOString().split('T')[0];
  
  const clean = {};
  Object.keys(state.signalsByDate).forEach(date => {
    if (date >= cutoff) clean[date] = state.signalsByDate[date];
  });
  state.signalsByDate = clean;
}, 3600000); // A cada 1 hora

function addLog(message, type = 'info') {
  const log = { timestamp: new Date().toISOString(), message, type };
  state.logs.unshift(log);
  if (state.logs.length > 2000) state.logs.pop(); // 🆕 Aumentado de 500 para 2000 (mais histórico)
  console.log(`[${type.toUpperCase()}] ${message}`);
}

// ============================================
// 🆕 FUNÇÕES DE ENVIO TELEGRAM (OPÇÃO C)
// ============================================
// sendToGroup   → Grupo (Bruno + Pai): sinais, TPs, resultados
// sendToPrivate → Privado (só Bruno): erros, startup, alertas técnicos
// sendTelegram  → Função legada (redireciona para grupo por padrão)
// ============================================

// Função interna - envia mensagem para um chat específico
async function sendToChat(chatId, message, chatName = 'chat') {
  try {
    // 🆕 Limita mensagem a 4000 caracteres (limite Telegram é 4096)
    let finalMessage = message;
    if (message.length > 4000) {
      finalMessage = message.substring(0, 3950) + '\n\n... (mensagem truncada)';
      addLog(`⚠️ Mensagem truncada (${message.length} chars)`, 'warning');
    }
    
    await bot.sendMessage(chatId, finalMessage);
    addLog(`✅ Telegram enviado para ${chatName}`, 'success');
    return true;
  } catch (error) {
    addLog(`❌ ERRO TELEGRAM (${chatName}): ${error.message}`, 'error');
    console.error(`TELEGRAM ERROR (${chatName}):`, error);
    return false;
  }
}

// 🆕 Envia para o GRUPO (Bruno + Pai) - sinais e resultados de trade
async function sendToGroup(message) {
  return await sendToChat(GROUP_ID, message, 'GRUPO');
}

// 🆕 Envia para o PRIVADO (só Bruno) - erros e alertas do sistema
async function sendToPrivate(message) {
  return await sendToChat(CHAT_ID, message, 'PRIVADO');
}

// Função legada - mantida para compatibilidade, envia para o GRUPO por padrão
async function sendTelegram(message) {
  return await sendToGroup(message);
}

// ============================================
// 🆕 FASE 3: GERAÇÃO DE GRÁFICO (DESATIVADO)
// ============================================
// Canvas desativado por incompatibilidade com Render free tier
// Se quiser reativar: adicione "canvas": "^2.11.2" no package.json

const fs = require('fs');
// const { createCanvas } = require('canvas'); // DESATIVADO

async function generateChartImage(signal, candles15m) {
  // Gráfico desativado - Render free tier não suporta canvas nativo
  addLog('📊 Gráfico desativado (canvas incompatível com Render free)', 'info');
  return null;
}

// 🌐 Sistema híbrido: Binance.com primeiro, Binance.US como fallback
// Binance.com tem mais liquidez e dados melhores, mas pode geobloquear IPs dos EUA
const BINANCE_ENDPOINTS = [
  { name: 'Binance.com', url: 'https://api.binance.com/api/v3', priority: 1 },
  { name: 'Binance.US', url: 'https://api.binance.us/api/v3', priority: 2 }
];

// Rastreia qual endpoint está funcionando
let activeEndpoint = null;

async function getCandlesticks(symbol, interval = '15m', limit = 200) {
  // Tenta endpoints em ordem de prioridade
  const endpoints = activeEndpoint 
    ? [activeEndpoint, ...BINANCE_ENDPOINTS.filter(e => e !== activeEndpoint)]
    : BINANCE_ENDPOINTS;
  
  for (const endpoint of endpoints) {
    try {
      const response = await axios.get(`${endpoint.url}/klines`, {
        params: { symbol, interval, limit },
        timeout: 10000
      });
      
      // Validação robusta
      if (!response.data) throw new Error('Sem resposta da API');
      if (!Array.isArray(response.data)) throw new Error('Resposta inválida (não é array)');
      if (response.data.length === 0) throw new Error('Array vazio');
      if (response.data.length < 10) throw new Error(`Dados insuficientes (${response.data.length} candles)`);
      
      const candles = response.data.map(c => ({
        time: c[0], 
        open: parseFloat(c[1]), 
        high: parseFloat(c[2]),
        low: parseFloat(c[3]), 
        close: parseFloat(c[4]), 
        volume: parseFloat(c[5])
      }));
      
      // Valida que todos os valores são números válidos
      const invalid = candles.find(c => 
        isNaN(c.open) || isNaN(c.high) || isNaN(c.low) || 
        isNaN(c.close) || isNaN(c.volume) ||
        c.high < c.low || c.open <= 0 || c.close <= 0
      );
      
      if (invalid) {
        throw new Error(`Dados inválidos em ${symbol}`);
      }
      
      // Se mudou de endpoint, loga a mudança
      if (activeEndpoint !== endpoint) {
        if (activeEndpoint) {
          addLog(`🌐 Mudou para ${endpoint.name} (${activeEndpoint.name} falhou)`, 'warning');
        } else {
          addLog(`🌐 Usando ${endpoint.name}`, 'info');
        }
        activeEndpoint = endpoint;
      }
      
      return candles;
      
    } catch (error) {
      // Erro específico de geobloqueio (IP dos EUA acessando Binance.com)
      if (error.response?.status === 451 || error.response?.status === 403) {
        console.log(`⚠️ ${endpoint.name} bloqueado (geo-restriction), tentando próximo...`);
        continue; // Tenta próximo endpoint
      }
      
      // Outros erros - loga e tenta próximo
      if (!error.message.includes('timeout')) {
        console.error(`${endpoint.name} - ${symbol}: ${error.message}`);
      }
      continue;
    }
  }
  
  // Todos os endpoints falharam
  return null;
}

// 🆕 Verifica spread real da exchange (usa endpoint ativo)
async function checkSpread(symbol) {
  try {
    // Usa o endpoint que está funcionando (ou default)
    const baseUrl = activeEndpoint ? activeEndpoint.url : BINANCE_ENDPOINTS[0].url;
    
    const response = await axios.get(`${baseUrl}/depth`, {
      params: { symbol, limit: 5 },
      timeout: 5000
    });
    
    if (!response.data || !response.data.bids || !response.data.asks) {
      return { valid: false, reason: 'Sem orderbook' };
    }
    
    if (response.data.bids.length === 0 || response.data.asks.length === 0) {
      return { valid: false, reason: 'Orderbook vazio' };
    }
    
    const bestBid = parseFloat(response.data.bids[0][0]);
    const bestAsk = parseFloat(response.data.asks[0][0]);
    const midPrice = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const spreadPercent = (spread / midPrice) * 100;
    
    return {
      valid: true,
      bestBid,
      bestAsk,
      spread,
      spreadPercent,
      acceptable: spreadPercent < 0.15
    };
  } catch (error) {
    return { valid: false, reason: error.message };
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

// 🆕 Calcula ATR atual com os candles fornecidos (para trailing stop dinâmico)
function calculateCurrentATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) {
    // Fallback: retorna range médio simples
    const ranges = candles.map(c => c.high - c.low);
    return ranges.reduce((a, b) => a + b, 0) / ranges.length;
  }
  
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }
  
  // ATR = média móvel exponencial dos TRs (últimos 'period')
  const recentTRs = trs.slice(-period);
  return recentTRs.reduce((a, b) => a + b, 0) / recentTRs.length;
}

// 🆕 Analisa se o momentum está enfraquecendo (para exit inteligente)
function analyzeMomentumWeakness(candles, direction) {
  if (!candles || candles.length < 10) return { weakening: false };
  
  const last5 = candles.slice(-5);
  const prev5 = candles.slice(-10, -5);
  
  // 1. Volume diminuindo
  const recentAvgVolume = last5.reduce((s, c) => s + c.volume, 0) / 5;
  const prevAvgVolume = prev5.reduce((s, c) => s + c.volume, 0) / 5;
  const volumeDrop = (prevAvgVolume - recentAvgVolume) / prevAvgVolume;
  
  // 2. Range das velas diminuindo (menos volatilidade = menos momentum)
  const recentAvgRange = last5.reduce((s, c) => s + (c.high - c.low), 0) / 5;
  const prevAvgRange = prev5.reduce((s, c) => s + (c.high - c.low), 0) / 5;
  const rangeDrop = (prevAvgRange - recentAvgRange) / prevAvgRange;
  
  // 3. Candles contrários se acumulando
  let contraryCount = 0;
  last5.forEach(c => {
    if (direction === 'LONG' && c.close < c.open) contraryCount++;
    if (direction === 'SHORT' && c.close > c.open) contraryCount++;
  });
  
  // Pelo menos 2 sinais de fraqueza para alertar
  const weaknessSignals = [];
  if (volumeDrop > 0.3) weaknessSignals.push('Volume caiu 30%+');
  if (rangeDrop > 0.4) weaknessSignals.push('Range caiu 40%+');
  if (contraryCount >= 3) weaknessSignals.push(`${contraryCount}/5 velas contra`);
  
  return {
    weakening: weaknessSignals.length >= 2,
    signals: weaknessSignals,
    volumeDrop: (volumeDrop * 100).toFixed(1) + '%',
    rangeDrop: (rangeDrop * 100).toFixed(1) + '%',
    contraryCandles: `${contraryCount}/5`
  };
}

// ============================================
// 🆕 FASE 2: GESTÃO DE RISCO DINÂMICA
// ============================================

function calculateDynamicRisk() {
  const { consecutiveWins, consecutiveLosses } = state.stats;
  const drawdown = (CONFIG.initialBalance - state.balance) / CONFIG.initialBalance;
  
  // Emergency Mode: Drawdown > 10%
  if (drawdown > 0.10) {
    state.riskMode = 'emergency';
    addLog('⚠️ EMERGENCY MODE: Drawdown > 10%', 'warning');
    return 0.005; // 0.5%
  }
  
  // Recovery Mode: 2+ losses seguidas
  if (consecutiveLosses >= 2) {
    state.riskMode = 'recovery';
    addLog('📉 Recovery Mode: 2+ losses', 'warning');
    return 0.01; // 1%
  }
  
  // Boost Mode: 3+ wins seguidas
  if (consecutiveWins >= 3) {
    state.riskMode = 'boost';
    addLog('📈 Boost Mode: 3+ wins', 'success');
    return 0.03; // 3%
  }
  
  // Normal Mode
  state.riskMode = 'normal';
  return CONFIG.riskPerTrade; // 2%
}

function canTakeNewTrade() {
  const activeTrades = state.pendingTrades.length;
  const currentRisk = calculateDynamicRisk();
  const totalExposure = activeTrades * currentRisk;
  
  if (activeTrades >= CONFIG.maxPositions) {
    addLog(`Máximo de ${CONFIG.maxPositions} posições ativas`, 'warning');
    return false;
  }
  
  if (totalExposure >= CONFIG.maxExposure) {
    addLog(`Exposição máxima (${CONFIG.maxExposure * 100}%) atingida`, 'warning');
    return false;
  }
  
  // 🆕 COOLDOWN: Evita overtrading (mínimo 30min entre sinais)
  if (state.lastSignalTime) {
    const minutesSinceLastSignal = (Date.now() - state.lastSignalTime) / (1000 * 60);
    if (minutesSinceLastSignal < 30) {
      addLog(`Cooldown ativo (${(30 - minutesSinceLastSignal).toFixed(0)}min restantes)`, 'info');
      return false;
    }
  }
  
  // 🆕 LIMITE DIÁRIO: Máximo 5 sinais por dia (evita overtrading em dias ruins)
  const today = new Date().toISOString().split('T')[0];
  if (state.signalsByDate && state.signalsByDate[today] >= 5) {
    addLog(`Limite diário atingido (5 sinais hoje)`, 'warning');
    return false;
  }
  
  return true;
}

// ============================================
// 🆕 FASE 2: FILTRO DE CORRELAÇÃO
// ============================================

function findCorrelationGroup(symbol) {
  for (const [groupName, pairs] of Object.entries(CONFIG.correlationGroups)) {
    if (pairs.includes(symbol)) return groupName;
  }
  return 'others';
}

function hasActiveTradeInGroup(symbol, direction) {
  const group = findCorrelationGroup(symbol);
  
  return state.pendingTrades.some(trade => {
    const tradeGroup = findCorrelationGroup(trade.symbol);
    return tradeGroup === group && trade.direction === direction;
  });
}

// ============================================
// 🆕 FASE 2: SESSION FILTERS (Horários Premium)
// ============================================

// ============================================
// 🆕 V6.0: NOVAS FUNÇÕES DAY TRADE
// ============================================

// 🆕 V6.0: Pega multiplicador ATR baseado na categoria do par
// ============================================
// 🆕 V6.2: SISTEMA DE NÍVEIS DE ENTRADA
// ============================================

// 🆕 V6.2: Detecta tendência por timeframe específico
function getTFTrend(structure, indicators, price) {
  // Combina structure + EMA21 + MACD para determinar tendência
  
  if (!structure || !indicators || !indicators.ema21) {
    return 'neutral';
  }
  
  const aboveEMA = price > indicators.ema21;
  const belowEMA = price < indicators.ema21;
  const macdBullish = indicators.macd && indicators.macd.histogram > 0;
  const macdBearish = indicators.macd && indicators.macd.histogram < 0;
  
  // BULLISH: structure bullish + acima EMA + MACD positivo
  if (structure.trend === 'bullish' && aboveEMA && macdBullish) {
    return 'bullish';
  }
  
  // BEARISH: structure bearish + abaixo EMA + MACD negativo
  if (structure.trend === 'bearish' && belowEMA && macdBearish) {
    return 'bearish';
  }
  
  // BULLISH FRACO: 2 de 3 indicadores positivos
  let bullScore = 0;
  if (structure.trend === 'bullish') bullScore++;
  if (aboveEMA) bullScore++;
  if (macdBullish) bullScore++;
  
  let bearScore = 0;
  if (structure.trend === 'bearish') bearScore++;
  if (belowEMA) bearScore++;
  if (macdBearish) bearScore++;
  
  if (bullScore >= 2 && bearScore < 2) return 'bullish';
  if (bearScore >= 2 && bullScore < 2) return 'bearish';
  
  return 'neutral';
}

// 🆕 V6.2: Calcula score de timeframes (4h + 1h + 15m)
function calculateTFScore(direction, trend4h, trend1h, setupQuality15m) {
  let score = 0;
  const breakdown = {};
  
  const dirMatch = direction === 'LONG' ? 'bullish' : 'bearish';
  const dirOpposite = direction === 'LONG' ? 'bearish' : 'bullish';
  
  // 4h - peso leve (contexto)
  if (trend4h === dirMatch) {
    score += CONFIG.tfWeights.h4.aligned;
    breakdown.h4 = { value: CONFIG.tfWeights.h4.aligned, status: 'aligned' };
  } else if (trend4h === dirOpposite) {
    score += CONFIG.tfWeights.h4.opposite;
    breakdown.h4 = { value: CONFIG.tfWeights.h4.opposite, status: 'opposite' };
  } else {
    score += CONFIG.tfWeights.h4.neutral;
    breakdown.h4 = { value: CONFIG.tfWeights.h4.neutral, status: 'neutral' };
  }
  
  // 1h - peso alto (direção)
  if (trend1h === dirMatch) {
    score += CONFIG.tfWeights.h1.aligned;
    breakdown.h1 = { value: CONFIG.tfWeights.h1.aligned, status: 'aligned' };
  } else if (trend1h === dirOpposite) {
    score += CONFIG.tfWeights.h1.opposite;
    breakdown.h1 = { value: CONFIG.tfWeights.h1.opposite, status: 'opposite' };
  } else {
    breakdown.h1 = { value: 0, status: 'neutral' };
  }
  
  // 15m - peso máximo (setup)
  if (setupQuality15m === 'strong') {
    score += CONFIG.tfWeights.m15.strong;
    breakdown.m15 = { value: CONFIG.tfWeights.m15.strong, status: 'strong' };
  } else if (setupQuality15m === 'medium') {
    score += CONFIG.tfWeights.m15.medium;
    breakdown.m15 = { value: CONFIG.tfWeights.m15.medium, status: 'medium' };
  } else {
    score += CONFIG.tfWeights.m15.weak;
    breakdown.m15 = { value: CONFIG.tfWeights.m15.weak, status: 'weak' };
  }
  
  return { score, breakdown };
}

// 🆕 V6.2: Determina nível de entrada baseado no TF score
function determineEntryLevel(tfResult, direction, trend4h) {
  const { score, breakdown } = tfResult;
  const dirMatch = direction === 'LONG' ? 'bullish' : 'bearish';
  const dirOpposite = direction === 'LONG' ? 'bearish' : 'bullish';
  
  const aligned4h = trend4h === dirMatch;
  const opposite4h = trend4h === dirOpposite;
  const neutral4h = !aligned4h && !opposite4h;
  
  const aligned1h = breakdown.h1.status === 'aligned';
  const setup15mGood = breakdown.m15.status === 'strong' || breakdown.m15.status === 'medium';
  
  // Verifica requisitos mínimos: 1h + 15m alinhados
  if (!aligned1h || !setup15mGood) {
    return null; // REJEITADO
  }
  
  // PREMIUM: tudo alinhado + setup forte
  if (aligned4h && breakdown.m15.status === 'strong' && score >= CONFIG.entryLevels.premium.minTFScore) {
    return {
      level: 'premium',
      label: CONFIG.entryLevels.premium.label,
      description: CONFIG.entryLevels.premium.description,
      tps: CONFIG.tpFixed,           // TPs normais
      tpType: 'normal'
    };
  }
  
  // AGRESSIVO: 4h contra
  if (opposite4h && score >= CONFIG.entryLevels.aggressive.minTFScore) {
    return {
      level: 'aggressive',
      label: CONFIG.entryLevels.aggressive.label,
      description: CONFIG.entryLevels.aggressive.description,
      tps: CONFIG.tpAggressive,      // TPs MENORES
      tpType: 'aggressive'
    };
  }
  
  // NORMAL: 4h neutro ou alinhado mas setup não premium
  if (score >= CONFIG.entryLevels.normal.minTFScore) {
    return {
      level: 'normal',
      label: CONFIG.entryLevels.normal.label,
      description: CONFIG.entryLevels.normal.description,
      tps: CONFIG.tpFixed,           // TPs normais
      tpType: 'normal'
    };
  }
  
  // Score baixo = REJEITADO
  return null;
}

// 🆕 V6.2: Avalia qualidade do setup 15m
function evaluateSetupQuality(structure, confluences, score) {
  // FORTE: structure clara + 5+ confluências + score alto base
  if (structure.choch && structure.bos && score >= 60) {
    return 'strong';
  }
  
  // FRACA: estrutura mal definida
  if (!structure.trend || structure.trend === 'neutral') {
    return 'weak';
  }
  
  // MÉDIO: padrão
  return 'medium';
}

// ============================================

function getCategoryATRMult(symbol) {
  for (const [catKey, catData] of Object.entries(CONFIG.stopByCategory)) {
    if (catData.pairs.includes(symbol)) {
      return {
        multiplier: catData.atrMultiplier,
        category: catKey,
        label: catData.label
      };
    }
  }
  // Fallback se não estiver categorizado
  return {
    multiplier: CONFIG.atrMultiplier,
    category: 'default',
    label: '⚪ Default'
  };
}

// 🆕 V6.0: Detecta tendência do BTC no 4h
async function getBTCTrend() {
  try {
    const btcCandles = await getCandlesticks('BTCUSDT', '4h', 10);
    
    if (!btcCandles || btcCandles.length < 5) {
      return { direction: 'unknown', change: 0, error: 'Sem dados BTC' };
    }
    
    // Pega últimos 4 candles fechados (16h de história)
    const recent = btcCandles.slice(-5, -1); // ignora candle atual aberto
    const oldestPrice = recent[0].close;
    const newestPrice = recent[recent.length - 1].close;
    
    const changePct = ((newestPrice - oldestPrice) / oldestPrice) * 100;
    
    // Determina direção
    let direction;
    if (Math.abs(changePct) < CONFIG.btcFilter.threshold) {
      direction = 'lateral';
    } else if (changePct > 0) {
      direction = 'up';
    } else {
      direction = 'down';
    }
    
    // Atualiza state
    state.btcStatus.direction = direction;
    state.btcStatus.change4h = changePct;
    state.btcStatus.lastUpdate = new Date().toISOString();
    
    return {
      direction,
      change: changePct,
      currentPrice: newestPrice
    };
  } catch (error) {
    addLog(`Erro ao detectar BTC trend: ${error.message}`, 'error');
    return { direction: 'unknown', change: 0, error: error.message };
  }
}

// 🆕 V6.0: Verifica volatilidade do BTC (movimento 1h)
async function checkBTCVolatility() {
  try {
    const btcCandles = await getCandlesticks('BTCUSDT', '15m', 8);
    if (!btcCandles || btcCandles.length < 4) return null;
    
    // Últimas 4 velas de 15m = 1h
    const last1h = btcCandles.slice(-5, -1);
    const oldest = last1h[0].close;
    const newest = last1h[last1h.length - 1].close;
    
    const changePct = ((newest - oldest) / oldest) * 100;
    
    // Se movimento > threshold, é volátil
    if (Math.abs(changePct) >= CONFIG.volatilityAlert.btcThreshold) {
      // Verifica cooldown
      const now = Date.now();
      const lastAlert = state.btcStatus.lastVolatilityAlert ? 
                       new Date(state.btcStatus.lastVolatilityAlert).getTime() : 0;
      const minutesSinceLastAlert = (now - lastAlert) / 60000;
      
      if (minutesSinceLastAlert >= CONFIG.volatilityAlert.cooldownMinutes) {
        return { isVolatile: true, change: changePct };
      }
    }
    
    return { isVolatile: false, change: changePct };
  } catch (error) {
    return null;
  }
}

// 🆕 V6.0: Aplica filtro BTC no score
function applyBTCFilter(score, signalDirection, symbol, btcTrend) {
  // Exceção: BTC, ETH, BNB não sofrem filtro
  if (['BTCUSDT', 'ETHUSDT', 'BNBUSDT'].includes(symbol)) {
    return { score, btcAlignment: 'self' };
  }
  
  // Se BTC lateral, sem penalidade
  if (btcTrend.direction === 'lateral' || btcTrend.direction === 'unknown') {
    return { score, btcAlignment: 'lateral' };
  }
  
  // BTC alta + sinal LONG = alinhado
  // BTC baixa + sinal SHORT = alinhado
  const isAligned = (btcTrend.direction === 'up' && signalDirection === 'LONG') ||
                    (btcTrend.direction === 'down' && signalDirection === 'SHORT');
  
  if (isAligned) {
    return { score, btcAlignment: 'aligned' };
  }
  
  // Sinal contra BTC = penalidade
  return { 
    score: score - CONFIG.btcFilter.penaltyContra,
    btcAlignment: 'against'
  };
}

// 🆕 V6.0: Calcula Setup Quality (estrelas)
function calculateSetupQuality(signal) {
  let stars = 0;
  
  // Critério 1: Score
  if (signal.score >= 90) stars += 2;
  else if (signal.score >= 80) stars += 1;
  
  // Critério 2: Volume
  const volRatio = parseFloat(signal.volumeRatio);
  if (volRatio >= 3.0) stars += 1;
  if (volRatio >= 4.0) stars += 1;
  
  // Critério 3: ADX (tendência forte)
  const adx = parseFloat(signal.adx);
  if (adx >= 30) stars += 1;
  
  // Critério 4: BTC alinhado
  if (signal.btcAlignment === 'aligned') stars += 1;
  if (signal.btcAlignment === 'self') stars += 1; // BTC/ETH/BNB
  
  // Limita a 5 estrelas
  stars = Math.min(stars, 5);
  
  // Garante mínimo 1
  stars = Math.max(stars, 1);
  
  const labels = {
    1: 'BÁSICO',
    2: 'MODERADO',
    3: 'BOM',
    4: 'MUITO BOM',
    5: 'PREMIUM'
  };
  
  return {
    stars,
    visual: '⭐'.repeat(stars) + '☆'.repeat(5 - stars),
    label: labels[stars]
  };
}

// 🆕 V6.0: Sistema de Aprendizado por par
function getLearningAdjustment(symbol) {
  const learn = state.learning.bySymbol[symbol];
  
  if (!learn || learn.trades < 5) {
    return 0; // Sem dados suficientes, sem ajuste
  }
  
  // Calcula ajuste baseado no winRate
  // > 70% winRate: +5 pontos (confiável)
  // 50-70%: 0 pontos (neutro)
  // < 50%: -5 pontos (questionável)
  // < 30%: -10 pontos (problemático)
  
  if (learn.winRate >= 70) return 5;
  if (learn.winRate >= 50) return 0;
  if (learn.winRate >= 30) return -5;
  return -10;
}

// 🆕 V6.0: Atualiza aprendizado após trade fechado manualmente
function updateLearning(symbol, result) {
  if (!state.learning.bySymbol[symbol]) {
    state.learning.bySymbol[symbol] = {
      trades: 0,
      wins: 0,
      losses: 0,
      breakeven: 0,
      winRate: 0,
      lastUpdate: null
    };
  }
  
  const learn = state.learning.bySymbol[symbol];
  learn.trades++;
  
  if (result === 'win') learn.wins++;
  else if (result === 'loss') learn.losses++;
  else if (result === 'breakeven') learn.breakeven++;
  
  // Recalcula winRate (considerando BE como neutro)
  const decisive = learn.wins + learn.losses;
  if (decisive > 0) {
    learn.winRate = (learn.wins / decisive) * 100;
  }
  
  learn.lastUpdate = new Date().toISOString();
}

// 🆕 V6.0: Formata horário corretamente para BR
function formatBrazilTime(date = new Date()) {
  return date.toLocaleTimeString('pt-BR', { 
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function formatBrazilDate(date = new Date()) {
  return date.toLocaleDateString('pt-BR', { 
    timeZone: 'America/Sao_Paulo'
  });
}

function formatBrazilDateTime(date = new Date()) {
  return `${formatBrazilDate(date)} ${formatBrazilTime(date)}`;
}

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
// 🆕 FASE 3: DETECÇÃO REAL DE MARKET STRUCTURE
// ============================================

function detectMarketStructure(candles) {
  const len = candles.length;
  const swings = [];
  
  // Detecta swing highs e lows com confirmação mais forte
  for (let i = 5; i < len - 5; i++) {
    const current = candles[i];
    const before = candles.slice(i - 5, i);
    const after = candles.slice(i + 1, i + 6);
    
    // Swing High: pico confirmado
    if (before.every(c => c.high < current.high) && after.every(c => c.high < current.high)) {
      swings.push({ index: i, type: 'high', price: current.high, time: current.time });
    }
    
    // Swing Low: vale confirmado
    if (before.every(c => c.low > current.low) && after.every(c => c.low > current.low)) {
      swings.push({ index: i, type: 'low', price: current.low, time: current.time });
    }
  }
  
  if (swings.length < 4) return null;
  
  // 🆕 FASE 3: CHoCH e BOS REAIS
  const recent = swings.slice(-6); // Analisa últimos 6 swings
  let trend = null, structure = null, choch = false, bos = false;
  
  const highs = recent.filter(s => s.type === 'high');
  const lows = recent.filter(s => s.type === 'low');
  
  if (highs.length >= 2 && lows.length >= 2) {
    const lastHigh = highs[highs.length - 1].price;
    const prevHigh = highs[highs.length - 2].price;
    const lastLow = lows[lows.length - 1].price;
    const prevLow = lows[lows.length - 2].price;
    
    // Tendência de alta: HH + HL
    if (lastHigh > prevHigh && lastLow > prevLow) {
      trend = 'bullish';
      structure = 'HH + HL';
    }
    // Tendência de baixa: LH + LL
    else if (lastHigh < prevHigh && lastLow < prevLow) {
      trend = 'bearish';
      structure = 'LH + LL';
    }
  }
  
  // 🆕 FASE 3: CHoCH (Change of Character) REAL
  // CHoCH = sinal de POSSÍVEL reversão (não muda trend imediatamente)
  // 🔧 FIX: Apenas marca flag, sem alterar trend (evita sinais contraditórios)
  if (recent.length >= 4) {
    const currentPrice = candles[len - 1].close;
    
    // CHoCH Bearish: preço quebra low anterior em uptrend (possível reversão)
    if (trend === 'bullish' && lows.length >= 2) {
      const lastLow = lows[lows.length - 1].price;
      if (currentPrice < lastLow) {
        choch = true;
        // 🔧 NÃO muda trend aqui - apenas sinaliza mudança
      }
    }
    
    // CHoCH Bullish: preço quebra high anterior em downtrend (possível reversão)
    if (trend === 'bearish' && highs.length >= 2) {
      const lastHigh = highs[highs.length - 1].price;
      if (currentPrice > lastHigh) {
        choch = true;
        // 🔧 NÃO muda trend aqui - apenas sinaliza mudança
      }
    }
  }
  
  // 🆕 FASE 3: BOS (Break of Structure) REAL
  // BOS = confirmação de tendência (quebra de high/low principal)
  if (highs.length >= 2 && lows.length >= 2) {
    const currentPrice = candles[len - 1].close;
    const maxHigh = Math.max(...highs.map(h => h.price));
    const minLow = Math.min(...lows.map(l => l.price));
    
    // BOS Bullish: quebra high mais alto
    if (trend === 'bullish' && currentPrice > maxHigh * 1.001) { // 0.1% margem
      bos = true;
    }
    
    // BOS Bearish: quebra low mais baixo
    if (trend === 'bearish' && currentPrice < minLow * 0.999) { // 0.1% margem
      bos = true;
    }
  }
  
  const allHighs = highs.map(h => h.price);
  const allLows = lows.map(l => l.price);
  
  return { 
    trend, 
    structure, 
    choch, 
    bos, 
    swings: recent, 
    lastHigh: allHighs.length > 0 ? Math.max(...allHighs) : 0, 
    lastLow: allLows.length > 0 ? Math.min(...allLows) : 0 
  };
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

// 🆕 FASE 3: ORDER BLOCKS REAIS
function detectOrderBlock(candles) {
  // 🔧 FIX: Validação de dados
  if (!candles || candles.length < 20) return null;
  
  const last20 = candles.slice(-20);
  let orderBlocks = [];
  
  for (let i = 0; i < last20.length - 2; i++) {
    const current = last20[i];
    const next = last20[i + 1];
    const next2 = last20[i + 2];
    
    const currentBody = Math.abs(current.close - current.open);
    const avgBody = last20.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / 20;
    const avgVolume = last20.reduce((sum, c) => sum + c.volume, 0) / 20;
    
    // Bullish Order Block: vela bearish forte seguida de movimento alcista
    if (current.close < current.open && // Vela vermelha
        currentBody > avgBody * 1.3 &&   // Corpo > 30% média
        current.volume > avgVolume * 1.2 && // Volume alto
        next.close > next.open &&        // Próxima verde
        next2.close > next2.open) {      // Confirmação
      
      orderBlocks.push({
        type: 'bullish',
        zone: [current.low, current.high],
        strength: (currentBody / avgBody) * (current.volume / avgVolume),
        time: current.time,
        price: (current.low + current.high) / 2
      });
    }
    
    // Bearish Order Block: vela bullish forte seguida de movimento baixista
    if (current.close > current.open && // Vela verde
        currentBody > avgBody * 1.3 &&   // Corpo > 30% média
        current.volume > avgVolume * 1.2 && // Volume alto
        next.close < next.open &&        // Próxima vermelha
        next2.close < next2.open) {      // Confirmação
      
      orderBlocks.push({
        type: 'bearish',
        zone: [current.low, current.high],
        strength: (currentBody / avgBody) * (current.volume / avgVolume),
        time: current.time,
        price: (current.low + current.high) / 2
      });
    }
  }
  
  // 🔧 FIX: Retorna OB mais RECENTE (não mais forte)
  // Order Block mais recente é mais relevante
  if (orderBlocks.length === 0) return null;
  return orderBlocks[orderBlocks.length - 1];
}

// 🆕 FASE 3: FVG (FAIR VALUE GAP) REAL
function detectFVG(candles) {
  // 🔧 FIX: Validação de dados
  if (!candles || candles.length < 10) return null;
  
  const last10 = candles.slice(-10);
  let fvgs = [];
  
  for (let i = 0; i < last10.length - 2; i++) {
    const first = last10[i];
    const middle = last10[i + 1];
    const third = last10[i + 2];
    
    const firstRange = first.high - first.low;
    const avgRange = last10.reduce((sum, c) => sum + (c.high - c.low), 0) / 10;
    
    // Bullish FVG: gap pra cima (third.low > first.high)
    if (third.low > first.high) {
      const gap = third.low - first.high;
      const gapPercent = gap / first.close;
      
      // Gap deve ser significativo (> 0.1% e > 20% do range médio)
      if (gapPercent > 0.001 && gap > avgRange * 0.2) {
        fvgs.push({
          type: 'bullish',
          gap,
          gapPercent,
          zone: [first.high, third.low],
          strength: gap / avgRange,
          time: third.time
        });
      }
    }
    
    // Bearish FVG: gap pra baixo (third.high < first.low)
    if (third.high < first.low) {
      const gap = first.low - third.high;
      const gapPercent = gap / first.close;
      
      // Gap deve ser significativo
      if (gapPercent > 0.001 && gap > avgRange * 0.2) {
        fvgs.push({
          type: 'bearish',
          gap,
          gapPercent,
          zone: [third.high, first.low],
          strength: gap / avgRange,
          time: third.time
        });
      }
    }
  }
  
  // 🔧 FIX: Retorna FVG mais RECENTE (não mais forte)
  // FVG mais recente é mais relevante para trade atual
  if (fvgs.length === 0) return null;
  
  // Retorna o último FVG detectado (mais recente)
  return fvgs[fvgs.length - 1];
}

// 🆕 FASE 3: LIQUIDITY ZONES REAIS
function detectLiquidity(candles, marketStructure) {
  if (!marketStructure || !marketStructure.swings) return null;
  
  const { swings } = marketStructure;
  const currentPrice = candles[candles.length - 1].close;
  const last20 = candles.slice(-20);
  
  // Zonas de liquidez = onde stops estão concentrados
  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');
  
  // Liquidity acima do preço (resistance)
  const aboveLiquidity = highs
    .filter(h => h.price > currentPrice)
    .map(h => ({
      price: h.price,
      type: 'sell_stops',
      distance: ((h.price - currentPrice) / currentPrice) * 100
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3);
  
  // Liquidity abaixo do preço (support)
  const belowLiquidity = lows
    .filter(l => l.price < currentPrice)
    .map(l => ({
      price: l.price,
      type: 'buy_stops',
      distance: ((currentPrice - l.price) / currentPrice) * 100
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3);
  
  // Verifica se liquidez foi "swept" (capturada)
  const recentHigh = Math.max(...last20.map(c => c.high));
  const recentLow = Math.min(...last20.map(c => c.low));
  
  let captured = null;
  
  if (aboveLiquidity.length > 0 && recentHigh > aboveLiquidity[0].price && currentPrice < aboveLiquidity[0].price) {
    captured = 'above';
  }
  
  if (belowLiquidity.length > 0 && recentLow < belowLiquidity[0].price && currentPrice > belowLiquidity[0].price) {
    captured = 'below';
  }
  
  return { 
    above: aboveLiquidity.map(l => l.price), 
    below: belowLiquidity.map(l => l.price), 
    captured 
  };
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
  
  // 🆕 FASE 1: ADX para detectar força de tendência
  const adx = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
  
  return {
    rsi: rsi[rsi.length - 1], 
    macd: macd[macd.length - 1],
    ema20: ema20[ema20.length - 1], 
    ema50: ema50[ema50.length - 1],
    ema200: ema200[ema200.length - 1], 
    atr: atr[atr.length - 1], 
    adx: adx[adx.length - 1]?.adx || 0,  // 🆕 FASE 1
    price: closes[closes.length - 1]
  };
}

// 🆕 FASE 1: Análise de volume melhorada (24h ao invés de 20 velas)
function analyzeVolume(candles) {
  const volumes = candles.map(c => c.volume);
  
  // 🔧 FIX CRÍTICO: Ignora a ÚLTIMA vela (pode estar ABERTA com volume parcial)
  const fechadas = volumes.slice(0, -1);
  
  // Pega últimas 96 velas FECHADAS para média de 24h
  const last96 = fechadas.slice(-96);
  const numVelas = last96.length;
  
  if (numVelas < 10) {
    return { 
      current: 0, average: 0, ratio: 0, spike: false, increasing: false,
      pattern: 'insufficient_data',
      patternLabel: '⚠️ Dados insuficientes',
      patternScore: 0,
      patternValid: false,
      patternReason: 'Menos de 10 velas',
      ratios: []
    };
  }
  
  // Volume médio 24h (96 velas fechadas de 15min = 24h)
  const avgVolume24h = last96.reduce((a, b) => a + b, 0) / numVelas;
  
  // Pega últimos 4 candles fechados para análise contextual
  const last4 = fechadas.slice(-4);
  
  // Calcula ratios (mais antigo → mais novo)
  const ratios = last4.map(v => avgVolume24h > 0 ? v / avgVolume24h : 0);
  
  // Garante que temos 4 ratios (preenche com 0 se faltar)
  while (ratios.length < 4) ratios.unshift(0);
  
  const [r3, r2, r1, r0] = ratios; // r0 = mais recente
  
  // 🆕 V6.2: ANÁLISE DE PADRÃO PROFISSIONAL
  const pattern = detectVolumePattern(r3, r2, r1, r0);
  
  return { 
    current: last4[last4.length - 1] || 0, 
    average: avgVolume24h, 
    ratio: r0,                    // mantém compatibilidade
    spike: r0 > 2.0 || r1 > 2.0,
    increasing: r3 < r2 && r2 < r1 && r1 < r0,
    // 🆕 V6.2: Novos campos
    ratios: ratios,
    pattern: pattern.pattern,
    patternLabel: pattern.label,
    patternScore: pattern.score,
    patternValid: pattern.valid,
    patternReason: pattern.reason
  };
}

// 🆕 V6.2: DETECÇÃO DE PADRÃO PROFISSIONAL DE VOLUME
function detectVolumePattern(r3, r2, r1, r0) {
  // r0 = mais recente, r3 = mais antigo
  
  // 🚨 CRESCENTE SUSTENTADO - Acumulação saudável
  if (r3 < r2 && r2 < r1 && r1 < r0 && r0 >= 1.2) {
    return {
      pattern: 'crescent',
      label: '📈 Volume Crescente',
      score: 20,
      valid: true,
      reason: `Acumulação: ${r3.toFixed(1)}→${r2.toFixed(1)}→${r1.toFixed(1)}→${r0.toFixed(1)}x`
    };
  }
  
  // 💥 SPIKE + CONTINUIDADE - Movimento institucional
  // Spike grande seguido de volume sustentado (não morre)
  const hadSpike = r1 > 2.5 || r2 > 2.5;
  if (hadSpike && r0 >= 1.3 && r0 >= r1 * 0.5) {
    return {
      pattern: 'spike_continuity',
      label: '💥 Spike + Continuidade',
      score: 18,
      valid: true,
      reason: `Spike ${Math.max(r1,r2).toFixed(1)}x + continuidade ${r0.toFixed(1)}x`
    };
  }
  
  // ⚠️ SPIKE + EXAUSTÃO - PEGADINHA! Volume morreu após spike
  // Tinha spike forte e agora morreu drasticamente
  if (hadSpike && r0 < 0.9) {
    return {
      pattern: 'spike_exhaustion',
      label: '⚠️ Spike + Exaustão',
      score: -15,
      valid: false,
      reason: `Spike ${Math.max(r1,r2).toFixed(1)}x mas morreu (${r0.toFixed(1)}x)`
    };
  }
  
  // 🌊 MÉDIA CONSISTENTE - Interesse contínuo
  // Volume sustentado acima da média sem grande variação
  const avg3 = (r0 + r1 + r2) / 3;
  const maxR = Math.max(r0, r1, r2);
  const minR = Math.min(r0, r1, r2);
  const isSustained = avg3 >= 1.15 && (maxR - minR) < 0.6;
  
  if (isSustained) {
    return {
      pattern: 'sustained',
      label: '🌊 Volume Consistente',
      score: 12,
      valid: true,
      reason: `Média 3 velas: ${avg3.toFixed(2)}x sustentado`
    };
  }
  
  // 📉 DECRESCENTE - Movimento perdendo força
  if (r3 > r2 && r2 > r1 && r1 > r0 && r3 > 1.5) {
    return {
      pattern: 'decrescent',
      label: '📉 Volume Decrescente',
      score: -8,
      valid: false,
      reason: `Esfriando: ${r3.toFixed(1)}→${r2.toFixed(1)}→${r1.toFixed(1)}→${r0.toFixed(1)}x`
    };
  }
  
  // 💀 VOLUME MORTO - Sem interesse
  if (avg3 < 0.9) {
    return {
      pattern: 'dead',
      label: '💀 Volume Morto',
      score: -12,
      valid: false,
      reason: `Sem interesse (média ${avg3.toFixed(2)}x)`
    };
  }
  
  // ✅ SPIKE ISOLADO - Volume só na vela atual (suspeito)
  if (r0 > 2.0 && r1 < 1.0 && r2 < 1.0) {
    return {
      pattern: 'isolated_spike',
      label: '⚡ Spike Isolado',
      score: 5,  // pode ser bom mas requer confirmação
      valid: true,
      reason: `Spike ${r0.toFixed(1)}x sem contexto anterior`
    };
  }
  
  // ✅ VOLUME OK SIMPLES - Atual acima da média (mantém compatibilidade)
  if (r0 >= 1.2) {
    return {
      pattern: 'simple_ok',
      label: '✅ Volume OK',
      score: 8,
      valid: true,
      reason: `Atual ${r0.toFixed(2)}x média`
    };
  }
  
  // ❌ VOLUME BAIXO - Não atende mínimo
  return {
    pattern: 'low',
    label: '❌ Volume Baixo',
    score: -5,
    valid: false,
    reason: `Atual ${r0.toFixed(2)}x < 1.2x mínimo`
  };
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
    // 🚀 OTIMIZAÇÃO: Pega os 3 timeframes em paralelo (3x mais rápido)
    const [candles15m, candles1h, candles4h] = await Promise.all([
      getCandlesticks(symbol, '15m', 200),
      getCandlesticks(symbol, '1h', 200),
      getCandlesticks(symbol, '4h', 100)
    ]);
    
    // 🔧 Validação mais específica de cada timeframe
    if (!candles15m || candles15m.length < 50) {
      return { valid: false, reason: 'Dados 15m insuficientes' };
    }
    if (!candles1h || candles1h.length < 50) {
      return { valid: false, reason: 'Dados 1h insuficientes' };
    }
    if (!candles4h || candles4h.length < 30) {
      return { valid: false, reason: 'Dados 4h insuficientes' };
    }
    
    const structure15m = detectMarketStructure(candles15m);
    const structure1h = detectMarketStructure(candles1h);
    const structure4h = detectMarketStructure(candles4h);
    
    if (!structure15m || !structure15m.trend) return { valid: false, reason: 'Sem estrutura 15m' };
    if (!structure1h || !structure1h.trend) return { valid: false, reason: 'Sem estrutura 1h' };
    if (!structure4h || !structure4h.trend) return { valid: false, reason: 'Sem estrutura 4h' };
    
    const ind15m = calculateIndicators(candles15m);
    const ind1h = calculateIndicators(candles1h);
    const ind4h = calculateIndicators(candles4h);
    
    // 🆕 FASE 1: FILTRO ADX - Rejeita mercados laterais
    if (ind15m.adx < CONFIG.minADX) {
      return { 
        valid: false, 
        reason: `Mercado lateral (ADX: ${ind15m.adx.toFixed(1)} < ${CONFIG.minADX})`,
        adx: ind15m.adx.toFixed(1),
        direction: structure15m.trend === 'bullish' ? 'LONG' : 'SHORT'
      };
    }
    
    const volume = analyzeVolume(candles15m);
    
    // 🆕 V6.2: FILTRO PADRÃO VOLUME - rejeita padrões problemáticos
    // Padrões inválidos: spike_exhaustion, decrescent, dead, low
    if (!volume.patternValid && volume.pattern !== 'insufficient_data') {
      return {
        valid: false,
        reason: `Volume: ${volume.patternLabel} - ${volume.patternReason}`,
        volumeRatio: volume.ratio.toFixed(2),
        volumePattern: volume.pattern,
        adx: ind15m.adx.toFixed(1),
        direction: structure15m.trend === 'bullish' ? 'LONG' : 'SHORT'
      };
    }
    
    // 🆕 FASE 1: FILTRO VOLUME (mantém compatibilidade) - Rejeita volume muito baixo
    if (volume.ratio < CONFIG.volumeMultiplier) {
      return { 
        valid: false, 
        reason: `Volume baixo (${volume.ratio.toFixed(2)}x < ${CONFIG.volumeMultiplier}x)`,
        volumeRatio: volume.ratio.toFixed(2),
        adx: ind15m.adx.toFixed(1),
        direction: structure15m.trend === 'bullish' ? 'LONG' : 'SHORT'
      };
    }
    
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
    
    // 🆕 PENALIDADES: Indicadores contra a tendência SUBTRAEM pontos
    if (ind15m.macd) {
      if (ind15m.macd.MACD < ind15m.macd.signal && structure15m.trend === 'bullish') {
        score -= 10;
        confluences.push('⚠️ MACD contra');
      }
      if (ind15m.macd.MACD > ind15m.macd.signal && structure15m.trend === 'bearish') {
        score -= 10;
        confluences.push('⚠️ MACD contra');
      }
    }
    
    // 🆕 Penalidade se EMAs estão contra a tendência
    if (structure15m.trend === 'bullish' && !emaTrend15m) {
      score -= 15;
      confluences.push('⚠️ EMAs contra');
    }
    if (structure15m.trend === 'bearish' && emaTrend15m) {
      score -= 15;
      confluences.push('⚠️ EMAs contra');
    }
    
    if (ind15m.rsi < 40 && structure15m.trend === 'bullish') { confluences.push('RSI Oversold'); score += CONFIG.scoreWeights.rsi; }
    if (ind15m.rsi > 60 && structure15m.trend === 'bearish') { confluences.push('RSI Overbought'); score += CONFIG.scoreWeights.rsi; }
    
    if (sr) { confluences.push('S/R'); score += CONFIG.scoreWeights.sr; }
    
    // 🆕 V6.2: PADRÃO DE VOLUME PROFISSIONAL
    // Substitui análise simples por detecção de 8 padrões diferentes
    if (volume.pattern && volume.pattern !== 'insufficient_data') {
      confluences.push(volume.patternLabel);
      score += volume.patternScore;
      
      // Log do padrão para debug (opcional)
      if (volume.patternScore !== 0) {
        addLog(`📊 ${symbol}: ${volume.patternLabel} (${volume.patternScore > 0 ? '+' : ''}${volume.patternScore} pts)`, 'info');
      }
    }
    
    // 🆕 FASE 1: BONUS ADX Forte (> 30)
    if (ind15m.adx > 30) {
      confluences.push(`ADX Forte (${ind15m.adx.toFixed(0)})`);
      score += CONFIG.scoreWeights.adxBonus;
    }
    
    // 🆕 V6.2: BONUS Volume Extremo apenas se padrão for VÁLIDO
    // (evita pontuar spike + exaustão como bom)
    if (volume.ratio > 2.5 && volume.patternValid) {
      confluences.push(`Volume Extremo (${volume.ratio.toFixed(1)}x)`);
      score += 5;
    }
    
    // 🆕 FASE 2: SESSION SCORE (Horários Premium)
    const sessionScore = getSessionScore();
    score += sessionScore;
    if (sessionScore > 0) {
      confluences.push('Horário Premium');
    } else if (sessionScore < 0) {
      // Dead zone - penaliza mas não rejeita (pode ter setup excepcional)
      confluences.push('Horário Fraco');
    }
    
    // 🆕 V6.2: NOVO SISTEMA DE NÍVEIS DE ENTRADA (substitui alinhamento rígido)
    const direction = structure15m.trend === 'bullish' ? 'LONG' : 'SHORT';
    
    // Detecta tendência por TF usando structure + indicadores
    const trend15m = getTFTrend(structure15m, ind15m, candles15m[candles15m.length-1].close);
    const trend1h = getTFTrend(structure1h, ind1h, candles1h[candles1h.length-1].close);
    const trend4h = getTFTrend(structure4h, ind4h, candles4h[candles4h.length-1].close);
    
    // Avalia qualidade do setup 15m
    const setupQuality15m = evaluateSetupQuality(structure15m, confluences, score);
    
    // Calcula score por timeframe
    const tfResult = calculateTFScore(direction, trend4h, trend1h, setupQuality15m);
    
    // Determina nível de entrada (Premium/Normal/Agressivo/Rejeitado)
    const entryLevel = determineEntryLevel(tfResult, direction, trend4h);
    
    if (!entryLevel) {
      return {
        valid: false,
        reason: `Setup TF inválido: 4h=${trend4h} 1h=${trend1h} 15m=${setupQuality15m} (TF score: ${tfResult.score})`,
        score: score,
        volumeRatio: volume.ratio.toFixed(2),
        adx: ind15m.adx.toFixed(1),
        direction: direction,
        tfScore: tfResult.score
      };
    }
    
    // Adiciona score do TF ao score base
    score += tfResult.score;
    
    // Confluences contextual
    confluences.push(`${entryLevel.label}`);
    if (trend4h === 'bullish' && direction === 'LONG' || trend4h === 'bearish' && direction === 'SHORT') {
      confluences.push(`📈 4h alinhado`);
    } else if (trend4h === 'bullish' && direction === 'SHORT' || trend4h === 'bearish' && direction === 'LONG') {
      confluences.push(`⚠️ 4h contra (entry agressiva)`);
    } else {
      confluences.push(`➡️ 4h neutro`);
    }
    
    addLog(`📊 ${symbol}: ${entryLevel.label} (TF: ${tfResult.score}, 4h:${trend4h} 1h:${trend1h} 15m:${setupQuality15m})`, 'info');
    
    // 🆕 V6.0: APLICA FILTRO BTC (-25 se contra)
    const btcTrend = state.btcStatus.direction !== 'unknown' ? 
                     { direction: state.btcStatus.direction, change: state.btcStatus.change4h } :
                     await getBTCTrend();
    
    const btcResult = applyBTCFilter(score, direction, symbol, btcTrend);
    score = btcResult.score;
    const btcAlignment = btcResult.btcAlignment;
    
    if (btcAlignment === 'against') {
      confluences.push(`⚠️ BTC contra (${btcTrend.change > 0 ? '📈' : '📉'} ${btcTrend.change.toFixed(2)}%)`);
    } else if (btcAlignment === 'aligned') {
      confluences.push(`✅ BTC alinhado (${btcTrend.change > 0 ? '📈' : '📉'} ${btcTrend.change.toFixed(2)}%)`);
    }
    
    // 🆕 V6.0: APLICA APRENDIZADO POR PAR
    const learningAdjust = getLearningAdjustment(symbol);
    if (learningAdjust !== 0) {
      score += learningAdjust;
      if (learningAdjust > 0) {
        confluences.push(`📚 Histórico bom (+${learningAdjust})`);
      } else {
        confluences.push(`⚠️ Histórico ruim (${learningAdjust})`);
      }
    }
    
    if (score < CONFIG.minScore) return { 
      valid: false, 
      reason: `Score baixo: ${score}/${CONFIG.minScore}${btcAlignment === 'against' ? ' (BTC contra -25)' : ''}`,
      score: score,
      volumeRatio: volume.ratio.toFixed(2),
      adx: ind15m.adx.toFixed(1),
      direction: direction
    };
    
    // 🆕 FASE 2: FILTRO DE CORRELAÇÃO
    if (hasActiveTradeInGroup(symbol, direction)) {
      return { 
        valid: false, 
        reason: `Grupo ${findCorrelationGroup(symbol)} já tem trade ${direction}` 
      };
    }
    
    const recentSignals = state.signals.slice(0, 20);
    const recentSame = recentSignals.find(s => s.symbol === symbol);
    if (recentSame) {
      const timeSince = Date.now() - new Date(recentSame.timestamp).getTime();
      const hoursSince = timeSince / (1000 * 60 * 60);
      
      if (hoursSince < 6) return { valid: false, reason: `Sinal recente (${hoursSince.toFixed(1)}h)` };
    }
    
    const entry = price;
    
    const atrValue = ind15m.atr;
    
    // 🆕 V6.0: Stop por categoria do par
    const categoryInfo = getCategoryATRMult(symbol);
    const atrStop = atrValue * categoryInfo.multiplier;
    
    let stop, tp1, tp2, tp3;
    
    // 🆕 V6.2: TPs adaptáveis por nível de entrada
    // Premium/Normal = TPs normais (0.7/1.5/2.5)
    // Agressivo = TPs reduzidos (0.5/1.0/1.5)
    const tpsToUse = entryLevel.tps;  // já vem do entryLevel
    const TP1_PCT = tpsToUse.tp1 / 100;
    const TP2_PCT = tpsToUse.tp2 / 100;
    const TP3_PCT = tpsToUse.tp3 / 100;
    
    if (direction === 'LONG') {
      stop = entry - atrStop;
      tp1 = entry * (1 + TP1_PCT);
      tp2 = entry * (1 + TP2_PCT);
      tp3 = entry * (1 + TP3_PCT);
    } else {
      stop = entry + atrStop;
      tp1 = entry * (1 - TP1_PCT);
      tp2 = entry * (1 - TP2_PCT);
      tp3 = entry * (1 - TP3_PCT);
    }
    
    const rr = Math.abs(tp3 - entry) / Math.abs(entry - stop);
    
    // 🔧 FIX: Stop mínimo DINÂMICO baseado em ATR (não fixo em 0.5%)
    const minStopDistance = Math.max(0.005, (atrValue / entry) * 1.5);
    if (Math.abs(entry - stop) / entry < minStopDistance) {
      return { valid: false, reason: `Stop muito próximo (${(minStopDistance * 100).toFixed(2)}% mínimo)` };
    }
    
    if (rr < 1.5) return { valid: false, reason: `R:R baixo: ${rr.toFixed(2)}` };
    
    // 🔧 FIX: Validação completa da ordem dos TPs
    if (direction === 'LONG') {
      if (tp3 <= entry) return { valid: false, reason: 'TP3 inválido LONG' };
      if (tp1 <= entry) return { valid: false, reason: 'TP1 não está acima da entrada (LONG)' };
      if (tp2 <= tp1) return { valid: false, reason: 'TP2 deve ser > TP1 (LONG)' };
      if (tp3 <= tp2) return { valid: false, reason: 'TP3 deve ser > TP2 (LONG)' };
      if (stop >= entry) return { valid: false, reason: 'Stop deve ser < entrada (LONG)' };
    } else { // SHORT
      if (tp3 >= entry) return { valid: false, reason: 'TP3 inválido SHORT' };
      if (tp1 >= entry) return { valid: false, reason: 'TP1 não está abaixo da entrada (SHORT)' };
      if (tp2 >= tp1) return { valid: false, reason: 'TP2 deve ser < TP1 (SHORT)' };
      if (tp3 >= tp2) return { valid: false, reason: 'TP3 deve ser < TP2 (SHORT)' };
      if (stop <= entry) return { valid: false, reason: 'Stop deve ser > entrada (SHORT)' };
    }
    
    const confidenceLevel = score >= CONFIG.highConfidence ? 'ALTA' : 'MEDIA';
    
    // 🆕 VERIFICAÇÃO DE SPREAD (só para sinais de alta confiança)
    // Spread alto = dificuldade de executar ordem no preço esperado
    if (confidenceLevel === 'ALTA' || score >= 80) {
      const spreadCheck = await checkSpread(symbol);
      if (spreadCheck.valid && !spreadCheck.acceptable) {
        return { 
          valid: false, 
          reason: `Spread alto: ${spreadCheck.spreadPercent.toFixed(3)}%` 
        };
      }
    }
    
    // 🆕 V6.0: Calcula Setup Quality
    const setupQuality = calculateSetupQuality({
      score, 
      volumeRatio: volume.ratio.toFixed(2),
      adx: ind15m.adx.toFixed(1),
      btcAlignment
    });
    
    return {
      valid: true, symbol, direction,
      entry: formatPrice(entry), stopLoss: formatPrice(stop),
      tp1: formatPrice(tp1), tp2: formatPrice(tp2), tp3: formatPrice(tp3),
      rr: rr.toFixed(2), confluences: confluences.join(' + '),
      confidenceLevel, score, structure: structure15m.structure,
      choch: structure15m.choch, bos: structure15m.bos,
      volumeRatio: volume.ratio.toFixed(2), atr: formatPrice(atrValue),
      adx: ind15m.adx.toFixed(1),
      timestamp: new Date().toISOString(),
      // 🆕 V6.0: Novos campos
      btcAlignment,
      btcChange: btcTrend.change ? btcTrend.change.toFixed(2) : '0',
      btcDirection: btcTrend.direction,
      category: categoryInfo.category,
      categoryLabel: categoryInfo.label,
      atrMultiplier: categoryInfo.multiplier,
      setupQuality: setupQuality.stars,
      setupVisual: setupQuality.visual,
      setupLabel: setupQuality.label,
      // 🆕 V6.2: Padrão de volume
      volumePattern: volume.pattern,
      volumePatternLabel: volume.patternLabel,
      volumePatternScore: volume.patternScore,
      volumeRatios: volume.ratios.map(r => r.toFixed(2)),
      // 🆕 V6.2: Sistema de níveis
      entryLevel: entryLevel.level,
      entryLevelLabel: entryLevel.label,
      entryLevelDescription: entryLevel.description,
      entryLevelTPType: entryLevel.tpType,
      tfScore: tfResult.score,
      tfBreakdown: tfResult.breakdown,
      trend4h: trend4h,
      trend1h: trend1h,
      trend15m: setupQuality15m,
      // Tracking
      reachedTP1: false,
      reachedTP2: false,
      reachedTP3: false,
      stopHit: false
    };
    
  } catch (error) {
    return { valid: false, reason: error.message };
  }
}

async function analyzeMarket() {
  try {
    state.analysisCount++;
    
    // 🆕 FASE 2: Log com modo de risco
    const currentRisk = calculateDynamicRisk();
    
    // 🆕 LOG DETALHADO: Início de ciclo
    addLog(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'info');
    addLog(`🔄 INICIANDO ANÁLISE #${state.analysisCount} | ${CONFIG.pairs.length} pares | Modo: ${state.riskMode.toUpperCase()} | Risco: ${(currentRisk * 100).toFixed(1)}%`, 'info');
    addLog(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'info');
    
    // 🆕 FASE 2: Verifica se pode abrir novos trades
    if (!canTakeNewTrade()) {
      addLog('⏸️ Não pode abrir novos trades agora', 'warning');
      return;
    }
    
    const results = [];
    
    // 🆕 CONTADORES DE REJEIÇÃO para resumo final
    const rejectionStats = {
      volumeBaixo: 0,
      scoreBaixo: 0,
      adxBaixo: 0,
      tendenciaDesalinhada: 0,
      semEstrutura: 0,
      dadosInsuficientes: 0,
      correlacao: 0,
      sinalRecente: 0,
      stopProximo: 0,
      rrBaixo: 0,
      spreadAlto: 0,
      tpInvalido: 0,
      outros: 0
    };
    
    // 🚀 OTIMIZAÇÃO: Analisa em batches de 5 pares em paralelo
    const BATCH_SIZE = 5;
    for (let i = 0; i < CONFIG.pairs.length; i += BATCH_SIZE) {
      const batch = CONFIG.pairs.slice(i, i + BATCH_SIZE);
      
      const batchResults = await Promise.all(
        batch.map(async (symbol) => {
          try {
            return await analyzeSymbol(symbol);
          } catch (error) {
            addLog(`❌ ${symbol.padEnd(10)} | ERRO: ${error.message}`, 'error');
            return { valid: false, reason: `Erro: ${error.message}`, symbol };
          }
        })
      );
      
      // 🆕 Processa resultados do batch com LOGS DETALHADOS
      batchResults.forEach((result, idx) => {
        const symbol = batch[idx];
        
        if (result.valid) {
          // ✅ SINAL VÁLIDO - log completo
          results.push(result);
          addLog(
            `✅ ${symbol.padEnd(10)} | ${result.direction.padEnd(5)} | Score: ${String(result.score).padStart(3)} | Vol: ${result.volumeRatio}x | ADX: ${result.adx} | 🎯 SETUP VÁLIDO!`, 
            'success'
          );
        } else {
          // ❌ SINAL REJEITADO - log detalhado com motivo
          const reason = result.reason || 'Desconhecido';
          
          // Dados disponíveis (se houver)
          const score = result.score !== undefined ? String(result.score).padStart(3) : ' --';
          const volume = result.volumeRatio !== undefined ? `${result.volumeRatio}x` : ' --';
          const adx = result.adx !== undefined ? result.adx : '--';
          const direction = result.direction || '----';
          
          // Emoji baseado no tipo de rejeição
          let icon = '⚪';
          if (reason.includes('Volume baixo')) { icon = '📉'; rejectionStats.volumeBaixo++; }
          else if (reason.includes('Score baixo')) { icon = '🎯'; rejectionStats.scoreBaixo++; }
          else if (reason.includes('Mercado lateral') || reason.includes('ADX')) { icon = '〰️'; rejectionStats.adxBaixo++; }
          else if (reason.includes('Tendências desalinhadas')) { icon = '🔀'; rejectionStats.tendenciaDesalinhada++; }
          else if (reason.includes('Sem estrutura')) { icon = '🏗️'; rejectionStats.semEstrutura++; }
          else if (reason.includes('insuficientes') || reason.includes('Sem dados')) { icon = '📡'; rejectionStats.dadosInsuficientes++; }
          else if (reason.includes('Grupo')) { icon = '🔗'; rejectionStats.correlacao++; }
          else if (reason.includes('Sinal recente')) { icon = '⏰'; rejectionStats.sinalRecente++; }
          else if (reason.includes('Stop muito próximo')) { icon = '🛑'; rejectionStats.stopProximo++; }
          else if (reason.includes('R:R baixo')) { icon = '⚖️'; rejectionStats.rrBaixo++; }
          else if (reason.includes('Spread alto')) { icon = '💨'; rejectionStats.spreadAlto++; }
          else if (reason.includes('TP')) { icon = '🎯'; rejectionStats.tpInvalido++; }
          else { rejectionStats.outros++; }
          
          addLog(
            `${icon} ${symbol.padEnd(10)} | ${direction.padEnd(5)} | Score: ${score} | Vol: ${volume.padEnd(6)} | ADX: ${adx} | ❌ ${reason}`,
            'warning'
          );
        }
      });
      
      // Delay entre batches para não sobrecarregar API
      if (i + BATCH_SIZE < CONFIG.pairs.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    // 🆕 LOG DETALHADO: Resumo do ciclo
    addLog(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'info');
    addLog(`✅ Análise #${state.analysisCount} COMPLETA | ${CONFIG.pairs.length} pares | ${results.length} setups válidos`, 'success');
    
    // Resumo das rejeições (só mostra categorias que tiveram rejeição)
    const rejectionSummary = [];
    if (rejectionStats.volumeBaixo > 0) rejectionSummary.push(`📉 ${rejectionStats.volumeBaixo} volume baixo`);
    if (rejectionStats.scoreBaixo > 0) rejectionSummary.push(`🎯 ${rejectionStats.scoreBaixo} score baixo`);
    if (rejectionStats.adxBaixo > 0) rejectionSummary.push(`〰️ ${rejectionStats.adxBaixo} ADX baixo`);
    if (rejectionStats.tendenciaDesalinhada > 0) rejectionSummary.push(`🔀 ${rejectionStats.tendenciaDesalinhada} tendência desalinhada`);
    if (rejectionStats.semEstrutura > 0) rejectionSummary.push(`🏗️ ${rejectionStats.semEstrutura} sem estrutura`);
    if (rejectionStats.dadosInsuficientes > 0) rejectionSummary.push(`📡 ${rejectionStats.dadosInsuficientes} dados insuficientes`);
    if (rejectionStats.correlacao > 0) rejectionSummary.push(`🔗 ${rejectionStats.correlacao} correlação`);
    if (rejectionStats.sinalRecente > 0) rejectionSummary.push(`⏰ ${rejectionStats.sinalRecente} sinal recente`);
    if (rejectionStats.stopProximo > 0) rejectionSummary.push(`🛑 ${rejectionStats.stopProximo} stop próximo`);
    if (rejectionStats.rrBaixo > 0) rejectionSummary.push(`⚖️ ${rejectionStats.rrBaixo} R:R baixo`);
    if (rejectionStats.spreadAlto > 0) rejectionSummary.push(`💨 ${rejectionStats.spreadAlto} spread alto`);
    if (rejectionStats.tpInvalido > 0) rejectionSummary.push(`🎯 ${rejectionStats.tpInvalido} TP inválido`);
    if (rejectionStats.outros > 0) rejectionSummary.push(`⚪ ${rejectionStats.outros} outros`);
    
    if (rejectionSummary.length > 0) {
      addLog(`📊 RESUMO: ${rejectionSummary.join(' | ')}`, 'info');
    }
    addLog(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'info');
    
    results.sort((a, b) => b.score - a.score);
    const topSignals = results.slice(0, 1);
    
    if (topSignals.length > 0) {
      const signal = topSignals[0];
      state.signals.unshift(signal);
      state.signals = state.signals.slice(0, 20);
      
      // Calcula zona de entrada (±0.3%)
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
      
      // Barra de força visual
      const scorePercent = Math.round((signal.score / 100) * 10);
      const greenBars = '🟩'.repeat(scorePercent);
      const grayBars = '⬜'.repeat(10 - scorePercent);
      
      // Análise de tendência
      const trendText = signal.direction === 'LONG' ? 'Alta' : 'Baixa';
      const volumeText = signal.volumeRatio >= 2 ? 'Forte' : signal.volumeRatio >= 1.5 ? 'Médio' : 'Fraco';
      const forceText = signal.score >= 85 ? 'Forte' : signal.score >= 70 ? 'Média' : 'Fraca';
      
      // 🆕 Trunca confluências se muito grande
      let confluencesText = signal.confluences;
      if (confluencesText.length > 500) {
        confluencesText = confluencesText.substring(0, 497) + '...';
      }
      
      // 🆕 V6.2: TPs corretos baseado no nível
      const tpUsed = signal.entryLevelTPType === 'aggressive' ? CONFIG.tpAggressive : CONFIG.tpFixed;
      
      const message = `🚨 DAY TRADE SIGNAL V6.2 | ${signal.symbol}

📈 Direção: ${signal.direction}
⚡ Alavancagem: ${CONFIG.leverage}x
${signal.setupVisual} ${signal.setupLabel}
${signal.entryLevelLabel || ''}

💰 Entrada: ${signal.entry}
📍 Zona: ${zoneMin} — ${zoneMax}
🛑 Stop Loss: ${signal.stopLoss}

🎯 Take Profits

🥇 TP1: ${signal.tp1} (+${tpUsed.tp1}%)
🥈 TP2: ${signal.tp2} (+${tpUsed.tp2}%)
🥉 TP3: ${signal.tp3} (+${tpUsed.tp3}%)
${signal.entryLevelTPType === 'aggressive' ? '⚠️ TPs reduzidos (entrada agressiva contra 4h)' : ''}
━━━━━━━━━━━━━━━━━
📊 Risk / Reward
📉 Risco: ${Math.abs(parseFloat(riskPercent))}%
📈 Retorno Máx: ${tpUsed.tp3}%
⚖️ RR: 1:${signal.rr}
━━━━━━━━━━━━━━━━━
📊 Multi-Timeframe Analysis
🕐 4h: ${signal.trend4h === 'bullish' ? '📈 ALTA' : signal.trend4h === 'bearish' ? '📉 BAIXA' : '➡️ NEUTRO'} (${signal.tfBreakdown && signal.tfBreakdown.h4 ? (signal.tfBreakdown.h4.value > 0 ? '+' : '') + signal.tfBreakdown.h4.value : '0'})
🕐 1h: ${signal.trend1h === 'bullish' ? '📈 ALTA' : signal.trend1h === 'bearish' ? '📉 BAIXA' : '➡️ NEUTRO'} (${signal.tfBreakdown && signal.tfBreakdown.h1 ? (signal.tfBreakdown.h1.value > 0 ? '+' : '') + signal.tfBreakdown.h1.value : '0'})
🕐 15m: ${signal.trend15m === 'strong' ? '💪 FORTE' : signal.trend15m === 'medium' ? '👍 Médio' : '👎 Fraco'} (${signal.tfBreakdown && signal.tfBreakdown.m15 ? (signal.tfBreakdown.m15.value > 0 ? '+' : '') + signal.tfBreakdown.m15.value : '0'})
🎯 Score TF: ${signal.tfScore !== undefined ? (signal.tfScore > 0 ? '+' : '') + signal.tfScore : 'N/A'}
━━━━━━━━━━━━━━━━━
📊 Dados do Trade

📈 Volume: ${volumeText} (${signal.volumeRatio}x)
${signal.volumePatternLabel ? `🔍 Padrão Vol: ${signal.volumePatternLabel}\n📊 Sequência: ${signal.volumeRatios ? signal.volumeRatios.join('→') + 'x' : 'N/A'}` : ''}
🔥 Volatilidade: Média/Alta
🎯 Score Final: ${signal.score}/100
📊 ADX: ${signal.adx} (Tendência ${signal.adx > 30 ? 'Forte' : 'Média'})
📏 ATR: ${signal.atr}
${signal.btcAlignment === 'self' 
  ? '📊 BTC: ⭐ Próprio ativo' 
  : `📊 BTC: ${signal.btcDirection === 'up' ? '📈' : signal.btcDirection === 'down' ? '📉' : '➡️'} ${signal.btcChange > 0 ? '+' : ''}${signal.btcChange}% (4h) ${signal.btcAlignment === 'aligned' ? '✅' : signal.btcAlignment === 'against' ? '⚠️' : '➡️'}`}
🏷️ Categoria: ${signal.categoryLabel} (Stop ATR×${signal.atrMultiplier})
━━━━━━━━━━━━━━━━━━
📊 Força do Sinal
${greenBars}${grayBars} ${signal.score}%
━━━━━━━━━━━━━━━━━━
✅ Confluências Detectadas:
${confluencesText}
━━━━━━━━━━━━━━━━━━
📡 Exchange: Binance Futures
⏱ Timeframe: 15m
📊 Tipo: Day Trade Profissional V6.2
⏳ Duração Estimada: 2h — 8h
━━━━━━━━━━━━━━━━━
📅 Data: ${formatBrazilDate()}
🕐 Horário: ${formatBrazilTime()} (UTC-3)

━━━━━━━━━━━━━━━━━━

💡 Gestão sugerida (40/40/20):
• 40% sai TP1
• 40% sai TP2
• 20% runner TP3
• Move stop pra entrada após TP1`;
      
      // 🆕 FASE 3: Gera e envia gráfico PRIMEIRO
      try {
        const chartPath = await generateChartImage(signal, candles15m);
        if (chartPath) {
          addLog('📤 Enviando gráfico para Telegram...', 'info');
          await bot.sendPhoto(CHAT_ID, chartPath, {
            caption: `📊 Análise Visual - ${signal.symbol} ${signal.direction}\nScore: ${signal.score}/100 | ADX: ${signal.adx}`
          });
          addLog('✅ Gráfico enviado!', 'success');
          
          // Deleta arquivo temporário
          fs.unlinkSync(chartPath);
        }
      } catch (chartError) {
        addLog(`⚠️ Erro no gráfico (continua sem ele): ${chartError.message}`, 'warning');
      }
      
      // Envia mensagem de texto
      await sendToGroup(message);
      
      // 🆕 V6.0: Adiciona ao tracking (não opera, só monitora)
      signal.signalTime = Date.now();
      
      // Mantém para compat (caso pendingTrades seja usado em outros lugares)
      signal.status = 'tracking';
      
      // 🆕 V6.0: Adiciona ao novo sistema de tracking
      trackNewTrade(signal);
      
      // 🆕 Atualiza controles de overtrading
      state.lastSignalTime = Date.now();
      const today = new Date().toISOString().split('T')[0];
      state.signalsByDate = state.signalsByDate || {};
      state.signalsByDate[today] = (state.signalsByDate[today] || 0) + 1;
      
      addLog(`📡 SINAL: ${signal.symbol} ${signal.direction} (${signal.score}/100, ${signal.setupVisual})`, 'success');
    } else {
      addLog('Nenhum setup de alta qualidade encontrado', 'info');
    }
    
    state.lastAnalysis = new Date();
    
  } catch (error) {
    addLog(`Erro: ${error.message}`, 'error');
  }
}

// Flag para evitar checkTrackedTrades rodar em paralelo
let isCheckingTrades = false;

// 🆕 V6.0: Adiciona trade para tracking (não opera, só monitora)
function trackNewTrade(signal) {
  const tracked = {
    id: `${signal.symbol}_${Date.now()}`,
    symbol: signal.symbol,
    direction: signal.direction,
    entry: parseFloat(signal.entry),
    stop: parseFloat(signal.stopLoss),
    tp1: parseFloat(signal.tp1),
    tp2: parseFloat(signal.tp2),
    tp3: parseFloat(signal.tp3),
    startTime: new Date().toISOString(),
    btcDirectionAtStart: state.btcStatus.direction,
    tpsHit: [],
    stopHit: false,
    timeoutHit: false,
    btcChangedNotified: false
  };
  
  state.trackedTrades.push(tracked);
  addLog(`📡 Acompanhando ${signal.symbol} ${signal.direction}`, 'info');
  return tracked;
}

// 🆕 V6.0: Verifica TPs/Stop dos trades tracked (não fecha, só notifica)
async function checkTrackedTrades() {
  if (state.trackedTrades.length === 0) return;
  
  if (isCheckingTrades) return;
  isCheckingTrades = true;
  
  try {
    const now = Date.now();
    const timeoutMs = CONFIG.tradeTracking.timeoutHours * 60 * 60 * 1000;
    
    for (let i = state.trackedTrades.length - 1; i >= 0; i--) {
      const trade = state.trackedTrades[i];
      
      // Verifica timeout (8h)
      const elapsedMs = now - new Date(trade.startTime).getTime();
      if (elapsedMs >= timeoutMs && !trade.timeoutHit) {
        trade.timeoutHit = true;
        await sendToGroup(`⏰ ${trade.symbol} - Trade timeout
8h sem TP3 ou stop
Bot parou de acompanhar`);
        state.trackedTrades.splice(i, 1);
        continue;
      }
      
      try {
        // Pega preço atual
        const candles = await getCandlesticks(trade.symbol, '1m', 5);
        if (!candles || candles.length === 0) continue;
        
        const currentPrice = candles[candles.length - 1].close;
        const isLong = trade.direction === 'LONG';
        
        // Verifica TP1
        if (!trade.tpsHit.includes('TP1')) {
          const tp1Hit = isLong ? currentPrice >= trade.tp1 : currentPrice <= trade.tp1;
          if (tp1Hit) {
            trade.tpsHit.push('TP1');
            await sendToGroup(`🟢 ${trade.symbol} - TP1 atingido (+${CONFIG.tpFixed.tp1}%)`);
          }
        }
        
        // Verifica TP2
        if (!trade.tpsHit.includes('TP2')) {
          const tp2Hit = isLong ? currentPrice >= trade.tp2 : currentPrice <= trade.tp2;
          if (tp2Hit) {
            trade.tpsHit.push('TP2');
            await sendToGroup(`🟢 ${trade.symbol} - TP2 atingido (+${CONFIG.tpFixed.tp2}%)`);
          }
        }
        
        // Verifica TP3
        if (!trade.tpsHit.includes('TP3')) {
          const tp3Hit = isLong ? currentPrice >= trade.tp3 : currentPrice <= trade.tp3;
          if (tp3Hit) {
            trade.tpsHit.push('TP3');
            await sendToGroup(`🟢 ${trade.symbol} - TP3 atingido (+${CONFIG.tpFixed.tp3}%)`);
            // TP3 = encerra acompanhamento
            state.trackedTrades.splice(i, 1);
            continue;
          }
        }
        
        // Verifica STOP
        if (!trade.stopHit) {
          const stopHit = isLong ? currentPrice <= trade.stop : currentPrice >= trade.stop;
          if (stopHit) {
            trade.stopHit = true;
            await sendToGroup(`🔴 ${trade.symbol} - Stop atingido`);
            // Stop = encerra acompanhamento
            state.trackedTrades.splice(i, 1);
            continue;
          }
        }
        
        // Verifica se BTC virou contra o trade (avisa só se ainda não notificou)
        if (!trade.btcChangedNotified) {
          const currentBTC = state.btcStatus.direction;
          const tradeBTCStart = trade.btcDirectionAtStart;
          
          // Detecta mudança contra
          let btcAgainst = false;
          if (isLong && currentBTC === 'down' && tradeBTCStart !== 'down') btcAgainst = true;
          if (!isLong && currentBTC === 'up' && tradeBTCStart !== 'up') btcAgainst = true;
          
          if (btcAgainst) {
            trade.btcChangedNotified = true;
            const btcEmoji = currentBTC === 'up' ? '📈' : '📉';
            await sendToGroup(`⚠️ ${trade.symbol} - BTC mudou direção
BTC agora: ${btcEmoji} ${state.btcStatus.change4h.toFixed(2)}%
Cuidado com seu trade`);
          }
        }
      } catch (error) {
        // Erro no par específico, continua os outros
        console.error(`Erro ao verificar ${trade.symbol}:`, error.message);
      }
    }
  } catch (error) {
    addLog(`Erro em checkTrackedTrades: ${error.message}`, 'error');
  } finally {
    isCheckingTrades = false;
  }
}

// 🆕 V6.0: Verifica volatilidade do BTC e alerta
async function checkAndAlertVolatility() {
  if (!CONFIG.volatilityAlert.enabled) return;
  if (state.trackedTrades.length === 0) return; // Só alerta se tiver trades abertos
  
  const vol = await checkBTCVolatility();
  if (vol && vol.isVolatile) {
    const emoji = vol.change > 0 ? '📈' : '📉';
    const direction = vol.change > 0 ? 'subiu' : 'caiu';
    
    await sendToGroup(`🚨 ALERTA - MERCADO VOLÁTIL

BTC ${emoji} ${direction} ${Math.abs(vol.change).toFixed(2)}% na última hora
⚠️ Cuidado com trades abertos
💡 Sugestão: realizar lucros parciais`);
    
    state.btcStatus.lastVolatilityAlert = new Date().toISOString();
  }
}


const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json({
    status: 'online', 
    version: '6.0.0 - Day Trade Profissional',
    uptime: process.uptime(),
    analysisCount: state.analysisCount, 
    signalsCount: state.signals.length,
    trackedTrades: state.trackedTrades.length,
    lastAnalysis: state.lastAnalysis,
    
    // 🆕 V6.0: Stats manuais (do /trade)
    manualStats: state.manualStats,
    
    // 🆕 V6.0: BTC status
    btcStatus: state.btcStatus,
    
    riskMode: state.riskMode,
    config: {
      style: 'Day Trade Profissional V6.2', 
      timeframes: '15m + 1h + 4h + BTC 4h',
      minScore: CONFIG.minScore, 
      pairs: CONFIG.pairs.length,
      tps: `${CONFIG.tpFixed.tp1}% / ${CONFIG.tpFixed.tp2}% / ${CONFIG.tpFixed.tp3}%`,
      btcFilterEnabled: CONFIG.btcFilter.enabled,
      btcPenalty: CONFIG.btcFilter.penaltyContra,
      categories: Object.keys(CONFIG.stopByCategory).length
    }
  });
});

app.get('/api/signals', (req, res) => {
  res.json({ signals: state.signals.slice(0, 20), total: state.signals.length });
});

app.get('/api/logs', (req, res) => {
  res.json({ logs: state.logs.slice(0, 100), count: state.logs.length });
});

// 🆕 V6.0: Endpoint de trades acompanhados (substitui pending)
app.get('/api/tracked', (req, res) => {
  res.json({ tracked: state.trackedTrades, count: state.trackedTrades.length });
});

// 🆕 V6.0: Endpoint de aprendizado
app.get('/api/learning', (req, res) => {
  res.json({ learning: state.learning.bySymbol });
});

// 🆕 ENDPOINT DE ESTATÍSTICAS DETALHADAS
app.get('/api/stats', (req, res) => {
  // 🆕 V6.0: Usa stats manuais
  res.json({
    manual: state.manualStats,
    learning: state.learning.bySymbol,
    btc: state.btcStatus,
    todaySignals: state.signalsByDate[new Date().toISOString().split('T')[0]] || 0
  });
});

// (mantém endpoint antigo para compat)
app.get('/api/stats-old', (req, res) => {
  const trades = state.trades;
  
  if (trades.length === 0) {
    return res.json({ 
      message: 'Ainda sem trades fechados',
      totalTrades: 0 
    });
  }
  
  // Win rate geral
  const winRate = (state.stats.wins / state.stats.totalTrades) * 100;
  
  // Estatísticas por par
  const bySymbol = {};
  trades.forEach(t => {
    if (!bySymbol[t.symbol]) {
      bySymbol[t.symbol] = { wins: 0, losses: 0, total: 0, profit: 0 };
    }
    bySymbol[t.symbol].total++;
    if (t.outcome === 'WIN') {
      bySymbol[t.symbol].wins++;
    } else {
      bySymbol[t.symbol].losses++;
    }
    bySymbol[t.symbol].profit += t.profit || 0;
  });
  
  // Calcular win rate por par
  Object.keys(bySymbol).forEach(symbol => {
    const s = bySymbol[symbol];
    s.winRate = ((s.wins / s.total) * 100).toFixed(1) + '%';
  });
  
  // Estatísticas por hora do dia (UTC)
  const byHour = {};
  trades.forEach(t => {
    const hour = new Date(t.timestamp).getUTCHours();
    if (!byHour[hour]) {
      byHour[hour] = { wins: 0, losses: 0, total: 0 };
    }
    byHour[hour].total++;
    if (t.outcome === 'WIN') byHour[hour].wins++;
    else byHour[hour].losses++;
  });
  
  Object.keys(byHour).forEach(hour => {
    byHour[hour].winRate = ((byHour[hour].wins / byHour[hour].total) * 100).toFixed(1) + '%';
  });
  
  // Estatísticas por faixa de score
  const byScore = {
    '65-74': { wins: 0, losses: 0, total: 0 },
    '75-84': { wins: 0, losses: 0, total: 0 },
    '85-94': { wins: 0, losses: 0, total: 0 },
    '95+': { wins: 0, losses: 0, total: 0 }
  };
  
  trades.forEach(t => {
    const score = t.score || 0;
    let range;
    if (score < 75) range = '65-74';
    else if (score < 85) range = '75-84';
    else if (score < 95) range = '85-94';
    else range = '95+';
    
    byScore[range].total++;
    if (t.outcome === 'WIN') byScore[range].wins++;
    else byScore[range].losses++;
  });
  
  Object.keys(byScore).forEach(range => {
    if (byScore[range].total > 0) {
      byScore[range].winRate = ((byScore[range].wins / byScore[range].total) * 100).toFixed(1) + '%';
    } else {
      byScore[range].winRate = 'N/A';
    }
  });
  
  // Profit factor e outras métricas
  const wins = trades.filter(t => t.outcome === 'WIN');
  const losses = trades.filter(t => t.outcome === 'LOSS');
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.profit || 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + Math.abs(t.profit || 0), 0) / losses.length : 0;
  const profitFactor = avgLoss > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : 0;
  
  res.json({
    geral: {
      totalTrades: state.stats.totalTrades,
      wins: state.stats.wins,
      losses: state.stats.losses,
      winRate: winRate.toFixed(1) + '%',
      totalProfit: state.stats.totalProfit.toFixed(2),
      balance: state.balance.toFixed(2),
      maxDrawdown: (state.stats.maxDrawdown * 100).toFixed(2) + '%',
      profitFactor: profitFactor.toFixed(2),
      avgWin: avgWin.toFixed(2) + '%',
      avgLoss: avgLoss.toFixed(2) + '%',
      consecutiveWins: state.stats.consecutiveWins,
      consecutiveLosses: state.stats.consecutiveLosses
    },
    porPar: bySymbol,
    porHora: byHour,
    porScore: byScore,
    ultimos10: trades.slice(0, 10).map(t => ({
      symbol: t.symbol,
      direction: t.direction,
      outcome: t.outcome,
      profit: t.profit ? t.profit.toFixed(2) + '%' : 'N/A',
      score: t.score,
      level: t.level,
      timestamp: t.timestamp
    }))
  });
});

app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, async () => {
  addLog('========================================', 'success');
  addLog('BRUNO TRADER PRO V6.2 - DAY TRADE PROFISSIONAL', 'success');
  addLog('========================================', 'success');
  addLog(`Pares: ${CONFIG.pairs.length}`, 'info');
  addLog(`Score mínimo: ${CONFIG.minScore}/100`, 'info');
  addLog(`TPs: ${CONFIG.tpFixed.tp1}% / ${CONFIG.tpFixed.tp2}% / ${CONFIG.tpFixed.tp3}%`, 'info');
  addLog(`Stop por categoria (Blue Chip 4x | Alts 4.5x | Memecoin 5x)`, 'info');
  addLog(`✅ V6.2: Day Trade + Filtro BTC + Tracking sem operação`, 'success');
  
  // Pega tendência inicial do BTC
  const btcInitial = await getBTCTrend();
  addLog(`📊 BTC inicial: ${btcInitial.direction} (${btcInitial.change.toFixed(2)}%)`, 'info');
  
  await sendToPrivate(`🚀 BRUNO TRADER PRO V6.2 INICIADO

━━━━━━━━━━━━━━━━━
🎯 DAY TRADE PROFISSIONAL

📊 CONFIGURAÇÃO:
• Pares: ${CONFIG.pairs.length}
• TP1: +${CONFIG.tpFixed.tp1}%
• TP2: +${CONFIG.tpFixed.tp2}%
• TP3: +${CONFIG.tpFixed.tp3}%
• Stop: ATR × 4.0/4.5/5.0 (por categoria)
• Score mínimo: ${CONFIG.minScore}/100

🆕 NOVIDADES V6.2:
✅ SISTEMA DE NÍVEIS DE ENTRADA
   ⭐ PREMIUM (3 TFs alinhados)
   ✅ NORMAL (1h+15m alinhados)
   ⚡ AGRESSIVO (4h contra, TPs reduzidos)
✅ 4h como CONTEXTO (não filtro rígido)
✅ Pesos por TF (4h=10, 1h=25, 15m=30)
✅ TPs adaptáveis por nível
✅ Análise Multi-TF detalhada nos sinais

🆕 V6.1 (mantido):
✅ Análise de Padrão de Volume PRO
   (8 padrões diferentes)

🆕 V6.0 (mantido):
✅ Filtro BTC (-25 score contra)
✅ Stop por categoria
✅ Setup Quality (estrelas)
✅ Sistema de aprendizado
✅ Tracking sem operação manual
✅ Resumo diário (22h BR)
✅ Alerta de volatilidade
✅ Comando /status, /trade, /stats

📊 BTC 4h: ${btcInitial.direction === 'up' ? '📈' : btcInitial.direction === 'down' ? '📉' : '➡️'} ${btcInitial.change.toFixed(2)}%

━━━━━━━━━━━━━━━━━
🎯 GESTÃO MANUAL (40/40/20):
• 40% sai TP1
• 40% sai TP2  
• 20% runner TP3
• Move stop pra entrada após TP1

━━━━━━━━━━━━━━━━━
⏱ SISTEMA INICIADO
📅 ${formatBrazilDateTime()}`);
  
  setTimeout(() => { addLog('Primeira análise V6.2...', 'info'); analyzeMarket(); }, 10000);
  
  // 🆕 V6.0: Analisa mercado a cada 15 minutos
  setInterval(analyzeMarket, 900000);
  
  // 🆕 V6.0: Checa trades tracked (TPs/Stop/timeout) a cada 60s
  setInterval(checkTrackedTrades, CONFIG.tradeTracking.checkInterval * 1000);
  
  // 🆕 V6.0: Checa volatilidade do BTC a cada 5 minutos
  setInterval(checkAndAlertVolatility, 5 * 60 * 1000);
  
  // 🆕 V6.0: Atualiza tendência do BTC a cada 15 minutos
  setInterval(getBTCTrend, 15 * 60 * 1000);
  
  // 🆕 V6.0: Resumo diário às 22h BR
  setInterval(checkAndSendDailySummary, 60 * 1000); // checa a cada minuto
});

// 🆕 V6.0: COMANDOS TELEGRAM
// =============================

// Comando /status
bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  
  const uptimeSeconds = process.uptime();
  const uptimeHours = Math.floor(uptimeSeconds / 3600);
  const uptimeMins = Math.floor((uptimeSeconds % 3600) / 60);
  
  const lastAnalysisMins = state.lastAnalysis ? 
    Math.floor((Date.now() - new Date(state.lastAnalysis).getTime()) / 60000) : 
    'N/A';
  
  const btcEmoji = state.btcStatus.direction === 'up' ? '📈' : 
                   state.btcStatus.direction === 'down' ? '📉' : '➡️';
  
  const todayKey = new Date().toISOString().split('T')[0];
  const signalsToday = state.signalsByDate[todayKey] || 0;
  
  const message = `🤖 BRUNO TRADER PRO V6.2

✅ Status: Online
⏰ Uptime: ${uptimeHours}h ${uptimeMins}min
📡 Monitorando: ${CONFIG.pairs.length} pares
🔄 Última análise: ${lastAnalysisMins}min atrás
🎯 Sinais hoje: ${signalsToday}/5
📊 BTC 4h: ${btcEmoji} ${state.btcStatus.change4h.toFixed(2)}%
🟢 Trades acompanhando: ${state.trackedTrades.length}

━━━━━━━━━━━━━━━━━
📊 Estatísticas (manuais):
🎯 Total: ${state.manualStats.total}
🟢 Wins: ${state.manualStats.wins}
🔴 Losses: ${state.manualStats.losses}
🟡 Breakeven: ${state.manualStats.breakeven}
📈 Win Rate: ${state.manualStats.winRate.toFixed(1)}%
━━━━━━━━━━━━━━━━━
🕐 ${formatBrazilDateTime()} (BR)`;

  try {
    await bot.sendMessage(chatId, message);
  } catch (error) {
    addLog(`Erro /status: ${error.message}`, 'error');
  }
});

// Comando /trade SYMBOL win|loss|be [tp1|tp2|tp3]
// Ex: /trade SOL win tp2
//     /trade DOGE loss
//     /trade ETH be
bot.onText(/\/trade\s+(\S+)\s+(win|loss|be)(?:\s+(tp1|tp2|tp3))?/i, async (msg, match) => {
  const chatId = msg.chat.id;
  let symbol = match[1].toUpperCase();
  const result = match[2].toLowerCase();
  const tpLevel = match[3] ? match[3].toLowerCase() : null;
  
  // Adiciona USDT se não tiver
  if (!symbol.endsWith('USDT')) symbol += 'USDT';
  
  // Registra trade manual
  const manualTrade = {
    symbol,
    result,
    tpLevel,
    timestamp: new Date().toISOString()
  };
  
  state.manualTrades.push(manualTrade);
  state.manualStats.total++;
  
  let resultText = '';
  if (result === 'win') {
    state.manualStats.wins++;
    if (tpLevel === 'tp1') state.manualStats.tp1Hits++;
    else if (tpLevel === 'tp2') state.manualStats.tp2Hits++;
    else if (tpLevel === 'tp3') state.manualStats.tp3Hits++;
    resultText = `🟢 WIN ${tpLevel ? tpLevel.toUpperCase() : ''}`;
  } else if (result === 'loss') {
    state.manualStats.losses++;
    resultText = '🔴 LOSS';
  } else if (result === 'be') {
    state.manualStats.breakeven++;
    resultText = '🟡 BREAKEVEN';
  }
  
  // Recalcula winRate
  const decisive = state.manualStats.wins + state.manualStats.losses;
  if (decisive > 0) {
    state.manualStats.winRate = (state.manualStats.wins / decisive) * 100;
  }
  
  // 🆕 V6.0: Atualiza aprendizado
  if (CONFIG.btcFilter.enabled && state.learning.enabled) {
    updateLearning(symbol, result);
  }
  
  saveState();
  
  const message = `✅ Trade registrado!

${resultText} - ${symbol}

📊 Estatísticas:
Total: ${state.manualStats.total}
Wins: ${state.manualStats.wins}
Losses: ${state.manualStats.losses}
BE: ${state.manualStats.breakeven}
Win Rate: ${state.manualStats.winRate.toFixed(1)}%`;
  
  try {
    await bot.sendMessage(chatId, message);
  } catch (error) {
    addLog(`Erro /trade: ${error.message}`, 'error');
  }
});

// Comando /stats - estatísticas detalhadas
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  
  // Top 5 pares com mais trades
  const symbolStats = Object.entries(state.learning.bySymbol)
    .filter(([_, v]) => v.trades >= 2)
    .sort((a, b) => b[1].trades - a[1].trades)
    .slice(0, 5);
  
  let topSymbols = '';
  if (symbolStats.length > 0) {
    topSymbols = '\n\n📊 Top pares:\n' + symbolStats.map(([sym, s]) => 
      `${sym}: ${s.wins}W/${s.losses}L (${s.winRate.toFixed(0)}%)`
    ).join('\n');
  }
  
  const message = `📊 ESTATÍSTICAS DETALHADAS

🎯 Trades manuais: ${state.manualStats.total}
🟢 Wins: ${state.manualStats.wins}
🔴 Losses: ${state.manualStats.losses}
🟡 Breakeven: ${state.manualStats.breakeven}

📈 Distribuição TPs:
TP1: ${state.manualStats.tp1Hits}
TP2: ${state.manualStats.tp2Hits}
TP3: ${state.manualStats.tp3Hits}

📊 Win Rate: ${state.manualStats.winRate.toFixed(1)}%${topSymbols}`;
  
  try {
    await bot.sendMessage(chatId, message);
  } catch (error) {
    addLog(`Erro /stats: ${error.message}`, 'error');
  }
});

// Comando /help
bot.onText(/\/help|\/start/, async (msg) => {
  const chatId = msg.chat.id;
  
  const message = `🤖 BRUNO TRADER PRO V6.2

📋 Comandos disponíveis:

/status - Status atual do bot
/stats - Estatísticas detalhadas
/trade SYMBOL win|loss|be [tp]
   Ex: /trade SOL win tp2
   Ex: /trade DOGE loss
   Ex: /trade ETH be
/help - Esta mensagem

🎯 Como usar:
1. Recebe sinal no grupo
2. Você decide se opera
3. Quando fechar, marque com /trade
4. Use /stats para ver desempenho

📊 Bot Day Trade Profissional V6.2`;
  
  try {
    await bot.sendMessage(chatId, message);
  } catch (error) {
    addLog(`Erro /help: ${error.message}`, 'error');
  }
});

// 🆕 V6.0: RESUMO DIÁRIO
// =============================

let lastDailySummaryDate = null;

async function checkAndSendDailySummary() {
  if (!CONFIG.dailySummary.enabled) return;
  
  // Pega hora atual em Brasília
  const now = new Date();
  const brazilHour = parseInt(now.toLocaleString('en-US', { 
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    hour12: false
  }));
  
  const todayKey = formatBrazilDate();
  
  // Só envia uma vez por dia, na hora configurada
  if (brazilHour === CONFIG.dailySummary.hour && lastDailySummaryDate !== todayKey) {
    await sendDailySummary();
    lastDailySummaryDate = todayKey;
  }
}

async function sendDailySummary() {
  try {
    const todayKey = new Date().toISOString().split('T')[0];
    const signalsToday = state.signalsByDate[todayKey] || 0;
    
    // Conta sinais por par hoje
    const signalsBySymbol = {};
    state.signals
      .filter(s => s.timestamp && s.timestamp.startsWith(todayKey))
      .forEach(s => {
        signalsBySymbol[s.symbol] = (signalsBySymbol[s.symbol] || 0) + 1;
      });
    
    const topPairs = Object.entries(signalsBySymbol)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([sym, count]) => `   • ${sym}: ${count} sinais`)
      .join('\n');
    
    // Trades manuais hoje
    const manualToday = state.manualTrades.filter(t => 
      t.timestamp && t.timestamp.startsWith(todayKey)
    );
    const winsToday = manualToday.filter(t => t.result === 'win').length;
    const lossesToday = manualToday.filter(t => t.result === 'loss').length;
    
    // BTC
    const btcEmoji = state.btcStatus.direction === 'up' ? '📈' : 
                     state.btcStatus.direction === 'down' ? '📉' : '➡️';
    
    const message = `📊 RESUMO DO DIA - ${formatBrazilDate()}

🔍 Análises: ${state.analysisCount} ciclos
🎯 Sinais gerados hoje: ${signalsToday}

${topPairs ? `🌟 Pares mais ativos:\n${topPairs}\n` : ''}

📊 Trades manuais hoje:
🟢 Wins: ${winsToday}
🔴 Losses: ${lossesToday}

📊 BTC do dia: ${btcEmoji} ${state.btcStatus.change4h.toFixed(2)}%

💪 Próxima análise: 00:00
Boa noite! 🌙`;
    
    await sendToPrivate(message);
    addLog('📊 Resumo diário enviado', 'success');
  } catch (error) {
    addLog(`Erro resumo diário: ${error.message}`, 'error');
  }
}

process.on('unhandledRejection', (error) => { addLog(`Erro: ${error.message}`, 'error'); });
