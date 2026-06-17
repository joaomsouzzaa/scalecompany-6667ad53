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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
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
  LogOut, Upload, Send, CheckCircle2, AlertTriangle,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

// ===================================================================
// Parser da planilha "Fluxo de Caixa Semanal" (Google Sheets → CSV).
// O arquivo tem várias seções no mesmo CSV; nos interessam duas:
//  1) CONTAS A RECEBER — colunas de data; pegamos a coluna do DIA DE HOJE.
//  2) VENCIDOS (inadimplentes) — Categoria, Cliente, Data de Vencimento, Valor, Obs.
// ===================================================================
function stripAccentsLower(s: string): string {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
function parseBRNumber(raw: string): number {
  if (!raw) return 0;
  let s = String(raw).trim().replace(/[R$\s]/g, "");
  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(",")) s = s.replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
// Conserta texto com mojibake (UTF-8 lido como Latin-1: "Ã§" → "ç") quando detectado.
function fixEncoding(text: string): string {
  if (!/Ã.|Â./.test(text)) return text;
  try { return decodeURIComponent(escape(text)); } catch { return text; }
}
// Tokeniza o CSV inteiro respeitando aspas (inclusive campos com quebra de linha).
function parseCsvAll(text: string, delim = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === delim) { row.push(cur); cur = ""; }
      else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (ch === "\r") { /* ignora */ }
      else cur += ch;
    }
  }
  row.push(cur); rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}
// "6/15/2026" (M/D/AAAA, US) → "2026-06-15"
function usDateToISO(d: string): string {
  const m = (d || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return "";
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${y}-${String(Number(m[1])).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
}
const normTelefone = (s: string) => (s || "").replace(/\D/g, "");

type RawReceber = { categoria_lancamento: string; cliente: string; valor: string; data: string };
type RawInad = { categoria_lancamento: string; cliente: string; data: string; valor: string; observacao: string };

function parsePlanilha(text: string): { receber: RawReceber[]; inad: RawInad[]; achouColunaHoje: boolean; hojeBR: string } {
  const rows = parseCsvAll(fixEncoding(text));
  const hojeISO = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const hojeBR = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });

  // ---- 1) CONTAS A RECEBER ----
  const receber: RawReceber[] = [];
  let achouColunaHoje = false;
  const recHdr = rows.findIndex((r) => stripAccentsLower(r[0]) === "categoria de lancamento");
  if (recHdr >= 0) {
    const hdr = rows[recHdr];
    let todayCol = -1;
    for (let c = 2; c < hdr.length; c++) if (usDateToISO(hdr[c]) === hojeISO) { todayCol = c; break; }
    achouColunaHoje = todayCol >= 0;
    if (todayCol >= 0) {
      const PULAR = new Set(["saldo do dia", "receitas", "despesas", "saldo final do dia", ""]);
      for (let i = recHdr + 1; i < rows.length; i++) {
        const r = rows[i];
        const catN = stripAccentsLower(r[0]);
        if (catN === "despesas" || catN === "saldo final do dia") break;
        if (PULAR.has(catN) || catN.startsWith("transferencias")) continue;
        const cliente = (r[1] || "").trim();
        if (!cliente) continue;
        const valor = (r[todayCol] || "").trim();
        if (!valor || parseBRNumber(valor) <= 0) continue;
        receber.push({ categoria_lancamento: r[0].trim(), cliente, valor, data: hojeBR });
      }
    }
  }

  // ---- 2) VENCIDOS (inadimplentes) ----
  const inad: RawInad[] = [];
  const inadHdr = rows.findIndex((r) =>
    stripAccentsLower(r[0]) === "categoria" && stripAccentsLower(r[2] || "").includes("data de vencimento"));
  if (inadHdr >= 0) {
    for (let i = inadHdr + 1; i < rows.length; i++) {
      const r = rows[i];
      const cat = (r[0] || "").trim();
      const cliente = (r[1] || "").trim();
      const valor = (r[3] || "").trim();
      // Linha de total (sem categoria/cliente, mas com valor) encerra a seção.
      if (!cliente && !cat) { if (valor) break; else continue; }
      if (!cliente || !valor) continue;
      inad.push({ categoria_lancamento: cat, cliente, data: (r[2] || "").trim(), valor, observacao: (r[4] || "").trim() });
    }
  }

  return { receber, inad, achouColunaHoje, hojeBR };
}

