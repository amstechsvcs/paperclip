#!/usr/bin/env node
/**
 * Repro e2e — PRO-909 T1: roteamento de summarization do omniroute.
 *
 * Reproduz no gateway real a assinatura dos runs mortos:
 *   request gigante (100k–313k tokens_in) via alias `claude-*` que o
 *   modelAliases roteia para elo flash (`glm/glm-5.3-flash`), streaming,
 *   mesmo shape do Claude CLI (tools + histórico + system).
 *
 * Uso:
 *   OMNIROUTE_URL=http://localhost:61236 \
 *   OMNIROUTE_KEY=<api key> \
 *   node scripts/omniroute-summarization-repro.mjs [--tokens 212966,313035] \
 *        [--alias claude-sonnet-5-5] [--timeout-ms 900000]
 *
 * Saída: JSON com status HTTP, tokens, duração, conteúdo da resposta
 * (primeiros 200 chars) e conteúdo do summary. Exit 0 se TODOS os targets
 * retornaram resposta não-vazia; exit 1 se qualquer target falhar/vazio.
 *
 * Nunca loga o valor da key.
 */
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const BASE_URL = (arg("url") || process.env.OMNIROUTE_URL || "http://localhost:61236").replace(/\/$/, "");
const API_KEY = arg("key") || process.env.OMNIROUTE_KEY;
const ALIAS = arg("alias") || process.env.OMNIROUTE_ALIAS || "claude-sonnet-5-5";
const TOKEN_TARGETS = String(arg("tokens") || process.env.OMNIROUTE_TOKENS || "212966,313035")
  .split(",")
  .map((t) => Number(t.trim()))
  .filter((t) => Number.isFinite(t) && t > 0);
const TIMEOUT_MS = Number(arg("timeout-ms") || process.env.OMNIROUTE_TIMEOUT_MS || 15 * 60 * 1000);
const OUT_DIR = arg("out") || "/tmp/omniroute-repro";

if (!API_KEY) {
  console.error("ERRO: informe OMNIROUTE_KEY (nunca em commit/log).");
  process.exit(2);
}
if (TOKEN_TARGETS.length === 0) {
  console.error("ERRO: informe ao menos um alvo de tokens (--tokens 212966,313035).");
  process.exit(2);
}

// Conteúdo real de histórico (código + prosa + JSON) tokeniza a ~3,3 chars/token;
// lorem repetido chega a ~6,7 e subestima os tokens. Usamos blocos com formato
// de código/JSON para calibrar, e o script ajusta com o usage real da resposta.
const CHARS_PER_TOKEN = 3.3;

/**
 * Fixture no shape do request de compaction do Claude CLI:
 * system curto + N mensagens user/assistant alternadas + tools dummy
 * (o CLI envia as tools do run na compaction; vimos 21–39 tools nos
 * requests de produção que morreram).
 */
function buildFixture(targetTokens) {
  const budgetChars = Math.round(targetTokens * CHARS_PER_TOKEN);
  const tools = Array.from({ length: 24 }, (_, i) => ({
    name: `Tool_${i}`,
    description: `Ferramenta sintética ${i} do repro PRO-909.`,
    input_schema: {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    },
  }));
  const toolsChars = JSON.stringify(tools).length;

  const messages = [];
  let used = JSON.stringify(messages).length + toolsChars + 2000; // margem p/ system e envelope
  let i = 0;
  while (used < budgetChars) {
    const role = i % 2 === 0 ? "user" : "assistant";
    // blocos de ~2.5k chars com formato de código/JSON (tokenização ~3,3 chars/token,
    // igual ao histórico real de agente medido nos call_logs de produção)
    const blockLen = Math.min(2500, budgetChars - used);
    const line = `  "field_${i}": {"path": "/srv/app/module_${i % 40}.ts", "lines": [${i}, ${i + 12}], "status": "modified"}, // checkpoint ${i}`;
    const text = `// Bloco sintético ${i} do repro PRO-909 (histórico de agente)\n` + line.repeat(Math.ceil(blockLen / line.length)).slice(0, blockLen);
    messages.push({ role, content: [{ type: "text", text }] });
    used += JSON.stringify(messages[messages.length - 1]).length;
    i++;
  }

  return {
    model: ALIAS,
    max_tokens: 4096,
    stream: true,
    system: [
      {
        type: "text",
        text: "Você é um assistente de engenharia. Quando pedido, produza um resumo detalhado e estruturado da conversa até o momento, preservando decisões, arquivos tocados e próximos passos. Responda sempre com conteúdo textual não-vazio.",
      },
    ],
    messages,
    tools,
  };
}

