import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BASE = "https://public-api.kiwify.com/v1";

function svc() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

// Normaliza texto p/ casar produto x slug da cidade (sem acento, sem espaço/hífen).
const norm = (s: string) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[\s-]/g, "");
// Normaliza e-mail (sem acento, minúsculo, trim).
const normEmail = (s: string) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

const ehUpgrade = (nome: string) => /upgrade/i.test(nome || "");
const ehVIP = (batch: string) => /vip\s*$/i.test((batch || "").trim());
// Lote-alvo = mesmo nome + " VIP" no final (preserva o hífen).
const loteAlvoVIP = (batch: string) => (batch || "").trim() + " VIP";

// OAuth client credentials → access_token.
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

// Lista paginada onde data é ARRAY (ex.: /products, /sales).
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

// Participantes de um evento: { data: { participants: [...] } }.
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

// Vendas de um produto nos últimos `dias` (janelas de 90 dias — limite da API).
async function listarVendasProduto(productId: string, token: string, dias = 180): Promise<any[]> {
  const out: any[] = [];
  const fim = new Date();
  const ini = new Date(fim.getTime() - dias * 24 * 3600 * 1000);
  // Quebra em janelas de até 90 dias.
  let janIni = new Date(ini);
  while (janIni < fim) {
    const janFim = new Date(Math.min(janIni.getTime() + 89 * 24 * 3600 * 1000, fim.getTime()));
    const sd = janIni.toISOString().slice(0, 10);
    const ed = janFim.toISOString().slice(0, 10);
    const vendas = await listarTudo(`/sales?product_id=${productId}&start_date=${sd}&end_date=${ed}`, token);
    out.push(...vendas);
    janIni = new Date(janFim.getTime() + 24 * 3600 * 1000);
  }
  return out;
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

    // E-mails de quem comprou UPGRADE (status pago).
    const upgradeEmails = new Set<string>();
    for (const pu of produtosUpgrade) {
      const vendas = await listarVendasProduto(pu.id, token);
      for (const v of vendas) {
        if (v.status && v.status !== "paid") continue;
        const e = normEmail(v.customer?.email || "");
        if (e) upgradeEmails.add(e);
      }
    }

    // order_id → e-mail do comprador, das vendas do(s) produto(s) de evento.
    const orderToBuyer = new Map<string, string>();
    for (const pe of produtosEvento) {
      const vendas = await listarVendasProduto(pe.id, token);
      for (const v of vendas) {
        if (v.id) orderToBuyer.set(String(v.id), normEmail(v.customer?.email || ""));
      }
    }

    // Participantes (lote real) dos produtos de evento.
    const rows: any[] = [];
    let totalParticipantes = 0;
    const vistos = new Set<string>();
    for (const pe of produtosEvento) {
      const parts = await listarParticipantes(pe.id, token);
      for (const part of parts) {
        if (part.id && vistos.has(String(part.id))) continue;
        if (part.id) vistos.add(String(part.id));
        totalParticipantes++;

        const compradorEmail = orderToBuyer.get(String(part.order_id)) || normEmail(part.email || "");
        const ehElegivel = upgradeEmails.has(compradorEmail) || upgradeEmails.has(normEmail(part.email || ""));
        if (!ehElegivel) continue;

        const loteAtual = String(part.batch_name || "").trim();
        const jaVip = !loteAtual || ehVIP(loteAtual);
        rows.push({
          id: String(part.id || `${part.order_id}-${rows.length}`),
          nome: part.name || "—",
          email: part.email || "—",
          comprador: compradorEmail || "—",
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
      compradores_elegiveis: compradoresElegiveis,
      ingressos_a_alterar: aAlterar.length,
      por_lote: [...porLoteMap.values()].sort((a, b) => b.qtd - a.qtd),
      linhas: rows,
    });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "erro interno" }, 500);
  }
});
