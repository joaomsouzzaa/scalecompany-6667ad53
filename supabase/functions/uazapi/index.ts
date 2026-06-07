import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ===================================================================
// Endpoints do UAZAPI. Ajuste aqui caso a sua instância use caminhos
// diferentes. Por padrão o UAZAPI usa:
//   - header "admintoken" para criar/instanciar
//   - header "token" para operações da instância (status, send, grupos)
// ===================================================================
const UAZAPI = {
  connect: (base: string) => `${base}/instance/connect`,
  status: (base: string) => `${base}/instance/status`,
  groups: (base: string) => `${base}/group/list`,
  sendText: (base: string) => `${base}/send/text`,
};

function svc() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

async function getConfig(supabase: any) {
  const { data } = await supabase.from("whatsapp_config").select("*").maybeSingle();
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

const fmtBRL = (n: number) => `R$ ${(Number(n) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Envia uma mensagem de texto via UAZAPI
async function enviarTexto(cfg: any, destinatario: string, mensagem: string) {
  const base = (cfg.server_url || "").replace(/\/$/, "");
  const token = cfg.admin_token;
  if (!base || !token) throw new Error("Configuração UAZAPI incompleta");
  return uazFetch(base, UAZAPI.sendText(base), token, { number: destinatario, text: mensagem });
}

// Monta as variáveis a partir de uma venda
function varsDaVenda(v: any): Record<string, string | number> {
  return {
    nome: v.nome_comprador || "",
    produto: v.produto || "",
    cidade: v.cidade || "",
    valor: fmtBRL(v.valor || 0),
    tipo: v.tipo_ingresso || "",
    quantidade: v.quantidade || 1,
    pagamento: v.metodo_pagamento || "",
    data: v.data_venda ? new Date(v.data_venda).toLocaleString("pt-BR") : "",
  };
}

// Calcula um resumo de cidade a partir das vendas (métricas do banco;
// investimento/CAC/projeção dependem do Meta e ficam como "-" por enquanto)
async function resumoCidade(supabase: any, cidadeSlug: string | null) {
  let q = supabase.from("vendas").select("produto,cidade,tipo_ingresso,quantidade,valor").eq("status", "aprovada");
  const { data } = await q;
  const rows = (data || []).filter((r: any) => {
    if (!cidadeSlug) return true;
    const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[\s-]/g, "");
    const parts = cidadeSlug.split(",").map((p) => norm(p)).filter(Boolean);
    return parts.some((s) => norm(r.cidade || "").includes(s) || norm(r.produto || "").includes(s));
  });
  let participantes = 0, vips = 0, convidados = 0, bilheteria = 0;
  for (const r of rows) {
    const qty = r.quantidade || 1; const valor = Number(r.valor) || 0; bilheteria += valor;
    const prod = (r.produto || "").toLowerCase();
    if (prod.includes("upgrade")) { vips += qty; continue; }
    participantes += qty;
    if ((r.tipo_ingresso || prod).toLowerCase().includes("vip")) vips += qty;
    if ((r.tipo_ingresso || "").toLowerCase().includes("convite") || valor === 0) convidados += qty;
  }
  return {
    cidade: cidadeSlug || "Todas",
    participantes, vips, convidados,
    bilheteria: fmtBRL(bilheteria),
    cac: "-", projecao: "-", investimento: "-",
  };
}

Deno.serve(async (req) => {
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
        const data = await uazFetch(base, UAZAPI.connect(base), cfg.admin_token, { instance: cfg.instance });
        const qrcode = data.qrcode || data.qrCode || data.base64 || data.qr || null;
        await supabase.from("whatsapp_config").update({ status: data.status || "aguardando_qr" }).eq("id", cfg.id);
        return json({ qrcode, status: data.status || "aguardando_qr" });
      }
      case "status": {
        if (!cfg?.server_url || !cfg?.admin_token) return json({ status: "desconectado" });
        const base = cfg.server_url.replace(/\/$/, "");
        const data = await uazFetch(base, UAZAPI.status(base), cfg.admin_token);
        const status = data.connected || data.status === "connected" ? "connected" : (data.status || "desconectado");
        const numero = data.number || data.phone || data.jid || null;
        await supabase.from("whatsapp_config").update({ status, numero }).eq("id", cfg.id);
        return json({ status, numero, connected: status === "connected" });
      }
      case "groups": {
        if (!cfg?.server_url || !cfg?.admin_token) return json({ groups: [] });
        const base = cfg.server_url.replace(/\/$/, "");
        const data = await uazFetch(base, UAZAPI.groups(base), cfg.admin_token);
        const list = data.groups || data.data || data || [];
        const groups = (Array.isArray(list) ? list : []).map((g: any) => ({
          id: g.id || g.jid || g.gid || g.group_id,
          name: g.name || g.subject || g.title || g.id,
        })).filter((g: any) => g.id);
        return json({ groups });
      }
      case "send": {
        await enviarTexto(cfg, payload.destinatario, payload.mensagem);
        return json({ success: true });
      }
      case "send_test": {
        const { data: n } = await supabase.from("notificacoes").select("*").eq("id", payload.notificacao_id).maybeSingle();
        if (!n) return json({ error: "Notificação não encontrada" }, 404);
        let vars: Record<string, string | number> = {};
        if (n.gatilho === "nova_venda") {
          vars = varsDaVenda({ nome_comprador: "Fulano (teste)", produto: "Workshop Scale | Belém - PA", cidade: "Belém", valor: 247, tipo_ingresso: "individual", quantidade: 1, metodo_pagamento: "pix", data_venda: new Date().toISOString() });
        } else if (n.gatilho === "resumo_cidade") {
          vars = await resumoCidade(supabase, n.cidade_slug);
        } else if (n.gatilho === "resumo_geral") {
          vars = { total_cidades: "—", participantes_total: "—", bilheteria_total: "—", investimento_total: "—", data: new Date().toLocaleDateString("pt-BR") };
        }
        const msg = render(n.mensagem, vars) + "\n\n_(mensagem de teste)_";
        const r = await enviarTexto(cfg, n.destinatario, msg);
        await supabase.from("notificacao_logs").insert({ notificacao_id: n.id, destinatario: n.destinatario, mensagem: msg, status: "enviado" });
        return json({ success: true, result: r });
      }
      case "nova_venda": {
        // Chamado pelo trigger do banco quando uma venda é inserida
        const v = payload.venda;
        if (!v) return json({ error: "venda ausente" }, 400);
        const { data: notifs } = await supabase.from("notificacoes").select("*").eq("ativo", true).eq("gatilho", "nova_venda");
        const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[\s-]/g, "");
        let enviados = 0;
        for (const n of notifs || []) {
          if (n.cidade_slug) {
            const parts = n.cidade_slug.split(",").map((p: string) => norm(p)).filter(Boolean);
            const match = parts.some((s) => norm(v.cidade || "").includes(s) || norm(v.produto || "").includes(s));
            if (!match) continue;
          }
          const msg = render(n.mensagem, varsDaVenda(v));
          try {
            await enviarTexto(cfg, n.destinatario, msg);
            await supabase.from("notificacao_logs").insert({ notificacao_id: n.id, destinatario: n.destinatario, mensagem: msg, status: "enviado" });
            enviados++;
          } catch (e) {
            await supabase.from("notificacao_logs").insert({ notificacao_id: n.id, destinatario: n.destinatario, mensagem: msg, status: "erro", erro: String(e) });
          }
        }
        return json({ success: true, enviados });
      }
      case "run_scheduled": {
        // Chamado por um cron; envia os resumos cujo horário == agora (HH:MM)
        const agora = payload.horario || new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
        const { data: notifs } = await supabase.from("notificacoes").select("*").eq("ativo", true).in("gatilho", ["resumo_cidade", "resumo_geral"]);
        let enviados = 0;
        for (const n of notifs || []) {
          if ((n.horario || "").slice(0, 5) !== agora.slice(0, 5)) continue;
          let vars: Record<string, string | number> = {};
          if (n.gatilho === "resumo_cidade") vars = await resumoCidade(supabase, n.cidade_slug);
          else vars = { total_cidades: "—", participantes_total: "—", bilheteria_total: "—", investimento_total: "—", data: new Date().toLocaleDateString("pt-BR") };
          const msg = render(n.mensagem, vars);
          try {
            await enviarTexto(cfg, n.destinatario, msg);
            await supabase.from("notificacao_logs").insert({ notificacao_id: n.id, destinatario: n.destinatario, mensagem: msg, status: "enviado" });
            enviados++;
          } catch (e) {
            await supabase.from("notificacao_logs").insert({ notificacao_id: n.id, destinatario: n.destinatario, mensagem: msg, status: "erro", erro: String(e) });
          }
        }
        return json({ success: true, enviados });
      }
      default:
        return json({ error: "ação desconhecida" }, 400);
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "erro interno" }, 500);
  }
});
