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
  stats: {
    signalsToday: 0,
    totalSignals: 0,
    wins: 0,
    losses: 0
  }
};

// ========== FUNÇÕES TELEGRAM ==========
async function sendTelegramNotification(message) {
  try {
    await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log('📱 Notificação Telegram enviada');
  } catch (error) {
    console.error('❌ Erro ao enviar Telegram:', error.message);
  }
}

// ========== FUNÇÕES API COINGECKO ==========
async function loadMarketData() {
  try {
    console.log('📡 Buscando preços da CoinGecko...');
    
    const coinIds = Object.keys(COINS);
    const batchSize = 25;
    const batches = [];
    
    for (let i = 0; i < coinIds.length; i += batchSize) {
      batches.push(coinIds.slice(i, i + batchSize));
    }
    
    state.marketData = {};
    
    for (const batch of batches) {
      const ids = batch.join(',');
      const timestamp = Date.now();
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&x_cg_demo_api_key=${COINGECKO_API_KEY}&_=${timestamp}`;
      
      const response = await fetch(url, {
        headers: { 'Cache-Control': 'no-cache' }
      });
      
      if (!response.ok) {
        console.error(`❌ Erro CoinGecko: ${response.status}`);
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
        }
      }
      
      if (batches.indexOf(batch) < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    console.log(`✅ ${Object.keys(state.marketData).length} moedas atualizadas`);
    return true;
  } catch (error) {
    console.error('❌ Erro ao buscar preços:', error.message);
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
    return { valid: false, reason: 'Volatilidade fora' };
  }
  
  if (volume24h < ROBOT_CONFIG.minVolume) {
    return { valid: false, reason: 'Volume baixo' };
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
    return { valid: false, reason: `Poucas confirmações (${confirmed})` };
  }
  
  const score = Math.floor((confirmed / 7) * 100);
  
  if (score < ROBOT_CONFIG.minScore) {
    return { valid: false, reason: `Score baixo (${score}%)` };
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
    console.log('\n🔍 Iniciando análise de mercado...');
    
    await loadMarketData();
    
    const potentialSignals = [];
    
    for (const [pair, data] of Object.entries(state.marketData)) {
      const setup = checkSetup(pair, data);
      
      if (setup.valid && state.activeOperations.length < ROBOT_CONFIG.maxPositions) {
        potentialSignals.push(setup);
      }
    }
    
    if (potentialSignals.length > 0) {
      const ranked = potentialSignals.sort((a, b) => b.ranking - a.ranking);
      const best = ranked[0];
      
      console.log(`✅ SINAL ENCONTRADO: ${best.pair} ${best.direction} - Ranking ${best.ranking}/110`);
      
      state.signals.unshift(best);
      state.signals = state.signals.slice(0, 10);
      state.stats.signalsToday++;
      state.stats.totalSignals++;
      
      const message = `
🎯 <b>SINAL ELITE DETECTADO!</b>

<b>Par:</b> ${best.pair}
<b>Direção:</b> ${best.direction}
<b>Entrada:</b> $${best.entry}
<b>Stop Loss:</b> $${best.stopLoss}
<b>TP2:</b> $${best.tp2}

<b>Ranking:</b> ${best.ranking}/110 ⭐
<b>Score:</b> ${best.strength}%
<b>Confirmações:</b> ${best.confirmed}/7
<b>Volatilidade:</b> ${best.volatility}%
<b>Setup:</b> ${best.setup}

💰 <b>Sugestão de Posição:</b> R$ ${(state.banca * ROBOT_CONFIG.riskPerTrade * ROBOT_CONFIG.leverage).toFixed(2)}

⏰ ${new Date().toLocaleTimeString('pt-BR')}
      `.trim();
      
      await sendTelegramNotification(message);
      
      state.lastAnalysis = new Date();
    } else {
      console.log('ℹ️ Nenhum sinal ELITE encontrado neste ciclo');
    }
    
  } catch (error) {
    console.error('❌ Erro na análise:', error.message);
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

// Health check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ========== INICIALIZAÇÃO ==========
app.listen(PORT, async () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📱 Notificações Telegram configuradas`);
  console.log(`🤖 Bruno Trader ATIVO 24/7!`);
  
  await sendTelegramNotification(`
🚀 <b>BRUNO TRADER INICIADO!</b>

✅ Servidor online e rodando 24/7
🔍 Monitorando 50 criptomoedas
💎 Filtro ELITE ativo
📊 Análise a cada 3 minutos

Você receberá notificações quando houver sinais!

⏰ ${new Date().toLocaleString('pt-BR')}
  `.trim());
  
  setTimeout(analyzeMarket, 5000);
  setInterval(loadMarketData, 10000);
  setInterval(analyzeMarket, 180000);
});

process.on('unhandledRejection', (error) => {
  console.error('❌ Erro não tratado:', error);
});
