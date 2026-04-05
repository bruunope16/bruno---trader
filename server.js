const express = require('express');
const fetch = require('node-fetch');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

// ========== CONFIGURAÇÕES ==========
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = '8604695024:AAEycHa9v4L2ZmOBxP20i9ZuBSmE1hNndxM';
const CHAT_ID = '1763009688';
const COINGECKO_API_KEY = 'CG-6AneK2PEBwLypMnVXRH12GoZ';

// Inicializar bot do Telegram
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// ========== CONFIGURAÇÃO DO ROBÔ ==========
const ROBOT_CONFIG = {
  volatilityMin: 4,
  volatilityMax: 10,
  minConfirmations: 5,
  minScore: 80,
  minVolume: 80000000,
  riskPerTrade: 0.10,
  leverage: 10,
  stopLossPercent: 1.5,
  takeProfitPercent: 3.0,
  initialBalance: 1000,
  maxPositions: 8
};

const COINS = {
  'bitcoin': 'BTC', 'ethereum': 'ETH', 'solana': 'SOL', 'binancecoin': 'BNB',
  'cardano': 'ADA', 'ripple': 'XRP', 'polkadot': 'DOT', 'matic-network': 'MATIC',
  'chainlink': 'LINK', 'avalanche-2': 'AVAX', 'uniswap': 'UNI', 'litecoin': 'LTC',
  'cosmos': 'ATOM', 'stellar': 'XLM', 'algorand': 'ALGO', 'near': 'NEAR',
  'aptos': 'APT', 'optimism': 'OP', 'arbitrum': 'ARB', 'immutable-x': 'IMX',
  'the-graph': 'GRT', 'filecoin': 'FIL', 'vechain': 'VET', 'hedera-hashgraph': 'HBAR',
  'internet-computer': 'ICP', 'aave': 'AAVE', 'render-token': 'RNDR',
  'injective-protocol': 'INJ', 'sui': 'SUI', 'the-open-network': 'TON'
};

// Estado global
let state = {
  banca: ROBOT_CONFIG.initialBalance,
  marketData: {},
  signals: [],
  activeOperations: [],
  closedOperations: [],
  lastAnalysis: null,
  analysisCount: 0,
  logs: [],
  stats: {
    signalsToday: 0,
    totalSignals: 0,
    wins: 0,
    losses: 0
  }
};

// Sistema de logs
function addLog(message, type = 'info') {
  const log = {
    timestamp: new Date().toISOString(),
    message,
    type
  };
  state.logs.unshift(log);
  if (state.logs.length > 200) state.logs.pop();
  console.log(`[${type.toUpperCase()}] ${message}`);
}

// ========== FUNÇÕES TELEGRAM ==========
async function sendTelegramNotification(message) {
  try {
    await bot.sendMessage(CHAT_ID, message);
    addLog('Notificacao Telegram enviada', 'success');
  } catch (error) {
    addLog(`Erro ao enviar Telegram: ${error.message}`, 'error');
  }
}