type Mensagem = { id: string; ordem: number; nome: string; mensagem: string; ativo: boolean; categoria: string };

type EspelhoRow = {
  cliente: string;
  categoria_lancamento: string;
  valor: string;
  data: string;
  observacao?: string;
  telefone: string;
  nome_match: string | null;
  score: number;
  mensagem: string | null;
  tem_mensagem: boolean;
  ultima_mensagem?: string | null;
  ultima_enviada_em?: string | null;
  proxima_ordem?: number | null;
  _tipo: "receber" | "inadimplente";
  _sel: boolean;
  _tel: string;
};

const CATEGORIAS = [
  { value: "inadimplente", label: "Inadimplente (fluxo 1,2,3...)" },
  { value: "dia_vencimento", label: "Dia do vencimento (única)" },
];
const emptyMsg = { ordem: 1, nome: "", mensagem: "", ativo: true, categoria: "inadimplente" };

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
    const patch: Record<string, unknown> = { server_url: cfg.server_url.replace(/\/$/, ""), instance: cfg.instance };
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

  useEffect(() => {
    refreshStatus(true);
    const id = setInterval(() => refreshStatus(true), 30000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  // ---- Banco de mensagens (cadência por categoria) ----
  const [mensagens, setMensagens] = useState<Mensagem[]>([]);
  const carregarMensagens = useCallback(async () => {
    const { data } = await (supabase as any).from("cobranca_mensagens").select("*").order("categoria").order("ordem");
    setMensagens((data || []) as Mensagem[]);
  }, []);
  useEffect(() => { carregarMensagens(); }, [carregarMensagens]);

  const [msgDialog, setMsgDialog] = useState(false);
  const [msgEditId, setMsgEditId] = useState<string | null>(null);
  const [msgForm, setMsgForm] = useState({ ...emptyMsg });
  const [msgDeleting, setMsgDeleting] = useState<Mensagem | null>(null);
  const msgTextRef = useRef<HTMLTextAreaElement | null>(null);

  const abrirNovaMsg = () => {
    setMsgEditId(null);
    setMsgForm({ ...emptyMsg });
    setMsgDialog(true);
  };
  const abrirEdicaoMsg = (m: Mensagem) => {
    setMsgEditId(m.id);
    setMsgForm({ ordem: m.ordem, nome: m.nome, mensagem: m.mensagem, ativo: m.ativo, categoria: m.categoria || "inadimplente" });
    setMsgDialog(true);
  };
  const salvarMsg = async () => {
    if (!msgForm.nome || !msgForm.mensagem) { toast.error("Preencha nome e mensagem"); return; }
    const ordem = msgForm.categoria === "dia_vencimento" ? 1 : (msgForm.ordem || 1);
    const payload = { ordem, nome: msgForm.nome, mensagem: msgForm.mensagem, ativo: msgForm.ativo, categoria: msgForm.categoria };
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

  // ---- Importação da planilha + espelhos ----
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [espelhoOpen, setEspelhoOpen] = useState(false);
  const [carregandoEspelho, setCarregandoEspelho] = useState(false);
  const [rowsReceber, setRowsReceber] = useState<EspelhoRow[]>([]);
  const [rowsInad, setRowsInad] = useState<EspelhoRow[]>([]);
  const [avisoImport, setAvisoImport] = useState<string | null>(null);

  const onCsvFile = async (file: File) => {
    const text = await file.text();
    const { receber, inad, achouColunaHoje, hojeBR } = parsePlanilha(text);
    if (!receber.length && !inad.length) { toast.error("Não encontrei seções de Contas a Receber nem de Vencidos na planilha."); return; }
    setAvisoImport(!achouColunaHoje ? `Não há coluna com a data de hoje (${hojeBR}) na planilha — o espelho "A Receber" ficou vazio.` : null);
    setCarregandoEspelho(true);
    setEspelhoOpen(true);
    try {
      const [recRes, inaRes] = await Promise.all([
        receber.length ? chamar("espelho_cobranca", { tipo: "receber", linhas: receber.map((r) => ({ cliente: r.cliente, categoria: r.categoria_lancamento, valor: r.valor, data: r.data })) }) : Promise.resolve({ linhas: [] }),
        inad.length ? chamar("espelho_cobranca", { tipo: "inadimplente", linhas: inad.map((r) => ({ cliente: r.cliente, categoria: r.categoria_lancamento, valor: r.valor, data: r.data, observacao: r.observacao })) }) : Promise.resolve({ linhas: [] }),
      ]);
      const mkRows = (linhas: any[], tipo: "receber" | "inadimplente"): EspelhoRow[] =>
        (linhas || []).map((l) => ({
          cliente: l.cliente, categoria_lancamento: l.categoria_lancamento, valor: l.valor, data: l.data, observacao: l.observacao,
          telefone: l.telefone || "", nome_match: l.nome_match, score: l.score || 0,
          mensagem: l.mensagem, tem_mensagem: !!l.tem_mensagem,
          ultima_mensagem: l.ultima_mensagem, ultima_enviada_em: l.ultima_enviada_em, proxima_ordem: l.proxima_ordem,
          _tipo: tipo, _tel: l.telefone || "",
          _sel: !!l.tem_mensagem && normTelefone(l.telefone || "").length >= 10,
        }));
      setRowsReceber(mkRows(recRes.linhas, "receber"));
      setRowsInad(mkRows(inaRes.linhas, "inadimplente"));
    } catch (e: any) {
      toast.error(e?.message || "Falha ao montar os espelhos");
      setEspelhoOpen(false);
    } finally {
      setCarregandoEspelho(false);
    }
  };

  const selValido = (r: EspelhoRow) => r.tem_mensagem && normTelefone(r._tel).length >= 10;
  const patchRow = (set: typeof setRowsReceber, idx: number, patch: Partial<EspelhoRow>) =>
    set((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const selecionadosReceber = rowsReceber.filter((r) => r._sel && selValido(r));
  const selecionadosInad = rowsInad.filter((r) => r._sel && selValido(r));
  const totalSelecionados = selecionadosReceber.length + selecionadosInad.length;

  // ---- Conferência + disparo ----
  const [conferOpen, setConferOpen] = useState(false);
  const [itensConfer, setItensConfer] = useState<EspelhoRow[]>([]);
  const [iniciando, setIniciando] = useState(false);

  const gerar = () => {
    if (!totalSelecionados) { toast.error("Selecione ao menos uma linha com telefone válido"); return; }
    setItensConfer([...selecionadosReceber, ...selecionadosInad]);
    setEspelhoOpen(false);
    setConferOpen(true);
  };

  const [disparoId, setDisparoId] = useState<string | null>(null);
  const [progresso, setProgresso] = useState<{ total: number; enviados: number; erros: number; status: string } | null>(null);

  const comecar = async () => {
    if (!isConnected) { toast.error("Conecte o WhatsApp antes de disparar"); return; }
    setIniciando(true);
    try {
      const itens = itensConfer.map((r) => ({
        telefone: normTelefone(r._tel),
        nome: r.cliente,
        mensagem: r.mensagem,
        categoria: r._tipo === "receber" ? "dia_vencimento" : "inadimplente",
        ordem: r._tipo === "inadimplente" ? (r.proxima_ordem ?? null) : null,
      }));
      const data = await chamar("preparar_lote", { itens });
      setDisparoId(data.disparo_id);
      setProgresso({ total: data.total, enviados: 0, erros: 0, status: "enviando" });
      setConferOpen(false);
      toast.success(`Lote criado: ${data.total} mensagem(ns). Envio no servidor (~1 a cada 20s).`);
    } catch (e: any) {
      toast.error(e?.message || "Falha ao iniciar o disparo");
    } finally {
      setIniciando(false);
    }
  };

  useEffect(() => {
    if (!disparoId) return;
    const tick = async () => {
      const { data } = await (supabase as any).from("cobranca_disparos").select("total,enviados,erros,status").eq("id", disparoId).maybeSingle();
      if (data) {
        setProgresso({ total: data.total, enviados: data.enviados, erros: data.erros, status: data.status });
        if (data.status === "concluido") { toast.success("Disparo concluído!"); setDisparoId(null); }
      }
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => clearInterval(id);
  }, [disparoId]);

  // ---- render de uma tabela de espelho ----
  const renderEspelho = (rows: EspelhoRow[], set: typeof setRowsReceber, tipo: "receber" | "inadimplente") => {
    const validos = rows.filter(selValido);
    const todos = validos.length > 0 && validos.every((r) => r._sel);
    const toggleTodos = () => set((rs) => rs.map((r) => (selValido(r) ? { ...r, _sel: !todos } : r)));
    if (!rows.length) return <p className="py-8 text-center text-sm text-muted-foreground">Nenhuma linha nesta seção.</p>;
    return (
      <div className="max-h-[55vh] overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10"><Checkbox checked={todos} onCheckedChange={toggleTodos} /></TableHead>
              <TableHead>Categoria</TableHead>
              <TableHead>Cliente</TableHead>
              <TableHead>{tipo === "inadimplente" ? "Venceu" : "Data"}</TableHead>
              <TableHead>Valor</TableHead>
              <TableHead>Telefone</TableHead>
              {tipo === "inadimplente" && <TableHead>Última enviada</TableHead>}
              <TableHead>{tipo === "inadimplente" ? "Próxima mensagem" : "Mensagem"}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, idx) => (
              <TableRow key={idx} className={!r.tem_mensagem ? "opacity-60" : ""}>
                <TableCell><Checkbox checked={r._sel} disabled={!selValido(r)} onCheckedChange={() => patchRow(set, idx, { _sel: !r._sel })} /></TableCell>
                <TableCell className="whitespace-nowrap text-xs">{r.categoria_lancamento}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {r.cliente}
                  {r.nome_match
                    ? <span className="block text-[10px] text-muted-foreground">match: {r.nome_match} ({r.score}%)</span>
                    : <span className="block text-[10px] text-amber-600">sem match — digite o telefone</span>}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs">{r.data}</TableCell>
                <TableCell className="whitespace-nowrap text-xs">{r.valor}</TableCell>
                <TableCell>
                  <Input value={r._tel} onChange={(e) => patchRow(set, idx, { _tel: e.target.value, _sel: r._sel && (normTelefone(e.target.value).length >= 10) })}
                    placeholder="55DDDNUMERO" className="h-8 w-36 text-xs" />
                </TableCell>
                {tipo === "inadimplente" && (
                  <TableCell className="text-xs text-muted-foreground max-w-[180px]">
                    {r.ultima_mensagem
                      ? <span title={r.ultima_mensagem}>{r.ultima_enviada_em ? new Date(r.ultima_enviada_em).toLocaleDateString("pt-BR") : ""} · {r.ultima_mensagem.slice(0, 30)}…</span>
                      : "—"}
                  </TableCell>
                )}
                <TableCell className="text-xs max-w-[280px]">
                  {r.tem_mensagem
                    ? <span title={r.mensagem || ""}>
                        {tipo === "inadimplente" && r.proxima_ordem ? <Badge variant="outline" className="mr-1">#{r.proxima_ordem}</Badge> : null}
                        {(r.mensagem || "").slice(0, 60)}{(r.mensagem || "").length > 60 ? "…" : ""}
                      </span>
                    : <span className="text-amber-600">sem mensagem nessa categoria</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  };

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

          <div className="p-6 space-y-6 max-w-6xl">
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
                <CardDescription>Instância exclusiva da cobrança (separada das Notificações). Conecte escaneando o QR Code.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label>URL do servidor UAZAPI</Label>
                    <Input placeholder="https://sua-instancia.uazapi.com" value={cfg.server_url} onChange={(e) => setCfg({ ...cfg, server_url: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label className="flex items-center gap-2">Token (admin/instância){tokenSalvo && <Badge variant="secondary" className="text-[10px]">salvo</Badge>}</Label>
                    <div className="relative">
                      <Input type={showToken ? "text" : "password"} placeholder={tokenSalvo ? "•••••••• (salvo — deixe em branco p/ manter)" : "cole o token"} className="pr-9"
                        value={cfg.admin_token} onChange={(e) => setCfg({ ...cfg, admin_token: e.target.value })} />
                      <button type="button" onClick={() => setShowToken((s) => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label={showToken ? "Ocultar token" : "Mostrar token"}>
                        {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label>Nome da instância</Label>
                    <Input placeholder="ex: cobranca" value={cfg.instance} onChange={(e) => setCfg({ ...cfg, instance: e.target.value })} />
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={conectar} disabled={connecting}><QrCode className="mr-2 h-4 w-4" /> {connecting ? "Conectando..." : "Conectar / Gerar QR"}</Button>
                  <Button variant="outline" onClick={() => refreshStatus(false)} disabled={loadingStatus}><RefreshCw className={`mr-2 h-4 w-4 ${loadingStatus ? "animate-spin" : ""}`} />{loadingStatus ? "Atualizando..." : "Atualizar status"}</Button>
                  {isConnected && <Button variant="destructive" onClick={desconectar} disabled={desconectando}><LogOut className="mr-2 h-4 w-4" />{desconectando ? "Desconectando..." : "Desconectar"}</Button>}
                </div>
                {qrCode && (
                  <div className="flex flex-col items-center gap-2 pt-2">
                    <img src={qrCode.startsWith("data:") ? qrCode : `data:image/png;base64,${qrCode}`} alt="QR Code WhatsApp" className="h-56 w-56 rounded-lg border border-border bg-white p-2" />
                    <p className="text-xs text-muted-foreground">WhatsApp → Aparelhos conectados → Conectar aparelho → escaneie</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Progresso do disparo */}
            {progresso && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2"><Send className="h-4 w-4 text-primary" /> Disparo em andamento<Badge variant="secondary" className="ml-2">{progresso.status}</Badge></CardTitle>
                  <CardDescription>O envio roda no servidor (~1 mensagem a cada 20s). Pode fechar esta aba — não interrompe.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  <Progress value={progresso.total ? (progresso.enviados / progresso.total) * 100 : 0} />
                  <p className="text-sm text-muted-foreground">{progresso.enviados} de {progresso.total} enviadas{progresso.erros ? ` · ${progresso.erros} erro(s)` : ""}</p>
                </CardContent>
              </Card>
            )}

            {/* Banco de mensagens */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-base">Mensagens / cadência</CardTitle>
                  <CardDescription>
                    Categoria <strong>Dia do vencimento</strong> = 1 mensagem única (Contas a Receber do dia).
                    Categoria <strong>Inadimplente</strong> = fluxo (1, 2, 3...) com memória por telefone.
                    Variáveis: {"{{nome}}"}, {"{{valor}}"}, {"{{vencimento}}"}, {"{{data}}"}.
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
                      <Badge variant={m.categoria === "dia_vencimento" ? "default" : "secondary"} className="shrink-0">
                        {m.categoria === "dia_vencimento" ? "Vencimento" : `Inad. #${m.ordem}`}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2"><span className="font-medium">{m.nome}</span>{!m.ativo && <Badge variant="outline" className="text-muted-foreground">inativa</Badge>}</div>
                        <p className="text-xs text-muted-foreground truncate">{m.mensagem}</p>
                      </div>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => abrirEdicaoMsg(m)}><Pencil className="h-4 w-4" /></Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => setMsgDeleting(m)}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            {/* Importar planilha */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-base">Importar planilha de Fluxo de Caixa (CSV)</CardTitle>
                  <CardDescription>Gera 2 espelhos: <strong>A Receber (hoje)</strong> e <strong>Inadimplentes</strong>. O telefone é casado por nome com vendas/mentoria.</CardDescription>
                </div>
                <Button size="sm" onClick={() => fileRef.current?.click()}><Upload className="mr-2 h-4 w-4" /> Importar CSV</Button>
                <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onCsvFile(f); e.target.value = ""; }} />
              </CardHeader>
            </Card>
          </div>
        </main>
      </div>

      {/* Dialog: mensagem */}
      <Dialog open={msgDialog} onOpenChange={setMsgDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{msgEditId ? "Editar mensagem" : "Nova mensagem"}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-1">
                <Label>Categoria</Label>
                <Select value={msgForm.categoria} onValueChange={(v) => setMsgForm((f) => ({ ...f, categoria: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{CATEGORIAS.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              {msgForm.categoria === "inadimplente" && (
                <div className="space-y-1">
                  <Label>Ordem</Label>
                  <Input type="number" min={1} value={msgForm.ordem} onChange={(e) => setMsgForm((f) => ({ ...f, ordem: Number(e.target.value) || 1 }))} />
                </div>
              )}
            </div>
            <div className="space-y-1">
              <Label>Nome (rótulo)</Label>
              <Input value={msgForm.nome} onChange={(e) => setMsgForm((f) => ({ ...f, nome: e.target.value }))} placeholder="ex: 1º aviso" />
            </div>
            <div className="space-y-1">
              <Label>Mensagem</Label>
              <Textarea ref={msgTextRef} rows={5} value={msgForm.mensagem} onChange={(e) => setMsgForm((f) => ({ ...f, mensagem: e.target.value }))} />
              <div className="flex flex-wrap gap-1 pt-1">
                {["nome", "valor", "vencimento", "data"].map((v) => (
                  <Button key={v} type="button" variant="secondary" size="sm" className="h-6 text-[11px]" onClick={() => inserirVar(v)}>{`{{${v}}}`}</Button>
                ))}
              </div>
              {msgForm.categoria === "dia_vencimento" && <p className="text-[11px] text-muted-foreground">Só a 1ª mensagem ativa desta categoria é usada (mensagem única do dia do vencimento).</p>}
            </div>
            <div className="flex items-center gap-2"><Switch checked={msgForm.ativo} onCheckedChange={(v) => setMsgForm((f) => ({ ...f, ativo: v }))} /><Label>Ativa</Label></div>
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
          <AlertDialogHeader><AlertDialogTitle>Excluir mensagem?</AlertDialogTitle><AlertDialogDescription>Esta ação não pode ser desfeita.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancelar</AlertDialogCancel><AlertDialogAction onClick={excluirMsg}>Excluir</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Dialog: espelhos */}
      <Dialog open={espelhoOpen} onOpenChange={setEspelhoOpen}>
        <DialogContent className="max-w-6xl">
          <DialogHeader><DialogTitle>Espelho da importação</DialogTitle></DialogHeader>
          {carregandoEspelho ? (
            <p className="py-10 text-center text-muted-foreground">Casando clientes e montando espelhos...</p>
          ) : (
            <>
              {avisoImport && <p className="text-xs text-amber-600 flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> {avisoImport}</p>}
              <Tabs defaultValue="receber">
                <TabsList>
                  <TabsTrigger value="receber">A Receber (hoje) · {rowsReceber.length}</TabsTrigger>
                  <TabsTrigger value="inad">Inadimplentes · {rowsInad.length}</TabsTrigger>
                </TabsList>
                <TabsContent value="receber">{renderEspelho(rowsReceber, setRowsReceber, "receber")}</TabsContent>
                <TabsContent value="inad">{renderEspelho(rowsInad, setRowsInad, "inadimplente")}</TabsContent>
              </Tabs>
            </>
          )}
          <DialogFooter className="items-center">
            <span className="text-sm text-muted-foreground mr-auto">{totalSelecionados} selecionado(s)</span>
            <Button variant="outline" onClick={() => setEspelhoOpen(false)}>Cancelar</Button>
            <Button onClick={gerar} disabled={!totalSelecionados}>Gerar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: conferência final */}
      <Dialog open={conferOpen} onOpenChange={setConferOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader><DialogTitle>Conferência ({itensConfer.length} envio(s))</DialogTitle></DialogHeader>
          <div className="max-h-[55vh] overflow-auto">
            <Table>
              <TableHeader><TableRow><TableHead>Tipo</TableHead><TableHead>Cliente</TableHead><TableHead>Telefone</TableHead><TableHead>Mensagem</TableHead></TableRow></TableHeader>
              <TableBody>
                {itensConfer.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell><Badge variant={r._tipo === "receber" ? "default" : "secondary"}>{r._tipo === "receber" ? "Vencimento" : `Inad. #${r.proxima_ordem || ""}`}</Badge></TableCell>
                    <TableCell className="whitespace-nowrap">{r.cliente}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{normTelefone(r._tel)}</TableCell>
                    <TableCell className="text-xs max-w-[360px]"><span title={r.mensagem || ""}>{(r.mensagem || "").slice(0, 80)}{(r.mensagem || "").length > 80 ? "…" : ""}</span></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setConferOpen(false); setEspelhoOpen(true); }}>Voltar</Button>
            <Button onClick={comecar} disabled={iniciando || !itensConfer.length}><Send className="mr-2 h-4 w-4" /> {iniciando ? "Iniciando..." : "Começar"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}
