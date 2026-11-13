/**
 * 避雷针 · 火山引擎语音识别本地代理
 *
 * 作用：前端（file:// 或本地页面）把录音转成 16k 单声道 WAV 后 POST 到这里，
 *      由本进程带凭据调用火山「一句话识别」，避免把 Access Token 暴露在页面里。
 *
 * 启动：
 *   VOLC_APPID=你的AppID VOLC_TOKEN=你的AccessToken node asr-proxy.mjs
 * 可选：
 *   PORT=8787  VOLC_CLUSTER=volcengine_input_common
 *
 * 说明：
 * - 走的是语音技术控制台的「一句话识别」HTTP 接口（≤60 秒音频）。
 * - 如果账号只开通了流式识别（volc.seedasr.sauc.duration），这个接口会返回鉴权/权限错误，
 *   需要改用流式 WebSocket 版本，告诉我即可替换。
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const APPID = process.env.VOLC_APPID || '';
const TOKEN = process.env.VOLC_TOKEN || '';
const CLUSTER = process.env.VOLC_CLUSTER || 'volcengine_input_common';
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

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (req.url === '/health') {
    return json(res, 200, { ok: true, configured: Boolean(APPID && TOKEN), cluster: CLUSTER });
  }

  if (req.url !== '/api/asr' || req.method !== 'POST') {
    return json(res, 404, { error: 'not found' });
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const wav = Buffer.concat(chunks);
  if (wav.length < 44) return json(res, 400, { error: '音频为空' });
  if (!APPID || !TOKEN) return json(res, 500, { error: '缺少 VOLC_APPID / VOLC_TOKEN 环境变量' });

  try {
    const url = `https://openspeech.bytedance.com/api/v1/asr?appid=${encodeURIComponent(APPID)}&cluster=${encodeURIComponent(CLUSTER)}`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': `Bearer; ${TOKEN}`
      },
      body: JSON.stringify({
        app: { appid: APPID, token: TOKEN, cluster: CLUSTER },
        user: { uid: 'bileizhen-demo' },
        audio: { format: 'wav', rate: 16000, bits: 16, channel: 1, data: wav.toString('base64') },
        request: {
          reqid: randomUUID(),
          sequence: 1,
          nbest: 1,
          workflow: 'audio_in,resample,partition,vad,fe,decode'
        }
      })
    });

    const data = await upstream.json().catch(() => ({}));
    const text = (data.result && data.result[0] && data.result[0].text) || '';
    if (!upstream.ok || data.code) {
      return json(res, 200, {
        text: '',
        error: data.message || `上游返回 ${upstream.status}（code ${data.code ?? '未知'}）`,
        raw: data
      });
    }
    return json(res, 200, { text });
  } catch (err) {
    return json(res, 500, { error: '调用失败：' + (err.message || String(err)) });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`ASR proxy: http://127.0.0.1:${PORT}/api/asr`);
  console.log(`凭据：${APPID && TOKEN ? '已配置' : '未配置（请设置 VOLC_APPID / VOLC_TOKEN）'} · cluster=${CLUSTER}`);
});
