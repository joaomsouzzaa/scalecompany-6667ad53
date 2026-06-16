import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BASE = "https://public-api.kiwify.com/v1";

// Número que recebe o relatório da sincronização via UAZAPI (instância conectada).
const RELATORIO_NUMERO = "5581996125512";

function svc() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[\s-]/g, "");
const hojeSPstr = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });

// OAuth client credentials → access_token (Bearer, validade 24h).
async function getToken(): Promise<string> {
  const id = Deno.env.get("KIWIFY_CLIENT_ID");
  const secret = Deno.env.get("KIWIFY_CLIENT_SECRET");
  if (!id || !secret) throw new Error("Configure KIWIFY_CLIENT_ID e KIWIFY_CLIENT_SECRET");
  const r = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(secret)}`,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`OAuth Kiwify falhou: ${j?.message || r.status}`);
  return j.access_token;
}

function authHeaders(token: string) {
  return {
    "Authorization": `Bearer ${token}`,
    "x-kiwify-account-id": Deno.env.get("KIWIFY_ACCOUNT_ID") || "",
    "Content-Type": "application/json",
  };
}

// Lista paginada onde `data` é um ARRAY (ex.: /products).
async function listarTudo(path: string, token: string, maxPages = 50): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const r = await fetch(`${BASE}${path}${sep}page_size=100&page_number=${page}`, { headers: authHeaders(token) });
    if (!r.ok) break;
    const j = await r.json().catch(() => ({}));
    const data = Array.isArray(j.data) ? j.data : [];
    out.push(...data);
    const count = j.pagination?.count ?? out.length;
    if (data.length === 0 || out.length >= count) break;
  }
  return out;
}

// Participantes de um evento: a resposta é { pagination, data: { ...metadados, participants: [...] } }.
async function listarParticipantes(productId: string, token: string, maxPages = 50): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await fetch(`${BASE}/events/${productId}/participants?page_size=100&page_number=${page}`, { headers: authHeaders(token) });
    if (!r.ok) break;
    const j = await r.json().catch(() => ({}));
    const parts = j.data?.participants || [];
    out.push(...parts);
    const count = j.pagination?.count ?? out.length;
    if (parts.length === 0 || out.length >= count) break;
  }
  return out;
}

// Convite/cortesia = lote "Convite" (batch_name casa convite/cortesia) OU sem order_id.
function ehConvite(part: any): boolean {
  return /convite|cortesia/i.test(String(part.batch_name || "")) || !part.order_id;
}

// Identificador único do ingresso, para comparar com id_transacao no banco:
// pago usa order_id (mesmo que o webhook grava); convite usa o id do participante.
function ticketId(part: any): string | null {
  const id = ehConvite(part) ? part.id : (part.order_id || part.id);
  return id != null ? String(id) : null;
}

const fmtSP = () => new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

// Envia o relatório (com chunking) via função uazapi → action "send".
async function enviarRelatorio(mensagem: string) {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/uazapi`;
  const auth = `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`;
  const MAX = 3500;
  // Quebra por linhas respeitando o limite (relatórios grandes viram várias mensagens).
  const chunks: string[] = [];
  let atual = "";
  for (const linha of mensagem.split("\n")) {
    if ((atual + linha + "\n").length > MAX && atual) { chunks.push(atual); atual = ""; }
    atual += linha + "\n";
  }
  if (atual.trim()) chunks.push(atual);

  for (const chunk of chunks) {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: auth },
        body: JSON.stringify({ action: "send", destinatario: RELATORIO_NUMERO, mensagem: chunk.trimEnd() }),
      });
    } catch (e) {
      console.log("Falha ao enviar relatório:", (e as any)?.message || e);
    }
  }
}

type CidadeRel = {
  cidade: string;
  kiwify_total: number;
  ja_no_banco: number;
  convites_inseridos: { nome: string; email: string }[];
  vendas_faltando: { nome: string; email: string; order_id: string }[];
  erros: { nome: string; email: string; erro: string }[];
};

function montarRelatorio(rels: CidadeRel[], cidadesAtivas: number): string {
  const totalInseridos = rels.reduce((s, c) => s + c.convites_inseridos.length, 0);
  const totalFaltando = rels.reduce((s, c) => s + c.vendas_faltando.length, 0);
  const totalErros = rels.reduce((s, c) => s + c.erros.length, 0);

  const L: string[] = [];
  L.push("🔄 *Sincronização Kiwify*");
  L.push(`🕒 ${fmtSP()}`);
  L.push(`🏙️ Cidades ativas: ${cidadesAtivas}`);
  L.push(`✅ Convites inseridos: ${totalInseridos} | ⚠️ Vendas faltando: ${totalFaltando} | ❌ Erros: ${totalErros}`);

  if (totalInseridos === 0 && totalFaltando === 0 && totalErros === 0) {
    L.push("");
    L.push("Nenhuma novidade — banco já está em dia. 👍");
    return L.join("\n");
  }

  for (const c of rels) {
    if (c.convites_inseridos.length === 0 && c.vendas_faltando.length === 0 && c.erros.length === 0) continue;
    L.push("");
    L.push(`📍 *${c.cidade}* — Kiwify: ${c.kiwify_total} | já no banco: ${c.ja_no_banco}`);

    if (c.convites_inseridos.length) {
      L.push(`  ✅ Convites inseridos (${c.convites_inseridos.length}) — lote Convite, não vem por webhook:`);
      for (const p of c.convites_inseridos) L.push(`    • ${p.nome || "?"} <${p.email || "?"}>`);
    }
    if (c.vendas_faltando.length) {
      L.push(`  ⚠️ Vendas pagas ausentes (${c.vendas_faltando.length}) — provável falha de webhook:`);
      for (const p of c.vendas_faltando) L.push(`    • ${p.nome || "?"} <${p.email || "?"}> (pedido ${p.order_id})`);
    }
    if (c.erros.length) {
      L.push(`  ❌ Erros de inserção (${c.erros.length}):`);
      for (const p of c.erros) L.push(`    • ${p.nome || "?"} <${p.email || "?"}>: ${p.erro}`);
    }
  }
  return L.join("\n");
}

