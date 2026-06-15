// Edge function: cobranca
// Ações:
//  - processar_lote: processa 1 item pendente do disparo em execução (envia via UAZAPI)
//  - criar_disparo: cria um disparo a partir de uma lista de contatos
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function aplicarVariaveis(tpl: string, contato: { nome?: string | null; telefone: string; dados?: Record<string, any> | null }) {
  const dados = contato.dados || {};
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) => {
    if (key === "nome") return (contato.nome || dados.nome || "") as string;
    if (key === "telefone") return contato.telefone;
    const v = dados[key];
    return v == null ? "" : String(v);
  });
}

async function enviarUazapi(cfg: any, telefone: string, mensagem: string) {
  const url = `${(cfg.server_url || "").replace(/\/$/, "")}/send/text`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      token: cfg.instance_token || "",
    },
    body: JSON.stringify({ number: telefone, text: mensagem }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`UAZAPI ${res.status}: ${text}`);
  return text;
}

async function processarUmItem(supa: any) {
  // Pega o disparo em execução mais recente (ou seta 'em_execucao' o mais antigo pendente)
  let { data: disparo } = await supa
    .from("cobranca_disparos")
    .select("*")
    .eq("status", "em_execucao")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!disparo) {
    const { data: pend } = await supa
      .from("cobranca_disparos")
      .select("*")
      .eq("status", "pendente")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!pend) return { ok: true, skipped: "sem_disparo" };
    await supa
      .from("cobranca_disparos")
      .update({ status: "em_execucao", updated_at: new Date().toISOString() })
      .eq("id", pend.id);
    disparo = pend;
  }

  const { data: item } = await supa
    .from("cobranca_disparo_itens")
    .select("*")
    .eq("disparo_id", disparo.id)
    .eq("status", "pendente")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!item) {
    // Finaliza disparo
    await supa
      .from("cobranca_disparos")
      .update({ status: "concluido", updated_at: new Date().toISOString() })
      .eq("id", disparo.id);
    return { ok: true, finalizado: disparo.id };
  }

  // Marca em_envio para evitar duplicidade entre execuções
  await supa.from("cobranca_disparo_itens").update({ status: "em_envio" }).eq("id", item.id);

  // Carrega config UAZAPI
  const { data: cfg } = await supa
    .from("cobranca_whatsapp_config")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (!cfg || !cfg.server_url || !cfg.instance_token) {
    await supa
      .from("cobranca_disparo_itens")
      .update({ status: "erro", erro: "Config UAZAPI ausente" })
      .eq("id", item.id);
    await supa
      .from("cobranca_disparos")
      .update({ erros: (disparo.erros || 0) + 1, updated_at: new Date().toISOString() })
      .eq("id", disparo.id);
    return { ok: false, erro: "config_ausente" };
  }

  // Carrega contato p/ aplicar variáveis
  const { data: contato } = await supa
    .from("cobranca_contatos")
    .select("*")
    .eq("telefone", item.telefone)
    .maybeSingle();

  const textoFinal = aplicarVariaveis(item.mensagem || "", contato || { telefone: item.telefone, nome: item.nome });

  try {
    await enviarUazapi(cfg, item.telefone, textoFinal);
    const now = new Date().toISOString();
    await supa
      .from("cobranca_disparo_itens")
      .update({ status: "enviado", enviado_em: now, mensagem: textoFinal })
      .eq("id", item.id);
    await supa
      .from("cobranca_disparos")
      .update({ enviados: (disparo.enviados || 0) + 1, updated_at: now })
      .eq("id", disparo.id);
    // Atualiza memória do contato
    if (contato) {
      await supa
        .from("cobranca_contatos")
        .update({
          ultima_ordem_enviada: item.ordem ?? contato.ultima_ordem_enviada,
          ultima_mensagem: textoFinal,
          ultima_enviada_em: now,
          updated_at: now,
        })
        .eq("id", contato.id);
    } else {
      await supa.from("cobranca_contatos").insert({
        telefone: item.telefone,
        nome: item.nome,
        ultima_ordem_enviada: item.ordem,
        ultima_mensagem: textoFinal,
        ultima_enviada_em: now,
      });
    }
    return { ok: true, item_id: item.id };
  } catch (e: any) {
    const now = new Date().toISOString();
    await supa
      .from("cobranca_disparo_itens")
      .update({ status: "erro", erro: String(e?.message || e) })
      .eq("id", item.id);
    await supa
      .from("cobranca_disparos")
      .update({ erros: (disparo.erros || 0) + 1, updated_at: now })
      .eq("id", disparo.id);
    return { ok: false, erro: String(e?.message || e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supa = createClient(SUPABASE_URL, SERVICE_KEY);

  let body: any = {};
  try { body = await req.json(); } catch (_) { body = {}; }
  const action = body?.action || "processar_lote";

  try {
    if (action === "processar_lote") {
      // Processa 3 itens com ~20s entre eles (cron mínimo de 1 min)
      const results: any[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await processarUmItem(supa);
        results.push(r);
        if (r?.skipped === "sem_disparo") break;
        if (i < 2) await new Promise((res) => setTimeout(res, 20_000));
      }
      return json({ ok: true, results });
    }

    if (action === "criar_disparo") {
      const contatos: Array<{ telefone: string; nome?: string; dados?: Record<string, any> }> = body.contatos || [];
      const mensagem_id: string | undefined = body.mensagem_id;
      if (!contatos.length) return json({ error: "contatos vazio" }, 400);

      let mensagemTpl = "";
      let ordem: number | null = null;
      if (mensagem_id) {
        const { data: m } = await supa.from("cobranca_mensagens").select("*").eq("id", mensagem_id).maybeSingle();
        if (!m) return json({ error: "mensagem_id inválido" }, 400);
        mensagemTpl = m.mensagem;
        ordem = m.ordem;
      } else if (body.mensagem) {
        mensagemTpl = body.mensagem;
        ordem = body.ordem ?? null;
      } else {
        return json({ error: "informe mensagem_id ou mensagem" }, 400);
      }

      const { data: disparo, error: e1 } = await supa
        .from("cobranca_disparos")
        .insert({ status: "pendente", total: contatos.length })
        .select()
        .single();
      if (e1) return json({ error: e1.message }, 500);

      const itens = contatos.map((c) => ({
        disparo_id: disparo.id,
        telefone: String(c.telefone).replace(/\D/g, ""),
        nome: c.nome || null,
        mensagem: mensagemTpl,
        ordem,
        status: "pendente",
      }));
      const { error: e2 } = await supa.from("cobranca_disparo_itens").insert(itens);
      if (e2) return json({ error: e2.message }, 500);

      // Upsert contatos (memória)
      for (const c of contatos) {
        const tel = String(c.telefone).replace(/\D/g, "");
        await supa
          .from("cobranca_contatos")
          .upsert(
            { telefone: tel, nome: c.nome || null, dados: c.dados || {}, updated_at: new Date().toISOString() },
            { onConflict: "telefone" }
          );
      }

      return json({ ok: true, disparo_id: disparo.id, total: contatos.length });
    }

    return json({ error: "action desconhecida" }, 400);
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
