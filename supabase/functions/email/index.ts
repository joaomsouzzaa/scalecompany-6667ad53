// Edge function: email
// Actions: test_connection, fetch_emails, regenerate_draft, send_reply
//
// IMAP: cliente nativo sobre Deno.connectTls (a lib imapflow NÃO funciona no
// runtime do Supabase Edge — depende de sockets do Node e estoura no teardown).
// SMTP: denomailer (Deno-native, funciona). IA: Lovable AI Gateway (Gemini).
// Extras: janela 72h, filtro por palavras-chave, resumo por e-mail e relatório
// no WhatsApp (UAZAPI, reusa whatsapp_config).
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "npm:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

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

// ===================================================================
// Cliente IMAP mínimo sobre Deno.connectTls (sem dependências). Subset:
// LOGIN, SELECT, UID SEARCH SINCE, UID FETCH (headers + texto).
// ===================================================================
class ImapClient {
  private conn!: Deno.TlsConn;
  private buf = new Uint8Array(0);
  private dec = new TextDecoder();
  private enc = new TextEncoder();
  private tagN = 0;

  constructor(private host: string, private port: number) {}

  async connect() {
    this.conn = await Deno.connectTls({ hostname: this.host, port: this.port });
    await this.readUntilLine(); // saudação do servidor (* OK ...)
  }
  close() { try { this.conn?.close(); } catch { /* ignore */ } }

