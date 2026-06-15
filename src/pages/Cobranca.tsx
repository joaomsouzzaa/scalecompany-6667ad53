import { useState, useEffect, useCallback, useRef } from "react";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  CreditCard, Plus, Pencil, Trash2, Wifi, WifiOff, RefreshCw, QrCode, Eye, EyeOff,
  LogOut, Upload, Send,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// ===================================================================
// Parser de CSV (mesmo padrão de VendasEventos: autodetecta delimitador,
// respeita aspas). Aqui mantemos TODAS as colunas do CSV (o espelho mostra
// os dados crus + colunas de cadência ao lado).
// ===================================================================
function stripAccentsLower(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

// Colunas que reconhecemos como telefone / nome (para identidade e {{nome}}).
const TEL_KEYS = ["telefone", "celular", "whatsapp", "fone", "telefone_comprador", "contato"];
const NOME_KEYS = ["nome", "cliente", "comprador", "nome_comprador", "razao_social"];

function parseCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === delim) { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

type CsvParsed = { headers: string[]; rows: Record<string, string>[] };

function parseCsv(text: string): CsvParsed {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) return { headers: [], rows: [] };
  const delim = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ";" : ",";
  const headers = parseCsvLine(lines[0], delim);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i], delim);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = cells[idx] ?? ""; });
    rows.push(row);
  }
  return { headers, rows };
}

function findKey(headers: string[], candidates: string[]): string | null {
  for (const h of headers) if (candidates.includes(stripAccentsLower(h))) return h;
  return null;
}

const normTelefone = (s: string) => (s || "").replace(/\D/g, "");

type Mensagem = { id: string; ordem: number; nome: string; mensagem: string; ativo: boolean };

type EspelhoLinha = {
  telefone: string;
  nome: string;
  dados: Record<string, unknown>;
  ultima_ordem_enviada: number;
  ultima_mensagem: string | null;
  proxima_ordem: number | null;
  proxima_mensagem_nome: string | null;
  proxima_mensagem: string | null;
  tem_proxima: boolean;
  _selecionado: boolean;
  _raw: Record<string, string>;
};

const emptyMsg = { ordem: 1, nome: "", mensagem: "", ativo: true };

