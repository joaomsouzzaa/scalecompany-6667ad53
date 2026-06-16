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

      // Espelho do CSV: dado um conjunto de telefones, devolve o histórico de cada
      // contato + qual será a próxima mensagem da cadência.
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

      // Cria o lote + itens (status pendente). O envio real ocorre no cron (processar_lote).
      case "preparar_lote": {
        const contatos: { telefone: string; nome?: string; dados?: Record<string, unknown> }[] = payload.contatos || [];
        if (!contatos.length) return json({ error: "Nenhum contato selecionado" }, 400);
        const { data: mensagens } = await supabase.from("cobranca_mensagens").select("*").eq("ativo", true).order("ordem");

        const tels = contatos.map((c) => normTelefone(c.telefone)).filter(Boolean);
        const { data: existentes } = tels.length
          ? await supabase.from("cobranca_contatos").select("*").in("telefone", tels)
          : { data: [] };
        const mapa = new Map<string, any>((existentes || []).map((e: any) => [e.telefone, e]));

        const itens: any[] = [];
        for (const c of contatos) {
          const tel = normTelefone(c.telefone);
          if (!tel) continue;
          const mem = mapa.get(tel);
          const prox = proximaMensagem(mensagens || [], mem?.ultima_ordem_enviada || 0);
          if (!prox) continue; // contato já recebeu toda a cadência
          const vars = { nome: c.nome || mem?.nome || "", ...(c.dados || {}) } as Record<string, string | number>;
          // upsert dos dados/nome mais recentes do CSV (não mexe na cadência ainda)
          await supabase.from("cobranca_contatos").upsert({
            telefone: tel,
            nome: c.nome || mem?.nome || null,
            dados: c.dados || mem?.dados || {},
            ultima_ordem_enviada: mem?.ultima_ordem_enviada || 0,
            updated_at: new Date().toISOString(),
          }, { onConflict: "telefone" });
          itens.push({ telefone: tel, nome: c.nome || mem?.nome || null, mensagem: render(prox.mensagem, vars), ordem: prox.ordem });
        }
        if (!itens.length) return json({ error: "Nenhum contato com próxima mensagem pendente" }, 400);

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
          await supabase.from("cobranca_disparo_itens").update({ status: "enviado", enviado_em: new Date().toISOString() }).eq("id", item.id);
          await supabase.from("cobranca_contatos").update({
            ultima_ordem_enviada: item.ordem,
            ultima_mensagem: item.mensagem,
            ultima_enviada_em: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq("telefone", item.telefone);
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