  private async fill(): Promise<boolean> {
    const tmp = new Uint8Array(65536);
    const n = await this.conn.read(tmp);
    if (n === null) return false;
    const merged = new Uint8Array(this.buf.length + n);
    merged.set(this.buf, 0);
    merged.set(tmp.subarray(0, n), this.buf.length);
    this.buf = merged;
    return true;
  }
  private async readUntilLine(): Promise<string> {
    while (true) {
      const idx = this.buf.indexOf(13);
      if (idx >= 0 && this.buf[idx + 1] === 10) {
        const line = this.dec.decode(this.buf.subarray(0, idx));
        this.buf = this.buf.subarray(idx + 2);
        return line;
      }
      if (!(await this.fill())) throw new Error("Conexão IMAP encerrada");
    }
  }
  private async readN(n: number): Promise<string> {
    while (this.buf.length < n) {
      if (!(await this.fill())) throw new Error("Conexão IMAP encerrada");
    }
    const out = this.dec.decode(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }
  private async command(cmd: string): Promise<string> {
    const tag = `A${++this.tagN}`;
    await this.conn.write(this.enc.encode(`${tag} ${cmd}\r\n`));
    let acc = "";
    while (true) {
      const line = await this.readUntilLine();
      const litMatch = line.match(/\{(\d+)\}$/);
      if (litMatch) {
        const len = parseInt(litMatch[1], 10);
        const literal = await this.readN(len);
        acc += line + "\r\n" + literal;
        continue;
      }
      acc += line + "\r\n";
      if (line.startsWith(`${tag} `)) {
        if (/^A\d+ (NO|BAD)/.test(line)) throw new Error(line.replace(/^A\d+ (NO|BAD)\s*/, "") || "Erro IMAP");
        return acc;
      }
    }
  }
  async login(user: string, pass: string) {
    const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    await this.command(`LOGIN ${q(user)} ${q(pass)}`);
  }
  async selectInbox() { await this.command("SELECT INBOX"); }
  async searchSince(date: Date): Promise<number[]> {
    const dd = String(date.getUTCDate()).padStart(2, "0");
    const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][date.getUTCMonth()];
    const res = await this.command(`UID SEARCH SINCE ${dd}-${mon}-${date.getUTCFullYear()}`);
    const m = res.match(/\*\s+SEARCH([^\r\n]*)/i);
    if (!m) return [];
    return m[1].trim().split(/\s+/).filter(Boolean).map(Number).filter((n) => !isNaN(n));
  }
  async fetchMessage(uid: number): Promise<{ headers: string; body: string }> {
    const res = await this.command(
      `UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID IN-REPLY-TO REFERENCES)] BODY.PEEK[TEXT])`,
    );
    const parts = res.split(/BODY\[/i).slice(1);
    let headers = "", body = "";
    for (const p of parts) {
      if (/^HEADER/i.test(p)) headers = afterLiteral(p);
      else if (/^TEXT/i.test(p)) body = afterLiteral(p);
    }
    return { headers, body };
  }
}

function afterLiteral(frag: string): string {
  const i = frag.indexOf("\r\n");
  return i >= 0 ? frag.slice(i + 2) : frag;
}

function decodeMime(s: string): string {
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, _cs, enc, txt) => {
    try {
      if (enc.toLowerCase() === "b") return new TextDecoder().decode(Uint8Array.from(atob(txt), (c) => c.charCodeAt(0)));
      return txt.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m: string, h: string) => String.fromCharCode(parseInt(h, 16)));
    } catch { return txt; }
  });
}
function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = raw.replace(/\r\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r\n/)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) out[m[1].toLowerCase()] = decodeMime(m[2].trim());
  }
  return out;
}
function parseFrom(from: string): { email: string; nome: string } {
  const m = from.match(/^(.*?)<([^>]+)>/);
  if (m) return { nome: m[1].replace(/["']/g, "").trim(), email: m[2].trim() };
  return { nome: "", email: from.trim() };
}
function cleanBody(raw: string): string {
  let t = raw.replace(/=\r\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  t = t.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  t = t.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
  t = t.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  return t.slice(0, 20000);
}

async function openSmtp(cfg: EmailConfig) {
  const port = cfg.smtp_port || 465;
  return new SMTPClient({
    connection: { hostname: cfg.smtp_host, port, tls: port === 465, auth: { username: cfg.username, password: cfg.password } },
  });
}

async function aiChat(system: string, user: string): Promise<string> {
  if (!LOVABLE_API_KEY) return "";
  try {
    const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${LOVABLE_API_KEY}` },
      body: JSON.stringify({ model: "google/gemini-2.5-flash", messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
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

function norm(s: string): string { return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); }
function matchKeyword(texto: string, keywords: string[]): string | null {
  const t = norm(texto);
  for (const k of keywords) { const kn = norm(k); if (kn && t.includes(kn)) return k; }
  return null;
}

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
  try { payload = await req.json().catch(() => ({})); action = String(payload.action || ""); } catch {}

  try {
    if (action === "test_connection") {
      const cfg = await getConfig(sb);
      // Testa só o IMAP (login + seleção da caixa). O denomailer conecta o SMTP
      // de forma preguiçosa (só no 1º envio), então chamar smtp.close() aqui sem
      // ter enviado acessa uma conexão undefined → "reading 'close'". O SMTP é
      // validado de verdade ao responder o primeiro e-mail.
      const imap = new ImapClient(cfg.imap_host, cfg.imap_port || 993);
      try {
        await imap.connect();
        await imap.login(cfg.username, cfg.password);
        await imap.selectInbox();
      } finally {
        imap.close();
      }
      return json({ ok: true, message: "Conexão IMAP OK (login bem-sucedido)" });
    }

    if (action === "fetch_emails") {
      const cfg = await getConfig(sb);
      const keywords = (cfg.keywords && cfg.keywords.length ? cfg.keywords : []) as string[];
      const desde = new Date(Date.now() - 72 * 60 * 60 * 1000);

      const imap = new ImapClient(cfg.imap_host, cfg.imap_port || 993);
      await imap.connect();
      await imap.login(cfg.username, cfg.password);
      await imap.selectInbox();
      const uids = await imap.searchSince(desde);

      let inserted = 0, skipped = 0, filtered = 0;
      const novos: any[] = [];
      for (const uid of uids) {
        let headers = "", rawBody = "";
        try { ({ headers, body: rawBody } = await imap.fetchMessage(uid)); } catch { continue; }
        const h = parseHeaders(headers);
        const messageId = (h["message-id"] || "").replace(/[<>]/g, "").trim() || `uid-${uid}`;
        const { data: exists } = await sb.from("email_mensagens").select("id").eq("message_id", messageId).maybeSingle();
        if (exists) { skipped++; continue; }

        const recebido = h["date"] ? new Date(h["date"]) : null;
        if (recebido && recebido.getTime() < desde.getTime()) { skipped++; continue; }

        const subject = h["subject"] || "(sem assunto)";
        const body = cleanBody(rawBody);
        const categoria = keywords.length ? matchKeyword(`${subject}\n${body}`, keywords) : "(sem filtro)";
        if (!categoria) { filtered++; continue; }

        const { email, nome } = parseFrom(h["from"] || "");
        const resumo = await generateResumo(subject, body);
        const draft = await generateDraft(subject, body);
        const { data: row } = await sb.from("email_mensagens").insert({
          message_id: messageId,
          from_email: email || null,
          from_name: nome || null,
          to_email: cfg.username,
          subject,
          body,
          received_at: recebido ? recebido.toISOString() : new Date().toISOString(),
          resumo,
          categoria: categoria === "(sem filtro)" ? null : categoria,
          draft_reply: draft,
          status: "novo",
        }).select("*").maybeSingle();
        if (row) novos.push(row);
        inserted++;
      }
      imap.close();

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
