import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

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

// UAZAPI: envia texto pela instância da Cobrança.
async function enviarTexto(cfg: any, destinatario: string, mensagem: string) {
  const base = (cfg?.server_url || "").replace(/\/$/, "");
  // Usa o token DA INSTÂNCIA (cai pro admin_token se ainda não houver).
  const token = cfg?.instance_token || cfg?.admin_token;
  if (!base || !token) throw new Error("Configuração UAZAPI (Cobrança) incompleta");
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
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Auth via API key (query param, Bearer header, ou header de webhook).
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

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const payload = await req.json();

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

    // Campos canônicos: tenta achar pelos labels conhecidos, senão caminhos comuns.
    const pick = (labels: string[], paths: string[]): unknown => {
      for (const l of labels) {
        const hit = (campos || []).find((c: any) => norm(c.label) === norm(l));
        if (hit && dados[hit.label] != null) return dados[hit.label];
      }
      for (const p of paths) {
        const v = getPath(payload, p);
        if (v != null) return v;
      }
      return null;
    };

    const produto = pick(
      ["produto", "product"],
      ["Product.product_name", "Product.name", "product.name", "produto"],
    );
    const forma_pagamento = pick(
      ["forma_pagamento", "pagamento", "payment_method", "metodo_pagamento"],
      ["payment_method", "Purchase.PaymentMethod.metodoPagamento", "forma_pagamento"],
    );
    const telefone = pick(
      ["telefone", "celular", "whatsapp", "phone"],
      ["Customer.mobile", "Customer.phone", "customer.phone", "telefone", "phone"],
    );
    const nome = pick(
      ["nome", "name", "comprador"],
      ["Customer.full_name", "Customer.name", "customer.name", "nome", "name"],
    );
    const id_transacao =
      (pick(["id_transacao", "order_id", "transaction_id"], [
        "order_id", "OrderId", "Transaction.id", "id_transacao",
      ]) as string | null) || null;
    const status =
      (pick(["status"], ["order_status", "EventType", "status"]) as string | null) || null;
    const data_venda =
      (pick(["data_venda", "data"], [
        "approved_date", "created_at", "Purchase.AuthorizedDate",
      ]) as string | null) || new Date().toISOString();

    // 3) Dedup por id_transacao (evita disparo duplicado em reentregas).
    if (id_transacao) {
      const { data: existente } = await supabase
        .from("mentoria_vendas")
        .select("id")
        .eq("id_transacao", id_transacao)
        .maybeSingle();
      if (existente) {
        return new Response(
          JSON.stringify({ ok: true, duplicada: true, id: existente.id }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

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

    // 5) Dispara a mensagem (se houver gatilho e telefone).
    const varsMsg: Record<string, unknown> = { ...dados, nome, produto, forma_pagamento, telefone };
    let mensagem_enviada = false;
    let mensagem_status: string | null = null;
    if (gatilho && telefone) {
      try {
        const { data: cfg } = await supabase
          .from("cobranca_whatsapp_config")
          .select("*")
          .maybeSingle();
        await enviarTexto(cfg, String(telefone), render(gatilho.mensagem, varsMsg));
        mensagem_enviada = true;
        mensagem_status = "enviada";
      } catch (e) {
        mensagem_status = `erro: ${e instanceof Error ? e.message : String(e)}`;
      }
    } else if (!gatilho) {
      mensagem_status = "sem gatilho";
    } else {
      mensagem_status = "sem telefone";
    }

    // 6) Grava a venda.
    const { data: inserida, error } = await supabase
      .from("mentoria_vendas")
      .insert({
        id_transacao,
        status,
        produto: produto != null ? String(produto) : null,
        forma_pagamento: forma_pagamento != null ? String(forma_pagamento) : null,
        telefone: telefone != null ? String(telefone) : null,
        nome: nome != null ? String(nome) : null,
        dados,
        payload,
        mensagem_enviada,
        mensagem_status,
        data_venda,
      })
      .select("id")
      .single();

    if (error) throw error;

    return new Response(
      JSON.stringify({ ok: true, id: inserida?.id, mensagem_enviada, mensagem_status }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("webhook-mentoria erro", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
