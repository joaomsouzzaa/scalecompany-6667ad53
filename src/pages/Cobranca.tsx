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
import { CreditCard, Plus, Pencil, Trash2, Upload, Send, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { InstanciasUazapi, type Instancia } from "@/components/InstanciasUazapi";

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

// Saudação atual no horário de SP — só para PRÉVIA. No envio real é resolvida no backend.
function saudacaoSPAgora(): string {
  const h = Number(new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", hour12: false, timeZone: "America/Sao_Paulo" }).slice(0, 2));
  if (h >= 5 && h < 12) return "Bom dia";
  if (h >= 12 && h < 18) return "Boa tarde";
  return "Boa noite";
}
const previewMsg = (m: string | null | undefined) => (m || "").replace(/\{\{\s*saudacao\s*\}\}/gi, saudacaoSPAgora());

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
  // ---- Instâncias (pool compartilhado; gerenciado pelo componente) ----
  const [instancias, setInstancias] = useState<Instancia[]>([]);
  const [instanciaSel, setInstanciaSel] = useState<string>("");
  const conectadas = instancias.filter((i) => i.status === "connected" || i.status === "conectado");

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
    if (!instanciaSel && conectadas.length) setInstanciaSel(conectadas[0].nome);
    setEspelhoOpen(false);
    setConferOpen(true);
  };

  const [disparoId, setDisparoId] = useState<string | null>(null);
  const [progresso, setProgresso] = useState<{ total: number; enviados: number; erros: number; status: string } | null>(null);

  // ---- Histórico de disparos + log de itens ----
  type DisparoHist = { id: string; status: string; total: number; enviados: number; erros: number; instancia: string | null; created_at: string };
  type LogItem = { id: string; nome: string | null; telefone: string; categoria: string | null; status: string; mensagem: string; enviado_em: string | null; erro: string | null };
  const [historico, setHistorico] = useState<DisparoHist[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [logDisparo, setLogDisparo] = useState<DisparoHist | null>(null);
  const [logItens, setLogItens] = useState<LogItem[]>([]);
  const [logCarregando, setLogCarregando] = useState(false);

  const carregarHistorico = useCallback(async () => {
    const { data } = await (supabase as any)
      .from("cobranca_disparos")
      .select("id,status,total,enviados,erros,instancia,created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    setHistorico((data || []) as DisparoHist[]);
  }, []);
  useEffect(() => { carregarHistorico(); }, [carregarHistorico]);

  const abrirLog = async (d: DisparoHist) => {
    setLogDisparo(d);
    setLogOpen(true);
    setLogCarregando(true);
    try {
      const { data } = await (supabase as any)
        .from("cobranca_disparo_itens")
        .select("id,nome,telefone,categoria,status,mensagem,enviado_em,erro")
        .eq("disparo_id", d.id)
        .order("created_at", { ascending: true });
      setLogItens((data || []) as LogItem[]);
    } finally {
      setLogCarregando(false);
    }
  };

  const comecar = async () => {
    if (!instanciaSel) { toast.error("Selecione a instância de envio"); return; }
    if (!conectadas.some((i) => i.nome === instanciaSel)) { toast.error("A instância selecionada não está conectada"); return; }
    setIniciando(true);
    try {
      const itens = itensConfer.map((r) => ({
        telefone: normTelefone(r._tel),
        nome: r.cliente,
        mensagem: r.mensagem,
        categoria: r._tipo === "receber" ? "dia_vencimento" : "inadimplente",
        ordem: r._tipo === "inadimplente" ? (r.proxima_ordem ?? null) : null,
      }));
      const data = await chamar("preparar_lote", { itens, instancia: instanciaSel });
      setDisparoId(data.disparo_id);
      setProgresso({ total: data.total, enviados: 0, erros: 0, status: "enviando" });
      setConferOpen(false);
      carregarHistorico();
      toast.success(`Lote criado: ${data.total} mensagem(ns). Envio no servidor (~1 a cada 30s).`);
    } catch (e: any) {
      toast.error(e?.message || "Falha ao iniciar o disparo");
    } finally {
      setIniciando(false);
    }
  };

  // Ao abrir a página, retoma o acompanhamento de qualquer disparo em andamento
  // (o envio roda no servidor, então a barra precisa aparecer mesmo após recarregar).
  useEffect(() => {
    (async () => {
      const { data } = await (supabase as any)
        .from("cobranca_disparos")
        .select("id,total,enviados,erros,status")
        .eq("status", "enviando")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) {
        setDisparoId(data.id);
        setProgresso({ total: data.total, enviados: data.enviados, erros: data.erros, status: data.status });
      }
    })();
  }, []);

  useEffect(() => {
    if (!disparoId) return;
    const tick = async () => {
      const { data } = await (supabase as any).from("cobranca_disparos").select("total,enviados,erros,status").eq("id", disparoId).maybeSingle();
      if (data) {
        setProgresso({ total: data.total, enviados: data.enviados, erros: data.erros, status: data.status });
        carregarHistorico();
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
      <div className="max-h-[55vh] overflow-auto min-w-0">
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
                    ? <span title={previewMsg(r.mensagem)}>
                        {tipo === "inadimplente" && r.proxima_ordem ? <Badge variant="outline" className="mr-1">#{r.proxima_ordem}</Badge> : null}
                        {previewMsg(r.mensagem).slice(0, 60)}{previewMsg(r.mensagem).length > 60 ? "…" : ""}
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
            {/* Instâncias (pool compartilhado) */}
            <InstanciasUazapi funcao="cobranca" onInstancias={setInstancias} />

            {/* Progresso do disparo */}
            {progresso && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2"><Send className="h-4 w-4 text-primary" /> Disparo em andamento<Badge variant="secondary" className="ml-2">{progresso.status}</Badge></CardTitle>
                  <CardDescription>O envio roda no servidor (~1 mensagem a cada 30s). Pode fechar esta aba — não interrompe.</CardDescription>
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

            {/* Histórico de disparos / log de envios */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle className="text-base">Histórico de disparos</CardTitle>
                  <CardDescription>Cada importação que virou disparo. Abra o log para ver o status de cada mensagem (enviada/erro).</CardDescription>
                </div>
                <Button size="sm" variant="outline" onClick={carregarHistorico}>Atualizar</Button>
              </CardHeader>
              <CardContent>
                {historico.length === 0 ? (
                  <p className="py-6 text-center text-muted-foreground text-sm">Nenhum disparo realizado ainda.</p>
                ) : (
                  <div className="max-h-[50vh] overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Quando</TableHead>
                          <TableHead>Instância</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Enviadas</TableHead>
                          <TableHead className="text-right">Erros</TableHead>
                          <TableHead className="text-right">Total</TableHead>
                          <TableHead></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {historico.map((d) => (
                          <TableRow key={d.id}>
                            <TableCell className="whitespace-nowrap text-xs">{new Date(d.created_at).toLocaleString("pt-BR")}</TableCell>
                            <TableCell className="text-xs">{d.instancia || "—"}</TableCell>
                            <TableCell>
                              <Badge variant={d.status === "concluido" ? "default" : d.status === "enviando" ? "secondary" : "outline"}>{d.status}</Badge>
                            </TableCell>
                            <TableCell className="text-right text-xs">{d.enviados}</TableCell>
                            <TableCell className={`text-right text-xs ${d.erros ? "text-destructive font-medium" : ""}`}>{d.erros}</TableCell>
                            <TableCell className="text-right text-xs">{d.total}</TableCell>
                            <TableCell className="text-right"><Button size="sm" variant="ghost" onClick={() => abrirLog(d)}>Ver log</Button></TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </main>
      </div>

      {/* Dialog: log de envios de um disparo */}
      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogContent className="max-w-5xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>
              Log do disparo {logDisparo ? `· ${new Date(logDisparo.created_at).toLocaleString("pt-BR")}` : ""}
            </DialogTitle>
          </DialogHeader>
          {logCarregando ? (
            <p className="py-10 text-center text-muted-foreground">Carregando itens...</p>
          ) : logItens.length === 0 ? (
            <p className="py-10 text-center text-muted-foreground">Nenhum item neste disparo.</p>
          ) : (
            <div className="max-h-[60vh] overflow-auto min-w-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Cliente</TableHead>
                    <TableHead>Telefone</TableHead>
                    <TableHead>Categoria</TableHead>
                    <TableHead>Enviada em</TableHead>
                    <TableHead>Mensagem / erro</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {logItens.map((it) => (
                    <TableRow key={it.id}>
                      <TableCell>
                        <Badge variant={it.status === "enviado" ? "default" : it.status === "erro" ? "destructive" : "secondary"}>{it.status}</Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{it.nome || "—"}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{it.telefone}</TableCell>
                      <TableCell className="text-xs">{it.categoria === "dia_vencimento" ? "Vencimento" : "Inadimplente"}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{it.enviado_em ? new Date(it.enviado_em).toLocaleString("pt-BR") : "—"}</TableCell>
                      <TableCell className="text-xs max-w-[320px]">
                        {it.status === "erro" && it.erro
                          ? <span className="text-destructive" title={it.erro}>{it.erro.slice(0, 120)}</span>
                          : <span className="text-muted-foreground" title={it.mensagem}>{it.mensagem.slice(0, 80)}{it.mensagem.length > 80 ? "…" : ""}</span>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>

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
                {["nome", "produto", "valor", "vencimento", "data", "saudacao"].map((v) => (
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
        <DialogContent className="max-w-6xl overflow-hidden">
          <DialogHeader><DialogTitle>Espelho da importação</DialogTitle></DialogHeader>
          {carregandoEspelho ? (
            <p className="py-10 text-center text-muted-foreground">Casando clientes e montando espelhos...</p>
          ) : (
            <>
              {avisoImport && <p className="text-xs text-amber-600 flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> {avisoImport}</p>}
              <Tabs defaultValue="receber" className="min-w-0">
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
        <DialogContent className="max-w-4xl overflow-hidden">
          <DialogHeader><DialogTitle>Conferência ({itensConfer.length} envio(s))</DialogTitle></DialogHeader>
          <div className="max-h-[55vh] overflow-auto min-w-0">
            <Table>
              <TableHeader><TableRow><TableHead>Tipo</TableHead><TableHead>Cliente</TableHead><TableHead>Telefone</TableHead><TableHead>Mensagem</TableHead></TableRow></TableHeader>
              <TableBody>
                {itensConfer.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell><Badge variant={r._tipo === "receber" ? "default" : "secondary"}>{r._tipo === "receber" ? "Vencimento" : `Inad. #${r.proxima_ordem || ""}`}</Badge></TableCell>
                    <TableCell className="whitespace-nowrap">{r.cliente}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{normTelefone(r._tel)}</TableCell>
                    <TableCell className="text-xs max-w-[360px]"><span title={previewMsg(r.mensagem)}>{previewMsg(r.mensagem).slice(0, 80)}{previewMsg(r.mensagem).length > 80 ? "…" : ""}</span></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <DialogFooter className="items-center">
            <div className="mr-auto flex items-center gap-2">
              <Label className="text-xs whitespace-nowrap">Enviar pela instância:</Label>
              <Select value={instanciaSel} onValueChange={setInstanciaSel}>
                <SelectTrigger className="h-8 w-44"><SelectValue placeholder="selecione" /></SelectTrigger>
                <SelectContent>
                  {conectadas.length === 0
                    ? <SelectItem value="__none" disabled>nenhuma conectada</SelectItem>
                    : conectadas.map((i) => <SelectItem key={i.nome} value={i.nome}>{i.nome}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button variant="outline" onClick={() => { setConferOpen(false); setEspelhoOpen(true); }}>Voltar</Button>
            <Button onClick={comecar} disabled={iniciando || !itensConfer.length || !instanciaSel}><Send className="mr-2 h-4 w-4" /> {iniciando ? "Iniciando..." : "Começar"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}
