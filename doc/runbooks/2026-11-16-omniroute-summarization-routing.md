# Runbook — Fix roteamento de summarization do omniroute (PRO-909 T1 / PRO-918)

Data: 2026-11-16 · Autor: DevOps Lead · Alvo: gateway omniroute em lothal (`diegosouzapw/omniroute` @ sha256:b08a12e8…, porta host 61236)

## 1. Diagnóstico (resumo dos fatos medidos)

Runs de agentes morriam com `Prompt is too long · automatic compaction failed: summarization produced empty response`. A chamada de resumo da *automatic compaction* do Claude CLI é um request `POST /v1/messages` com o **histórico completo do run** (100k–313k `tokens_in`), `stream: true`, com as tools do run — o mesmo shape de um turno normal. O `model` pedido é o alias do run (ex.: `claude-sonnet-5-5`), que o gateway resolve via `key_value(namespace='settings', key='modelAliases')` para o elo flash.

Fatos (7 dias de `call_logs`, `api_key_name` lothal_proalog/kamino_hermes/lothal_traffic-pro):

| Elo (`model`) | tokens_in | Taxa de erro | Observação |
|---|---|---|---|
| `glm-5.3-flash` | ≤180k | ~0,3% | saudável |
| `glm-5.3-flash` | 200k–220k | 3,7–9% | início do cliff |
| `glm-5.3-flash` | 240k–280k | 11–22% | zona de morte |
| `glm-5.3-flash` | ≥300k | 100% (2/2 nos últimos 7d) | 313.035 tok → 499 abort; 502 stream active timeout |
| `glm-5.3` (não-flash) | até 399.713 | 200 OK estável | mesmo provider, janela 1M |

Assinatura dos runs mortos: request gigante via alias `claude-sonnet-5*` → `glm/glm-5.3-flash` → 502 (`stream active timeout`, 21 min) / 504 (SSE sem evento em 100s) / 499 (CLI aborta a espera) / resposta vazia. A compaction do CLI dispara exatamente nessa faixa de tokens — daí a correlação com "summarization produced empty response".

Nota adicional: probe com `max_tokens=32` no elo flash retorna **`(empty response)`** mesmo com 18 tokens de input — o flash queima o budget em reasoning invisível. Qualquer chamada de resumo com budget apertado no flash tende ao vazio; com budget folgado o cliff de contexto domina.

## 2. Decisão de mitigação (ordem 2a → 2b do plano aprovado)

**2a — alias/perfil dedicado por request-pattern:** o omniroute tem *middleware hooks* (`middleware_hooks`, sandbox VM que recebe `{body, headers, model, combo, apiKeyInfo, metadata}` e pode reescrever `model` por request) e `forced_model` por api-key. Ambos foram avaliados e **rejeitados**:
- Não há credencial de management disponível para o pipeline (nenhuma `oma_live_`/`manage` scope no banco; dashboard exige senha que não está sob custódia do DevOps). O card manda preferir a admin API — sem ela, hooks não são criáveis pelo caminho aprovado.
- `forced_model` por api-key sobrescreve **todos** os requests da key — mataria o roteamento por modelo de todos os agentes que compartilham a key.
- Um hook global no caminho de inferência de todos os agentes adiciona um sandbox VM como dependência crítica (blast radius desproporcional à correção).

**2b — aplicada:** trocar o destino dos aliases de contexto insuficiente no alias-map compartilhado:
- `claude-sonnet-5` : `glm/glm-5.3-flash` → **`glm/glm-5.3`**
- `claude-sonnet-5-5` : `glm/glm-5.3-flash` → **`glm/glm-5.3`**
- `claude-5-5-sonnet` : `glm/glm-5.3-flash` → **`glm/glm-5.3`**
- `ams-work` : `glm/glm-5.3-flash` → **`glm/glm-5.3`**

Justificativa: `glm/glm-5.3` é o elo que já serve `claude-opus-5*`/`ams-plan` com 10x o volume (até 399k tokens, 200 OK estável, latência p50 ~5–10s). Mesmo provider (zhipu primária), sem tier gratuito, janela declarada 1M. Os aliases `claude-haiku*`/`ams-flash`/`claude-5-5-haiku` continuam no `glm-5-turbo`/flash (usados para tarefas leves de classificação — fora do caminho de compaction).

Blast radius: agents que usam `claude-sonnet-5*`/`ams-work` passam a consumir `glm-5.3` (mais caro por token que flash). Janela monitorada: ver §5.

## 3. Estado antes/depois do `key_value`

**Antes** (`namespace='settings' AND key='modelAliases'` — blob JSON, 724 bytes):

```json
{
  "ams-plan": "glm/glm-5.3",
  "ams-work": "glm/glm-5.3-flash",
  "ams-flash": "glm/glm-5-turbo",
  "ams-review": "antigravity/gemini-3.8-flash-tiered",
  "claude-opus-5": "glm/glm-5.3",
  "claude-sonnet-5": "glm/glm-5.3-flash",
  "claude-haiku-4-5": "glm/glm-5-turbo",
  "claude-fable-5": "antigravity/gemini-3.8-flash-tiered",
  "claude-mythos-5": "antigravity/gemini-3.1-pro-high",
  "claude-opus-5-5": "glm/glm-5.3",
  "claude-sonnet-5-5": "glm/glm-5.3-flash",
  "claude-5-5-opus": "glm/glm-5.3",
  "claude-5-5-sonnet": "glm/glm-5.3-flash",
  "claude-5-5-haiku": "glm/glm-5-turbo",
  "claude-haiku-5": "glm/glm-5-turbo",
  "claude-haiku-5-5": "glm/glm-5-turbo",
  "gemini-3.1-pro-high": "antigravity/gemini-3.1-pro-high",
  "gemini-3.8-flash-infered": "antigravity/gemini-3.8-flash-tiered"
}
```

