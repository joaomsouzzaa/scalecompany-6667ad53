// Edge function: email
// Actions: test_connection, fetch_emails, regenerate_draft, send_reply
// Base: implementação do Lovable (imapflow + Lovable AI Gateway).
// Acréscimos: janela de 72h, filtro por palavras-chave, resumo por e-mail e
// relatório diário no WhatsApp (UAZAPI, reusa whatsapp_config).
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";
import { ImapFlow } from "npm:imapflow@1.0.164";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type EmailConfig = {
  imap_host: string; imap_port: number;
  smtp_host: string; smtp_port: number;
  username: string; password: string;
  from_name: string | null;
  whatsapp_destino: string | null;
  keywords: string[] | null;
};

async function getConfig(sb: ReturnType<typeof createClient>): Promise<EmailConfig> {
  const { data, error } = await sb.from("email_config").select("*").eq("id", 1).maybeSingle();
  if (error) throw error;
  if (!data || !data.username || !data.password) {
    throw new Error("email_config não configurado (preencha host/porta/usuário/senha)");
  }
  return data as EmailConfig;
}

async function openImap(cfg: EmailConfig) {
  const client = new ImapFlow({
    host: cfg.imap_host,
    port: cfg.imap_port || 993,
    secure: true,
    auth: { user: cfg.username, pass: cfg.password },
    logger: false,
  });
  await client.connect();
  return client;
}

async function openSmtp(cfg: EmailConfig) {
  const port = cfg.smtp_port || 465;
  return new SMTPClient({
    connection: {
      hostname: cfg.smtp_host,
      port,
      tls: port === 465,
      auth: { username: cfg.username, password: cfg.password },
    },
  });
}

