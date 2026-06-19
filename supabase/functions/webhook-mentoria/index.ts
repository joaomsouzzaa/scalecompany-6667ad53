import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Converte uma data (inclusive DD/MM/AAAA do BR) em ISO; se inválida, usa agora.
function parseDataVenda(raw: unknown): string {
  if (raw == null || String(raw).trim() === "") return new Date().toISOString();
  const s = String(raw).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const dt = new Date(year, Number(m[2]) - 1, Number(m[1]), Number(m[4] || 0), Number(m[5] || 0));
    if (!isNaN(dt.getTime())) return dt.toISOString();
  }
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? new Date().toISOString() : dt.toISOString();
}

// Lê um caminho aninhado do payload, ex: "Customer.email" ou "data.buyer.name".
function getPath(obj: unknown, caminho: string): unknown {
  if (!caminho) return undefined;
  return caminho.split(".").reduce<unknown>((acc, key) => {
    if (acc == null) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

// Substitui {{var}} pelos valores do mapa (chave = label do campo mapeado).
// Aceita nomes com espaço/acento (ex: {{Razão Social}}) e faz match
// case/acento-insensível, então {{nome}} e {{Nome}} resolvem igual.
function render(template: string, vars: Record<string, unknown>): string {
  const idx = new Map<string, unknown>();
  for (const [k, v] of Object.entries(vars)) idx.set(norm(k), v);
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, k) => {
    const v = idx.get(norm(k));
    return v != null ? String(v) : "";
  });
}

function norm(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase();
}

// Resolve { base, token } para enviar via UAZAPI usando o POOL compartilhado
// (uazapi_instancias): pega a 1ª instância CONECTADA com token. Cai pro token da
// config singleton (legado) só se o pool não tiver nenhuma conectada.
// A base vem do secret UAZAPI_SERVER_URL, senão da config.
async function resolverEnvio(supabase: any, cfg: any): Promise<{ base: string; token: string }> {
  const base = (Deno.env.get("UAZAPI_SERVER_URL") || cfg?.server_url || "").replace(/\/$/, "");
  const { data: inst } = await supabase
    .from("uazapi_instancias")
    .select("instance_token,status")
    .in("status", ["connected", "conectado"])
    .not("instance_token", "is", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const token = inst?.instance_token || cfg?.instance_token || cfg?.admin_token || "";
  return { base, token };
}

// UAZAPI: envia texto. Base/token já resolvidos pelo pool em resolverEnvio.
async function enviarTexto(base: string, token: string, destinatario: string, mensagem: string) {
  base = (base || "").replace(/\/$/, "");
  if (!base || !token) throw new Error("Nenhuma instância UAZAPI conectada — conecte uma instância na tela de Cobrança");
  const tel = String(destinatario || "").replace(/\D/g, "");
  if (!tel) throw new Error("Telefone do comprador ausente");
  const res = await fetch(`${base}/send/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", token, admintoken: token },
    body: JSON.stringify({ number: tel, text: mensagem }),
  });
  const text = await res.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(json?.error || json?.message || `UAZAPI ${res.status}`);
  return json;
}

Deno.serve(async (req) => {
  console.log("webhook-mentoria v1");
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  // GET/HEAD: responde 200 (alguns CRMs validam o endpoint com GET antes de enviar).
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: true, status: "webhook-mentoria online" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Auth OPCIONAL: o Clint CRM não envia token no webhook. Só rejeita se houver
  // uma chave configurada E um token enviado que não confere. Sem token, passa.
  const url = new URL(req.url);
  const queryToken = url.searchParams.get("token");
  const authHeader = req.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const webhookToken = req.headers.get("x-webhook-token") || req.headers.get("token");
  const providedKey = queryToken || bearerToken || webhookToken;
  const expectedKey = Deno.env.get("WEBHOOK_API_KEY");

  if (expectedKey && providedKey && providedKey !== expectedKey) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // Leitura resiliente do corpo: aceita JSON, form-encoded ou JSON dentro de form.
    const rawBody = await req.text();
    console.log("webhook-mentoria RAW PAYLOAD:", rawBody);
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(rawBody);
    } catch {
      const params = new URLSearchParams(rawBody);
      // Alguns CRMs mandam tudo dentro de um campo (ex: payload=...{json}...).
      const wrapped = params.get("payload") || params.get("data") || params.get("body");
      if (wrapped) {
        try { payload = JSON.parse(wrapped); } catch { payload = { [wrapped]: true }; }
      } else {
        payload = Object.fromEntries(params.entries());
      }
    }
    console.log("webhook-mentoria PAYLOAD PARSED keys:", Object.keys(payload).join(", "));

    // 0) GRAVA UMA LINHA JÁ COM O PAYLOAD BRUTO. Garante que TODO POST que chega
    // vira uma linha visível, mesmo que algo abaixo falhe. Depois enriquecemos.
    const { data: linhaBase, error: erroBase } = await supabase
      .from("mentoria_vendas")
      .insert({ payload, dados: {}, mensagem_enviada: false, mensagem_status: "recebido", data_venda: new Date().toISOString() })
      .select("id")
      .single();
    if (erroBase) throw erroBase;
    const vendaId = linhaBase!.id;

    // 1) Carrega campos mapeados (definem as colunas e as variáveis).
    const { data: campos } = await supabase
      .from("mentoria_campos")
      .select("*")
      .eq("ativo", true)
      .order("ordem");

    // 2) Achata o payload conforme o mapeamento -> dados[label] = valor.
    const dados: Record<string, unknown> = {};
    for (const c of campos || []) {
      dados[c.label] = getPath(payload, c.caminho) ?? null;
    }

    // Campos canônicos: procura entre os campos mapeados aquele cujo NOME ou
    // CAMINHO contém alguma das palavras-chave (tolerante a maiúscula/acento/typo),
    // e por fim tenta caminhos comuns direto no payload.
    const pick = (keywords: string[], paths: string[] = []): unknown => {
      for (const kw of keywords) {
        const k = norm(kw);
        // Entre TODOS os campos que casam a palavra-chave, pega o primeiro com VALOR
        // (ex.: se houver deal_forma_de_pagamento vazio e deal_forma_de_pagamento_1
        // preenchido, usa o preenchido).
        const hits = (campos || []).filter(
          (c: any) => norm(c.label).includes(k) || norm(c.caminho).includes(k),
        );
        for (const hit of hits) {
          if (dados[hit.label] != null && String(dados[hit.label]).trim() !== "") return dados[hit.label];
        }
      }
      for (const p of paths) {
        const v = getPath(payload, p);
        if (v != null) return v;
      }
      return null;
    };

    // "produt" cobre "produto" e o typo "porduto"; também casa o caminho deal_tipo_de_produto.
    const produto = pick(
      ["produt", "product"],
      ["Product.product_name", "Product.name", "product.name", "produto"],
    );
    const forma_pagamento = pick(
      ["pagamento", "payment", "forma_pag"],
      ["payment_method", "Purchase.PaymentMethod.metodoPagamento", "forma_pagamento"],
    );
    const telefone = pick(
      ["telefone", "celular", "whatsapp", "phone", "fone"],
      ["Customer.mobile", "Customer.phone", "customer.phone", "telefone", "phone"],
    );
    const nome = pick(
      ["contact_name", "nome", "name", "comprador"],
      ["Customer.full_name", "Customer.name", "customer.name", "nome", "name"],
    );
    const id_transacao =
      (pick(["id_transacao", "order_id", "transaction", "deal_id"], [
        "order_id", "OrderId", "Transaction.id", "id_transacao",
      ]) as string | null) || null;
    const status =
      (pick(["status"], ["order_status", "EventType", "status"]) as string | null) || null;
    const data_venda = parseDataVenda(
      pick(["data_venda", "fechamento", "data"], [
        "approved_date", "created_at", "Purchase.AuthorizedDate",
      ]),
    );
    const origem =
      (pick(["origem", "source", "fonte"], ["deal_origem", "origem", "source"]) as string | null) || null;
    const valor =
      (pick(["valor", "value", "amount", "deal_value"], ["deal_value", "value", "amount", "valor"]) as string | null) || null;

    // 4) Resolve o gatilho (produto + forma de pagamento).
    const { data: gatilhos } = await supabase
      .from("mentoria_gatilhos")
      .select("*")
      .eq("ativo", true);

    // Produto: match "contém" (tolera variação de nome do CRM).
    const matchContem = (regra: string | null, valor: unknown): boolean => {
      if (!regra) return true; // null/vazio = qualquer
      return norm(valor).includes(norm(regra));
    };
    // Forma de pagamento: match EXATO. Cada venda tem um único valor (ex: "Cartão"
    // ou "Cartão + Boleto"), então "Cartão" NÃO deve casar com "Espécie + Cartão".
    const matchExato = (regra: string | null, valor: unknown): boolean => {
      if (!regra) return true; // null/vazio = qualquer
      return norm(valor) === norm(regra);
    };
    // Entre os gatilhos que casam, vence o MAIS ESPECÍFICO (mais campos preenchidos),
    // assim uma regra produto+forma ganha de uma regra genérica/fallback.
    const especificidade = (g: any): number =>
      (g.produto ? 1 : 0) + (g.forma_pagamento ? 1 : 0);
    const gatilho = (gatilhos || [])
      .filter(
        (g: any) =>
          matchContem(g.produto, produto) &&
          matchExato(g.forma_pagamento, forma_pagamento),
      )
      .sort((a: any, b: any) => especificidade(b) - especificidade(a))[0];

    // 5) ENRIQUECE a linha já gravada (passo 0) com os campos extraídos.
    const status_inicial = !gatilho
      ? "sem gatilho"
      : !telefone
        ? "sem telefone"
        : "enviando";

    const { error } = await supabase
      .from("mentoria_vendas")
      .update({
        id_transacao,
        status,
        produto: produto != null ? String(produto) : null,
        forma_pagamento: forma_pagamento != null ? String(forma_pagamento) : null,
        telefone: telefone != null ? String(telefone) : null,
        nome: nome != null ? String(nome) : null,
        dados,
        mensagem_status: status_inicial,
        data_venda,
      })
      .eq("id", vendaId);

    if (error) throw error;

    // 6) Envio do WhatsApp em segundo plano (não bloqueia a resposta).
    if (gatilho && telefone) {
      const varsMsg: Record<string, unknown> = { ...dados, nome, produto, forma_pagamento, telefone };
      const enviar = async () => {
        let mensagem_enviada = false;
        let mensagem_status = "enviada";
        try {
          const { data: cfg } = await supabase
            .from("cobranca_whatsapp_config")
            .select("*")
            .maybeSingle();
          const { base, token } = await resolverEnvio(supabase, cfg);
          await enviarTexto(base, token, String(telefone), render(gatilho.mensagem, varsMsg));
          mensagem_enviada = true;
        } catch (e) {
          mensagem_status = `erro: ${e instanceof Error ? e.message : String(e)}`;
        }
        await supabase
          .from("mentoria_vendas")
          .update({ mensagem_enviada, mensagem_status })
          .eq("id", vendaId);
      };
      // EdgeRuntime.waitUntil mantém a tarefa viva após o return; se indisponível, dispara solto.
      try {
        // @ts-ignore — EdgeRuntime existe no runtime do Supabase
        if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
          // @ts-ignore
          EdgeRuntime.waitUntil(enviar());
        } else {
          enviar();
        }
      } catch {
        enviar();
      }
    }

    // 7) Notificação interna de NOVA VENDA (gatilho "nova_venda_inside_sales" em
    //    Notificações). Dispara para TODA venda, independente do gatilho do comprador.
    //    Roda em segundo plano chamando a função `uazapi`.
    const notificarNovaVenda = async () => {
      try {
        const venda = { id: vendaId, nome, telefone, produto, forma_pagamento, valor, origem, status, id_transacao, data_venda, dados };
        await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/uazapi`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({ action: "nova_venda_inside_sales", venda }),
        });
      } catch (e) {
        console.log("notificarNovaVenda falhou:", (e as any)?.message || e);
      }
    };
    try {
      // @ts-ignore — EdgeRuntime existe no runtime do Supabase
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(notificarNovaVenda());
      } else {
        notificarNovaVenda();
      }
    } catch {
      notificarNovaVenda();
    }

    return new Response(
      JSON.stringify({ ok: true, id: vendaId, mensagem_status: status_inicial }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("webhook-mentoria erro", e);
    const msg = e instanceof Error
      ? e.message
      : (e && typeof e === "object" ? JSON.stringify(e) : String(e));
    // Responde 200 mesmo em erro para o CRM não marcar como falha e reentregar em loop.
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