**Depois** (somente as 4 chaves acima mudam):

```json
"ams-work":         "glm/glm-5.3",        // era glm/glm-5.3-flash
"claude-sonnet-5":  "glm/glm-5.3",        // era glm/glm-5.3-flash
"claude-sonnet-5-5":"glm/glm-5.3",        // era glm/glm-5.3-flash
"claude-5-5-sonnet":"glm/glm-5.3"         // era glm/glm-5.3-flash
```

## 4. Procedimento de aplicação

Pré-requisito: snapshot do banco (feito, ver §6).

1. **Snapshot**:
   ```sh
   sqlite3 ~/omniroute/data/storage.sqlite \
     ".backup /home/arthur/omniroute/backups/storage-pre-909-$(date +%Y%m%d-%H%M%S).sqlite"
   ```
2. **Ler estado atual** (read-only):
   ```sh
   sqlite3 -readonly ~/omniroute/data/storage.sqlite \
     "SELECT value FROM key_value WHERE namespace='settings' AND key='modelAliases';" > /tmp/aliases-antes.json
   ```
3. **Aplicar** (UPDATE atômico do blob; o runtime lê o `key_value` por request e o writer invalida cache — sem restart):
   ```sh
   python3 - <<'EOF'
   import json, sqlite3
   path = "/home/arthur/omniroute/data/storage.sqlite"
   con = sqlite3.connect(path, timeout=30)
   cur = con.execute("SELECT value FROM key_value WHERE namespace='settings' AND key='modelAliases'")
   aliases = json.loads(cur.fetchone()[0])
   for k in ("ams-work", "claude-sonnet-5", "claude-sonnet-5-5", "claude-5-5-sonnet"):
       aliases[k] = "glm/glm-5.3"
   con.execute("UPDATE key_value SET value=? WHERE namespace='settings' AND key='modelAliases'",
               (json.dumps(aliases, separators=(',',':')),))
   con.commit()
   print("aliases atualizados:", {k: aliases[k] for k in ("ams-work","claude-sonnet-5","claude-sonnet-5-5","claude-5-5-sonnet")})
   EOF
   ```
4. **Verificar** (read-only + probe):
   ```sh
   sqlite3 -readonly ~/omniroute/data/storage.sqlite \
     "SELECT value FROM key_value WHERE namespace='settings' AND key='modelAliases';" | python3 -m json.tool | grep -E 'sonnet|ams-work'
   # probe de roteamento (esperado: ROUTING claude-sonnet-5-5 → glm/glm-5.3 no app.log):
   node /home/arthur/paperclip/scripts/omniroute-summarization-repro.mjs --tokens 1000 --alias claude-sonnet-5-5
   ```
5. **Verificação e2e** (passo 3 do card): rodar o MESMO repro do passo "antes" com os alvos 212.966/313.035 e conferir resposta não-vazia + linha nova no `call_logs` com `model='glm-5.3'`.

## 5. Rollback

Reverter o blob para o snapshot salvo em `/tmp/aliases-antes.json` (ou o `.backup` completo §6):

```sh
python3 - <<'EOF'
import json, sqlite3
con = sqlite3.connect("/home/arthur/omniroute/data/storage.sqlite", timeout=30)
antes = json.load(open("/tmp/aliases-antes.json"))
con.execute("UPDATE key_value SET value=? WHERE namespace='settings' AND key='modelAliases'",
            (json.dumps(antes, separators=(',',':')),))
con.commit()
print("rollback aplicado")
EOF
```

Rollback é O(1) — um UPDATE no `key_value`, efetivo no request seguinte, sem restart. Se o `.backup` inteiro for necessário (corrupção), restaurar via `docker compose down && cp backup storage.sqlite && docker compose up -d` em `~/omniroute` (janela de downtime do gateway; preferir o UPDATE).

## 6. Registros

- Snapshot pré-mudança: `~/omniroute/backups/storage-pre-909-20261116-135019.sqlite` (689 MB, 2026-11-16 13:50 -03)
- `/tmp/aliases-antes.json` — blob exato antes do UPDATE
- Repro script: `scripts/omniroute-summarization-repro.mjs` (branch `bugfix/909-omniroute-summarization`)

## 7. Monitoramento pós-mudança (janela de 48h)

- `call_logs` por `model='glm-5.3'` e `requested_model IN ('glm/glm-5.3-flash', 'glm/glm-5.3')`: taxa de erro e tokens_out (vazios).
- `app.log` tag `ROUTING`: confirmar `claude-sonnet-5-5 → glm/glm-5.3`.
- Custo: `glm-5.3` é mais caro por token que o flash — acompanhar faturamento zhipu na janela; se custo explodir, rever para combo com fallback (fora do escopo T1).
