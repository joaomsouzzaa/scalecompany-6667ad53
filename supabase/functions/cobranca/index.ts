import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Endpoints do UAZAPI (mesmos da função `uazapi`).
const UAZAPI = {
  init: (base: string) => `${base}/instance/init`,
  connect: (base: string) => `${base}/instance/connect`,
  status: (base: string) => `${base}/instance/status`,
  disconnect: (base: string) => `${base}/instance/disconnect`,
  sendText: (base: string) => `${base}/send/text`,
};

// Garante que a instância existe na UAZAPI e devolve o token DELA.
// Cada instância tem seu próprio token; o admintoken (server) serve só para criá-la.
// Guarda o instance_token no banco para reutilizar nas próximas operações.
async function ensureInstanceToken(supabase: any, cfg: any, base: string): Promise<string> {
  if (cfg?.instance_token) return cfg.instance_token;
  const nome = cfg?.instance || "cobranca";
  // POST /instance/init com admintoken cria (ou retorna) a instância.
  const data = await uazFetch(base, UAZAPI.init(base), cfg.admin_token, { name: nome });
  const inst = data.instance || data || {};
  const token = inst.token || inst.apikey || data.token || data.apikey || null;
  if (!token) throw new Error("UAZAPI não retornou o token da instância ao criar");
  await supabase
    .from("cobranca_whatsapp_config")
    .update({ instance_token: token, updated_at: new Date().toISOString() })
    .eq("id", cfg.id);
  cfg.instance_token = token;
  return token;
}

function svc() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

// Config da instância EXCLUSIVA da Cobrança.
async function getConfig(supabase: any) {
  const { data } = await supabase.from("cobranca_whatsapp_config").select("*").maybeSingle();
  return data;
}

async function uazFetch(base: string, path: string, token: string, body?: unknown) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", token, admintoken: token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(json?.error || json?.message || `UAZAPI ${res.status}`);
  return json;
}

// Substitui {{var}} pelos valores do mapa
function render(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ""));
}

// Normaliza telefone para a chave de identidade (só dígitos).
function normTelefone(s: string): string {
  return (s || "").replace(/\D/g, "");
}

async function enviarTexto(cfg: any, destinatario: string, mensagem: string) {
  const base = (cfg?.server_url || "").replace(/\/$/, "");
  // Envio usa o token DA INSTÂNCIA (cai pro admin_token se ainda não houver).
  const token = cfg?.instance_token || cfg?.admin_token;
  if (!base || !token) throw new Error("Configuração UAZAPI (Cobrança) incompleta");
  return uazFetch(base, UAZAPI.sendText(base), token, { number: destinatario, text: mensagem });
}

// Próxima mensagem da cadência para um contato, dado o estado atual.
function proximaMensagem(mensagens: any[], ultimaOrdem: number): any | null {
  const ativas = mensagens.filter((m) => m.ativo).sort((a, b) => a.ordem - b.ordem);
  return ativas.find((m) => m.ordem > (ultimaOrdem || 0)) || null;
}

