import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BASE = "https://public-api.kiwify.com/v1";

// Fallback usado só quando não houver notificação 'relatorio_sync' ativa cadastrada.
const RELATORIO_NUMERO_FALLBACK = "5581996125512";

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

// Grava 1 linha de histórico em sync_logs (best-effort, nunca quebra a sync).
async function registrarLog(supabase: any, dados: Record<string, unknown>) {
  try { await supabase.from("sync_logs").insert(dados); }
  catch (e) { console.log("sync_logs insert falhou:", (e as any)?.message || e); }
}

// Busca destinatários do relatório na tabela `notificacoes`:
// linha mais recente com gatilho='relatorio_sync' e ativo=true.
// Retorna a lista de números/JIDs (com fallback) + cabeçalho opcional + id da notificação.
async function destinatariosRelatorio(supabase: any): Promise<{ numeros: string[]; cabecalho: string; notificacao_id: string | null }> {
  const { data: notif } = await supabase
    .from("notificacoes")
    .select("id,mensagem,destinatario,destinatarios")
    .eq("gatilho", "relatorio_sync")
    .eq("ativo", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!notif) return { numeros: [RELATORIO_NUMERO_FALLBACK], cabecalho: "", notificacao_id: null };

  const numeros: string[] = [];
  const arr = Array.isArray(notif.destinatarios) ? notif.destinatarios : [];
  for (const d of arr) {
    const v = (d && typeof d === "object") ? String(d.valor || "").trim() : String(d || "").trim();
    if (v) numeros.push(v);
  }
  if (numeros.length === 0 && notif.destinatario) {
    const v = String(notif.destinatario).trim();
    if (v) numeros.push(v);
  }
  if (numeros.length === 0) numeros.push(RELATORIO_NUMERO_FALLBACK);
  return { numeros, cabecalho: (notif.mensagem || "").toString(), notificacao_id: notif.id };
}

