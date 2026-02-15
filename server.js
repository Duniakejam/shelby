import express from 'express';
import cors from 'cors';
import { ShelbyNodeClient, ClayErasureCodingProvider, generateCommitments } from "@shelby-protocol/sdk/node";
import { PrivateKey, Ed25519Account, Ed25519PrivateKey, Aptos, AptosConfig, Network } from "@aptos-labs/ts-sdk";
import crypto from "crypto";
import fetch from "node-fetch";
import fs from 'fs/promises';
import { existsSync } from 'fs';

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const DATA_FILE = './sessions.json';
let sessions = new Map();
const sseClients = new Map();

async function loadSessions() {
  try {
    if (existsSync(DATA_FILE)) {
      const data = await fs.readFile(DATA_FILE, 'utf8');
      const obj = JSON.parse(data);
      sessions = new Map(Object.entries(obj));
    }
  } catch (e) {}
}

async function saveSessions() {
  const obj = Object.fromEntries(sessions);
  await fs.writeFile(DATA_FILE, JSON.stringify(obj, null, 2));
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function formatPrivateKey(privateKey) {
  if (privateKey.startsWith('ed25519-priv-')) return privateKey;
  const hexPart = privateKey.replace('0x', '');
  if (hexPart.length === 64) return `ed25519-priv-${hexPart}`;
  try {
    return PrivateKey.formatPrivateKey(privateKey, 'ed25519');
  } catch (e) {
    return privateKey;
  }
}

function generateTextBlob(index) {
  const subjects = ["Aku", "Dia", "Mereka", "Kita", "Temanku"];
  const verbs = ["makan", "lihat", "suka", "pergi ke"];
  const objects = ["rumah", "taman", "mall", "pantai"];
  const extras = ["kemarin", "besok", "tadi"];
  const s = subjects[Math.floor(Math.random() * subjects.length)];
  const v = verbs[Math.floor(Math.random() * verbs.length)];
  const o = objects[Math.floor(Math.random() * objects.length)];
  const e = extras[Math.floor(Math.random() * extras.length)];
  return {
    name: `uploads/text_${Date.now()}_${index}.txt`,
    data: Buffer.from(`${s} ${v} ${o} ${e}. Kalimat ${index + 1}.`)
  };
}

async function downloadRandomImage(index) {
  try {
    const seed = crypto.randomBytes(4).toString('hex');
    const resp = await fetch(`https://picsum.photos/seed/${seed}/800/600`);
    return { name: `uploads/image_${seed}_800x600.jpg`, data: await resp.buffer() };
  } catch (e) {
    return { name: `uploads/random_${Date.now()}_${index}.bin`, data: crypto.randomBytes(50000) };
  }
}

// ================= CONNECT =================
app.post('/api/connect', async (req, res) => {
  const { privateKey } = req.body;
  if (!privateKey) return res.json({ success: false, error: "PK required" });
  
  try {
    const formattedPk = formatPrivateKey(privateKey);
    const pk = new Ed25519PrivateKey(formattedPk);
    const signer = new Ed25519Account({ privateKey: pk });
    const address = signer.accountAddress.toString();
    
    const sessionId = crypto.randomBytes(16).toString('hex');
    sessions.set(sessionId, {
      privateKey: formattedPk,
      address,
      uploads: [], // {name, size, timestamp, txHash}
      createdAt: Date.now()
    });
    await saveSessions();
    
    res.json({
      success: true,
      sessionId,
      address,
      shortAddress: `${address.slice(0, 6)}...${address.slice(-4)}`
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ================= ADD EXISTING BLOB (Manual Import) =================
app.post('/api/add-existing', async (req, res) => {
  const { sessionId, blobNames } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  
  // Tambahkan blob yang sudah ada (dari explorer) ke session
  for (const name of blobNames) {
    if (!session.uploads.find(u => u.name === name)) {
      session.uploads.push({
        name: name,
        size: 0, // Unknown
        timestamp: Date.now(),
        txHash: 'unknown',
        isExisting: true // Mark as imported from explorer
      });
    }
  }
  
  await saveSessions();
  res.json({ success: true, added: blobNames.length, total: session.uploads.length });
});

// ================= UPLOAD =================
app.post('/api/upload', async (req, res) => {
  const { sessionId, mode, count, delay } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(401).json({ error: "Session not found" });
  
  res.json({ success: true });
  
  (async () => {
    try {
      const aptosClient = new Aptos(new AptosConfig({ network: Network.SHELBYNET }));
      const shelbyClient = new ShelbyNodeClient({ network: Network.SHELBYNET });
      const pk = new Ed25519PrivateKey(session.privateKey);
      const signer = new Ed25519Account({ privateKey: pk });
      
      const send = (data) => {
        const clients = sseClients.get(sessionId) || [];
        clients.forEach(c => { try { c.write(`data: ${JSON.stringify(data)}\n\n`); } catch(e) {} });
      };
      
      send({ type: 'start', total: count });
      
      for (let i = 0; i < count; i++) {
        try {
          send({ type: 'progress', current: i + 1, total: count, step: 'generate' });
          let blobData = mode === 'text' ? generateTextBlob(i) : await downloadRandomImage(i);
          
          send({ type: 'progress', current: i + 1, total: count, step: 'register', name: blobData.name });
          const provider = await ClayErasureCodingProvider.create();
          const commitments = await generateCommitments(provider, blobData.data);
          
          const { transaction: pendingTx } = await shelbyClient.coordination.registerBlob({
            account: signer,
            blobName: blobData.name,
            blobMerkleRoot: commitments.blob_merkle_root,
            size: blobData.data.length,
            expirationMicros: BigInt((Date.now() + 30 * 24 * 60 * 60 * 1000) * 1000),
          });
          
          send({ type: 'progress', current: i + 1, total: count, step: 'confirm', hash: pendingTx.hash });
          await aptosClient.waitForTransaction({ transactionHash: pendingTx.hash });
          
          send({ type: 'progress', current: i + 1, total: count, step: 'upload' });
          await shelbyClient.rpc.putBlob({
            account: signer.accountAddress,
            blobName: blobData.name,
            blobData: blobData.data,
          });
          
          session.uploads.push({
            name: blobData.name,
            size: blobData.data.length,
            timestamp: Date.now(),
            txHash: pendingTx.hash,
            isExisting: false
          });
          await saveSessions();
          
          send({ type: 'uploaded', name: blobData.name, current: i + 1 });
        } catch (err) {
          console.error(`[ERROR ${i+1}]`, err.message);
          send({ type: 'error', current: i + 1, message: err.message });
          if (err.message.includes('INSUFFICIENT') || err.message.includes('SEQUENCE')) {
            send({ type: 'fatal', message: 'Gas error. Stopping.' });
            break;
          }
        }
        if (i < count - 1) await sleep(delay || 2000);
      }
      send({ type: 'done', total: count, uploaded: session.uploads.length });
    } catch (err) {
      console.error('[FATAL]', err);
    }
  })();
});

// ================= GET BLOBS (GROUPED BY FOLDER) =================
app.get('/api/blobs/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  
  // Group by folder (prefix before last /)
  const folders = {};
  session.uploads.forEach(blob => {
    const parts = blob.name.split('/');
    const folder = parts.length > 1 ? parts[0] : 'root';
    if (!folders[folder]) folders[folder] = [];
    folders[folder].push(blob);
  });
  
  res.json({
    success: true,
    uploads: session.uploads,
    folders: folders,
    count: session.uploads.length,
    address: session.address
  });
});

// ================= DELETE BULK =================
app.post('/api/delete', async (req, res) => {
  const { sessionId, blobNames } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  
  const results = [];
  try {
    const aptosClient = new Aptos(new AptosConfig({ network: Network.SHELBYNET }));
    const shelbyClient = new ShelbyNodeClient({ network: Network.SHELBYNET });
    const pk = new Ed25519PrivateKey(session.privateKey);
    const signer = new Ed25519Account({ privateKey: pk });
    
    for (const blobName of blobNames) {
      try {
        try { await shelbyClient.rpc.deleteBlob({ account: signer.accountAddress, blobName }); } catch (e) {}
        const { transaction: pendingTx } = await shelbyClient.coordination.deleteBlob({ account: signer, blobName });
        await aptosClient.waitForTransaction({ transactionHash: pendingTx.hash });
        session.uploads = session.uploads.filter(u => u.name !== blobName);
        results.push({ name: blobName, success: true });
        await sleep(1500);
      } catch (error) {
        results.push({ name: blobName, success: false, error: error.message });
      }
    }
    await saveSessions();
    res.json({ success: true, results, summary: { deleted: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length } });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ================= SSE =================
app.get('/api/stream/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (!sessions.has(sessionId)) return res.status(404).end();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (!sseClients.has(sessionId)) sseClients.set(sessionId, []);
  sseClients.get(sessionId).push(res);
  req.on('close', () => {
    const clients = sseClients.get(sessionId) || [];
    sseClients.set(sessionId, clients.filter(c => c !== res));
  });
});

// ================= DISCONNECT =================
app.post('/api/disconnect', async (req, res) => {
  const { sessionId } = req.body;
  if (sessions.has(sessionId)) {
    sessions.delete(sessionId);
    await saveSessions();
    sseClients.delete(sessionId);
  }
  res.json({ success: true });
});

await loadSessions();
app.listen(8080, () => console.log('🚀 http://localhost:8080'));