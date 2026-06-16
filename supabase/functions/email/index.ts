// Edge function: email
// Actions: test_connection, fetch_emails, regenerate_draft, send_reply
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

async function getConfig(sb: ReturnType<typeof createClient>) {
  const { data, error } = await sb.from("email_config").select("*").eq("id", 1).maybeSingle();
  if (error) throw error;
  if (!data || !data.username || !data.password) {
    throw new Error("email_config não configurado (preencha host/porta/usuário/senha)");
  }
  return data as {
    imap_host: string; imap_port: number;
    smtp_host: string; smtp_port: number;
    username: string; password: string;
    from_name: string | null;
  };
}

async function openImap(cfg: Awaited<ReturnType<typeof getConfig>>) {
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

async function openSmtp(cfg: Awaited<ReturnType<typeof getConfig>>) {
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

async function generateDraft(subject: string, body: string): Promise<string> {
  if (!LOVABLE_API_KEY) return "";
  try {
    const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${LOVABLE_API_KEY}` },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "Você é um assistente que escreve rascunhos de resposta de e-mail em português, educados, claros e diretos. Devolva apenas o corpo da resposta, sem assinatura nem assunto." },
          { role: "user", content: `Assunto: ${subject}\n\nMensagem recebida:\n${body}\n\nEscreva um rascunho de resposta.` },
        ],
      }),
    });
    if (!r.ok) return "";
    const j = await r.json();
    return j?.choices?.[0]?.message?.content?.trim() ?? "";
  } catch { return ""; }
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
      const imap = await openImap(cfg);
      let inserted = 0, skipped = 0;
      const mb = await imap.getMailboxLock("INBOX");
      try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        for await (const msg of imap.fetch({ since }, { envelope: true, source: true, uid: true })) {
          const env: any = msg.envelope;
          const messageId: string = env?.messageId || `uid-${msg.uid}`;
          const { data: exists } = await sb.from("email_mensagens").select("id").eq("message_id", messageId).maybeSingle();
          if (exists) { skipped++; continue; }
          const from = env?.from?.[0];
          const to = env?.to?.[0];
          const subject = env?.subject || "(sem assunto)";
          const bodyText = msg.source ? new TextDecoder().decode(msg.source) : "";
          // Try to extract plain text body roughly
          let body = bodyText;
          const ix = bodyText.indexOf("\r\n\r\n");
          if (ix > -1) body = bodyText.slice(ix + 4);
          body = body.slice(0, 20000);
          const draft = await generateDraft(subject, body);
          await sb.from("email_mensagens").insert({
            message_id: messageId,
            from_email: from?.address ?? null,
            from_name: from?.name ?? null,
            to_email: to?.address ?? cfg.username,
            subject,
            body,
            received_at: env?.date ?? new Date().toISOString(),
            draft_reply: draft,
            status: "novo",
          });
          inserted++;
        }
      } finally { mb.release(); }
      await imap.logout();
      return json({ ok: true, inserted, skipped });
    }

    if (action === "regenerate_draft") {
      const id = payload.id as string;
      if (!id) return json({ error: "id obrigatório" }, 400);
      const { data: msg, error } = await sb.from("email_mensagens").select("*").eq("id", id).maybeSingle();
      if (error || !msg) return json({ error: "mensagem não encontrada" }, 404);
      const draft = await generateDraft(msg.subject ?? "", msg.body ?? "");
      await sb.from("email_mensagens").update({ draft_reply: draft }).eq("id", id);
      return json({ ok: true, draft });
    }

    if (action === "send_reply") {
      const id = payload.id as string;
      const reply = String(payload.reply ?? "");
      if (!id || !reply) return json({ error: "id e reply são obrigatórios" }, 400);
      const { data: msg, error } = await sb.from("email_mensagens").select("*").eq("id", id).maybeSingle();
      if (error || !msg) return json({ error: "mensagem não encontrada" }, 404);
      const cfg = await getConfig(sb);
      const smtp = await openSmtp(cfg);
      const subject = msg.subject?.startsWith("Re:") ? msg.subject : `Re: ${msg.subject ?? ""}`;
      await smtp.send({
        from: cfg.from_name ? `${cfg.from_name} <${cfg.username}>` : cfg.username,
        to: msg.from_email,
        subject,
        content: reply,
        html: reply.replace(/\n/g, "<br>"),
        inReplyTo: msg.message_id ?? undefined,
      });
      await smtp.close();
      await sb.from("email_mensagens").update({ status: "respondido", replied_at: new Date().toISOString() }).eq("id", id);
      return json({ ok: true });
    }

    return json({ error: "ação inválida (use: test_connection, fetch_emails, regenerate_draft, send_reply)" }, 400);
  } catch (e: any) {
    console.error("[email] erro:", e?.message || e);
    return json({ error: e?.message || String(e) }, 500);
  }
});
