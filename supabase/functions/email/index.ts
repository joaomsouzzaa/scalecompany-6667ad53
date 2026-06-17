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
  id: number;
  nome: string | null;
  imap_host: string; imap_port: number;
  smtp_host: string; smtp_port: number;
  username: string; password: string;
  from_name: string | null;
  whatsapp_destino: string | null;
  keywords: string[] | null;
  ativo?: boolean;
};

// Carrega uma conta específica (por id). Usado por test_connection/send_reply.
async function getConfigById(sb: ReturnType<typeof createClient>, id: number): Promise<EmailConfig> {
  const { data, error } = await sb.from("email_config").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data || !data.username || !data.password) {
    throw new Error("conta de e-mail não configurada (preencha host/porta/usuário/senha)");
  }
  return data as EmailConfig;
}

// Lista todas as contas ativas e configuradas. Usado pelo cron/fetch geral.
async function listActiveConfigs(sb: ReturnType<typeof createClient>): Promise<EmailConfig[]> {
  const { data, error } = await sb.from("email_config").select("*").eq("ativo", true);
  if (error) throw error;
  return ((data || []) as EmailConfig[]).filter((c) => c.username && c.password);
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
  // Grava uma mensagem (raw RFC822) numa pasta — usado p/ registrar a resposta
  // na pasta Enviados (SMTP sozinho não faz isso).
  async append(mailbox: string, raw: string): Promise<void> {
    const bytes = this.enc.encode(raw);
    const tag = `A${++this.tagN}`;
    await this.conn.write(this.enc.encode(`${tag} APPEND ${JSON.stringify(mailbox)} (\\Seen) {${bytes.length}}\r\n`));
    const cont = await this.readUntilLine();
    if (!cont.startsWith("+")) throw new Error("APPEND não aceito: " + cont);
    await this.conn.write(bytes);
    await this.conn.write(this.enc.encode("\r\n"));
    while (true) {
      const l = await this.readUntilLine();
      if (l.startsWith(`${tag} `)) {
        if (/^A\d+ (NO|BAD)/.test(l)) throw new Error(l.replace(/^A\d+ (NO|BAD)\s*/, "") || "Erro APPEND");
        return;
      }
    }
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
// Rodapé fixo de toda resposta: link de WhatsApp (mensagem pré-carregada) +
// assinatura. Anexado em código para garantir presença (não depende da IA).
const WHATSAPP_ATENDIMENTO = "5511939412899";
const WHATSAPP_TEXTO = "Oi, recebi o retorno do e-mail e preciso realizar o cancelamento e reembolso da minha compra.";
const WHATSAPP_LINK = `https://wa.me/${WHATSAPP_ATENDIMENTO}?text=${encodeURIComponent(WHATSAPP_TEXTO)}`;
const ASSINATURA = "Att. João Souza\nTime de Eventos Raphael Mattos";
const RODAPE = `\n\nSe preferir, agilize pelo WhatsApp: ${WHATSAPP_LINK}\n\n${ASSINATURA}`;

async function generateDraft(subject: string, body: string): Promise<string> {
  const corpo = await aiChat(
    "Você escreve rascunhos de resposta de e-mail para o atendimento de eventos (Raphael Mattos), em português, cordiais, claros e diretos. " +
    "REGRAS OBRIGATÓRIAS: (1) comece com uma saudação (ex.: 'Olá, tudo bem?'). " +
    "(2) Para localizar o pedido, solicite APENAS três informações: número do pedido, nome completo e e-mail usado na compra. " +
    "(3) Não prometa nem confirme cancelamento/reembolso/valores; diga que, com esses dados, seguiremos com a solicitação. " +
    "(4) NÃO inclua assinatura nem despedida (isso é adicionado depois). Devolva apenas o corpo, sem assunto.",
    `Assunto: ${subject}\n\nMensagem recebida:\n${body}\n\nEscreva o corpo da resposta seguindo as regras.`,
  );
  if (!corpo) return "";
  return corpo.trimEnd() + RODAPE;
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

// Monta a mensagem RFC822 da resposta para gravar na pasta Enviados.
function buildRawSent(cfg: EmailConfig, msg: any, subject: string, reply: string): string {
  const from = cfg.from_name ? `${cfg.from_name} <${cfg.username}>` : cfg.username;
  const dominio = (cfg.username.split("@")[1] || "local").trim();
  const date = new Date().toUTCString().replace("GMT", "+0000");
  const html = reply.replace(/\n/g, "<br>");
  const headers = [
    `From: ${from}`,
    `To: ${msg.from_email}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: <${crypto.randomUUID()}@${dominio}>`,
    msg.message_id ? `In-Reply-To: <${msg.message_id}>` : "",
    msg.message_id ? `References: <${msg.message_id}>` : "",
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
  ].filter(Boolean).join("\r\n");
  return headers + "\r\n\r\n" + html.replace(/\r?\n/g, "\r\n");
}

// Grava a resposta na pasta Enviados, tentando os nomes mais comuns do cPanel/Dovecot.
async function gravarEnviados(cfg: EmailConfig, raw: string) {
  const imap = new ImapClient(cfg.imap_host, cfg.imap_port || 993);
  try {
    await imap.connect();
    await imap.login(cfg.username, cfg.password);
    const pastas = ["INBOX.Sent", "Sent", "INBOX.Sent Items", "Sent Items", "INBOX.Enviados", "Enviados"];
    for (const p of pastas) {
      try { await imap.append(p, raw); return; } catch { /* tenta a próxima */ }
    }
    throw new Error("nenhuma pasta de Enviados aceitou o APPEND");
  } finally {
    imap.close();
  }
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

// Varre uma conta: últimas 72h, dedup, filtro por keywords, resumo+rascunho,
// insere os novos e dispara o relatório no WhatsApp dessa conta.
async function processFetch(sb: ReturnType<typeof createClient>, cfg: EmailConfig) {
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
    const messageId = (h["message-id"] || "").replace(/[<>]/g, "").trim() || `uid-${cfg.id}-${uid}`;
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
      email_config_id: cfg.id,
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
    const conta = cfg.nome || cfg.username;
    const linhas = novos.map((e, i) =>
      `*${i + 1}. ${e.from_name || e.from_email}*${e.categoria ? ` _(${e.categoria})_` : ""}\n📨 ${e.subject}\n📝 ${e.resumo || "(sem resumo)"}`,
    );
    const texto = `📧 *Relatório de E-mails — ${conta} (últimas 72h)*\n${novos.length} novo(s) e-mail(s) relevante(s):\n\n${linhas.join("\n\n")}\n\n_Revise e responda em Eventos → E-mail._`;
    try { await enviarWhatsapp(sb, cfg.whatsapp_destino, texto); } catch (e) { console.error("[email] WhatsApp falhou:", (e as any)?.message || e); }
  }

  await sb.from("email_config").update({ ultima_execucao: new Date().toISOString() }).eq("id", cfg.id);
  return { inserted, skipped, filtered };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  let action = "";
  let payload: any = {};
  try { payload = await req.json().catch(() => ({})); action = String(payload.action || ""); } catch {}

  try {
    if (action === "test_connection") {
      if (!payload.id) return json({ error: "id da conta obrigatório" }, 400);
      const cfg = await getConfigById(sb, Number(payload.id));
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
      // Com id: varre só aquela conta. Sem id (cron): todas as contas ativas.
      if (payload.id) {
        const cfg = await getConfigById(sb, Number(payload.id));
        const r = await processFetch(sb, cfg);
        return json({ ok: true, contas: 1, ...r });
      }
      const cfgs = await listActiveConfigs(sb);
      let inserted = 0, skipped = 0, filtered = 0;
      const erros: string[] = [];
      for (const cfg of cfgs) {
        try {
          const r = await processFetch(sb, cfg);
          inserted += r.inserted; skipped += r.skipped; filtered += r.filtered;
        } catch (e) {
          erros.push(`${cfg.nome || cfg.username}: ${(e as any)?.message || e}`);
        }
      }
      return json({ ok: true, contas: cfgs.length, inserted, skipped, filtered, erros });
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
      const cfg = await getConfigById(sb, Number((msg as any).email_config_id) || 1);
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
      // Registra a resposta na pasta Enviados do webmail (SMTP não faz isso).
      try { await gravarEnviados(cfg, buildRawSent(cfg, msg, subject, reply)); } catch (e) { console.error("[email] gravar Enviados falhou:", (e as any)?.message || e); }
      await sb.from("email_mensagens").update({ status: "respondido", replied_at: new Date().toISOString(), draft_reply: reply }).eq("id", id);
      return json({ ok: true });
    }

    return json({ error: "ação inválida (use: test_connection, fetch_emails, regenerate_draft, send_reply)" }, 400);
  } catch (e: any) {
    console.error("[email] erro:", e?.message || e);
    return json({ error: e?.message || String(e) }, 500);
  }
});
