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
  init: (base: string) => `${base}/instance/init`,
  connect: (base: string) => `${base}/instance/connect`,
  status: (base: string) => `${base}/instance/status`,
  disconnect: (base: string) => `${base}/instance/disconnect`,
  remove: (base: string) => `${base}/instance`, // DELETE
  groups: (base: string) => `${base}/group/list`,
  sendText: (base: string) => `${base}/send/text`,
};

// Credenciais de ADMIN vêm de secrets (UAZAPI_SERVER_URL/UAZAPI_ADMIN_TOKEN);
// cai pro que estiver salvo no banco (legado) se o secret não existir.
function adminCreds(cfg: any) {
  const base = (Deno.env.get("UAZAPI_SERVER_URL") || cfg?.server_url || "").replace(/\/$/, "");
  const admin = Deno.env.get("UAZAPI_ADMIN_TOKEN") || cfg?.admin_token || "";
  return { base, admin };
}

function svc() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

async function getConfig(supabase: any) {
  const { data } = await supabase.from("whatsapp_config").select("*").maybeSingle();
  return data;
}

async function uazFetch(base: string, path: string, token: string, body?: unknown, method?: string) {
  const res = await fetch(path, {
    method: method || (body ? "POST" : "GET"),
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

// Envia uma mensagem de texto via UAZAPI usando o token de uma instância.
async function enviarTexto(base: string, token: string, destinatario: string, mensagem: string) {
  if (!base || !token) throw new Error("Instância UAZAPI indisponível — crie/conecte uma instância");
  return uazFetch(base, UAZAPI.sendText(base), token, { number: destinatario, text: mensagem });
}

// Busca uma instância do pool pelo nome.
async function getInstancia(supabase: any, nome: string) {
  const { data } = await supabase.from("uazapi_instancias").select("*").eq("nome", nome).maybeSingle();
  return data;
}
// Resolve { base, token } para enviar: usa a instância `nome`; se não houver,
// cai pra primeira instância do pool e, em último caso, pro admin token (legado).
async function tokenDe(supabase: any, cfg: any, nome?: string | null): Promise<{ base: string; token: string }> {
  const { base, admin } = adminCreds(cfg);
  let token = "";
  if (nome) {
    const inst = await getInstancia(supabase, nome);
    token = inst?.instance_token || "";
  }
  if (!token) {
    const { data } = await supabase.from("uazapi_instancias").select("instance_token")
      .not("instance_token", "is", null).order("created_at", { ascending: true }).limit(1).maybeSingle();
    token = data?.instance_token || admin;
  }
  return { base, token };
}

// Lista os grupos de uma instância (normalizados em {id, name}).
async function listarGrupos(supabase: any, cfg: any, instancia?: string | null) {
  const { base } = adminCreds(cfg);
  const { token } = await tokenDe(supabase, cfg, instancia);
  if (!base || !token) return [] as { id: string; name: string }[];
  const data = await uazFetch(base, UAZAPI.groups(base), token);
  const list = data.groups || data.data || data || [];
  return (Array.isArray(list) ? list : []).map((g: any) => ({
    id: g.JID || g.id || g.jid || g.gid || g.group_id,
    name: g.Name || g.name || g.subject || g.title || g.JID || g.id,
  })).filter((g: any) => g.id);
}

// Converte número em formato BR ("847.250" ou "2.705.000,50") para Number.
function parseMetaNumero(raw: string): number {
  if (!raw) return 0;
  let s = String(raw).trim();
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");   // 1.234,56 -> 1234.56
  else s = s.replace(/\./g, "");                                      // 847.250 -> 847250
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// Extrai (faturado/meta) do nome do grupo: "Scale Company (847.250/2.705.000)".
function parseFaturadoMeta(nome: string): { faturado: number; meta: number } | null {
  const m = (nome || "").match(/\(([\d.,]+)\s*\/\s*([\d.,]+)\)/);
  if (!m) return null;
  return { faturado: parseMetaNumero(m[1]), meta: parseMetaNumero(m[2]) };
}

// Lê o nome do grupo configurado, faz parse e grava config + snapshot.
async function metaSync(supabase: any, cfg: any) {
  const { data: conf } = await supabase.from("meta_faturado_config").select("*").limit(1).maybeSingle();
  if (!conf) throw new Error("meta_faturado_config não configurada");
  const grupos = await listarGrupos(supabase, cfg, conf.instancia);
  // Acha o grupo: por id se setado, senão por nome (match parcial).
  const alvo = conf.grupo_id
    ? grupos.find((g) => g.id === conf.grupo_id)
    : grupos.find((g) => (g.name || "").toLowerCase().includes((conf.grupo_nome || "").toLowerCase()));
  if (!alvo) throw new Error("Grupo não encontrado na instância");
  const parsed = parseFaturadoMeta(alvo.name);
  if (!parsed) throw new Error(`Nome do grupo sem formato (faturado/meta): "${alvo.name}"`);
  const agora = new Date().toISOString();
  await supabase.from("meta_faturado_config").update({
    grupo_id: alvo.id, grupo_nome: alvo.name,
    faturado: parsed.faturado, meta: parsed.meta, atualizado_em: agora,
  }).eq("id", conf.id);
  await supabase.from("meta_faturado_snapshots").insert({
    faturado: parsed.faturado, meta: parsed.meta, captado_em: agora,
  });
  return { ...parsed, grupo_id: alvo.id, grupo_nome: alvo.name, atualizado_em: agora };
}

// Lista de destinatários de uma notificação (novo formato `destinatarios` ou legado)
function destinatariosDe(n: any, soNumeros = false): string[] {
  if (Array.isArray(n.destinatarios) && n.destinatarios.length) {
    return n.destinatarios
      .filter((d: any) => !soNumeros || d.tipo === "numero")
      .map((d: any) => d.valor).filter(Boolean);
  }
  if (soNumeros && n.destinatario_tipo !== "numero") return [];
  return n.destinatario ? [n.destinatario] : [];
}

// Grava uma linha no Google Sheets (via função google-sheets) se ativo na notificação.
async function enviarSheets(n: any, vars: Record<string, string | number>) {
  if (!n.sheets_ativo || !n.sheets_spreadsheet_id || !n.sheets_aba) return;
  const mapa = n.sheets_mapa || {};
  const valores: Record<string, string> = {};
  for (const [col, tpl] of Object.entries(mapa)) {
    if (!tpl) continue;
    valores[col] = render(String(tpl), vars);
  }
  if (Object.keys(valores).length === 0) return;
  try {
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/google-sheets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
      body: JSON.stringify({ action: "append", spreadsheet_id: n.sheets_spreadsheet_id, aba: n.sheets_aba, valores }),
    });
  } catch (e) { console.log("Sheets append falhou:", (e as any)?.message || e); }
}

// Envia um e-mail (via função `email`, action send_custom) se a notificação tiver
// e-mail ativo. Assunto/corpo/destinatário aceitam {{variáveis}}.
async function enviarEmailNotif(n: any, vars: Record<string, string | number>) {
  if (!n.email_ativo || !n.email_para) return;
  const to = render(String(n.email_para), vars);
  const subject = render(String(n.email_assunto || ""), vars);
  const body = render(String(n.email_corpo || ""), vars);
  if (!to.trim()) return;
  try {
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}` },
      body: JSON.stringify({ action: "send_custom", config_id: n.email_config_id || null, to, subject, body }),
    });
  } catch (e) { console.log("envio de e-mail falhou:", (e as any)?.message || e); }
}

// "vip_duplo" -> "Vip Duplo", "convite" -> "Convite" (tira _ e capitaliza cada palavra)
function formatTipo(s: string): string {
  return (s || "").split(/[_\s]+/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

// Status do pagamento como texto amigável (igual à planilha): "Pagamento aprovado" etc.
const STATUS_LABEL: Record<string, string> = {
  aprovada: "Pagamento aprovado",
  pendente: "Pagamento pendente",
  cancelada: "Pagamento cancelado",
  reembolsada: "Pagamento reembolsado",
};
function formatStatus(s: string): string {
  return STATUS_LABEL[(s || "").toLowerCase()] || formatTipo(s);
}

// Monta as variáveis a partir de uma venda
function varsDaVenda(v: any): Record<string, string | number> {
  return {
    nome: v.nome_comprador || "",
    email: v.email_comprador || "",
    telefone: v.telefone_comprador || "",
    documento: v.documento || "",
    produto: v.produto || "",
    cidade: v.cidade || "",
    valor: fmtBRL(v.valor || 0),
    tipo: formatTipo(v.tipo_ingresso || ""),
    status: formatStatus(v.status || ""),
    quantidade: v.quantidade || 1,
    pagamento: v.metodo_pagamento || "",            // legado (mantido p/ templates antigos)
    forma_pagamento: formatTipo(v.metodo_pagamento || ""),
    data: v.data_venda ? new Date(v.data_venda).toLocaleDateString("pt-BR") : "",
  };
}

// Variáveis de uma venda de Inside Sales / Mentoria (tabela mentoria_vendas).
// Espalha também os campos mapeados (dados) para templates avançados.
function varsDaMentoria(v: any): Record<string, string | number> {
  const dados = (v && typeof v.dados === "object" && v.dados) ? v.dados : {};
  return {
    ...dados,
    nome: v.nome || "",
    telefone: v.telefone || "",
    produto: v.produto || "",
    forma_pagamento: v.forma_pagamento || "",
    origem: v.origem || dados.origem || dados.Origem || "",
    valor: (v.valor != null && v.valor !== "") ? v.valor : (dados.valor ?? dados.deal_value ?? ""),
    email: v.email || dados.email || "",
    status: v.status || "",
    observacoes: v.observacoes || dados.observacoes || dados["Observações"] || dados["Observacoes"] || "",
    cnpj: v.cnpj || dados.cnpj || dados.CNPJ || "",
    dono_negocio: v.dono_negocio || dados.dono_negocio || dados["Dono do negócio"] || dados.deal_user || "",
    data_fechamento: v.data_fechamento || dados.data_fechamento || dados["Data do fechamento"] || "",
    id_transacao: v.id_transacao || "",
    data: v.data_venda ? new Date(v.data_venda).toLocaleDateString("pt-BR") : new Date().toLocaleDateString("pt-BR"),
  };
}

// Variáveis de um lead de recuperação (tabela recuperacao_leads).
function varsDoLead(l: any): Record<string, string | number> {
  return {
    nome: l.nome || "",
    email: l.email || "",
    telefone: l.telefone || "",
    produto: l.produto || "",
    cidade: l.cidade || "",
    valor: fmtBRL(l.valor || 0),
    tipo: formatTipo(l.tipo_ingresso || ""),
    quantidade: 1,
    data: l.data_venda ? new Date(l.data_venda).toLocaleDateString("pt-BR") : "",
  };
}

// Hora (0-23) no fuso de São Paulo de um instante.
function horaSP(d: Date): number {
  return Number(d.toLocaleString("en-US", { hour: "2-digit", hour12: false, timeZone: "America/Sao_Paulo" }).slice(0, 2)) % 24;
}
// Quiet hours: nunca enviar entre 22h e 7h (SP). Se `alvo` cair nessa janela,
// joga para as 07:00 (SP) do próximo período válido.
function proximoHorarioValido(alvo: Date): Date {
  const d = new Date(alvo);
  // Itera no máximo ~3 vezes (segurança) até cair fora da janela [22h, 7h).
  for (let i = 0; i < 4; i++) {
    const h = horaSP(d);
    if (h >= 7 && h < 22) return d;
    // Calcula quantas horas faltam até as 07:00 SP do próximo dia válido.
    const horasAte7 = h >= 22 ? (24 - h + 7) : (7 - h);
    d.setTime(d.getTime() + horasAte7 * 3600_000);
    // Zera para 07:00 cravado (minutos): ajusta minutos/segundos via diferença SP.
    const min = Number(d.toLocaleString("en-US", { minute: "2-digit", timeZone: "America/Sao_Paulo" }));
    d.setTime(d.getTime() - min * 60_000);
  }
  return d;
}
// Delay de um passo em milissegundos.
function delayMs(valor: number, unidade: string): number {
  const v = Number(valor) || 0;
  return unidade === "minutos" ? v * 60_000 : v * 3600_000;
}

// ---- Meta Ads (server-side, usa token salvo no banco) ----
function slugVariants(slug: string): string[] {
  return (slug || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
function stripLower(s: string): string {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
const META_EXCLUDE = ["lead", "meteorico"];
function campMatch(name: string, variants: string[]): boolean {
  const n = (name || "").toLowerCase();
  if (!variants.some((v) => n.includes(v))) return false;
  const na = stripLower(name);
  if (META_EXCLUDE.some((t) => na.includes(t))) return false;
  return true;
}
const GRAPH = "https://graph.facebook.com/v21.0";

async function metaSpend(meta: any, slug: string): Promise<number> {
  const variants = slugVariants(slug);
  // Considera apenas campanhas ATIVAS que casam o slug (ignora antigas/pausadas
  // de eventos passados que tenham o mesmo slug no nome).
  const cj = await (await fetch(`${GRAPH}/${meta.account_id}/campaigns?fields=id,name,status&limit=500&access_token=${meta.access_token}`)).json();
  const ativos = new Set<string>((cj.data || []).filter((c: any) => c.status === "ACTIVE" && campMatch(c.name, variants)).map((c: any) => c.name));
  if (ativos.size === 0) return 0;
  const r = await fetch(`${GRAPH}/${meta.account_id}/insights?level=campaign&fields=spend,campaign_name&date_preset=maximum&limit=500&access_token=${meta.access_token}`);
  const j = await r.json();
  let spend = 0;
  for (const row of j.data || []) if (ativos.has(row.campaign_name)) spend += parseFloat(row.spend) || 0;
  return spend;
}
async function metaDailyBudget(meta: any, slug: string): Promise<number> {
  const variants = slugVariants(slug);
  const cj = await (await fetch(`${GRAPH}/${meta.account_id}/campaigns?fields=id,name,daily_budget,status&limit=500&access_token=${meta.access_token}`)).json();
  const camps = (cj.data || []).filter((c: any) => c.status === "ACTIVE" && campMatch(c.name, variants));
  let total = 0; const need = new Set<string>();
  for (const c of camps) { if (c.daily_budget && +c.daily_budget > 0) total += +c.daily_budget / 100; else need.add(c.id); }
  if (need.size) {
    const aj = await (await fetch(`${GRAPH}/${meta.account_id}/adsets?fields=daily_budget,status,campaign&limit=500&access_token=${meta.access_token}`)).json();
    for (const a of aj.data || []) {
      if (a.campaign?.id && need.has(a.campaign.id) && a.status === "ACTIVE" && a.daily_budget && +a.daily_budget > 0) total += +a.daily_budget / 100;
    }
  }
  return total;
}

// Calcula um resumo de cidade (métricas do banco + Meta, se o token estiver salvo)
async function resumoCidade(supabase: any, cidadeSlug: string | null) {
  // Usa a MESMA RPC do dashboard (filtra por cidade no servidor) para o report
  // bater com os números do dashboard e evitar o limite de 1000 linhas que
  // subcontava cidades quando carregávamos todas as vendas e filtrávamos no JS.
  // Janela de 90 dias para trás: evita misturar vendas de um evento anterior
  // na MESMA cidade (eventos podem se repetir). 90 dias é seguro entre eventos.
  const inicio90 = new Date(Date.now() - 90 * 86400000).toISOString();
  const { data } = await supabase.rpc("buscar_vendas", {
    p_status: "aprovada",
    p_start: inicio90,
    p_end: "2030-01-01T00:00:00Z",
    p_city_slug: cidadeSlug || null,
  });
  const rows = (data || []) as any[];

  // Usa o nome COMPLETO do produto que vem nas vendas (com a data),
  // ex.: "Workshop Scale | Porto Alegre - RS | 09/06/2026" — ignora upgrades.
  const prodCount: Record<string, number> = {};
  for (const r of rows) {
    const p = (r.produto || "").trim();
    if (p && !p.toLowerCase().includes("upgrade")) prodCount[p] = (prodCount[p] || 0) + 1;
  }
  const cidadeNome = Object.keys(prodCount).sort((a, b) => prodCount[b] - prodCount[a])[0]
    || (rows.find((r: any) => r.produto)?.produto)
    || cidadeSlug || "Todas";

  let participantes = 0, pagantes = 0, vips = 0, convidados = 0, bilheteria = 0;
  for (const r of rows) {
    const qty = r.quantidade || 1; const valor = Number(r.valor) || 0; bilheteria += valor;
    const prod = (r.produto || "").toLowerCase();
    if (prod.includes("upgrade")) { vips += qty; continue; }
    participantes += qty;
    if ((r.tipo_ingresso || prod).toLowerCase().includes("vip")) vips += qty;
    const convite = (r.tipo_ingresso || "").toLowerCase().includes("convite") || valor === 0;
    if (convite) convidados += qty; else pagantes += qty;
  }

  let investimento = "-", cac = "-", projecao = "-", projecao_investimento = "-";
  let spendNum = 0;
  const meta = (await supabase.from("meta_config").select("*").maybeSingle()).data;
  if (meta?.access_token && meta?.account_id && cidadeSlug) {
    try {
      const spend = await metaSpend(meta, cidadeSlug);
      spendNum = spend;
      investimento = fmtBRL(spend);
      const cacNum = pagantes > 0 && spend > 0 ? spend / pagantes : 0;
      if (cacNum > 0) cac = fmtBRL(cacNum);
      // Projeções (precisam da data do evento + orçamento diário)
      const { data: cid } = await supabase.from("cidades").select("data_evento").eq("slug", cidadeSlug).maybeSingle();
      if (cid?.data_evento) {
        const budget = await metaDailyBudget(meta, cidadeSlug);
        // Dias restantes (fuso SP): dia do evento só capta até 12h; depois disso zera.
        const spDate = (d: Date) => new Date(d.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
        const ev = spDate(new Date(cid.data_evento));
        const agora = spDate(new Date());
        const evDia = Date.UTC(ev.getFullYear(), ev.getMonth(), ev.getDate());
        const hojeDia = Date.UTC(agora.getFullYear(), agora.getMonth(), agora.getDate());
        const diffDias = Math.round((evDia - hojeDia) / 86400000);
        const dias = diffDias < 0 ? 0 : diffDias === 0 ? (agora.getHours() < 12 ? 0.5 : 0) : diffDias + 0.5;
        if (budget > 0) {
          // Investimento projetado = gasto atual + orçamento diário × dias restantes
          projecao_investimento = fmtBRL(spend + budget * dias);
          if (cacNum > 0) projecao = String(Math.ceil(participantes + (budget / cacNum) * dias));
        }
      }
    } catch (_) { /* mantém "-" */ }
  }

  return {
    cidade: cidadeNome,
    participantes, vips, convidados,
    bilheteria: fmtBRL(bilheteria),
    bilheteria_resultado: fmtBRL(bilheteria - spendNum), // Bilheteria (+/-): bilheteria menos investimento
    cac, projecao, investimento, projecao_investimento,
    _bilheteriaNum: bilheteria, _investimentoNum: spendNum,
  };
}

// Data de hoje (YYYY-MM-DD) em horário de São Paulo.
function hojeSPstr(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}
// Cidade ATIVA = evento de hoje em diante. Compara só a data (YYYY-MM-DD) para
// evitar erros de fuso. Sem data_evento => não bloqueia (legado).
function eventoAtivo(dataEvento: string | null): boolean {
  if (!dataEvento) return true;
  return String(dataEvento).slice(0, 10) >= hojeSPstr();
}
// Data do evento (YYYY-MM-DD) no fuso de São Paulo.
function eventoDataSP(dataEvento: string | null): string {
  if (!dataEvento) return "";
  return new Date(dataEvento).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}
// Slugs das cidades cujo evento é HOJE (respeitando a cidade específica da notificação, se houver).
async function slugsEventoHoje(supabase: any, n: any): Promise<string[]> {
  const { data: cids } = await supabase.from("cidades").select("slug,data_evento");
  const hoje = hojeSPstr();
  const eventoHoje = (cids || []).filter((c: any) => eventoDataSP(c.data_evento) === hoje);
  if (!n.cidade_slug) return eventoHoje.map((c: any) => c.slug);
  const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[\s-]/g, "");
  const parts = String(n.cidade_slug).split(",").map((p: string) => norm(p)).filter(Boolean);
  return eventoHoje
    .filter((c: any) => { const cs = norm(c.slug); return parts.some((p) => p === cs || cs.includes(p) || p.includes(cs)); })
    .map((c: any) => c.slug);
}

// Resumo consolidado de todas as cidades ativas (gatilho resumo_geral).
async function resumoGeral(supabase: any): Promise<Record<string, string | number>> {
  const { data: cids } = await supabase.from("cidades").select("slug,data_evento");
  const ativas = (cids || []).filter((c: any) => eventoAtivo(c.data_evento));
  let participantes = 0, bilheteria = 0, investimento = 0;
  for (const c of ativas) {
    const r = await resumoCidade(supabase, c.slug);
    participantes += Number(r.participantes) || 0;
    bilheteria += Number(r._bilheteriaNum) || 0;
    investimento += Number(r._investimentoNum) || 0;
  }
  return {
    total_cidades: ativas.length,
    participantes_total: participantes,
    bilheteria_total: fmtBRL(bilheteria),
    investimento_total: fmtBRL(investimento),
    bilheteria_resultado_total: fmtBRL(bilheteria - investimento), // Bilheteria (+/-) consolidada
    data: new Date().toLocaleDateString("pt-BR"),
  };
}

// Slugs a processar: 1 por cidade ATIVA (evento >= hoje) quando "todas",
// senão a cidade específica da notificação.
async function slugsDaNotif(supabase: any, n: any): Promise<(string | null)[]> {
  const { data: cids } = await supabase.from("cidades").select("slug,data_evento");
  const lista = (cids || []) as any[];

  // "Todas as cidades": só as ATIVAS (evento de hoje em diante).
  if ((n.gatilho === "resumo_cidade" || n.gatilho === "manual") && !n.cidade_slug) {
    return lista.filter((c) => eventoAtivo(c.data_evento)).map((c) => c.slug);
  }

  // Cidade específica: NUNCA envia se o evento já passou (cidade inativa).
  const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[\s-]/g, "");
  const parts = String(n.cidade_slug || "").split(",").map((p: string) => norm(p)).filter(Boolean);
  const cidade = lista.find((c) => {
    const cs = norm(c.slug);
    return parts.some((p) => p === cs || cs.includes(p) || p.includes(cs));
  });
  // Se a cidade está cadastrada e o evento passou, bloqueia. Sem match => legado (envia).
  if (cidade && !eventoAtivo(cidade.data_evento)) return [];
  return [n.cidade_slug || null];
}

// Lista de conjuntos de variáveis: 1 por cidade ativa (resumo) ou 1 (venda/geral)
async function buildVarsList(supabase: any, n: any): Promise<Record<string, string | number>[]> {
  if (n.gatilho === "nova_venda" || n.gatilho === "compra_realizada" || n.gatilho === "recuperacao_venda") {
    return [varsDaVenda({ nome_comprador: "Fulano (teste)", produto: "Workshop Scale | Belém - PA", cidade: "Belém", valor: 247, tipo_ingresso: "individual", quantidade: 1, metodo_pagamento: "pix", data_venda: new Date().toISOString() })];
  }
  if (n.gatilho === "resumo_geral") {
    return [await resumoGeral(supabase)];
  }
  const slugs = await slugsDaNotif(supabase, n);
  const out: Record<string, string | number>[] = [];
  for (const slug of slugs) out.push(await resumoCidade(supabase, slug));
  return out;
}

Deno.serve(async (req) => {
  console.log("uazapi v11 - logs cidade");
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const supabase = svc();
    const { action, ...payload } = await req.json();
    const cfg = await getConfig(supabase);

    switch (action) {
      // Lista todas as instâncias do pool (compartilhado por Notificações e Cobrança).
      case "listar_instancias": {
        const { data } = await supabase.from("uazapi_instancias").select("nome,status,numero").order("nome");
        return json({ instancias: data || [] });
      }
      // Cria uma nova instância na UAZAPI e adiciona ao pool.
      case "criar_instancia": {
        const { base, admin } = adminCreds(cfg);
        const nome = (payload.nome || "").trim();
        if (!base || !admin) return json({ error: "Credenciais de admin UAZAPI ausentes (configure os secrets)" }, 400);
        if (!nome) return json({ error: "Informe o nome da instância" }, 400);
        const data = await uazFetch(base, UAZAPI.init(base), admin, { name: nome });
        const inst = data.instance || data || {};
        const token = inst.token || inst.apikey || data.token || data.apikey || null;
        if (!token) throw new Error("UAZAPI não retornou o token da instância ao criar");
        await supabase.from("uazapi_instancias").upsert(
          { nome, instance_token: token, status: "desconectado", numero: null, updated_at: new Date().toISOString() },
          { onConflict: "nome" });
        return json({ success: true, instance: nome });
      }
      // Remove a instância na UAZAPI e tira do pool.
      case "deletar_instancia": {
        const { base } = adminCreds(cfg);
        const inst = await getInstancia(supabase, payload.nome);
        if (inst?.instance_token && base) {
          try { await uazFetch(base, UAZAPI.remove(base), inst.instance_token, undefined, "DELETE"); } catch (_) { /* tira do pool mesmo se a API recusar */ }
        }
        await supabase.from("uazapi_instancias").delete().eq("nome", payload.nome);
        return json({ success: true });
      }
      case "connect": {
        const { base } = adminCreds(cfg);
        const inst = await getInstancia(supabase, payload.instancia);
        if (!base || !inst?.instance_token) return json({ error: "Instância não encontrada — crie primeiro" }, 400);
        const data = await uazFetch(base, UAZAPI.connect(base), inst.instance_token, {});
        const i = data.instance || {};
        const qrcode = i.qrcode || data.qrcode || i.paircode || null;
        const status = i.status || (data.connected ? "connected" : "aguardando_qr");
        await supabase.from("uazapi_instancias").update({ status, updated_at: new Date().toISOString() }).eq("nome", payload.instancia);
        return json({ qrcode, status });
      }
      case "status": {
        const { base } = adminCreds(cfg);
        const inst = await getInstancia(supabase, payload.instancia);
        if (!base || !inst?.instance_token) return json({ status: "desconectado" });
        const data = await uazFetch(base, UAZAPI.status(base), inst.instance_token);
        const i = data.instance || {};
        const connected = i.status === "connected" || data.connected === true;
        const status = connected ? "connected" : (i.status || "desconectado");
        const numero = i.owner || i.profileName || null;
        const qrcode = i.qrcode || null;
        await supabase.from("uazapi_instancias").update({ status, numero, updated_at: new Date().toISOString() }).eq("nome", payload.instancia);
        return json({ status, numero, connected, qrcode });
      }
      case "disconnect": {
        const { base } = adminCreds(cfg);
        const inst = await getInstancia(supabase, payload.instancia);
        if (base && inst?.instance_token) {
          try { await uazFetch(base, UAZAPI.disconnect(base), inst.instance_token, {}); } catch (_) { /* marca desconectado mesmo se a API recusar */ }
        }
        await supabase.from("uazapi_instancias").update({ status: "desconectado", numero: null, updated_at: new Date().toISOString() }).eq("nome", payload.instancia);
        return json({ success: true, status: "desconectado" });
      }
      case "groups":
      case "meta_grupos": {
        const groups = await listarGrupos(supabase, cfg, payload.instancia);
        return json({ groups });
      }
      case "meta_sync": {
        const result = await metaSync(supabase, cfg);
        return json({ success: true, ...result });
      }
      case "send": {
        const { base, token } = await tokenDe(supabase, cfg, payload.instancia);
        await enviarTexto(base, token, payload.destinatario, payload.mensagem);
        return json({ success: true });
      }
      case "send_test": {
        const { data: n } = await supabase.from("notificacoes").select("*").eq("id", payload.notificacao_id).maybeSingle();
        if (!n) return json({ error: "Notificação não encontrada" }, 404);
        const ds = destinatariosDe(n);
        if (ds.length === 0) return json({ error: "Notificação sem destinatário" }, 400);
        const { base: baseT, token: tokenT } = await tokenDe(supabase, cfg, n.instancia);
        // 1 mensagem por cidade ativa (quando "todas") — enviadas separadamente
        const varsList = await buildVarsList(supabase, n);
        // No fluxo de recuperação a mensagem vem do 1º passo (recuperacao_mensagens).
        let templateTest = n.mensagem;
        if (n.gatilho === "recuperacao_venda") {
          const { data: passo } = await supabase.from("recuperacao_mensagens")
            .select("mensagem").eq("notificacao_id", n.id).eq("ativo", true)
            .order("ordem", { ascending: true }).limit(1).maybeSingle();
          templateTest = passo?.mensagem || "(fluxo sem mensagens cadastradas)";
        }
        let enviados = 0;
        const erros: string[] = [];
        for (const vars of varsList) {
          const msg = render(templateTest, vars) + "\n\n_(mensagem de teste)_";
          for (const dest of ds) {
            try {
              await enviarTexto(baseT, tokenT, dest, msg);
              await supabase.from("notificacao_logs").insert({ notificacao_id: n.id, destinatario: dest, mensagem: msg, status: "enviado", cidade: (vars as any).cidade || null });
              enviados++;
            } catch (e) {
              // Um número/cidade que falha não pode abortar o restante do lote.
              erros.push(`${(vars as any).cidade || ""} → ${dest}: ${e instanceof Error ? e.message : e}`);
              await supabase.from("notificacao_logs").insert({ notificacao_id: n.id, destinatario: dest, mensagem: msg, status: "erro", erro: String(e), cidade: (vars as any).cidade || null });
            }
          }
          await enviarSheets(n, vars);
          await enviarEmailNotif(n, vars);
        }
        return json({ success: true, enviados, erros });
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
          const { base: baseT, token: tokenT } = await tokenDe(supabase, cfg, n.instancia);
          const vendaVars = varsDaVenda(v);
          const msg = render(n.mensagem, vendaVars);
          for (const dest of destinatariosDe(n)) {
            try {
              await enviarTexto(baseT, tokenT, dest, msg);
              await supabase.from("notificacao_logs").insert({ notificacao_id: n.id, destinatario: dest, mensagem: msg, status: "enviado", cidade: v.cidade || null });
              enviados++;
            } catch (e) {
              await supabase.from("notificacao_logs").insert({ notificacao_id: n.id, destinatario: dest, mensagem: msg, status: "erro", erro: String(e), cidade: v.cidade || null });
            }
          }
          await enviarSheets(n, vendaVars);
          await enviarEmailNotif(n, vendaVars);
        }
        return json({ success: true, enviados });
      }
      case "nova_venda_inside_sales": {
        // Chamado pela função webhook-mentoria quando chega uma venda de Inside Sales.
        const v = payload.venda;
        if (!v) return json({ error: "venda ausente" }, 400);
        const { data: notifs } = await supabase.from("notificacoes").select("*").eq("ativo", true).eq("gatilho", "nova_venda_inside_sales");
        const vars = varsDaMentoria(v);
        let enviados = 0;
        for (const n of notifs || []) {
          const { base: baseT, token: tokenT } = await tokenDe(supabase, cfg, n.instancia);
          const msg = render(n.mensagem, vars);
          for (const dest of destinatariosDe(n)) {
            try {
              await enviarTexto(baseT, tokenT, dest, msg);
              await supabase.from("notificacao_logs").insert({ notificacao_id: n.id, destinatario: dest, mensagem: msg, status: "enviado", cidade: null });
              enviados++;
            } catch (e) {
              await supabase.from("notificacao_logs").insert({ notificacao_id: n.id, destinatario: dest, mensagem: msg, status: "erro", erro: String(e), cidade: null });
            }
          }
          await enviarSheets(n, vars);
          await enviarEmailNotif(n, vars);
        }
        return json({ success: true, enviados });
      }
      case "run_scheduled": {
        // Chamado por um cron; envia os resumos cujo horário == agora (HH:MM)
        const agora = payload.horario || new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
        const { data: notifs } = await supabase.from("notificacoes").select("*").eq("ativo", true).in("gatilho", ["resumo_cidade", "resumo_geral"]);
        let enviados = 0;
        const hhmm = agora.slice(0, 5);
        for (const n of notifs || []) {
          // Disparo normal (ex.: 9h): todas as cidades ativas.
          const normalMatch = (n.horario || "").slice(0, 5) === hhmm;
          // Disparo extra NO DIA do evento (ex.: 12h): só a(s) cidade(s) com evento hoje.
          const eventoMatch = n.disparo_dia_evento && n.gatilho === "resumo_cidade"
            && (n.horario_evento || "12:00").slice(0, 5) === hhmm;
          if (!normalMatch && !eventoMatch) continue;

          let varsList: Record<string, string | number>[];
          if (normalMatch) {
            varsList = await buildVarsList(supabase, n);
          } else {
            // Só cidades cujo evento é hoje (ignora as demais).
            const slugs = await slugsEventoHoje(supabase, n);
            varsList = [];
            for (const slug of slugs) varsList.push(await resumoCidade(supabase, slug));
          }
          // No disparo do dia do evento: só números (ignora grupos). No normal: todos.
          const soEventoDia = eventoMatch && !normalMatch;
          const dests = destinatariosDe(n, soEventoDia);
          const { base: baseT, token: tokenT } = await tokenDe(supabase, cfg, n.instancia);
          for (const vars of varsList) {
            const msg = render(n.mensagem, vars);
            for (const dest of dests) {
              try {
                await enviarTexto(baseT, tokenT, dest, msg);
                await supabase.from("notificacao_logs").insert({ notificacao_id: n.id, destinatario: dest, mensagem: msg, status: "enviado", cidade: (vars as any).cidade || null });
                enviados++;
              } catch (e) {
                await supabase.from("notificacao_logs").insert({ notificacao_id: n.id, destinatario: dest, mensagem: msg, status: "erro", erro: String(e), cidade: (vars as any).cidade || null });
              }
            }
            await enviarSheets(n, vars);
          await enviarEmailNotif(n, vars);
          }
        }
        return json({ success: true, enviados });
      }
      case "compra_realizada": {
        // Chamado pela função webhook-vendas quando uma venda é APROVADA.
        // Parabeniza o comprador no WhatsApp dele e grava o status na venda.
        const v = payload.venda;
        if (!v) return json({ error: "venda ausente" }, 400);
        const { data: notifs } = await supabase.from("notificacoes").select("*").eq("ativo", true).eq("gatilho", "compra_realizada");
        const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[\s-]/g, "");
        const telefone = v.telefone_comprador || v.telefone || "";
        let enviados = 0; let status = "erro"; let ultimoErro: string | null = null;
        for (const n of notifs || []) {
          if (n.cidade_slug) {
            const parts = n.cidade_slug.split(",").map((p: string) => norm(p)).filter(Boolean);
            const match = parts.some((s: string) => norm(v.cidade || "").includes(s) || norm(v.produto || "").includes(s));
            if (!match) continue;
          }
          if (!telefone) { ultimoErro = "venda sem telefone do comprador"; continue; }
          const { base: baseT, token: tokenT } = await tokenDe(supabase, cfg, n.instancia);
          const vendaVars = varsDaVenda(v);
          const msg = render(n.mensagem, vendaVars);
          try {
            await enviarTexto(baseT, tokenT, telefone, msg);
            await supabase.from("notificacao_logs").insert({ notificacao_id: n.id, destinatario: telefone, mensagem: msg, status: "enviado", cidade: v.cidade || null });
            enviados++; status = "enviada"; ultimoErro = null;
          } catch (e) {
            ultimoErro = e instanceof Error ? e.message : String(e);
            await supabase.from("notificacao_logs").insert({ notificacao_id: n.id, destinatario: telefone, mensagem: msg, status: "erro", erro: ultimoErro, cidade: v.cidade || null });
          }
          await enviarSheets(n, vendaVars);
          await enviarEmailNotif(n, vendaVars);
        }
        // Atualiza o status do envio na venda (se identificável).
        if (v.id) {
          await supabase.from("vendas").update({
            msg_compra_status: status, msg_compra_erro: status === "enviada" ? null : ultimoErro, msg_compra_em: new Date().toISOString(),
          }).eq("id", v.id);
        }
        return json({ success: true, enviados });
      }
      case "recuperacao_processar": {
        // Cron (a cada minuto): processa o fluxo de recuperação dos leads cujo
        // proximo_envio_em já passou e respeitando a janela 7h–22h.
        const agora = new Date();
        if (horaSP(agora) < 7 || horaSP(agora) >= 22) {
          return json({ success: true, enviados: 0, motivo: "fora da janela 7h-22h" });
        }
        const { data: leads } = await supabase.from("recuperacao_leads").select("*")
          .in("status", ["aguardando", "em_fluxo"])
          .not("proximo_envio_em", "is", null)
          .lte("proximo_envio_em", agora.toISOString())
          .order("proximo_envio_em", { ascending: true }).limit(30);

        // Carrega as notificações ativas de recuperação (poucas) uma vez.
        const { data: notifs } = await supabase.from("notificacoes").select("*").eq("ativo", true).eq("gatilho", "recuperacao_venda");
        const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[\s-]/g, "");
        const notifDoLead = (l: any) => (notifs || []).find((n: any) => {
          if (!n.cidade_slug) return true;
          const parts = n.cidade_slug.split(",").map((p: string) => norm(p)).filter(Boolean);
          return parts.some((s: string) => norm(l.cidade || "").includes(s) || norm(l.produto || "").includes(s));
        }) || (notifs || [])[0];

        let enviados = 0;
        for (const l of leads || []) {
          const n = notifDoLead(l);
          if (!n) {
            // Sem notificação de recuperação configurada: encerra o fluxo do lead.
            await supabase.from("recuperacao_leads").update({ status: "fluxo_concluido", proximo_envio_em: null }).eq("id", l.id);
            continue;
          }
          const { data: passos } = await supabase.from("recuperacao_mensagens").select("*")
            .eq("notificacao_id", n.id).eq("ativo", true).order("ordem", { ascending: true });
          const lista = passos || [];
          const atual = lista.find((p: any) => p.ordem === l.proxima_ordem) || lista.find((p: any) => p.ordem >= l.proxima_ordem);
          if (!atual) {
            await supabase.from("recuperacao_leads").update({ status: "fluxo_concluido", proximo_envio_em: null }).eq("id", l.id);
            continue;
          }
          if (!l.telefone) {
            await supabase.from("recuperacao_leads").update({ status: "fluxo_concluido", proximo_envio_em: null }).eq("id", l.id);
            continue;
          }
          const { base: baseT, token: tokenT } = await tokenDe(supabase, cfg, n.instancia);
          const vars = varsDoLead(l);
          const msg = render(atual.mensagem, vars);
          try {
            await enviarTexto(baseT, tokenT, l.telefone, msg);
            await supabase.from("notificacao_logs").insert({ notificacao_id: n.id, destinatario: l.telefone, mensagem: msg, status: "enviado", cidade: l.cidade || null });
            enviados++;
          } catch (e) {
            await supabase.from("notificacao_logs").insert({ notificacao_id: n.id, destinatario: l.telefone, mensagem: msg, status: "erro", erro: String(e), cidade: l.cidade || null });
          }
          // Agenda o próximo passo (se houver), respeitando a janela 7h–22h.
          const proximo = lista.find((p: any) => p.ordem > atual.ordem);
          if (proximo) {
            const quando = proximoHorarioValido(new Date(Date.now() + delayMs(proximo.delay_valor, proximo.delay_unidade)));
            await supabase.from("recuperacao_leads").update({
              status: "em_fluxo", proxima_ordem: proximo.ordem, proximo_envio_em: quando.toISOString(),
            }).eq("id", l.id);
          } else {
            await supabase.from("recuperacao_leads").update({ status: "fluxo_concluido", proximo_envio_em: null }).eq("id", l.id);
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