// ---- Match de cliente por similaridade de nome/razão social ----
// Remove acentos, pontuação e sufixos societários (LTDA, ME, EIRELI, S.A...) para comparar.
const SUFIXOS = ["ltda", "me", "epp", "eireli", "sa", "s a", "cia", "e cia", "ltda me", "mei", "ss", "s s"];
function normNome(s: string): string {
  let n = (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  n = n.replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const palavras = n.split(" ").filter((w) => w && !SUFIXOS.includes(w));
  return palavras.join(" ");
}
function tokensDe(s: string): Set<string> {
  return new Set(normNome(s).split(" ").filter((w) => w.length >= 3));
}
// Score 0..1: Jaccard de tokens, com bônus quando um nome contém o outro.
function scoreNome(a: string, b: string): number {
  const na = normNome(a), nb = normNome(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = tokensDe(a), tb = tokensDe(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const jac = inter / (ta.size + tb.size - inter);
  const contains = na.includes(nb) || nb.includes(na) ? 0.3 : 0;
  return Math.min(1, jac + contains);
}
type Cand = { nome: string; telefone: string };
async function carregarCandidatos(supabase: any): Promise<Cand[]> {
  const out: Cand[] = [];
  const { data: vd } = await supabase.from("vendas").select("nome_comprador,telefone_comprador").not("telefone_comprador", "is", null);
  for (const v of vd || []) if (v.nome_comprador && v.telefone_comprador) out.push({ nome: v.nome_comprador, telefone: normTelefone(v.telefone_comprador) });
  const { data: mv } = await supabase.from("mentoria_vendas").select("nome,telefone").not("telefone", "is", null);
  for (const m of mv || []) if (m.nome && m.telefone) out.push({ nome: m.nome, telefone: normTelefone(m.telefone) });
  return out.filter((c) => c.telefone);
}
function melhorMatch(cliente: string, cands: Cand[]): { telefone: string; nome: string; score: number } | null {
  let best: { telefone: string; nome: string; score: number } | null = null;
  for (const c of cands) {
    const s = scoreNome(cliente, c.nome);
    if (!best || s > best.score) best = { telefone: c.telefone, nome: c.nome, score: s };
  }
  // Limiar mínimo de confiança; abaixo disso tratamos como "não encontrado".
  return best && best.score >= 0.5 ? best : null;
}

Deno.serve(async (req) => {
  console.log("cobranca v1");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const supabase = svc();
    const { action, ...payload } = await req.json();
    const cfg = await getConfig(supabase);

    switch (action) {
      case "connect": {
        if (!cfg?.server_url || !cfg?.admin_token) return json({ error: "Configure URL e token primeiro" }, 400);
        const base = cfg.server_url.replace(/\/$/, "");
        // Cria a instância automaticamente (se preciso) e usa o token DELA pra gerar o QR.
        const instToken = await ensureInstanceToken(supabase, cfg, base);
        const data = await uazFetch(base, UAZAPI.connect(base), instToken, {});
        const inst = data.instance || {};
        const qrcode = inst.qrcode || data.qrcode || inst.paircode || null;
        const status = inst.status || (data.connected ? "connected" : "aguardando_qr");
        await supabase.from("cobranca_whatsapp_config").update({ status, updated_at: new Date().toISOString() }).eq("id", cfg.id);
        return json({ qrcode, status });
      }
      case "status": {
        if (!cfg?.server_url || !cfg?.admin_token) return json({ status: "desconectado" });
        const base = cfg.server_url.replace(/\/$/, "");
        const statusToken = cfg.instance_token || cfg.admin_token;
        const data = await uazFetch(base, UAZAPI.status(base), statusToken);
        const inst = data.instance || {};
        const connected = inst.status === "connected" || data.connected === true;
        const status = connected ? "connected" : (inst.status || "desconectado");
        const numero = inst.owner || inst.profileName || null;
        const qrcode = inst.qrcode || null;
        await supabase.from("cobranca_whatsapp_config").update({ status, numero, updated_at: new Date().toISOString() }).eq("id", cfg.id);
        return json({ status, numero, connected, qrcode });
      }
      case "disconnect": {
        if (!cfg?.server_url || !cfg?.admin_token) return json({ error: "Configure URL e token primeiro" }, 400);
        const base = cfg.server_url.replace(/\/$/, "");
        const discToken = cfg.instance_token || cfg.admin_token;
        try { await uazFetch(base, UAZAPI.disconnect(base), discToken, {}); } catch (_) { /* marca desconectado mesmo se a API recusar */ }
        await supabase.from("cobranca_whatsapp_config").update({ status: "desconectado", numero: null, updated_at: new Date().toISOString() }).eq("id", cfg.id);
        return json({ success: true, status: "desconectado" });
      }
      case "send": {
        await enviarTexto(cfg, payload.destinatario, payload.mensagem);
        return json({ success: true });
      }

      // Espelho da planilha de Fluxo de Caixa. Recebe as linhas já parseadas no
      // front (cliente, categoria, valor, data) e:
      //  - casa o nome do cliente com vendas/mentoria_vendas (telefone por similaridade)
      //  - 'receber': mensagem única da categoria 'dia_vencimento'
      //  - 'inadimplente': cadência (última/próxima) por telefone
      case "espelho_cobranca": {
        const tipo: string = payload.tipo === "receber" ? "receber" : "inadimplente";
        const linhasIn: { cliente: string; categoria?: string; valor?: string; data?: string; observacao?: string }[] = payload.linhas || [];
        const catMsg = tipo === "receber" ? "dia_vencimento" : "inadimplente";
        const { data: msgs } = await supabase.from("cobranca_mensagens").select("*").eq("ativo", true).eq("categoria", catMsg).order("ordem");
        const msgUnica = (msgs || [])[0] || null; // 'receber' usa a 1ª (única)
        const cands = await carregarCandidatos(supabase);

        // Pré-carrega memória de cadência (só inadimplente) dos telefones casados.
        const matchPorLinha = linhasIn.map((l) => melhorMatch(l.cliente, cands));
        const tels = matchPorLinha.map((m) => m?.telefone).filter(Boolean) as string[];
        const { data: contatos } = tels.length
          ? await supabase.from("cobranca_contatos").select("*").in("telefone", tels)
          : { data: [] };
        const memMap = new Map<string, any>((contatos || []).map((c: any) => [c.telefone, c]));

        const linhas = linhasIn.map((l, i) => {
          const match = matchPorLinha[i];
          const telefone = match?.telefone || "";
          const vars: Record<string, string | number> = {
            nome: l.cliente || "", valor: l.valor || "", data: l.data || "",
            vencimento: l.data || "", categoria: l.categoria || "", observacao: l.observacao || "",
          };
          const base = {
            cliente: l.cliente, categoria_lancamento: l.categoria || "", valor: l.valor || "", data: l.data || "",
            observacao: l.observacao || "",
            telefone, nome_match: match?.nome || null, score: match ? Math.round(match.score * 100) : 0,
          };
          if (tipo === "receber") {
            return { ...base, mensagem: msgUnica ? render(msgUnica.mensagem, vars) : null, tem_mensagem: !!msgUnica };
          }
          const mem = telefone ? memMap.get(telefone) : null;
          const ultimaOrdem = mem?.ultima_ordem_enviada || 0;
          const prox = proximaMensagem(msgs || [], ultimaOrdem);
          return {
            ...base,
            ultima_ordem_enviada: ultimaOrdem,
            ultima_mensagem: mem?.ultima_mensagem || null,
            ultima_enviada_em: mem?.ultima_enviada_em || null,
            proxima_ordem: prox?.ordem || null,
            proxima_mensagem_nome: prox?.nome || null,
            mensagem: prox ? render(prox.mensagem, vars) : null,
            tem_mensagem: !!prox,
          };
        });
        return json({ linhas, categoria: catMsg, tem_mensagem_categoria: (msgs || []).length > 0 });
      }

      // Espelho do CSV (legado): dado um conjunto de telefones, devolve o histórico
      // de cada contato + qual será a próxima mensagem da cadência.
      case "espelho": {
        const contatos: { telefone: string; nome?: string; dados?: Record<string, unknown> }[] = payload.contatos || [];
        const { data: mensagens } = await supabase.from("cobranca_mensagens").select("*").eq("ativo", true).order("ordem");
        const tels = contatos.map((c) => normTelefone(c.telefone)).filter(Boolean);
        const { data: existentes } = tels.length
          ? await supabase.from("cobranca_contatos").select("*").in("telefone", tels)
          : { data: [] };
        const mapa = new Map<string, any>((existentes || []).map((e: any) => [e.telefone, e]));
        const linhas = contatos.map((c) => {
          const tel = normTelefone(c.telefone);
          const mem = mapa.get(tel);
          const ultimaOrdem = mem?.ultima_ordem_enviada || 0;
          const prox = proximaMensagem(mensagens || [], ultimaOrdem);
          const vars = { nome: c.nome || mem?.nome || "", ...(c.dados || {}) } as Record<string, string | number>;
          return {
            telefone: tel,
            nome: c.nome || mem?.nome || "",
            dados: c.dados || {},
            ultima_ordem_enviada: ultimaOrdem,
            ultima_mensagem: mem?.ultima_mensagem || null,
            ultima_enviada_em: mem?.ultima_enviada_em || null,
            proxima_ordem: prox?.ordem || null,
            proxima_mensagem_nome: prox?.nome || null,
            proxima_mensagem: prox ? render(prox.mensagem, vars) : null,
            tem_proxima: !!prox,
          };
        });
        return json({ linhas });
      }

      // Cria o lote + itens (status pendente). Recebe os itens JÁ revisados/renderizados
      // no front: { telefone, nome, mensagem, categoria, ordem }. O envio é no cron.
      case "preparar_lote": {
        const itensIn: { telefone: string; nome?: string; mensagem: string; categoria?: string; ordem?: number | null }[] = payload.itens || payload.contatos || [];
        if (!itensIn.length) return json({ error: "Nenhum item selecionado" }, 400);

        const itens: any[] = [];
        for (const it of itensIn) {
          const tel = normTelefone(it.telefone);
          if (!tel || !it.mensagem) continue;
          const categoria = it.categoria === "dia_vencimento" ? "dia_vencimento" : "inadimplente";
          // Garante que o contato existe (não mexe na cadência aqui).
          await supabase.from("cobranca_contatos").upsert({
            telefone: tel, nome: it.nome || null, updated_at: new Date().toISOString(),
          }, { onConflict: "telefone", ignoreDuplicates: false });
          itens.push({ telefone: tel, nome: it.nome || null, mensagem: it.mensagem, ordem: it.ordem ?? null, categoria });
        }
        if (!itens.length) return json({ error: "Nenhum item válido (telefone + mensagem)" }, 400);

        const { data: disparo, error: dErr } = await supabase.from("cobranca_disparos")
          .insert({ status: "enviando", total: itens.length }).select("id").single();
        if (dErr) throw dErr;
        const { error: iErr } = await supabase.from("cobranca_disparo_itens")
          .insert(itens.map((it) => ({ ...it, disparo_id: disparo.id })));
        if (iErr) throw iErr;
        return json({ disparo_id: disparo.id, total: itens.length });
      }

      // Chamado pelo cron a cada ~20s: envia 1 item pendente e atualiza memória/progresso.
      case "processar_lote": {
        // Pega o item pendente mais antigo do disparo "enviando" mais antigo.
        const { data: disparo } = await supabase.from("cobranca_disparos")
          .select("*").eq("status", "enviando").order("created_at", { ascending: true }).limit(1).maybeSingle();
        if (!disparo) return json({ success: true, idle: true });

        const { data: item } = await supabase.from("cobranca_disparo_itens")
          .select("*").eq("disparo_id", disparo.id).eq("status", "pendente")
          .order("created_at", { ascending: true }).limit(1).maybeSingle();

        if (!item) {
          // Sem mais itens pendentes → conclui o lote.
          await supabase.from("cobranca_disparos").update({ status: "concluido", updated_at: new Date().toISOString() }).eq("id", disparo.id);
          return json({ success: true, concluido: disparo.id });
        }

        try {
          await enviarTexto(cfg, item.telefone, item.mensagem);
          const agora = new Date().toISOString();
          await supabase.from("cobranca_disparo_itens").update({ status: "enviado", enviado_em: agora }).eq("id", item.id);
          // Só a cadência de inadimplência avança a ordem; 'dia_vencimento' só registra o último envio.
          const patchContato: Record<string, unknown> = { ultima_mensagem: item.mensagem, ultima_enviada_em: agora, updated_at: agora };
          if (item.categoria === "inadimplente" && item.ordem != null) patchContato.ultima_ordem_enviada = item.ordem;
          await supabase.from("cobranca_contatos").update(patchContato).eq("telefone", item.telefone);
          await supabase.from("cobranca_disparos").update({ enviados: (disparo.enviados || 0) + 1, updated_at: new Date().toISOString() }).eq("id", disparo.id);
          return json({ success: true, enviado: item.id });
        } catch (e) {
          await supabase.from("cobranca_disparo_itens").update({ status: "erro", erro: String(e) }).eq("id", item.id);
          await supabase.from("cobranca_disparos").update({ erros: (disparo.erros || 0) + 1, updated_at: new Date().toISOString() }).eq("id", disparo.id);
          return json({ success: false, erro: String(e), item: item.id });
        }
      }

      default:
        return json({ error: "ação desconhecida" }, 400);
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "erro interno" }, 500);
  }
});