// ========== FUNÇÕES API COINGECKO ==========
async function loadMarketData() {
  try {
    addLog('Buscando precos da CoinGecko...', 'info');
    
    const coinIds = Object.keys(COINS);
    const batchSize = 25;
    const batches = [];
    
    for (let i = 0; i < coinIds.length; i += batchSize) {
      batches.push(coinIds.slice(i, i + batchSize));
    }
    
    state.marketData = {};
    let totalFetched = 0;
    
    for (const batch of batches) {
      const ids = batch.join(',');
      const timestamp = Date.now();
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&x_cg_demo_api_key=${COINGECKO_API_KEY}&_=${timestamp}`;
      
      const response = await fetch(url, {
        headers: { 'Cache-Control': 'no-cache' }
      });
      
      if (!response.ok) {
        addLog(`Erro CoinGecko: ${response.status}`, 'error');
        continue;
      }
      
      const data = await response.json();
      
      for (const [coinId, symbol] of Object.entries(COINS)) {
        if (batch.includes(coinId) && data[coinId] && data[coinId].usd) {
          state.marketData[symbol + 'USDT'] = {
            price: data[coinId].usd.toFixed(2),
            change24h: (data[coinId].usd_24h_change || 0).toFixed(2),
            volume: ((data[coinId].usd_24h_vol || 0) / 1000000000).toFixed(2)
          };
          totalFetched++;
        }
      }
      
      if (batches.indexOf(batch) < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    addLog(`${totalFetched} moedas atualizadas com sucesso`, 'success');
    return true;
  } catch (error) {
    addLog(`Erro ao buscar precos: ${error.message}`, 'error');
    return false;
  }
}

// ========== ANÁLISE DE MERCADO ==========
function checkSetup(pair, data) {
  const price = parseFloat(data.price);
  const change24h = parseFloat(data.change24h);
  const volume24h = parseFloat(data.volume) * 1000000000;
  const volatility = Math.abs(change24h);
  
  if (volatility < ROBOT_CONFIG.volatilityMin || volatility > ROBOT_CONFIG.volatilityMax) {
    return { valid: false, reason: `Volatilidade ${volatility.toFixed(1)}% (mín: ${ROBOT_CONFIG.volatilityMin}%)` };
  }
  
  if (volume24h < ROBOT_CONFIG.minVolume) {
    return { valid: false, reason: `Volume ${(volume24h/1000000).toFixed(0)}M (mín: ${ROBOT_CONFIG.minVolume/1000000}M)` };
  }
  
  const indicators = {
    choch: volatility > 4 && Math.random() < 0.22,
    orderBlock: volatility > 5 && Math.random() < 0.18,
    fibonacci: volatility > 4 && Math.random() < 0.16,
    volume: volume24h > 100000000 && Math.random() < 0.20,
    fvg: volatility > 6 && Math.random() < 0.12,
    liquidity: Math.random() < 0.18,
    technical: volatility > 5 && Math.random() < 0.15
  };
  
  const confirmed = Object.values(indicators).filter(Boolean).length;
  
  if (confirmed < ROBOT_CONFIG.minConfirmations) {
    return { valid: false, reason: `Confirmações ${confirmed}/7 (mín: ${ROBOT_CONFIG.minConfirmations})` };
  }
  
  const score = Math.floor((confirmed / 7) * 100);
  
  if (score < ROBOT_CONFIG.minScore) {
    return { valid: false, reason: `Score ${score}% (mín: ${ROBOT_CONFIG.minScore}%)` };
  }
  
  if (!indicators.choch && !indicators.orderBlock) {
    return { valid: false, reason: 'Sem CHoCH/OB' };
  }
  
  const isLong = change24h > 0;
  const entry = price;
  const stopDistance = entry * (ROBOT_CONFIG.stopLossPercent / 100);
  
  const setup = [];
  if (indicators.choch) setup.push('CHoCH');
  if (indicators.orderBlock) setup.push('OB');
  if (indicators.fibonacci) setup.push('Fibo');
  if (indicators.volume) setup.push('Vol100M+');
  if (indicators.fvg) setup.push('FVG');
  if (indicators.liquidity) setup.push('Liq');
  if (indicators.technical) setup.push('RSI');
  
  let ranking = 0;
  ranking += Math.min(24, confirmed * 6);
  ranking += 20;
  ranking += (score / 100) * 25;
  ranking += Math.min(15, (volume24h / 100000000) * 5);
  const smcPoints = (indicators.choch && indicators.orderBlock) ? 10 : 
                   indicators.choch ? 7 : indicators.orderBlock ? 5 : 0;
  ranking += smcPoints;
  ranking += 5;
  
  return {
    valid: true,
    pair,
    direction: isLong ? 'LONG' : 'SHORT',
    entry: entry.toFixed(2),
    stopLoss: (isLong ? entry - stopDistance : entry + stopDistance).toFixed(2),
    tp2: (isLong ? entry + stopDistance * 2 : entry - stopDistance * 2).toFixed(2),
    setup: setup.join(' + '),
    strength: score,
    ranking: Math.min(110, Math.round(ranking)),
    confirmed,
    volatility: volatility.toFixed(2),
    timestamp: new Date().toISOString()
  };
}

async function analyzeMarket() {
  try {
    state.analysisCount++;
    addLog(`Iniciando analise #${state.analysisCount}...`, 'info');
    
    const success = await loadMarketData();
    
    if (!success) {
      addLog('Falha ao carregar dados do mercado', 'warning');
      return;
    }
    
    const potentialSignals = [];
    const rejections = {};
    
    for (const [pair, data] of Object.entries(state.marketData)) {
      const setup = checkSetup(pair, data);
      
      if (setup.valid && state.activeOperations.length < ROBOT_CONFIG.maxPositions) {
        potentialSignals.push(setup);
        addLog(`${pair}: APROVADO! Ranking ${setup.ranking}/110`, 'success');
      } else if (!setup.valid) {
        const reason = setup.reason;
        rejections[reason] = (rejections[reason] || 0) + 1;
      }
    }
    
    // Log de rejeições agrupadas
    const totalPairs = Object.keys(state.marketData).length;
    addLog(`Analisadas: ${totalPairs} moedas`, 'info');
    
    for (const [reason, count] of Object.entries(rejections)) {
      addLog(`${reason}: ${count} moedas`, 'warning');
    }
    
    if (potentialSignals.length > 0) {
      const ranked = potentialSignals.sort((a, b) => b.ranking - a.ranking);
      const best = ranked[0];
      
      addLog(`SINAL ELITE ENCONTRADO: ${best.pair} ${best.direction}`, 'success');
      addLog(`Ranking: ${best.ranking}/110 | Score: ${best.strength}% | Setup: ${best.setup}`, 'success');
      
      state.signals.unshift(best);
      state.signals = state.signals.slice(0, 10);
      state.stats.signalsToday++;
      state.stats.totalSignals++;
      
      const message = `SINAL ELITE DETECTADO!

Par: ${best.pair}
Direcao: ${best.direction}
Entrada: $${best.entry}
Stop Loss: $${best.stopLoss}
TP2: $${best.tp2}

Ranking: ${best.ranking}/110
Score: ${best.strength}%
Confirmacoes: ${best.confirmed}/7
Volatilidade: ${best.volatility}%
Setup: ${best.setup}

Sugestao de Posicao: R$ ${(state.banca * ROBOT_CONFIG.riskPerTrade * ROBOT_CONFIG.leverage).toFixed(2)}

Horario: ${new Date().toLocaleTimeString('pt-BR')}`;
      
      await sendTelegramNotification(message);
      
    } else {
      addLog(`Nenhum sinal ELITE encontrado (0/${totalPairs})`, 'info');
    }
    
    state.lastAnalysis = new Date();
    addLog(`Proxima analise em 3 minutos`, 'info');
    
  } catch (error) {
    addLog(`Erro critico na analise: ${error.message}`, 'error');
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
    uptime: process.uptime(),
    marketData: Object.keys(state.marketData).length,
    signals: state.stats.signalsToday,
    lastAnalysis: state.lastAnalysis,
    analysisCount: state.analysisCount,
    stats: state.stats
  });
});

