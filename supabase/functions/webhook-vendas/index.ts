import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  console.log("webhook-vendas atualizado");
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Authenticate via API key (query param, Bearer header, or webhook token header)
  const url = new URL(req.url);
  const queryToken = url.searchParams.get("token");
  const authHeader = req.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const webhookToken = req.headers.get("x-webhook-token") || req.headers.get("token");
  const providedKey = queryToken || bearerToken || webhookToken;
  const expectedKey = Deno.env.get("WEBHOOK_API_KEY");

  if (!expectedKey || providedKey !== expectedKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const payload = await req.json();
    let venda: Record<string, unknown>;

    if (payload.OrderId && payload.EventType) {
      // ===== GoExplosion =====
      const buyer = payload.Purchase?.Buyer || {};
      const marketing = payload.Purchase?.MarketingData || {};
      const totalDetails = payload.Purchase?.TotalDetails || payload.ProductTotalDetails || {};
      const product = payload.Product || {};

      venda = {
        plataforma: "goexplosion",
        id_transacao: payload.OrderId,
        status: mapStatus(payload.EventType),
        valor: totalDetails.Total ?? totalDetails.SubTotal ?? 0,
        quantidade: product.Quantity ?? 1,
        nome_comprador: buyer.FullName || null,
        email_comprador: buyer.Email || null,
        telefone_comprador: buyer.Phone || null,
        documento: buyer.Document || null,
        produto: product.Name || null,
        tipo_ingresso: detectTipoIngresso(product.Name || ""),
        produtor: product.Producer || null,
        cidade: buyer.Addresses?.[0]?.City || extractCidadeFromProduct(product.Name || "") || null,
        metodo_pagamento: payload.Purchase?.PaymentMethod?.metodoPagamento || null,
        cupom: totalDetails.CouponName || null,
        utm_source: marketing.UtmSource || null,
        utm_medium: marketing.UtmMedium || null,
        utm_campaign: marketing.UtmCampaign || null,
        utm_content: marketing.UtmContent || null,
        utm_term: marketing.UtmTerm || null,
        data_venda: payload.Purchase?.AuthorizedDate || payload.createdDate || new Date().toISOString(),
        payload,
      };
    } else if (payload.event || payload.webhook_event_type) {
      // ===== Kiwify =====
      const product = payload.Product || payload.product || {};
      const customer = payload.Customer || payload.customer || {};
      const commissions = payload.Commissions || {};
      const tracking = payload.TrackingParameters || {};
      const productName = fixMojibake(product.product_name || product.name || "") || null;
      // Usamos o PREÇO BASE do produto (sem juros de parcelamento no cartão), não o
      // charge_amount (valor cobrado com acréscimo). Tudo em centavos (29700 = R$ 297,00).
      const baseAmount = commissions.product_base_price ?? commissions.charge_amount;

      venda = {
        plataforma: "kiwify",
        id_transacao: payload.order_id || payload.Transaction?.id || null,
        status: mapStatus(payload.order_status || payload.webhook_event_type || payload.event || "aprovada"),
        valor: baseAmount != null ? Number(baseAmount) / 100 : parseFloat(payload.order_price || payload.Transaction?.amount || "0"),
        quantidade: Array.isArray(payload.event_tickets) && payload.event_tickets.length > 0 ? payload.event_tickets.length : 1,
        nome_comprador: fixMojibake(customer.full_name || customer.name || "") || null,
        email_comprador: customer.email || null,
        telefone_comprador: customer.mobile || customer.phone || null,
        documento: customer.CPF || customer.cnpj || null,
        produto: productName,
        tipo_ingresso: detectTipoIngresso(`${productName || ""} ${payload.event_batch?.name || ""}`),
        produtor: null,
        cidade: extractCidadeFromKiwify(productName || ""),
        metodo_pagamento: payload.payment_method || null,
        cupom: null,
        utm_source: tracking.utm_source || null,
        utm_medium: tracking.utm_medium || null,
        utm_campaign: tracking.utm_campaign || null,
        utm_content: tracking.utm_content || null,
        utm_term: tracking.utm_term || null,
        data_venda: payload.approved_date || payload.created_at || new Date().toISOString(),
        payload,
      };
    } else {
      // ===== Formato genérico =====
      venda = {
        plataforma: payload.plataforma || "desconhecida",
        id_transacao: payload.id_transacao || payload.transaction_id || null,
        status: mapStatus(payload.status || "aprovada"),
        valor: parseFloat(payload.valor || payload.amount || "0"),
        quantidade: payload.quantidade || 1,
        nome_comprador: payload.nome || payload.name || null,
        email_comprador: payload.email || null,
        telefone_comprador: payload.telefone || payload.phone || null,
        documento: null,
        produto: payload.produto || payload.product || null,
        tipo_ingresso: payload.tipo_ingresso || null,
        produtor: null,
        cidade: payload.cidade || payload.city || null,
        metodo_pagamento: null,
        cupom: null,
        utm_source: null,
        utm_medium: null,
        utm_campaign: null,
        utm_content: null,
        utm_term: null,
        data_venda: payload.data_venda || new Date().toISOString(),
        payload,
      };
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Carrinho abandonado / compra recusada: NÃO entram em vendas — viram leads
    // de recuperação (tela própria + fluxo de mensagens no WhatsApp).
    const tipoRecuperacao = classificarRecuperacao(payload);
    if (tipoRecuperacao) {
      await gravarLeadRecuperacao(supabase, tipoRecuperacao, venda);
      return new Response(JSON.stringify({ success: true, action: "recuperacao", tipo: tipoRecuperacao }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const status = venda.status as string;
    const idTransacao = venda.id_transacao as string | null;

    // If it's a cancellation/refund and we have a transaction ID, update existing record
    if (idTransacao && (status === "cancelada" || status === "reembolsada")) {
      const { data: existing } = await supabase
        .from("vendas")
        .select("id")
        .eq("id_transacao", idTransacao)
        .maybeSingle();

      if (existing) {
        const { error } = await supabase
          .from("vendas")
          .update({ status, payload: venda.payload })
          .eq("id_transacao", idTransacao);

        if (error) {
          console.error("[Webhook Update Error]", { timestamp: new Date().toISOString(), code: error.code, message: error.message });
          return new Response(JSON.stringify({ error: "Failed to update sale status" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ success: true, action: "updated" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Upgrade (orderbump): a quantidade deve ser a mesma da compra principal
    // (Workshop) do mesmo comprador/cidade — o webhook costuma mandar 1.
    await resolveUpgradeQuantity(supabase, venda);

    // Otherwise insert as new record
    const { data: inserida, error } = await supabase.from("vendas").insert(venda).select("id").single();

    if (error) {
      console.error("[Webhook Error]", { timestamp: new Date().toISOString(), code: error.code, message: error.message });
      return new Response(JSON.stringify({ error: "Failed to process webhook" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Grava 1 linha por pessoa em ingressos_emitidos (event_tickets ou fallback).
    await gravarIngressos(supabase, inserida?.id || null, venda, payload);

    // Se chegou a compra principal, atualiza upgrades já existentes desse
    // comprador/cidade para refletirem a quantidade correta (ordem inversa).
    await syncUpgradesForCompra(supabase, venda);

    // Venda aprovada: encerra eventuais fluxos de recuperação do mesmo lead
    // (telefone/email) e dispara a notificação de "compra realizada" ao comprador.
    if (status === "aprovada") {
      await marcarLeadComprou(supabase, venda);
      await dispararCompraRealizada({ ...venda, id: inserida?.id });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[Webhook Exception]", { timestamp: new Date().toISOString(), message: err instanceof Error ? err.message : "Unknown" });
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

// Grava 1 linha por pessoa em ingressos_emitidos. Para Kiwify usa
// payload.event_tickets[] (nome real por pessoa); senão gera `quantidade`
// linhas (1ª com o comprador, demais "(nome não informado)").
async function gravarIngressos(
  supabase: any,
  vendaId: string | null,
  venda: Record<string, unknown>,
  payload: any,
) {
  try {
    const orderId = (venda.id_transacao as string | null) || null;
    const base = {
      venda_id: vendaId,
      order_id: orderId,
      cidade: (venda.cidade as string | null) || null,
      tipo_ingresso: (venda.tipo_ingresso as string | null) || null,
      plataforma: (venda.plataforma as string | null) || null,
      status: (venda.status as string) || "aprovada",
      data_venda: (venda.data_venda as string) || new Date().toISOString(),
    };

    const tickets = Array.isArray(payload?.event_tickets) ? payload.event_tickets : [];
    if (tickets.length > 0) {
      const rows = tickets.map((t: any) => ({
        ...base,
        ingresso_id: t.id != null ? String(t.id) : null,
        external_id: t.external_id || null,
        nome: t.name || null,
        email: t.email || null,
        telefone: t.phone || null,
        cpf: t.cpf || null,
        batch_name: t.batch_name || null,
      }));
      await supabase.from("ingressos_emitidos").upsert(rows, { onConflict: "ingresso_id", ignoreDuplicates: false });
      return;
    }

    // Fallback sem nomes por pessoa: gera `quantidade` linhas.
    const qtd = Math.max(1, Number(venda.quantidade) || 1);
    const rows = Array.from({ length: qtd }, (_, i) => ({
      ...base,
      ingresso_id: null,
      external_id: null,
      nome: i === 0 ? (venda.nome_comprador as string | null) || null : "(nome não informado)",
      email: i === 0 ? (venda.email_comprador as string | null) || null : null,
      telefone: i === 0 ? (venda.telefone_comprador as string | null) || null : null,
      cpf: (venda.documento as string | null) || null,
      batch_name: null,
    }));
    await supabase.from("ingressos_emitidos").insert(rows);
  } catch (e) {
    console.log("gravarIngressos falhou:", (e as any)?.message || e);
  }
}

function isUpgradeProduto(nome: unknown): boolean {
  return typeof nome === "string" && nome.toLowerCase().includes("upgrade");
}

// Se a venda for um Upgrade (orderbump), copia a quantidade da compra principal
// (Workshop/ingresso) do mesmo comprador e cidade. O webhook do upgrade costuma
// vir com quantidade 1, mas ela deve refletir a compra principal.
async function resolveUpgradeQuantity(supabase: any, venda: Record<string, unknown>) {
  if (!isUpgradeProduto(venda.produto)) return;
  const email = venda.email_comprador as string | null;
  const cidade = venda.cidade as string | null;
  if (!email) return;
  try {
    let query = supabase
      .from("vendas")
      .select("quantidade")
      .eq("email_comprador", email)
      .eq("status", "aprovada")
      .not("produto", "ilike", "%upgrade%")
      .order("quantidade", { ascending: false })
      .limit(1);
    if (cidade) query = query.eq("cidade", cidade);
    const { data } = await query.maybeSingle();
    if (data && data.quantidade != null) {
      venda.quantidade = data.quantidade;
      // Upgrade VIP herda também o "tamanho" da compra: qtd 2 => vip_duplo.
      const t = String(venda.tipo_ingresso || "").toLowerCase();
      if (t.includes("vip")) {
        venda.tipo_ingresso = Number(data.quantidade) === 2 ? "vip_duplo" : "vip_individual";
      }
    }
  } catch (_) {
    // silencioso: na pior hipótese mantém a quantidade do webhook
  }
}

// Quando chega a compra principal (não-upgrade), atualiza upgrades já existentes
// do mesmo comprador/cidade para terem a mesma quantidade (caso o upgrade tenha
// chegado antes da compra principal).
async function syncUpgradesForCompra(supabase: any, venda: Record<string, unknown>) {
  if (isUpgradeProduto(venda.produto)) return;
  const email = venda.email_comprador as string | null;
  const cidade = venda.cidade as string | null;
  const qty = venda.quantidade;
  if (!email || qty == null) return;
  try {
    let query = supabase
      .from("vendas")
      .update({ quantidade: qty })
      .eq("email_comprador", email)
      .eq("status", "aprovada")
      .ilike("produto", "%upgrade%");
    if (cidade) query = query.eq("cidade", cidade);
    await query;

    // Ajusta o tipo dos upgrades VIP conforme a quantidade (qtd 2 => vip_duplo).
    const vipTipo = Number(qty) === 2 ? "vip_duplo" : "vip_individual";
    let q2 = supabase
      .from("vendas")
      .update({ tipo_ingresso: vipTipo })
      .eq("email_comprador", email)
      .eq("status", "aprovada")
      .ilike("produto", "%upgrade%")
      .ilike("tipo_ingresso", "%vip%");
    if (cidade) q2 = q2.eq("cidade", cidade);
    await q2;
  } catch (_) {
    // silencioso
  }
}

// Classifica um evento de recuperação a partir das strings de evento do webhook.
// Retorna 'abandono' (carrinho abandonado), 'recusada' (compra recusada) ou null.
function classificarRecuperacao(payload: any): "abandono" | "recusada" | null {
  const s = [
    payload?.event, payload?.webhook_event_type, payload?.order_status,
    payload?.EventType, payload?.status,
  ].filter(Boolean).join(" ").toLowerCase().replace(/_/g, " ");
  if (s.includes("abandon") || s.includes("cart") || s.includes("carrinho")) return "abandono";
  if (s.includes("refus") || s.includes("declin") || s.includes("rejeit") || s.includes("recus")) return "recusada";
  return null;
}

// ---- Quiet hours (igual ao uazapi): nunca enviar entre 22h e 7h (SP) ----
function horaSP(d: Date): number {
  return Number(d.toLocaleString("en-US", { hour: "2-digit", hour12: false, timeZone: "America/Sao_Paulo" }).slice(0, 2)) % 24;
}
function proximoHorarioValido(alvo: Date): Date {
  const d = new Date(alvo);
  for (let i = 0; i < 4; i++) {
    const h = horaSP(d);
    if (h >= 7 && h < 22) return d;
    const horasAte7 = h >= 22 ? (24 - h + 7) : (7 - h);
    d.setTime(d.getTime() + horasAte7 * 3600_000);
    const min = Number(d.toLocaleString("en-US", { minute: "2-digit", timeZone: "America/Sao_Paulo" }));
    d.setTime(d.getTime() - min * 60_000);
  }
  return d;
}
function delayMs(valor: number, unidade: string): number {
  const v = Number(valor) || 0;
  return unidade === "minutos" ? v * 60_000 : v * 3600_000;
}

// Grava um lead de recuperação e agenda a 1ª mensagem do fluxo (se houver
// notificação 'recuperacao_venda' ativa que case com a cidade/produto).
async function gravarLeadRecuperacao(
  supabase: any,
  tipoEvento: "abandono" | "recusada",
  venda: Record<string, unknown>,
) {
  const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[\s-]/g, "");
  const { data: notifs } = await supabase.from("notificacoes").select("*").eq("ativo", true).eq("gatilho", "recuperacao_venda");
  const cidade = (venda.cidade as string) || "";
  const produto = (venda.produto as string) || "";
  const notif = (notifs || []).find((n: any) => {
    if (!n.cidade_slug) return true;
    const parts = n.cidade_slug.split(",").map((p: string) => norm(p)).filter(Boolean);
    return parts.some((s: string) => norm(cidade).includes(s) || norm(produto).includes(s));
  }) || (notifs || [])[0];

  // Delay do 1º passo (default 2h).
  let proximo = proximoHorarioValido(new Date(Date.now() + 2 * 3600_000));
  if (notif) {
    const { data: passo } = await supabase.from("recuperacao_mensagens").select("delay_valor,delay_unidade")
      .eq("notificacao_id", notif.id).eq("ativo", true).order("ordem", { ascending: true }).limit(1).maybeSingle();
    if (passo) proximo = proximoHorarioValido(new Date(Date.now() + delayMs(passo.delay_valor, passo.delay_unidade)));
  }

  const lead = {
    tipo_evento: tipoEvento,
    id_transacao: (venda.id_transacao as string | null) || null,
    nome: (venda.nome_comprador as string | null) || null,
    email: (venda.email_comprador as string | null) || null,
    telefone: (venda.telefone_comprador as string | null) || null,
    produto: produto || null,
    cidade: cidade || null,
    valor: (venda.valor as number | null) ?? null,
    tipo_ingresso: (venda.tipo_ingresso as string | null) || null,
    plataforma: (venda.plataforma as string | null) || null,
    payload: venda.payload,
    status: "aguardando",
    proxima_ordem: 1,
    proximo_envio_em: proximo.toISOString(),
    data_venda: (venda.data_venda as string) || new Date().toISOString(),
  };
  // upsert por id_transacao (quando houver) p/ não duplicar reentregas.
  if (lead.id_transacao) {
    await supabase.from("recuperacao_leads").upsert(lead, { onConflict: "id_transacao", ignoreDuplicates: true });
  } else {
    await supabase.from("recuperacao_leads").insert(lead);
  }
}

// Compra aprovada: marca como "comprou" qualquer lead de recuperação em aberto
// do mesmo comprador (casa por telefone OU email), parando o fluxo.
async function marcarLeadComprou(supabase: any, venda: Record<string, unknown>) {
  const telefone = (venda.telefone_comprador as string | null) || null;
  const email = (venda.email_comprador as string | null) || null;
  if (!telefone && !email) return;
  try {
    const ors: string[] = [];
    if (telefone) ors.push(`telefone.eq.${telefone}`);
    if (email) ors.push(`email.eq.${email}`);
    await supabase.from("recuperacao_leads")
      .update({ status: "comprou", comprou_em: new Date().toISOString(), proximo_envio_em: null })
      .or(ors.join(","))
      .neq("status", "comprou");
  } catch (e) {
    console.log("marcarLeadComprou falhou:", (e as any)?.message || e);
  }
}

// Dispara a notificação "compra_realizada" (parabéns ao comprador) via uazapi.
async function dispararCompraRealizada(venda: Record<string, unknown>) {
  try {
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/uazapi`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
      body: JSON.stringify({ action: "compra_realizada", venda }),
    });
  } catch (e) {
    console.log("dispararCompraRealizada falhou:", (e as any)?.message || e);
  }
}

function mapStatus(status: string): string {
  const s = status.toLowerCase().replace(/_/g, " ");
  if (s.includes("approved") || s.includes("purchase approved") || s.includes("paid") || s.includes("completed") || s.includes("ready")) return "aprovada";
  if (s.includes("refund")) return "reembolsada";
  // Kiwify manda chargeback como "chargedback"; cobre as duas grafias + cancel/refused.
  if (s.includes("cancel") || s.includes("chargeback") || s.includes("chargedback") || s.includes("charged back") || s.includes("refused") || s.includes("declined")) return "cancelada";
  if (s.includes("pending") || s.includes("waiting")) return "pendente";
  return status;
}

function detectTipoIngresso(productName: string): string | null {
  const name = productName.toLowerCase();
  if (name.includes("vip duplo")) return "vip_duplo";
  if (name.includes("vip") && (name.includes("individual") || name.includes("1 pessoa"))) return "vip_individual";
  if (name.includes("vip")) return "vip_individual";
  if (name.includes("duplo") || name.includes("2 pessoas")) return "duplo";
  if (name.includes("individual") || name.includes("1 pessoa")) return "individual";
  if (name.includes("diamond")) return "diamond";
  if (name.includes("gold")) return "gold";
  if (name.includes("silver")) return "silver";
  if (name.includes("bronze")) return "bronze";
  return null;
}

// Kiwify: extrai a cidade procurando o padrão "Cidade - UF" (UF = 2 letras
// maiúsculas) em qualquer trecho do nome do produto, e remove prefixos
// comerciais (Upgrade/Ingresso/Lote). Produtos sem "- UF" (ex.: "Trilha
// Mentor", produtos online) retornam null.
function extractCidadeFromKiwify(productName: string): string | null {
  if (!productName) return null;
  const match = productName.match(/([^|]+?)\s*-\s*[A-Z]{2}\b/);
  if (match) {
    const cidade = match[1].trim().replace(/^(Upgrade|Ingresso|Lote)\s+/i, "").trim();
    if (cidade) return cidade;
  }
  // fallback para o padrão dos outros produtos
  return extractCidadeFromProduct(productName);
}

// Corrige texto UTF-8 que chegou decodificado como latin-1 (ex.: "BelÃ©m" -> "Belém").
// Strings já corretas lançam erro no decode e são retornadas intactas.
function fixMojibake(s: string): string {
  if (!s) return s;
  try {
    return decodeURIComponent(escape(s));
  } catch {
    return s;
  }
}

function extractCidadeFromProduct(productName: string): string | null {
  // Match "Recife Scale Summit" or similar city-named summits
  const summitMatch = productName.match(/\((\w[\w\s]*?)\s+Scale\s+Summit\)/i);
  if (summitMatch) return summitMatch[1].trim();
  // Match patterns like "Workshop Scale - Natal )" or "Workshop Scale - São Luís"
  const match = productName.match(/[-–]\s*([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)*)\s*(?:\)|$)/);
  if (match) return match[1].trim();
  return null;
}