async function runOne(targetTokens) {
  const fixture = buildFixture(targetTokens);
  const bodyBytes = Buffer.byteLength(JSON.stringify(fixture));
  console.error(`[${targetTokens} tokens] fixture: ${fixture.messages.length} mensagens, ${bodyBytes} bytes`);

  const t0 = Date.now();
  let resp;
  let err = null;
  try {
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    resp = await fetch(`${BASE_URL}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(fixture),
      signal: ctrl.signal,
    });
    clearTimeout(kill);
  } catch (e) {
    err = e;
  }
  const durMs = Date.now() - t0;

  const result = {
    targetTokens,
    alias: ALIAS,
    requestedBytes: bodyBytes,
    durationMs: durMs,
    httpStatus: resp ? resp.status : null,
    fetchError: err ? String(err && err.message || err) : null,
    contentType: resp ? resp.headers.get("content-type") : null,
  };

  if (!resp) {
    result.empty = true;
    result.contentChars = 0;
    result.summary = `fetch falhou: ${result.fetchError}`;
    return result;
  }

  // Consome o SSE (stream=true) contando eventos de conteúdo
  let contentChars = 0;
  let stopReason = null;
  let usage = null;
  let firstErr = null;
  const text = await resp.text();
  if ((result.contentType || "").includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const ev = JSON.parse(payload);
        if (ev.type === "content_block_delta" && ev.delta && typeof ev.delta.text === "string") {
          contentChars += ev.delta.text.length;
        }
        if (ev.type === "message_delta" && ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.type === "message_delta" && ev.usage) usage = ev.usage;
        if (ev.type === "error" || ev.error) firstErr = firstErr || JSON.stringify(ev.error || ev).slice(0, 200);
      } catch {
        /* ping/keepalive não-JSON */
      }
    }
  } else {
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j.content)) {
        contentChars = j.content.reduce((n, b) => n + (b.type === "text" ? (b.text || "").length : 0), 0);
      }
      stopReason = j.stop_reason || null;
      usage = j.usage || null;
      if (j.error) firstErr = JSON.stringify(j.error).slice(0, 200);
    } catch {
      firstErr = `resposta não-JSON: ${text.slice(0, 200)}`;
    }
  }

  result.contentChars = contentChars;
  result.empty = contentChars === 0;
  result.stopReason = stopReason;
  result.usage = usage;
  result.summary =
    contentChars > 0
      ? `resposta não-vazia: ${contentChars} chars de conteúdo`
      : firstErr
        ? `resposta VAZIA — primeiro erro: ${firstErr}`
        : `resposta VAZIA — stop_reason=${stopReason}`;
  return result;
}

mkdirSync(OUT_DIR, { recursive: true });
const results = [];
let allOk = true;
for (const t of TOKEN_TARGETS) {
  const r = await runOne(t);
  results.push(r);
  console.error(`[${t}] HTTP ${r.httpStatus} em ${(r.durationMs / 1000).toFixed(1)}s → ${r.summary}`);
  if (r.empty || (r.httpStatus && r.httpStatus >= 400)) allOk = false;
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = join(OUT_DIR, `repro-${stamp}.json`);
writeFileSync(outFile, JSON.stringify({ baseUrl: BASE_URL, alias: ALIAS, results }, null, 2));
console.error(`resultado salvo em ${outFile}`);
process.exit(allOk ? 0 : 1);