export default function Cobranca() {
  // ---- Conexão WhatsApp (UAZAPI — instância exclusiva da Cobrança) ----
  const [cfg, setCfg] = useState({ server_url: "", admin_token: "", instance: "" });
  const [cfgStatus, setCfgStatus] = useState<string>("desconectado");
  const [connecting, setConnecting] = useState(false);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [numeroConectado, setNumeroConectado] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [tokenSalvo, setTokenSalvo] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [desconectando, setDesconectando] = useState(false);
  const isConnected = cfgStatus === "connected" || cfgStatus === "conectado";

  useEffect(() => {
    (supabase as any).from("cobranca_whatsapp_config").select("server_url,instance,status,numero").maybeSingle().then(({ data }: any) => {
      if (data) {
        setCfg({ server_url: data.server_url || "", admin_token: "", instance: data.instance || "" });
        setCfgStatus(data.status || "desconectado");
        setNumeroConectado(data.numero || null);
        setTokenSalvo(!!data.server_url);
      }
    });
  }, []);

  const salvarConfig = async () => {
    const { data: existing } = await (supabase as any).from("cobranca_whatsapp_config").select("id").maybeSingle();
    const patch: Record<string, unknown> = {
      server_url: cfg.server_url.replace(/\/$/, ""),
      instance: cfg.instance,
    };
    if (cfg.admin_token) patch.admin_token = cfg.admin_token;
    const res = existing
      ? await (supabase as any).from("cobranca_whatsapp_config").update(patch).eq("id", existing.id)
      : await (supabase as any).from("cobranca_whatsapp_config").insert(patch);
    if (res.error) { toast.error("Erro ao salvar configuração"); return; }
    toast.success("Configuração salva");
  };

  const chamar = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    const { data, error } = await supabase.functions.invoke("cobranca", { body: { action, ...payload } });
    if (error) {
      let msg = error.message;
      try { const ctx = (error as any).context; if (ctx?.json) { const b = await ctx.json(); if (b?.error) msg = b.error; } } catch { /* ignore */ }
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }, []);

  const refreshStatus = useCallback(async (silent = false): Promise<boolean> => {
    if (!silent) setLoadingStatus(true);
    try {
      const data = await chamar("status");
      const connected = data?.status === "connected" || data?.connected;
      setCfgStatus(data?.status || "desconectado");
      setNumeroConectado(data?.numero || null);
      if (connected) { setQrCode(null); if (!silent) toast.success("Conectado!"); }
      else if (data?.qrcode) setQrCode(data.qrcode);
      return !!connected;
    } catch (e: any) {
      if (!silent) toast.error(e?.message || "Falha ao consultar status");
      else setCfgStatus("erro");
      return false;
    } finally {
      if (!silent) setLoadingStatus(false);
    }
  }, [chamar]);

  const pollUntilConnected = useCallback(() => {
    let tries = 0;
    const id = setInterval(async () => {
      tries++;
      const ok = await refreshStatus(true);
      if (ok || tries >= 20) clearInterval(id);
    }, 3000);
  }, [refreshStatus]);

  const conectar = async () => {
    setConnecting(true);
    setQrCode(null);
    try {
      await salvarConfig();
      const data = await chamar("connect");
      if (data?.qrcode) setQrCode(data.qrcode);
      if (data?.status) setCfgStatus(data.status);
      toast.success("Escaneie o QR Code no WhatsApp");
      pollUntilConnected();
    } catch (e: any) {
      toast.error(e?.message || "Falha ao conectar. Confira URL e token.");
    } finally {
      setConnecting(false);
    }
  };

  const desconectar = async () => {
    if (!confirm("Desconectar o WhatsApp da Cobrança? Você precisará escanear o QR Code de novo.")) return;
    setDesconectando(true);
    try {
      await chamar("disconnect");
      setQrCode(null); setNumeroConectado(null); setCfgStatus("desconectado");
      toast.success("WhatsApp desconectado.");
    } catch (e: any) {
      toast.error(e?.message || "Falha ao desconectar");
    } finally {
      setDesconectando(false);
    }
  };

  // Auto-poll do status (a cada 30s)
  useEffect(() => {
    refreshStatus(true);
    const id = setInterval(() => refreshStatus(true), 30000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  // ---- Banco de mensagens (cadência) ----
  const [mensagens, setMensagens] = useState<Mensagem[]>([]);
  const carregarMensagens = useCallback(async () => {
    const { data } = await (supabase as any).from("cobranca_mensagens").select("*").order("ordem");
    setMensagens((data || []) as Mensagem[]);
  }, []);
  useEffect(() => { carregarMensagens(); }, [carregarMensagens]);

  const [msgDialog, setMsgDialog] = useState(false);
  const [msgEditId, setMsgEditId] = useState<string | null>(null);
  const [msgForm, setMsgForm] = useState({ ...emptyMsg });
  const [msgDeleting, setMsgDeleting] = useState<Mensagem | null>(null);
  const msgTextRef = useRef<HTMLTextAreaElement | null>(null);

  const abrirNovaMsg = () => {
    const prox = mensagens.length ? Math.max(...mensagens.map((m) => m.ordem)) + 1 : 1;
    setMsgEditId(null);
    setMsgForm({ ...emptyMsg, ordem: prox, nome: `${prox}ª mensagem` });
    setMsgDialog(true);
  };
  const abrirEdicaoMsg = (m: Mensagem) => {
    setMsgEditId(m.id);
    setMsgForm({ ordem: m.ordem, nome: m.nome, mensagem: m.mensagem, ativo: m.ativo });
    setMsgDialog(true);
  };
  const salvarMsg = async () => {
    if (!msgForm.nome || !msgForm.mensagem) { toast.error("Preencha nome e mensagem"); return; }
    const payload = { ordem: msgForm.ordem, nome: msgForm.nome, mensagem: msgForm.mensagem, ativo: msgForm.ativo };
    const res = msgEditId
      ? await (supabase as any).from("cobranca_mensagens").update(payload).eq("id", msgEditId)
      : await (supabase as any).from("cobranca_mensagens").insert(payload);
    if (res.error) { toast.error("Erro ao salvar mensagem"); return; }
    toast.success("Mensagem salva");
    setMsgDialog(false);
    carregarMensagens();
  };
  const excluirMsg = async () => {
    if (!msgDeleting) return;
    await (supabase as any).from("cobranca_mensagens").delete().eq("id", msgDeleting.id);
    setMsgDeleting(null);
    carregarMensagens();
  };

  const inserirVar = (v: string) => {
    const ta = msgTextRef.current;
    const token = `{{${v}}}`;
    if (!ta) { setMsgForm((f) => ({ ...f, mensagem: f.mensagem + token })); return; }
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const novo = ta.value.slice(0, start) + token + ta.value.slice(end);
    setMsgForm((f) => ({ ...f, mensagem: novo }));
    requestAnimationFrame(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = start + token.length; });
  };

  // ---- Importação de CSV + popup espelho ----
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [espelhoOpen, setEspelhoOpen] = useState(false);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [linhas, setLinhas] = useState<EspelhoLinha[]>([]);
  const [carregandoEspelho, setCarregandoEspelho] = useState(false);

  const onCsvFile = async (file: File) => {
    const text = await file.text();
    const { headers, rows } = parseCsv(text);
    if (!rows.length) { toast.error("CSV vazio ou inválido"); return; }
    const telKey = findKey(headers, TEL_KEYS);
    if (!telKey) { toast.error("Não encontrei uma coluna de telefone no CSV (telefone, celular, whatsapp...)"); return; }
    const nomeKey = findKey(headers, NOME_KEYS);

    setCsvHeaders(headers);
    setCarregandoEspelho(true);
    setEspelhoOpen(true);
    try {
      // Monta os contatos: telefone (chave) + nome + dados (todas as colunas viram {{var}})
      const contatos = rows.map((r) => {
        const dados: Record<string, string> = {};
        headers.forEach((h) => { dados[stripAccentsLower(h).replace(/\s+/g, "_")] = r[h]; });
        return {
          telefone: normTelefone(r[telKey]),
          nome: nomeKey ? r[nomeKey] : "",
          dados,
          _raw: r,
        };
      }).filter((c) => c.telefone);

      const data = await chamar("espelho", { contatos: contatos.map(({ _raw, ...c }) => c) });
      const linhasSrv = (data?.linhas || []) as Omit<EspelhoLinha, "_selecionado" | "_raw">[];
      // Casa de volta com a linha crua do CSV (pela posição → telefones na mesma ordem)
      const merged: EspelhoLinha[] = linhasSrv.map((l, i) => ({
        ...l,
        _selecionado: l.tem_proxima,
        _raw: contatos[i]?._raw || {},
      }));
      setLinhas(merged);
    } catch (e: any) {
      toast.error(e?.message || "Falha ao montar o espelho da importação");
      setEspelhoOpen(false);
    } finally {
      setCarregandoEspelho(false);
    }
  };

  const toggleLinha = (idx: number) =>
    setLinhas((ls) => ls.map((l, i) => (i === idx ? { ...l, _selecionado: !l._selecionado } : l)));
  const selecionados = linhas.filter((l) => l._selecionado && l.tem_proxima);
  const todosMarcados = linhas.filter((l) => l.tem_proxima).every((l) => l._selecionado) && selecionados.length > 0;
  const toggleTodos = () =>
    setLinhas((ls) => ls.map((l) => (l.tem_proxima ? { ...l, _selecionado: !todosMarcados } : l)));

  // ---- Disparo + barra de progresso ----
  const [disparoId, setDisparoId] = useState<string | null>(null);
  const [progresso, setProgresso] = useState<{ total: number; enviados: number; erros: number; status: string } | null>(null);

  const dispararSelecionados = async () => {
    if (!isConnected) { toast.error("Conecte o WhatsApp antes de disparar"); return; }
    if (!selecionados.length) { toast.error("Selecione ao menos um contato"); return; }
    try {
      const contatos = selecionados.map((l) => ({ telefone: l.telefone, nome: l.nome, dados: l.dados }));
      const data = await chamar("preparar_lote", { contatos });
      setDisparoId(data.disparo_id);
      setProgresso({ total: data.total, enviados: 0, erros: 0, status: "enviando" });
      setEspelhoOpen(false);
      toast.success(`Lote criado: ${data.total} mensagem(ns). O envio roda no servidor (~1 a cada 20s).`);
    } catch (e: any) {
      toast.error(e?.message || "Falha ao preparar o disparo");
    }
  };

  // Polling do progresso (lê do banco — o envio ocorre no cron do servidor).
  useEffect(() => {
    if (!disparoId) return;
    const tick = async () => {
      const { data } = await (supabase as any).from("cobranca_disparos").select("total,enviados,erros,status").eq("id", disparoId).maybeSingle();
      if (data) {
        setProgresso({ total: data.total, enviados: data.enviados, erros: data.erros, status: data.status });
        if (data.status === "concluido") {
          toast.success("Disparo concluído!");
          setDisparoId(null);
        }
      }
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => clearInterval(id);
  }, [disparoId]);

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full">
        <AppSidebar />
        <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
          <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-border bg-background/80 backdrop-blur-sm px-6 py-3">
            <SidebarTrigger />
            <div>
              <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
                <CreditCard className="h-5 w-5 text-primary" /> Cobrança
              </h1>
              <p className="text-sm text-muted-foreground">Disparo em massa de cobrança via WhatsApp (UAZAPI)</p>
            </div>
          </header>

          <div className="p-6 space-y-6 max-w-5xl">
            {/* Conexão WhatsApp */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  {isConnected ? <Wifi className="h-4 w-4 text-success" /> : <WifiOff className="h-4 w-4 text-muted-foreground" />}
                  Conexão WhatsApp (UAZAPI · Cobrança)
                  <Badge variant={isConnected ? "default" : "secondary"} className="ml-2">
                    {isConnected ? `Conectado${numeroConectado ? ` · ${numeroConectado}` : ""}` : cfgStatus}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  Instância exclusiva da cobrança (separada das Notificações). Conecte escaneando o QR Code.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label>URL do servidor UAZAPI</Label>
                    <Input placeholder="https://sua-instancia.uazapi.com"
                      value={cfg.server_url} onChange={(e) => setCfg({ ...cfg, server_url: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label className="flex items-center gap-2">
                      Token (admin/instância)
                      {tokenSalvo && <Badge variant="secondary" className="text-[10px]">salvo</Badge>}
                    </Label>
                    <div className="relative">
                      <Input type={showToken ? "text" : "password"}
                        placeholder={tokenSalvo ? "•••••••• (salvo — deixe em branco p/ manter)" : "cole o token"}
                        className="pr-9"
                        value={cfg.admin_token} onChange={(e) => setCfg({ ...cfg, admin_token: e.target.value })} />
                      <button type="button" onClick={() => setShowToken((s) => !s)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        aria-label={showToken ? "Ocultar token" : "Mostrar token"}>
                        {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label>Nome da instância</Label>
                    <Input placeholder="ex: cobranca"
                      value={cfg.instance} onChange={(e) => setCfg({ ...cfg, instance: e.target.value })} />
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={conectar} disabled={connecting}>
                    <QrCode className="mr-2 h-4 w-4" /> {connecting ? "Conectando..." : "Conectar / Gerar QR"}
                  </Button>
                  <Button variant="outline" onClick={() => refreshStatus(false)} disabled={loadingStatus}>
                    <RefreshCw className={`mr-2 h-4 w-4 ${loadingStatus ? "animate-spin" : ""}`} />
                    {loadingStatus ? "Atualizando..." : "Atualizar status"}
                  </Button>
                  {isConnected && (
                    <Button variant="destructive" onClick={desconectar} disabled={desconectando}>
                      <LogOut className="mr-2 h-4 w-4" />
                      {desconectando ? "Desconectando..." : "Desconectar"}
                    </Button>
                  )}
                </div>
                {qrCode && (
                  <div className="flex flex-col items-center gap-2 pt-2">
                    <img
                      src={qrCode.startsWith("data:") ? qrCode : `data:image/png;base64,${qrCode}`}
                      alt="QR Code WhatsApp" className="h-56 w-56 rounded-lg border border-border bg-white p-2"
                    />
                    <p className="text-xs text-muted-foreground">
                      WhatsApp → Aparelhos conectados → Conectar aparelho → escaneie
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Progresso do disparo em andamento */}
            {progresso && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Send className="h-4 w-4 text-primary" /> Disparo em andamento
                    <Badge variant="secondary" className="ml-2">{progresso.status}</Badge>
                  </CardTitle>
                  <CardDescription>
                    O envio roda no servidor (~1 mensagem a cada 20s). Pode fechar esta aba — não interrompe.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  <Progress value={progresso.total ? (progresso.enviados / progresso.total) * 100 : 0} />
                  <p className="text-sm text-muted-foreground">
                    {progresso.enviados} de {progresso.total} enviadas
                    {progresso.erros ? ` · ${progresso.erros} erro(s)` : ""}
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Banco de mensagens / cadência */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-base">Cadência de mensagens</CardTitle>
                  <CardDescription>
                    Os textos da cobrança (1ª, 2ª, 3ª...). O sistema escolhe a próxima para cada contato
                    com base no histórico (memória por telefone). Use variáveis como {"{{nome}}"} e as colunas do CSV.
                  </CardDescription>
                </div>
                <Button size="sm" onClick={abrirNovaMsg}><Plus className="mr-2 h-4 w-4" /> Nova mensagem</Button>
              </CardHeader>
              <CardContent className="space-y-2">
                {mensagens.length === 0 ? (
                  <p className="py-6 text-center text-muted-foreground text-sm">Nenhuma mensagem cadastrada ainda.</p>
                ) : (
                  mensagens.map((m) => (
                    <div key={m.id} className="flex items-center gap-3 rounded-md border border-border p-3">
                      <Badge variant="outline" className="shrink-0">#{m.ordem}</Badge>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{m.nome}</span>
                          {!m.ativo && <Badge variant="outline" className="text-muted-foreground">inativa</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">{m.mensagem}</p>
                      </div>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => abrirEdicaoMsg(m)}><Pencil className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => setMsgDeleting(m)}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            {/* Importar CSV */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-base">Importar cobranças (CSV)</CardTitle>
                  <CardDescription>
                    O CSV precisa de uma coluna de telefone. Após importar, você revê tudo no espelho antes de disparar.
                  </CardDescription>
                </div>
                <Button size="sm" onClick={() => fileRef.current?.click()}>
                  <Upload className="mr-2 h-4 w-4" /> Importar CSV
                </Button>
                <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) onCsvFile(f); e.target.value = ""; }} />
              </CardHeader>
            </Card>
          </div>
        </main>
      </div>

      {/* Dialog: mensagem (cadência) */}
      <Dialog open={msgDialog} onOpenChange={setMsgDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{msgEditId ? "Editar mensagem" : "Nova mensagem"}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label>Ordem</Label>
                <Input type="number" min={1} value={msgForm.ordem}
                  onChange={(e) => setMsgForm((f) => ({ ...f, ordem: Number(e.target.value) || 1 }))} />
              </div>
              <div className="col-span-2 space-y-1">
                <Label>Nome</Label>
                <Input value={msgForm.nome} onChange={(e) => setMsgForm((f) => ({ ...f, nome: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Mensagem</Label>
              <Textarea ref={msgTextRef} rows={5} value={msgForm.mensagem}
                onChange={(e) => setMsgForm((f) => ({ ...f, mensagem: e.target.value }))} />
              <div className="flex flex-wrap gap-1 pt-1">
                {["nome", "valor", "vencimento"].map((v) => (
                  <Button key={v} type="button" variant="secondary" size="sm" className="h-6 text-[11px]" onClick={() => inserirVar(v)}>
                    {`{{${v}}}`}
                  </Button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Qualquer coluna do CSV vira variável (ex.: uma coluna "Valor" → {"{{valor}}"}).
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={msgForm.ativo} onCheckedChange={(v) => setMsgForm((f) => ({ ...f, ativo: v }))} />
              <Label>Ativa</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMsgDialog(false)}>Cancelar</Button>
            <Button onClick={salvarMsg}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AlertDialog: excluir mensagem */}
      <AlertDialog open={!!msgDeleting} onOpenChange={(o) => !o && setMsgDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir mensagem?</AlertDialogTitle>
            <AlertDialogDescription>Esta ação não pode ser desfeita.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={excluirMsg}>Excluir</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Dialog: espelho da importação */}
      <Dialog open={espelhoOpen} onOpenChange={setEspelhoOpen}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>Espelho da importação ({linhas.length} contato(s))</DialogTitle>
          </DialogHeader>
          {carregandoEspelho ? (
            <p className="py-10 text-center text-muted-foreground">Montando espelho e buscando histórico...</p>
          ) : (
            <div className="max-h-[60vh] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox checked={todosMarcados} onCheckedChange={toggleTodos} />
                    </TableHead>
                    {csvHeaders.map((h) => <TableHead key={h}>{h}</TableHead>)}
                    <TableHead>Última enviada</TableHead>
                    <TableHead>Próxima mensagem</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {linhas.map((l, idx) => (
                    <TableRow key={idx} className={!l.tem_proxima ? "opacity-50" : ""}>
                      <TableCell>
                        <Checkbox checked={l._selecionado} disabled={!l.tem_proxima} onCheckedChange={() => toggleLinha(idx)} />
                      </TableCell>
                      {csvHeaders.map((h) => <TableCell key={h} className="whitespace-nowrap">{l._raw[h]}</TableCell>)}
                      <TableCell className="text-xs text-muted-foreground max-w-[200px]">
                        {l.ultima_mensagem
                          ? <span title={l.ultima_mensagem}>#{l.ultima_ordem_enviada} · {l.ultima_mensagem.slice(0, 40)}{l.ultima_mensagem.length > 40 ? "…" : ""}</span>
                          : "—"}
                      </TableCell>
                      <TableCell className="text-xs max-w-[260px]">
                        {l.tem_proxima
                          ? <span title={l.proxima_mensagem || ""}><Badge variant="outline" className="mr-1">#{l.proxima_ordem}</Badge>{(l.proxima_mensagem || "").slice(0, 50)}{(l.proxima_mensagem || "").length > 50 ? "…" : ""}</span>
                          : <span className="text-muted-foreground">cadência concluída</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <DialogFooter className="items-center">
            <span className="text-sm text-muted-foreground mr-auto">{selecionados.length} selecionado(s) para envio</span>
            <Button variant="outline" onClick={() => setEspelhoOpen(false)}>Cancelar</Button>
            <Button onClick={dispararSelecionados} disabled={!selecionados.length}>
              <Send className="mr-2 h-4 w-4" /> Disparar selecionados
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}
