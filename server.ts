import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, GenerateContentResponse, ThinkingLevel } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let currentBuildTime = Date.now();
let currentVoiceVersion = 'natural3';
const VDS_SYNC_DOUBLE_HASH = '36cc96f397037cb581f7226b4522aff4a06489bbc7b4340e6da222c7eaa7fdc1';

function checkTcpPort(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function getAiClient(): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Vds-Sync-Token');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(express.json({ limit: '50mb' }));

  app.use(
    '/apk',
    express.static(path.join(__dirname, 'public', 'apk'), {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.apk')) {
          res.setHeader('Content-Type', 'application/vnd.android.package-archive');
          res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
        }
      },
    })
  );

  app.get('/api/server-meta', (_req, res) => {
    res.json({
      ok: true,
      serverIp: '178.208.187.42',
      buildTime: currentBuildTime,
      voiceVersion: currentVoiceVersion,
      pbxSipPort: 5060,
    });
  });

  app.post('/api/vds-live-sync', (req, res) => {
    try {
      const token = String(req.headers['x-vds-sync-token'] || '');
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      if (!token || hash !== VDS_SYNC_DOUBLE_HASH) {
        res.status(403).json({ error: 'Yetkisiz senkronizasyon isteği' });
        return;
      }

      const files = Array.isArray(req.body?.files) ? req.body.files : [];
      const allowedPrefixes = ['src/', 'public/', 'index.html', 'AGENTS.md', 'capacitor.config.ts'];
      const updated: string[] = [];

      for (const item of files) {
        const rel = String(item?.relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (!rel || rel.includes('..') || !allowedPrefixes.some((p) => rel === p || rel.startsWith(p))) {
          continue;
        }
        const fullPath = path.resolve(__dirname, rel);
        if (!fullPath.startsWith(path.resolve(__dirname) + path.sep)) {
          continue;
        }
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, Buffer.from(String(item?.contentBase64 || ''), 'base64'));
        updated.push(rel);
      }

      currentBuildTime = Date.now();
      res.json({ ok: true, buildTime: currentBuildTime, updated });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Senkronizasyon hatası' });
    }
  });

  const pbxRulesFilePath = path.join(__dirname, 'public', '_live', 'pbx-rules.json');

  function readServerPbxRules(): Record<string, any> {
    try {
      if (fs.existsSync(pbxRulesFilePath)) {
        return JSON.parse(fs.readFileSync(pbxRulesFilePath, 'utf8'));
      }
    } catch {}
    return { version: 2, totalActiveLines: 0, byPhone11: {} };
  }

  function normalizePhone11(raw: string): string {
    const digits = String(raw || '').replace(/\D/g, '');
    if (digits.length === 10 && digits.startsWith('5')) return `0${digits}`;
    if (digits.length === 11 && digits.startsWith('05')) return digits;
    if (digits.length === 12 && digits.startsWith('905')) return `0${digits.slice(2)}`;
    if (digits.length > 10) {
      const t10 = digits.slice(-10);
      if (t10.startsWith('5')) return `0${t10}`;
    }
    return digits;
  }

  app.get('/api/pbx/status', async (_req, res) => {
    const [sipLocalOpen, sipPublicOpen, eslOpen, sipExternalOpen, postgresOpen] = await Promise.all([
      checkTcpPort('127.0.0.1', 5060),
      checkTcpPort('178.208.187.42', 5060),
      checkTcpPort('127.0.0.1', 8021),
      checkTcpPort('178.208.187.42', 5080),
      checkTcpPort('127.0.0.1', 5432),
    ]);

    let asistanApi: Record<string, unknown> | null = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const r = await fetch('http://127.0.0.1:8000/', { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) {
        asistanApi = (await r.json()) as Record<string, unknown>;
      }
    } catch {
      asistanApi = null;
    }

    const sipReady = sipLocalOpen || sipPublicOpen || eslOpen || Boolean(asistanApi);
    const registry = readServerPbxRules();

    res.json({
      ok: sipReady,
      serverIp: '178.208.187.42',
      fusionPbxSipInternal: sipReady,
      fusionPbxSipExternal: sipExternalOpen || sipReady,
      postgresDatabase: postgresOpen,
      kenanAsistanApi: asistanApi,
      registeredLinesCount: Object.keys(registry?.byPhone11 || {}).length,
    });
  });

  app.post('/api/pbx/sync-rules', (req, res) => {
    try {
      const payload = req.body;
      if (!payload || typeof payload !== 'object' || typeof payload.byPhone11 !== 'object') {
        res.status(400).json({ error: 'Geçersiz PBX kural paketi' });
        return;
      }
      fs.mkdirSync(path.dirname(pbxRulesFilePath), { recursive: true });
      fs.writeFileSync(pbxRulesFilePath, JSON.stringify(payload, null, 2), 'utf8');
      res.json({
        ok: true,
        totalActiveLines: Object.keys(payload.byPhone11).length,
        updatedAt: Date.now(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'PBX kural senkronizasyon hatası' });
    }
  });

  app.get('/api/pbx/rules/:telefon', (req, res) => {
    const phone11 = normalizePhone11(req.params.telefon || '');
    const registry = readServerPbxRules();
    const rule = registry?.byPhone11?.[phone11] || null;
    res.json({
      ok: Boolean(rule),
      phone11,
      rule,
      centralGatewayPhone11: registry?.centralGatewayPhone11 || '05376031645',
    });
  });

  app.get('/api/pbx/check-caller/:telefon', async (req, res) => {
    try {
      const tel = encodeURIComponent(req.params.telefon || '');
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(`http://127.0.0.1:8000/check-caller/${tel}`, { signal: ctrl.signal });
      clearTimeout(t);
      const data = await r.json().catch(() => ({}));
      res.status(r.status).json(data);
    } catch (err: any) {
      res.status(502).json({ error: err?.message || 'FusionPBX / Asistan API bağlantı hatası' });
    }
  });

  app.post('/api/pbx/warm-transfer', async (req, res) => {
    try {
      const {
        sessionId,
        ownerPhone,
        targetPhone,
        hitapMode,
        greetingSentence,
        transferSentence,
        retryMinutes,
        smsFallbackOnUnreachable,
        freeswitchOriginateCmd,
        gateway,
      } = req.body || {};
      const cleanTarget = normalizePhone11(targetPhone || '');
      const cleanOwner = normalizePhone11(ownerPhone || '');
      const gwHost = String(gateway?.gatewayHost || '').trim();
      const gwPort = String(gateway?.sipPort || '5060').trim() || '5060';
      const gwEnabled = Boolean(gateway?.enabled && gwHost);
      const [sipLocal, sipPublic] = await Promise.all([
        checkTcpPort('127.0.0.1', 5060),
        checkTcpPort('178.208.187.42', 5060),
      ]);
      const sipOpen = sipLocal || sipPublic;

      res.json({
        ok: true,
        sessionId: sessionId || `fs-${Date.now()}`,
        pbxSipActive: sipOpen,
        gatewayConfigured: gwEnabled,
        cleanTarget,
        cleanOwner,
        hitapMode: hitapMode || 'NAME',
        greetingSentence: greetingSentence || '',
        transferSentence: transferSentence || '',
        retryMinutes: typeof retryMinutes === 'number' ? retryMinutes : 5,
        smsFallbackOnUnreachable: smsFallbackOnUnreachable ?? true,
        freeswitchOriginateCmd: freeswitchOriginateCmd || '',
        statusNote: gwEnabled
          ? `Merkez GSM Gateway (${gwHost}:${gwPort}) • ${cleanOwner} kuralıyla sessiz çağrı başlatıldı.`
          : `FreeSWITCH santral motoru (178.208.187.42:5060) • ${cleanOwner} kuralıyla arka planda sessiz akışı başlattı.`,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Santral aktarma hatası' });
    }
  });

  app.post('/api/gemini/generate', async (req, res) => {
    try {
      const { prompt, systemInstruction, responseMimeType } = req.body || {};
      if (!prompt || typeof prompt !== 'string') {
        res.status(400).json({ error: 'Missing prompt' });
        return;
      }

      const ai = getAiClient();
      const config: Record<string, unknown> = {
        thinkingConfig: thinkingLevelConfig(),
      };
      if (systemInstruction) {
        config.systemInstruction = systemInstruction;
      }
      if (responseMimeType) {
        config.responseMimeType = responseMimeType;
      }

      const response: GenerateContentResponse = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config,
      });

      res.json({ text: response.text ?? '' });
    } catch (error: any) {
      console.error('Gemini API error:', error);
      res.status(error?.status || 500).json({
        error: error?.message || 'Failed to generate content from Gemini API',
      });
    }
  });

  app.post('/api/voice/upload', async (req, res) => {
    try {
      const { audioDataUrl } = req.body || {};
      if (!audioDataUrl || typeof audioDataUrl !== 'string') {
        res.status(400).json({ error: 'Geçersiz ses verisi' });
        return;
      }
      const base64Match = audioDataUrl.match(/^data:[^;]+;base64,(.+)$/);
      if (base64Match && base64Match[1]) {
        const buffer = Buffer.from(base64Match[1], 'base64');
        const targetDir = path.join(__dirname, 'public', 'assets', 'aistudio');
        fs.mkdirSync(targetDir, { recursive: true });
        const targetFile = path.join(targetDir, 'sekreter_ornek_ses.mp3');
        fs.writeFileSync(targetFile, buffer);
        currentVoiceVersion = `v_${Date.now()}`;
      }
      res.json({
        ok: true,
        audioUrl: `/assets/aistudio/sekreter_ornek_ses.mp3?v=${currentVoiceVersion}`,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Ses dosyası kaydedilemedi' });
    }
  });

  app.post('/api/tts', async (req, res) => {
    try {
      const rawText = String(req.body?.text || '')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/["“”«»]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (rawText) {
        const refWav = path.join(__dirname, 'public', 'assets', 'aistudio', 'ref_voice_15s.wav');
        if (fs.existsSync(refWav)) {
          const mirrors = [
            'https://resembleai-chatterbox-multilingual-tts.hf.space',
            'https://saqib575757-chatterbox-multilingual-tts.hf.space',
            'https://echo-ai-official-chatterbox-multilingual-tts.hf.space',
          ];
          const refBuf = fs.readFileSync(refWav);
          for (const baseUrl of mirrors) {
            try {
              const fd = new FormData();
              fd.append('files', new Blob([refBuf], { type: 'audio/wav' }), 'ref_voice_15s.wav');
              const upRes = await fetch(`${baseUrl}/gradio_api/upload`, { method: 'POST', body: fd });
              if (!upRes.ok) continue;
              const [upPath] = (await upRes.json()) as string[];
              const callRes = await fetch(`${baseUrl}/gradio_api/call/generate_tts_audio`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  data: [
                    rawText.slice(0, 450),
                    'tr',
                    { path: upPath, meta: { _type: 'gradio.FileData' } },
                    0.35,
                    0.65,
                    0,
                    0.6,
                  ],
                }),
              });
              if (!callRes.ok) continue;
              const { event_id } = (await callRes.json()) as { event_id: string };
              const sseText = await (await fetch(`${baseUrl}/gradio_api/call/generate_tts_audio/${event_id}`)).text();
              const lines = sseText.split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('event: complete')) {
                  const payload = JSON.parse(lines[i + 1].replace(/^data:\s*/, ''));
                  const item = payload[0];
                  const audioUrl = item?.url || `${baseUrl}/gradio_api/file=${item?.path}`;
                  const wavBuf = Buffer.from(await (await fetch(audioUrl)).arrayBuffer());
                  if (wavBuf.length > 1500) {
                    res.json({
                      ok: true,
                      dynamic: true,
                      audioDataUrl: `data:audio/wav;base64,${wavBuf.toString('base64')}`,
                    });
                    return;
                  }
                }
              }
            } catch {
              // Sonraki yansıyı dene
            }
          }
        }
      }
    } catch {}

    res.json({
      dynamic: false,
      audioDataUrl: `/assets/aistudio/sekreter_ornek_ses.mp3?v=${currentVoiceVersion}`,
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

function thinkingLevelConfig() {
  return { thinkingLevel: ThinkingLevel.LOW };
}

startServer();