Deno.serve(async (req) => {
  console.log("sync-kiwify v2 - puxar tudo + relatório");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const supabase = svc();
    const token = await getToken();

    // Cidades ATIVAS (evento de hoje em diante).
    const hoje = hojeSPstr();
    const { data: cids } = await supabase.from("cidades").select("nome,slug,data_evento");
    const ativas = (cids || []).filter((c: any) => !c.data_evento || String(c.data_evento).slice(0, 10) >= hoje);
    if (ativas.length === 0) {
      await enviarRelatorio(montarRelatorio([], 0));
      return json({ success: true, msg: "Nenhuma cidade ativa", inseridos: 0 });
    }

    // Dedup POR INGRESSO: conjunto de id_transacao já existentes no banco.
    // Mantém também os e-mails como fallback p/ registros manuais antigos sem id.
    const { data: existentes } = await supabase.from("vendas").select("id_transacao,email_comprador");
    const idsBanco = new Set((existentes || []).map((r: any) => (r.id_transacao != null ? String(r.id_transacao) : "")).filter(Boolean));
    const emailsBanco = new Set((existentes || []).map((r: any) => norm(r.email_comprador)).filter(Boolean));

    // Produtos do Kiwify → casa cada um com uma cidade ativa pelo nome.
    const produtos = await listarTudo("/products", token);
    const matchCidade = (nomeProduto: string) => {
      const np = norm(nomeProduto);
      return ativas.find((c: any) => {
        const partes = String(c.slug || "").split(",").map((x: string) => norm(x)).filter(Boolean);
        return partes.some((s) => np.includes(s)) || np.includes(norm(c.nome));
      });
    };

    const relPorCidade = new Map<string, CidadeRel>();
    const relDe = (nome: string): CidadeRel => {
      let r = relPorCidade.get(nome);
      if (!r) { r = { cidade: nome, kiwify_total: 0, ja_no_banco: 0, convites_inseridos: [], vendas_faltando: [], erros: [] }; relPorCidade.set(nome, r); }
      return r;
    };

    let inseridos = 0;
    for (const p of produtos) {
      const cidade = matchCidade(p.name || "");
      if (!cidade) continue; // produto que não é de cidade ativa
      let participantes: any[] = [];
      try { participantes = await listarParticipantes(p.id, token); } catch { continue; }

      const rel = relDe(cidade.nome);
      for (const part of participantes) {
        rel.kiwify_total++;
        const tid = ticketId(part);
        const email = norm(part.email);

        if (!ehConvite(part)) {
          // Venda paga: já no banco? (id do ingresso ou e-mail como fallback).
          if ((tid && idsBanco.has(tid)) || (email && emailsBanco.has(email))) { rel.ja_no_banco++; continue; }
          // Venda paga ausente: só reporta (não insere — sem valor confiável aqui).
          rel.vendas_faltando.push({ nome: part.name || "", email: part.email || "", order_id: String(part.order_id || "") });
          continue;
        }

        // Convite: dedup SÓ pelo id do ingresso (part.id). Não usa e-mail como
        // fallback — senão convidado que já tem qualquer outro registro (pago,
        // importação) era descartado e o dash subcontava convites.
        if (tid && idsBanco.has(tid)) { rel.ja_no_banco++; continue; }

        // Convite faltante → insere.
        const { error } = await supabase.from("vendas").insert({
          plataforma: "kiwify",
          id_transacao: part.id || null,
          status: "aprovada",
          valor: 0,
          quantidade: 1,
          tipo_ingresso: "convite",
          produto: p.name || null,
          cidade: cidade.nome,
          nome_comprador: part.name || null,
          email_comprador: part.email || null,
          telefone_comprador: part.phone || null,
          documento: part.cpf || null,
          data_venda: part.created_at || new Date().toISOString(),
          payload: part,
        });
        if (error) {
          rel.erros.push({ nome: part.name || "", email: part.email || "", erro: error.message });
        } else {
          inseridos++;
          if (tid) idsBanco.add(tid);
          if (email) emailsBanco.add(email);
          rel.convites_inseridos.push({ nome: part.name || "", email: part.email || "" });
        }
      }
    }

    const rels = [...relPorCidade.values()];
    await enviarRelatorio(montarRelatorio(rels, ativas.length));

    return json({
      success: true,
      cidades_ativas: ativas.length,
      convites_inseridos: inseridos,
      detalhe: rels,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "erro interno" }, 500);
  }
});
