// Edge function "upgrade-lote" — 100% AO VIVO na Kiwify, sem usar o nosso banco.
// Fluxo:
//   1. Lista todas as VENDAS da cidade nos últimos 90 dias (produtos de evento).
//   2. Vê quais desses COMPRADORES (customer.email) também compraram o UPGRADE
//      da mesma cidade nos últimos 90 dias.
//   3. Para os pedidos casados, pega os INGRESSOS gerados (participants: nome,
//      e-mail, lote atual) e lista com o novo lote VIP.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BASE = "https://public-api.kiwify.com/v1";

const norm = (s: string) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[\s-]/g, "");
const normEmail = (s: string) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

const ehUpgrade = (nome: string) => /upgrade/i.test(nome || "");
const ehVIP = (batch: string) => /vip\s*$/i.test((batch || "").trim());
// Lote-alvo = mesmo nome SEM os separadores " - " / " | " + sufixo " VIP".
//   "Lote 2 - Duplo"      -> "Lote 2 Duplo VIP"
//   "Lote 1 - Individual" -> "Lote 1 Individual VIP"
//   "Pré-Venda | Duplo"   -> "Pré-Venda Duplo VIP"  (mantém o hífen de "Pré-Venda")
const loteAlvoVIP = (batch: string) =>
  (batch || "").replace(/\s+[|\-–—]\s+/g, " ").replace(/\s{2,}/g, " ").trim() + " VIP";

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

// Lista paginada onde data é ARRAY (/products, /sales).
async function listarTudo(path: string, token: string, maxPages = 100): Promise<any[]> {
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

// Participantes de um evento: { data: { participants: [...] } }.
async function listarParticipantes(productId: string, token: string, maxPages = 100): Promise<any[]> {
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

// Vendas de um produto nos últimos 90 dias (janela única — limite da API).
async function listarVendasProduto(productId: string, token: string): Promise<any[]> {
  const fim = new Date();
  const ini = new Date(fim.getTime() - 89 * 24 * 3600 * 1000);
  const sd = ini.toISOString().slice(0, 10);
  const ed = fim.toISOString().slice(0, 10);
  return await listarTudo(`/sales?product_id=${productId}&start_date=${sd}&end_date=${ed}`, token);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const citySlug: string = body?.city_slug || "";
    const cityNome: string = body?.city_nome || "";
    if (!citySlug && !cityNome) return json({ error: "Informe city_slug ou city_nome" }, 400);

    const token = await getToken();
    const produtos = await listarTudo("/products", token);

    // Casa produto com a cidade pelo slug (partes) ou pelo nome.
    const partes = String(citySlug).split(",").map((x) => norm(x)).filter(Boolean);
    const nomeN = norm(cityNome);
    const daCidade = (nomeProduto: string) => {
      const np = norm(nomeProduto);
      return partes.some((s) => np.includes(s)) || (nomeN && np.includes(nomeN));
    };

    const produtosCidade = produtos.filter((p: any) => daCidade(p.name || ""));
    const produtosUpgrade = produtosCidade.filter((p: any) => ehUpgrade(p.name || ""));
    const produtosEvento = produtosCidade.filter((p: any) => !ehUpgrade(p.name || ""));

    // (2) E-mails de quem comprou UPGRADE da cidade (90 dias).
    const upgradeEmails = new Set<string>();
    for (const pu of produtosUpgrade) {
      const vendas = await listarVendasProduto(pu.id, token);
      for (const v of vendas) {
        if (v.status && v.status !== "paid") continue;
        const e = normEmail(v.customer?.email || "");
        if (e) upgradeEmails.add(e);
      }
    }

    // (1) Vendas da cidade (evento) nos 90 dias → pedidos cujo COMPRADOR também
    // comprou upgrade. order_id (sale.id) → e-mail do comprador.
    const pedidosElegiveis = new Set<string>();
    const orderToBuyer = new Map<string, string>();
    for (const pe of produtosEvento) {
      const vendas = await listarVendasProduto(pe.id, token);
      for (const v of vendas) {
        if (v.status && v.status !== "paid") continue;
        const buyer = normEmail(v.customer?.email || "");
        const oid = v.id ? String(v.id) : "";
        if (oid) orderToBuyer.set(oid, buyer);
        if (oid && buyer && upgradeEmails.has(buyer)) pedidosElegiveis.add(oid);
      }
    }

    // (3) Ingressos gerados (participants) dos pedidos elegíveis.
    const rows: any[] = [];
    let totalParticipantes = 0;
    const vistos = new Set<string>();
    for (const pe of produtosEvento) {
      const parts = await listarParticipantes(pe.id, token);
      for (const part of parts) {
        if (part.id && vistos.has(String(part.id))) continue;
        if (part.id) vistos.add(String(part.id));
        totalParticipantes++;

        const oid = String(part.order_id || "");
        if (!pedidosElegiveis.has(oid)) continue;

        const loteAtual = String(part.batch_name || "").trim();
        const jaVip = !loteAtual || ehVIP(loteAtual);
        rows.push({
          id: String(part.id || `${oid}-${rows.length}`),
          nome: part.name || "—",
          email: part.email || "—",
          comprador: orderToBuyer.get(oid) || "—",
          loteAtual: loteAtual || "(sem lote)",
          loteAlvo: jaVip ? "—" : loteAlvoVIP(loteAtual),
          acao: !jaVip,
        });
      }
    }

    rows.sort((a, b) => Number(b.acao) - Number(a.acao) || a.loteAtual.localeCompare(b.loteAtual));

    const aAlterar = rows.filter((r) => r.acao);
    const compradoresElegiveis = new Set(rows.map((r) => r.comprador)).size;
    const porLoteMap = new Map<string, { de: string; para: string; qtd: number }>();
    for (const r of aAlterar) {
      const k = `${r.loteAtual}→${r.loteAlvo}`;
      const cur = porLoteMap.get(k) || { de: r.loteAtual, para: r.loteAlvo, qtd: 0 };
      cur.qtd++;
      porLoteMap.set(k, cur);
    }

    return json({
      success: true,
      cidade: cityNome || citySlug,
      produtos_evento: produtosEvento.map((p: any) => p.name),
      produtos_upgrade: produtosUpgrade.map((p: any) => p.name),
      total_participantes: totalParticipantes,
      compradores_upgrade: upgradeEmails.size,
      pedidos_elegiveis: pedidosElegiveis.size,
      compradores_elegiveis: compradoresElegiveis,
      ingressos_a_alterar: aAlterar.length,
      por_lote: [...porLoteMap.values()].sort((a, b) => b.qtd - a.qtd),
      linhas: rows,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "erro interno" }, 500);
  }
});
