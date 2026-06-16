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

// Monta a linha de ingressos_emitidos a partir de um participante da Kiwify.
function ingressoDeParticipante(part: any, cidadeNome: string, vendaId: string | null) {
  return {
    venda_id: vendaId,
    order_id: part.order_id ? String(part.order_id) : (ehConvite(part) && part.id ? String(part.id) : null),
    ingresso_id: part.id != null ? String(part.id) : null,
    external_id: part.external_id || null,
    nome: part.name || null,
    email: part.email || null,
    telefone: part.phone || null,
    cpf: part.cpf || null,
    cidade: cidadeNome,
    tipo_ingresso: ehConvite(part) ? "convite" : null,
    plataforma: "kiwify",
    batch_name: part.batch_name || null,
    status: "aprovada",
    data_venda: part.created_at || new Date().toISOString(),
    checkin_at: part.checkin_at || null,
  };
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

// Backfill (rodar uma vez): popula ingressos_emitidos a partir dos payloads já
// salvos em vendas. Idempotente — apaga os ingressos da venda e regrava.
async function backfillIngressos(supabase: any) {
  let vendasLidas = 0, ingressosGravados = 0, comTickets = 0, fallback = 0;
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: lote } = await supabase
      .from("vendas")
      .select("id,id_transacao,plataforma,quantidade,nome_comprador,email_comprador,telefone_comprador,documento,cidade,tipo_ingresso,status,data_venda,payload")
      .range(from, from + PAGE - 1);
    if (!lote || lote.length === 0) break;

    for (const v of lote) {
      vendasLidas++;
      const p = v.payload || {};
      const base = {
        venda_id: v.id,
        order_id: v.id_transacao || null,
        cidade: v.cidade || null,
        plataforma: v.plataforma || null,
        status: v.status || "aprovada",
        data_venda: v.data_venda || new Date().toISOString(),
      };

      let rows: any[] = [];
      const tickets = Array.isArray(p?.event_tickets) ? p.event_tickets : [];
      if (tickets.length > 0) {
        // Venda paga Kiwify com event_tickets.
        comTickets++;
        rows = tickets.map((t: any) => ({
          ...base, tipo_ingresso: v.tipo_ingresso || null, batch_name: t.batch_name || null,
          ingresso_id: t.id != null ? String(t.id) : null, external_id: t.external_id || null,
          nome: t.name || null, email: t.email || null, telefone: t.phone || null, cpf: t.cpf || null,
        }));
      } else if (v.plataforma === "kiwify" && p?.id && p?.name) {
        // Convite Kiwify: payload é o próprio participante.
        comTickets++;
        rows = [{
          ...base, tipo_ingresso: "convite", batch_name: p.batch_name || null,
          ingresso_id: String(p.id), external_id: p.external_id || null,
          nome: p.name || null, email: p.email || null, telefone: p.phone || null, cpf: p.cpf || null,
          checkin_at: p.checkin_at || null,
        }];
      } else {
        // Sem dados por pessoa: gera `quantidade` linhas (1ª comprador, resto sem nome).
        fallback++;
        const qtd = Math.max(1, Number(v.quantidade) || 1);
        rows = Array.from({ length: qtd }, (_, i) => ({
          ...base, tipo_ingresso: v.tipo_ingresso || null, batch_name: null,
          ingresso_id: null, external_id: null,
          nome: i === 0 ? (v.nome_comprador || null) : "(nome não informado)",
          email: i === 0 ? (v.email_comprador || null) : null,
          telefone: i === 0 ? (v.telefone_comprador || null) : null,
          cpf: v.documento || null,
        }));
      }

      if (rows.length === 0) continue;
      // Idempotência por venda: limpa e regrava.
      await supabase.from("ingressos_emitidos").delete().eq("venda_id", v.id);
      const comId = rows.filter((r) => r.ingresso_id);
      const semId = rows.filter((r) => !r.ingresso_id);
      if (comId.length) await supabase.from("ingressos_emitidos").upsert(comId, { onConflict: "ingresso_id", ignoreDuplicates: false });
      if (semId.length) await supabase.from("ingressos_emitidos").insert(semId);
      ingressosGravados += rows.length;
    }
    if (lote.length < PAGE) break;
  }
  return { success: true, vendas_lidas: vendasLidas, ingressos_gravados: ingressosGravados, com_tickets: comTickets, fallback };
}

Deno.serve(async (req) => {
  console.log("sync-kiwify v3 - ingressos emitidos");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const supabase = svc();

    // Lê o body uma única vez (action opcional).
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    if (body?.action === "backfill_ingressos") {
      return json(await backfillIngressos(supabase));
    }

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
    // IMPORTANTE: paginar — o Supabase retorna no máx. 1000 linhas por consulta,
    // e a tabela vendas tem mais que isso. Sem paginar, convites já inseridos
    // (fora das 1000) eram reinseridos (duplicata) e pagos existentes apareciam
    // como "faltando" falso.
    const idsBanco = new Set<string>();
    const emailsBanco = new Set<string>();
    const idToVenda = new Map<string, string>(); // id_transacao -> venda.id
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data: lote } = await supabase
        .from("vendas")
        .select("id,id_transacao,email_comprador")
        .range(from, from + PAGE - 1);
      if (!lote || lote.length === 0) break;
      for (const r of lote) {
        if (r.id_transacao != null) { idsBanco.add(String(r.id_transacao)); idToVenda.set(String(r.id_transacao), r.id); }
        const e = norm(r.email_comprador);
        if (e) emailsBanco.add(e);
      }
      if (lote.length < PAGE) break;
    }

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

        // Ingressos emitidos: grava/atualiza 1 linha por participante (pago e
        // convite), mesmo que a venda paga ainda não exista no banco — reflete
        // a verdade da Kiwify. Liga à venda pelo id_transacao quando houver.
        try {
          const vId = (tid && idToVenda.get(tid)) || null;
          await supabase.from("ingressos_emitidos")
            .upsert(ingressoDeParticipante(part, cidade.nome, vId), { onConflict: "ingresso_id", ignoreDuplicates: false });
        } catch (_) { /* não aborta a sincronização */ }

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
        const { data: novaVenda, error } = await supabase.from("vendas").insert({
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
        }).select("id").single();
        if (error) {
          rel.erros.push({ nome: part.name || "", email: part.email || "", erro: error.message });
        } else {
          inseridos++;
          if (tid) { idsBanco.add(tid); if (novaVenda?.id) idToVenda.set(tid, novaVenda.id); }
          if (email) emailsBanco.add(email);
          rel.convites_inseridos.push({ nome: part.name || "", email: part.email || "" });
          // Liga o ingresso recém-criado à venda do convite.
          if (novaVenda?.id) {
            try {
              await supabase.from("ingressos_emitidos")
                .upsert(ingressoDeParticipante(part, cidade.nome, novaVenda.id), { onConflict: "ingresso_id", ignoreDuplicates: false });
            } catch (_) { /* segue */ }
          }
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