// Chamada genérica ao Lovable AI Gateway (Gemini) — usada para resumo e rascunho.
async function aiChat(system: string, user: string): Promise<string> {
  if (!LOVABLE_API_KEY) return "";
  try {
    const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${LOVABLE_API_KEY}` },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    if (!r.ok) return "";
    const j = await r.json();
    return j?.choices?.[0]?.message?.content?.trim() ?? "";
  } catch { return ""; }
}

function generateDraft(subject: string, body: string): Promise<string> {
  return aiChat(
    "Você é um assistente que escreve rascunhos de resposta de e-mail em português, educados, claros e diretos. Devolva apenas o corpo da resposta, sem assinatura nem assunto. Não invente dados (valores, datas, reembolsos aprovados); onde faltar informação use [colchetes].",
    `Assunto: ${subject}\n\nMensagem recebida:\n${body}\n\nEscreva um rascunho de resposta.`,
  );
}

function generateResumo(subject: string, body: string): Promise<string> {
  return aiChat(
    "Resuma o e-mail do cliente em 1 frase curta em português, dizendo do que se trata e o que ele solicita. Responda apenas com o resumo, sem prefixos.",
    `Assunto: ${subject}\n\nMensagem:\n${body}`,
  );
}

// Normaliza para comparação (minúsculas, sem acento).
function norm(s: string): string {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function matchKeyword(texto: string, keywords: string[]): string | null {
  const t = norm(texto);
  for (const k of keywords) {
    const kn = norm(k);
    if (kn && t.includes(kn)) return k;
  }
  return null;
}

// Envia mensagem via UAZAPI reusando a config das Notificações (whatsapp_config).
async function enviarWhatsapp(sb: ReturnType<typeof createClient>, destino: string, mensagem: string) {
  const { data: cfg } = await sb.from("whatsapp_config").select("*").maybeSingle();
  const base = ((cfg as any)?.server_url || "").replace(/\/$/, "");
  const token = (cfg as any)?.admin_token;
  if (!base || !token) throw new Error("WhatsApp (UAZAPI) não configurado");
  const res = await fetch(`${base}/send/text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", token, admintoken: token },
    body: JSON.stringify({ number: destino, text: mensagem }),
  });
  if (!res.ok) throw new Error(`UAZAPI ${res.status}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  let action = "";
  let payload: any = {};
  try {
    payload = await req.json().catch(() => ({}));
    action = String(payload.action || "");
  } catch {}

  try {
    if (action === "test_connection") {
      const cfg = await getConfig(sb);
      const imap = await openImap(cfg);
      const mb = await imap.getMailboxLock("INBOX");
      try { /* opened ok */ } finally { mb.release(); }
      await imap.logout();
      const smtp = await openSmtp(cfg);
      await smtp.close();
      return json({ ok: true, message: "IMAP e SMTP conectaram com sucesso" });
    }

    if (action === "fetch_emails") {
      const cfg = await getConfig(sb);
      const keywords = (cfg.keywords && cfg.keywords.length ? cfg.keywords : []) as string[];
      const imap = await openImap(cfg);
      let inserted = 0, skipped = 0, filtered = 0;
      const novos: any[] = [];
      const mb = await imap.getMailboxLock("INBOX");
      try {
        // Janela de 72h (SINCE é por dia; refinamos por data abaixo).
        const desde = new Date(Date.now() - 72 * 60 * 60 * 1000);
        for await (const msg of imap.fetch({ since: desde }, { envelope: true, source: true, uid: true })) {
          const env: any = msg.envelope;
          const messageId: string = env?.messageId || `uid-${msg.uid}`;
          const { data: exists } = await sb.from("email_mensagens").select("id").eq("message_id", messageId).maybeSingle();
          if (exists) { skipped++; continue; }

          const recebido = env?.date ? new Date(env.date) : null;
          if (recebido && recebido.getTime() < desde.getTime()) { skipped++; continue; }

          const from = env?.from?.[0];
          const to = env?.to?.[0];
          const subject = env?.subject || "(sem assunto)";
          const bodyText = msg.source ? new TextDecoder().decode(msg.source) : "";
          let body = bodyText;
          const ix = bodyText.indexOf("\r\n\r\n");
          if (ix > -1) body = bodyText.slice(ix + 4);
          body = body.slice(0, 20000);

          // Filtro por palavras-chave (assunto + corpo).
          const categoria = keywords.length ? matchKeyword(`${subject}\n${body}`, keywords) : "(sem filtro)";
          if (!categoria) { filtered++; continue; }

          const resumo = await generateResumo(subject, body);
          const draft = await generateDraft(subject, body);
          const { data: row } = await sb.from("email_mensagens").insert({
            message_id: messageId,
            from_email: from?.address ?? null,
            from_name: from?.name ?? null,
            to_email: to?.address ?? cfg.username,
            subject,
            body,
            received_at: env?.date ?? new Date().toISOString(),
            resumo,
            categoria: categoria === "(sem filtro)" ? null : categoria,
            draft_reply: draft,
            status: "novo",
          }).select("*").maybeSingle();
          if (row) novos.push(row);
          inserted++;
        }
      } finally { mb.release(); }
      await imap.logout();

      // Relatório no WhatsApp
      if (novos.length > 0 && cfg.whatsapp_destino) {
        const linhas = novos.map((e, i) =>
          `*${i + 1}. ${e.from_name || e.from_email}*${e.categoria ? ` _(${e.categoria})_` : ""}\n📨 ${e.subject}\n📝 ${e.resumo || "(sem resumo)"}`,
        );
        const texto = `📧 *Relatório de E-mails (últimas 72h)*\n${novos.length} novo(s) e-mail(s) relevante(s):\n\n${linhas.join("\n\n")}\n\n_Revise e responda em Eventos → E-mail._`;
        try { await enviarWhatsapp(sb, cfg.whatsapp_destino, texto); } catch (e) { console.error("[email] WhatsApp falhou:", (e as any)?.message || e); }
      }

      await sb.from("email_config").update({ ultima_execucao: new Date().toISOString() }).eq("id", 1);
      return json({ ok: true, inserted, skipped, filtered });
    }

    if (action === "regenerate_draft") {
      const id = payload.id as string;
      if (!id) return json({ error: "id obrigatório" }, 400);
      const { data: msg, error } = await sb.from("email_mensagens").select("*").eq("id", id).maybeSingle();
      if (error || !msg) return json({ error: "mensagem não encontrada" }, 404);
      const resumo = await generateResumo((msg as any).subject ?? "", (msg as any).body ?? "");
      const draft = await generateDraft((msg as any).subject ?? "", (msg as any).body ?? "");
      await sb.from("email_mensagens").update({ resumo, draft_reply: draft }).eq("id", id);
      return json({ ok: true, resumo, draft });
    }

    if (action === "send_reply") {
      const id = payload.id as string;
      const reply = String(payload.reply ?? "");
      if (!id || !reply) return json({ error: "id e reply são obrigatórios" }, 400);
      const { data: msg, error } = await sb.from("email_mensagens").select("*").eq("id", id).maybeSingle();
      if (error || !msg) return json({ error: "mensagem não encontrada" }, 404);
      const cfg = await getConfig(sb);
      const smtp = await openSmtp(cfg);
      const subject = (msg as any).subject?.startsWith("Re:") ? (msg as any).subject : `Re: ${(msg as any).subject ?? ""}`;
      await smtp.send({
        from: cfg.from_name ? `${cfg.from_name} <${cfg.username}>` : cfg.username,
        to: (msg as any).from_email,
        subject,
        content: reply,
        html: reply.replace(/\n/g, "<br>"),
        inReplyTo: (msg as any).message_id ?? undefined,
      });
      await smtp.close();
      await sb.from("email_mensagens").update({ status: "respondido", replied_at: new Date().toISOString(), draft_reply: reply }).eq("id", id);
      return json({ ok: true });
    }

    return json({ error: "ação inválida (use: test_connection, fetch_emails, regenerate_draft, send_reply)" }, 400);
  } catch (e: any) {
    console.error("[email] erro:", e?.message || e);
    return json({ error: e?.message || String(e) }, 500);
  }
});