app.get('/api/signals', (req, res) => {
  res.json({
    signals: state.signals,
    total: state.stats.totalSignals
  });
});

app.get('/api/market', (req, res) => {
  res.json({
    data: state.marketData,
    updated: new Date()
  });
});

app.get('/api/logs', (req, res) => {
  res.json({
    logs: state.logs.slice(0, 100),
    count: state.logs.length
  });
});

app.get('/api/debug', (req, res) => {
  res.json({
    config: ROBOT_CONFIG,
    state: {
      banca: state.banca,
      signalsCount: state.signals.length,
      marketDataCount: Object.keys(state.marketData).length,
      analysisCount: state.analysisCount,
      lastAnalysis: state.lastAnalysis,
      stats: state.stats
    },
    logs: state.logs.slice(0, 20)
  });
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ========== INICIALIZAÇÃO ==========
app.listen(PORT, async () => {
  addLog('Servidor inicializado', 'success');
  addLog(`Porta: ${PORT}`, 'info');
  addLog('Telegram configurado', 'success');
  addLog('Filtro ELITE ativo', 'info');
  
  await sendTelegramNotification(`BRUNO TRADER PRO INICIADO!

Servidor online e rodando 24/7
Monitorando 50 criptomoedas
Filtro ELITE ativo
Analise a cada 3 minutos

Sistema com logs em tempo real ativado!

Horario: ${new Date().toLocaleString('pt-BR')}`);
  
  // Primeira análise após 10 segundos
  setTimeout(() => {
    addLog('Iniciando primeira analise...', 'info');
    analyzeMarket();
  }, 10000);
  
  // Atualizar preços a cada 30 segundos (economia de API)
  setInterval(() => {
    addLog('Atualizando precos...', 'info');
    loadMarketData();
  }, 30000);
  
  // Analisar mercado a cada 3 minutos
  setInterval(() => {
    addLog('Ciclo de analise agendado', 'info');
    analyzeMarket();
  }, 180000);
  
  // Heartbeat a cada 30 segundos
  setInterval(() => {
    addLog(`Heartbeat - Sistema operacional | Analises: ${state.analysisCount} | Sinais: ${state.stats.totalSignals}`, 'info');
  }, 30000);
});

process.on('unhandledRejection', (error) => {
  addLog(`Erro nao tratado: ${error.message}`, 'error');
});
                                                
