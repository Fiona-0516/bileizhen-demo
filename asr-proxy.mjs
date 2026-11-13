/**
 * 避雷针 · 火山「大模型流式语音识别」本地代理
 *
 * 前端把录音转成 16k 单声道 WAV 后 POST 到这里，本进程解析 PCM、
 * 通过 WebSocket 流式发给火山 SAUC（seedasr），返回最终文本。
 *
 * 启动：
 *   VOLC_SPEECH_API_KEY=你的Key node asr-proxy.mjs
 * 可选：
 *   PORT=8787
 *   VOLC_ASR_URL=wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async
 *   VOLC_ASR_RESOURCE_ID=volc.seedasr.sauc.duration
 */
import { createServer } from 'node:http';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';

const KEY = process.env.VOLC_SPEECH_API_KEY || process.env.VOLC_ARK_KEY || '';
const ASR_URL = process.env.VOLC_ASR_URL || 'wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async';
const RESOURCE = process.env.VOLC_ASR_RESOURCE_ID || 'volc.seedasr.sauc.duration';
const PORT = Number(process.env.PORT || 8787);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Private-Network': 'true'
};
const json = (res, code, obj) => {
  res.writeHead(code, { ...CORS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

function frame(msgType, flags, ser, comp, payload) {
  const head = Buffer.alloc(8);
  head[0] = 0x11;
  head[1] = (msgType << 4) | flags;
  head[2] = (ser << 4) | comp;
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

function readFrame(raw) {
  const flags = raw[1] & 0x0f;
  let off = 4;
  if (flags & 1) off += 4;
  const size = raw.readUInt32BE(off);
  off += 4;
  let body = raw.subarray(off, off + size);
  if ((raw[2] & 0x0f) === 1) { try { body = gunzipSync(body); } catch (e) { /* ignore */ } }
  return body.toString('utf8');
}

function wavToPcm(buf) {
  if (buf.length < 44) return buf;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
    off += 8 + size + (size % 2);
  }
  return buf.subarray(44);
}

async function transcribe(pcm) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ASR_URL, {
      headers: {
        'X-Api-Key': KEY,
        'X-Api-Resource-Id': RESOURCE,
        'X-Api-Request-Id': randomUUID()
      }
    });
    let finalText = '';
    const timer = setTimeout(() => { try { ws.close(); } catch (e) { } reject(new Error('识别超时')); }, 20000);

    ws.onopen = () => {
      const cfg = {
        user: { uid: 'bileizhen-demo' },
        audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1, codec: 'raw' },
        request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true, result_type: 'full' }
      };
      ws.send(frame(1, 0, 1, 1, gzipSync(Buffer.from(JSON.stringify(cfg)))));
      let off = 0;
      const step = 3200; // 100ms @16k16bit
      const tick = setInterval(() => {
        if (off >= pcm.length) {
          clearInterval(tick);
          try { ws.send(frame(2, 2, 0, 1, gzipSync(Buffer.alloc(0)))); } catch (e) { }
          return;
        }
        try { ws.send(frame(2, 0, 0, 1, gzipSync(pcm.subarray(off, off + step)))); } catch (e) { }
        off += step;
      }, 60);
    };

    ws.onmessage = async ev => {
      const raw = Buffer.from(ev.data instanceof Blob ? await ev.data.arrayBuffer() : ev.data);
      let body;
      try { body = JSON.parse(readFrame(raw)); } catch (e) { return; }
      if (body.result && body.result.text) finalText = body.result.text;
      if (body.error) { clearTimeout(timer); reject(new Error(body.error)); }
    };

    ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket 连接失败')); };
    ws.onclose = () => {
      clearTimeout(timer);
      resolve(finalText.replace(/[。，]$/, ''));
    };
  });
}

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (req.url === '/health') return json(res, 200, { ok: true, configured: Boolean(KEY), resource: RESOURCE });

  if (req.url !== '/api/asr' || req.method !== 'POST') return json(res, 404, { error: 'not found' });
  if (!KEY) return json(res, 500, { error: '缺少 VOLC_SPEECH_API_KEY 环境变量' });

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const wav = Buffer.concat(chunks);
  if (wav.length < 100) return json(res, 400, { error: '音频为空' });

  try {
    const text = await transcribe(wavToPcm(wav));
    json(res, 200, { text });
  } catch (err) {
    json(res, 200, { text: '', error: err.message || '识别失败' });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`ASR proxy: http://127.0.0.1:${PORT}/api/asr`);
  console.log(`凭据：${KEY ? '已配置' : '未配置（请设置 VOLC_SPEECH_API_KEY）'} · ${RESOURCE}`);
});