// Envia o relatório (com chunking) DIRETO na UAZAPI (lê whatsapp_config).
// Evita o hop de chamar a função uazapi via HTTP (que falhava em silêncio).
// Para cada destinatário registra uma linha em notificacao_logs.
async function enviarRelatorio(supabase: any, mensagem: string) {
  const diag: { enviados: number; erros: string[]; destinatarios: number } = { enviados: 0, erros: [], destinatarios: 0 };
  const { data: cfg } = await supabase.from("whatsapp_config").select("server_url,admin_token,status").maybeSingle();
  if (!cfg?.server_url) { diag.erros.push("whatsapp_config incompleto"); return diag; }
  const base = String(cfg.server_url).replace(/\/$/, "");
  // O endpoint /send/text exige o TOKEN DA INSTÂNCIA (não o admin_token, que é só
  // p/ administrar instâncias e dá 401 ao enviar). Mesma lógica do `tokenDe` da
  // função uazapi: 1ª instância conectada com instance_token; fallback admin_token.
  const { data: inst } = await supabase.from("uazapi_instancias")
    .select("instance_token")
    .not("instance_token", "is", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const token = inst?.instance_token || cfg.admin_token;
  if (!token) { diag.erros.push("sem token de instância UAZAPI"); return diag; }

  const { numeros, cabecalho, notificacao_id } = await destinatariosRelatorio(supabase);
  diag.destinatarios = numeros.length;
  const textoFinal = cabecalho ? `${cabecalho.trim()}\n\n${mensagem}` : mensagem;

  const MAX = 3500;
  const chunks: string[] = [];
  let atual = "";
  for (const linha of textoFinal.split("\n")) {
    if ((atual + linha + "\n").length > MAX && atual) { chunks.push(atual); atual = ""; }
    atual += linha + "\n";
  }
  if (atual.trim()) chunks.push(atual);

  for (const number of numeros) {
    for (const chunk of chunks) {
      const payload = chunk.trimEnd();
      let status = "enviado";
      let erro: string | null = null;
      try {
        const r = await fetch(`${base}/send/text`, {
          method: "POST",
          headers: { "Content-Type": "application/json", token, admintoken: token },
          body: JSON.stringify({ number, text: payload }),
        });
        if (r.ok) {
          diag.enviados++;
        } else {
          const t = await r.text();
          status = "erro";
          erro = `HTTP ${r.status}: ${t.slice(0, 200)}`;
          diag.erros.push(`${number}: ${erro}`);
        }
      } catch (e) {
        status = "erro";
        erro = (e as any)?.message || String(e);
        diag.erros.push(`${number}: ${erro}`);
      }
      try {
        await supabase.from("notificacao_logs").insert({
          notificacao_id,
          destinatario: number,
          status,
          erro,
          mensagem: payload,
        });
      } catch (_) { /* log opcional */ }
    }
  }
  return diag;
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
// salvos em vendas. Idempotente — LIMPA a tabela uma vez e regrava em lote
// (delete/insert por venda estourava o timeout de 150s da edge function).
async function backfillIngressos(supabase: any) {
  let vendasLidas = 0, comTickets = 0, fallback = 0;
  const PAGE = 1000;
  const allRows: any[] = [];
  const seenIds = new Set<string>(); // evita ingresso_id duplicado no lote

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

      const push = (r: any) => {
        if (r.ingresso_id) { if (seenIds.has(r.ingresso_id)) return; seenIds.add(r.ingresso_id); }
        allRows.push(r);
      };

      const tickets = Array.isArray(p?.event_tickets) ? p.event_tickets : [];
      if (tickets.length > 0) {
        comTickets++;
        for (const t of tickets) push({
          ...base, tipo_ingresso: v.tipo_ingresso || null, batch_name: t.batch_name || null,
          ingresso_id: t.id != null ? String(t.id) : null, external_id: t.external_id || null,
          nome: t.name || null, email: t.email || null, telefone: t.phone || null, cpf: t.cpf || null,
        });
      } else if (v.plataforma === "kiwify" && p?.id && p?.name) {
        comTickets++;
        push({
          ...base, tipo_ingresso: "convite", batch_name: p.batch_name || null,
          ingresso_id: String(p.id), external_id: p.external_id || null,
          nome: p.name || null, email: p.email || null, telefone: p.phone || null, cpf: p.cpf || null,
          checkin_at: p.checkin_at || null,
        });
      } else {
        fallback++;
        const qtd = Math.max(1, Number(v.quantidade) || 1);
        for (let i = 0; i < qtd; i++) push({
          ...base, tipo_ingresso: v.tipo_ingresso || null, batch_name: null,
          ingresso_id: null, external_id: null,
          nome: i === 0 ? (v.nome_comprador || null) : "(nome não informado)",
          email: i === 0 ? (v.email_comprador || null) : null,
          telefone: i === 0 ? (v.telefone_comprador || null) : null,
          cpf: v.documento || null,
        });
      }
    }
    if (lote.length < PAGE) break;
  }

  // Limpa tudo (1 query) e regrava em lotes.
  await supabase.from("ingressos_emitidos").delete().not("id", "is", null);
  const CHUNK = 500;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    await supabase.from("ingressos_emitidos").insert(allRows.slice(i, i + CHUNK));
  }
  return { success: true, vendas_lidas: vendasLidas, ingressos_gravados: allRows.length, com_tickets: comTickets, fallback };
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
    // Sync manual (botão): `full:true` = histórico completo (legado);
    // `dias:N` = janela de N dias escolhida no popup. `origem` rotula o log.
    const fullSync = body?.full === true || body?.action === "full";
    const diasParam = Number(body?.dias);
    const temDias = Number.isFinite(diasParam) && diasParam > 0;
    const origem = (body?.origem === "manual" || temDias || fullSync) ? "manual" : "auto";
    // Janela de processamento: manual usa N dias do popup; automático mantém 72h
    // (roda 2x/dia, então 72h cobre com folga). `full` ignora a janela.
    const JANELA_HORAS = temDias ? diasParam * 24 : 72;
    const dias_janela = fullSync ? null : Math.round(JANELA_HORAS / 24);

    const token = await getToken();

    // Cidades a sincronizar: toda cidade cujo evento seja futuro OU tenha passado
    // há no máximo 7 dias. Só descarta depois de evento + 7 dias (antes era +48h,
    // que dava gap em vendas/check-ins atrasados). Vale pro auto e pro manual.
    const AGORA = Date.now();
    const RETENCAO_MS = 7 * 24 * 60 * 60 * 1000; // evento + 7 dias
    const { data: cids } = await supabase.from("cidades").select("nome,slug,data_evento");
    const ativas = (cids || []).filter((c: any) => {
      if (!c.data_evento) return true;
      const ev = new Date(c.data_evento); ev.setHours(0, 0, 0, 0);
      return AGORA <= ev.getTime() + RETENCAO_MS;
    });
    if (ativas.length === 0) {
      const textoRel = montarRelatorio([], 0);
      const rel0 = await enviarRelatorio(supabase, textoRel);
      await registrarLog(supabase, {
        origem, dias_janela, cidades_ativas: 0, convites_inseridos: 0, vendas_faltando: 0,
        erros: rel0.erros.length, status: rel0.erros.length ? "erro" : "ok",
        relatorio: textoRel, detalhe: [], relatorio_enviados: rel0.enviados, relatorio_erros: rel0.erros,
      });
      return json({ success: true, msg: "Nenhuma cidade ativa", inseridos: 0, relatorio: rel0 });
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
    // Janela de processamento já calculada acima (JANELA_HORAS): N dias no manual,
    // 72h no automático. `full` ignora a janela e varre todo o histórico.
    const CUTOFF_MS = fullSync ? -Infinity : Date.now() - JANELA_HORAS * 3600 * 1000;
    // Acumula participantes p/ gravar ingressos_emitidos EM LOTE no fim (upsert
    // por participante estourava o timeout de 150s).
    const partsTodos: { part: any; cidadeNome: string }[] = [];
    for (const p of produtos) {
      const cidade = matchCidade(p.name || "");
      if (!cidade) continue; // produto que não é de cidade ativa
      let participantes: any[] = [];
      try { participantes = await listarParticipantes(p.id, token); } catch { continue; }

      const rel = relDe(cidade.nome);
      for (const part of participantes) {
        // Janela de 72h: processa só participantes criados nas últimas 72h
        // (sync diário leve). Histórico antigo já está no banco.
        const criado = part.created_at ? Date.parse(part.created_at) : NaN;
        if (!Number.isNaN(criado) && criado < CUTOFF_MS) continue;

        rel.kiwify_total++;
        const tid = ticketId(part);
        const email = norm(part.email);
        partsTodos.push({ part, cidadeNome: cidade.nome });

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
        }
      }
    }

    // Ingressos emitidos EM LOTE: 1 linha por participante (resolve venda_id
    // agora que os convites já foram inseridos). Dedup por ingresso_id — a
    // Kiwify às vezes lista o mesmo participante 2x, e o upsert quebra com
    // ingresso_id repetido no mesmo comando.
    const ingMap = new Map<string, any>();
    const ordersComTicket = new Set<string>();
    for (const { part, cidadeNome } of partsTodos) {
      const tid = ticketId(part);
      const vId = (tid && idToVenda.get(tid)) || null;
      const row = ingressoDeParticipante(part, cidadeNome, vId);
      if (row.ingresso_id) ingMap.set(row.ingresso_id, row);
      if (part.order_id) ordersComTicket.add(String(part.order_id));
    }
    const ingRows = [...ingMap.values()];
    const CHUNK = 500;
    for (let i = 0; i < ingRows.length; i += CHUNK) {
      try { await supabase.from("ingressos_emitidos").upsert(ingRows.slice(i, i + CHUNK), { onConflict: "ingresso_id", ignoreDuplicates: false }); } catch (e) { console.log("upsert ingressos falhou:", (e as any)?.message || e); }
    }
    // Remove fallback (sem ingresso_id) dos pedidos que agora têm nome real.
    const orders = [...ordersComTicket];
    for (let i = 0; i < orders.length; i += 100) {
      try { await supabase.from("ingressos_emitidos").delete().in("order_id", orders.slice(i, i + 100)).is("ingresso_id", null); } catch (_) { /* segue */ }
    }

    const rels = [...relPorCidade.values()];
    const relatorioTexto = montarRelatorio(rels, ativas.length);
    const relatorio = await enviarRelatorio(supabase, relatorioTexto);

    const totalFaltando = rels.reduce((s, c) => s + c.vendas_faltando.length, 0);
    const totalErrosIns = rels.reduce((s, c) => s + c.erros.length, 0);
    const errosTotal = totalErrosIns + relatorio.erros.length;
    await registrarLog(supabase, {
      origem, dias_janela, cidades_ativas: ativas.length, convites_inseridos: inseridos,
      vendas_faltando: totalFaltando, erros: errosTotal, status: errosTotal ? "erro" : "ok",
      relatorio: relatorioTexto, detalhe: rels, relatorio_enviados: relatorio.enviados,
      relatorio_erros: relatorio.erros,
    });

    return json({
      success: true,
      cidades_ativas: ativas.length,
      convites_inseridos: inseridos,
      relatorio,
      detalhe: rels,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "erro interno";
    try { await svc().from("sync_logs").insert({ status: "erro", mensagem_erro: msg }); } catch (_) { /* best-effort */ }
    return json({ error: msg }, 500);
  }
});
