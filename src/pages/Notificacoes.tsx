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
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command";
import { Bot, Plus, Pencil, Trash2, Send, RefreshCw, Check, ChevronsUpDown, History, CheckCircle2, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { syncMetaTokenToServer } from "@/lib/meta-ads";
import { useCidades } from "@/hooks/useCidades";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { InstanciasUazapi, type Instancia } from "@/components/InstanciasUazapi";

// Gatilhos disponíveis e as variáveis que cada um disponibiliza no template
const GATILHOS: Record<string, { label: string; desc: string; vars: string[] }> = {
  nova_venda: {
    label: "Nova venda",
    desc: "Dispara quando uma venda é registrada",
    vars: ["nome", "email", "telefone", "documento", "produto", "cidade", "valor", "tipo", "status", "quantidade", "forma_pagamento", "data"],
  },
  nova_venda_inside_sales: {
    label: "Nova venda Inside Sales",
    desc: "Dispara quando chega uma nova venda de mentoria (Inside Sales)",
    vars: ["nome", "telefone", "produto", "forma_pagamento", "origem", "valor", "observacoes", "cnpj", "dono_negocio", "data_fechamento", "email", "status", "id_transacao", "data"],
  },
  resumo_cidade: {
    label: "Resumo de cidade (agendado)",
    desc: "Resumo periódico de uma cidade",
    vars: ["cidade", "participantes", "vips", "convidados", "bilheteria", "bilheteria_resultado", "cac", "projecao", "investimento", "projecao_investimento"],
  },
  resumo_geral: {
    label: "Resumo geral diário (agendado)",
    desc: "Consolidado de todas as cidades, 1x/dia",
    vars: ["total_cidades", "participantes_total", "bilheteria_total", "investimento_total", "bilheteria_resultado_total", "data"],
  },
  manual: {
    label: "Manual / sob demanda",
    desc: "Enviado quando você clicar em Enviar. Usa o resumo da cidade selecionada.",
    vars: ["cidade", "participantes", "vips", "convidados", "bilheteria", "bilheteria_resultado", "cac", "projecao", "investimento", "projecao_investimento"],
  },
  relatorio_sync: {
    label: "Relatório de sincronização (Kiwify)",
    desc: "Para onde vai o relatório da sincronização com a Kiwify (automática e manual). A mensagem é usada como cabeçalho.",
    vars: [],
  },
};

type Dest = { tipo: string; valor: string; nome: string }; // tipo: grupo | numero

type Notificacao = {
  id: string;
  nome: string;
  gatilho: string;
  ativo: boolean;
  destinatario_tipo: string; // legado (1º destinatário)
  destinatario: string;      // legado (1º destinatário)
  destinatario_nome: string | null;
  destinatarios?: Dest[] | null;
  mensagem: string;
  cidade_slug: string | null;
  horario: string | null;
  instancia?: string | null;
};

const emptyForm = {
  nome: "",
  gatilho: "nova_venda",
  ativo: true,
  instancia: "" as string,
  destinatarios: [{ tipo: "grupo", valor: "", nome: "" }] as Dest[],
  mensagem: "",
  cidade_slug: null as string | null,
  horario: "09:00" as string | null,
  disparo_dia_evento: false,
  horario_evento: "12:00" as string | null,
  sheets_ativo: false,
  sheets_spreadsheet_id: "" as string,
  sheets_spreadsheet_nome: "" as string,
  sheets_aba: "" as string,
  sheets_mapa: {} as Record<string, string>,
  email_ativo: false,
  email_config_id: null as number | null,
  email_destinatarios: [""] as string[],
  email_assunto: "" as string,
  email_corpo: "" as string,
};

// Junta a lista de destinatários de e-mail num texto (vírgula), removendo vazios.
const emailParaJoin = (arr: string[]) => (arr || []).map((s) => s.trim()).filter(Boolean).join(", ");

// Valores de exemplo p/ renderizar o e-mail de teste (cobre todas as variáveis).
const EXEMPLO_VARS: Record<string, string> = {
  nome: "Fulano (teste)", email: "fulano@email.com", telefone: "5511999999999", documento: "000.000.000-00",
  produto: "Mentoria Scale", cidade: "São Paulo", valor: "R$ 5.000,00", tipo: "Individual",
  status: "Pagamento aprovado", quantidade: "1", forma_pagamento: "Pix", data: new Date().toLocaleDateString("pt-BR"),
  origem: "Instagram", observacoes: "Cliente quer começar em julho", cnpj: "12.345.678/0001-90",
  dono_negocio: "joao@empresa.com", data_fechamento: new Date().toLocaleDateString("pt-BR"), id_transacao: "TESTE-123",
};
const renderExemplo = (tpl: string) =>
  String(tpl || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => EXEMPLO_VARS[k] ?? "");

const CONTA_VAZIA = {
  nome: "", imap_host: "", imap_port: 993, smtp_host: "", smtp_port: 465,
  username: "", password: "", from_name: "",
};

export default function Notificacoes() {
  const queryClient = useQueryClient();
  const { data: cidades = [] } = useCidades();

  // ---- Instâncias (pool compartilhado, gerenciado pelo componente) ----
  const [instancias, setInstancias] = useState<Instancia[]>([]);
  const conectadas = instancias.filter((i) => i.status === "connected" || i.status === "conectado");
  const isConnected = conectadas.length > 0;
  const [loadingGrupos, setLoadingGrupos] = useState(false);
  const [testando, setTestando] = useState(false);     // botão do dialog
  const [testandoId, setTestandoId] = useState<string | null>(null); // botão da linha

  const chamarUazapi = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    const { data, error } = await supabase.functions.invoke("uazapi", { body: { action, ...payload } });
    if (error) {
      // tenta extrair a mensagem real do corpo da resposta (ex.: "Invalid token")
      let msg = error.message;
      try { const ctx = (error as any).context; if (ctx?.json) { const b = await ctx.json(); if (b?.error) msg = b.error; } } catch { /* ignore */ }
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }, []);

  // Grupos do WhatsApp (carregados sob demanda) — usa uma instância conectada.
  const [grupos, setGrupos] = useState<Array<{ id: string; name: string }>>([]);
  const carregarGrupos = async (instancia?: string) => {
    setLoadingGrupos(true);
    try {
      const inst = instancia || conectadas[0]?.nome;
      const data = await chamarUazapi("groups", { instancia: inst });
      setGrupos(data?.groups || []);
      toast.success(`${(data?.groups || []).length} grupo(s) carregado(s)`);
    } catch (e: any) {
      toast.error(e?.message || "Falha ao listar grupos (conecte o WhatsApp primeiro)");
    } finally {
      setLoadingGrupos(false);
    }
  };

  // Contas de e-mail (para a opção de envio por e-mail). Carregadas via função `email`.
  const [emailAccounts, setEmailAccounts] = useState<Array<{ id: number; nome: string; username: string; ativo?: boolean }>>([]);
  const carregarContasEmail = useCallback(async () => {
    try {
      const { data, error } = await supabase.functions.invoke("email", { body: { action: "list_accounts" } });
      if (error || data?.error) return;
      setEmailAccounts(data?.accounts || []);
    } catch { /* silencioso */ }
  }, []);

  // Destinatários de e-mail (lista dinâmica)
  const addEmailDest = () => setForm((f) => ({ ...f, email_destinatarios: [...f.email_destinatarios, ""] }));
  const removeEmailDest = (i: number) => setForm((f) => ({ ...f, email_destinatarios: f.email_destinatarios.filter((_, idx) => idx !== i) }));
  const updateEmailDest = (i: number, v: string) => setForm((f) => ({ ...f, email_destinatarios: f.email_destinatarios.map((d, idx) => (idx === i ? v : d)) }));

  // Envia um e-mail de TESTE (só e-mail), renderizando o template com valores de exemplo.
  const [testandoEmail, setTestandoEmail] = useState(false);
  const enviarEmailTeste = async () => {
    const to = emailParaJoin(form.email_destinatarios);
    if (!to) { toast.error("Informe ao menos um destinatário de e-mail"); return; }
    if (!form.email_corpo.trim()) { toast.error("Preencha o corpo do e-mail"); return; }
    setTestandoEmail(true);
    try {
      const { data, error } = await supabase.functions.invoke("email", {
        body: {
          action: "send_custom",
          config_id: form.email_config_id || null,
          to,
          subject: (renderExemplo(form.email_assunto) || "Teste de notificação") + " (teste)",
          body: renderExemplo(form.email_corpo),
        },
      });
      if (error || data?.error) throw new Error(data?.error || error?.message);
      toast.success("E-mail de teste enviado");
    } catch (e: any) {
      toast.error(e?.message || "Falha ao enviar e-mail de teste");
    } finally {
      setTestandoEmail(false);
    }
  };

  // ---- Nova conta de e-mail (cadastro inline) ----
  const [contaModalOpen, setContaModalOpen] = useState(false);
  const [contaForm, setContaForm] = useState({ ...CONTA_VAZIA });
  const [salvandoConta, setSalvandoConta] = useState(false);
  const salvarNovaConta = async () => {
    if (!contaForm.username || !contaForm.password || !contaForm.smtp_host) {
      toast.error("Preencha ao menos usuário, senha e servidor SMTP"); return;
    }
    setSalvandoConta(true);
    try {
      const dados: any = {
        nome: contaForm.nome || contaForm.username,
        imap_host: contaForm.imap_host || contaForm.smtp_host, imap_port: Number(contaForm.imap_port) || 993,
        smtp_host: contaForm.smtp_host, smtp_port: Number(contaForm.smtp_port) || 465,
        username: contaForm.username, password: contaForm.password, from_name: contaForm.from_name, ativo: true,
      };
      const { data, error } = await (supabase as any).from("email_config").insert(dados).select("id").maybeSingle();
      if (error) throw new Error(error.message);
      await carregarContasEmail();
      const novoId = data?.id ?? null;
      if (novoId) setForm((f) => ({ ...f, email_config_id: Number(novoId) }));
      toast.success("Conta de e-mail adicionada");
      setContaModalOpen(false);
      setContaForm({ ...CONTA_VAZIA });
    } catch (e: any) {
      toast.error(e?.message || "Erro ao salvar conta");
    } finally {
      setSalvandoConta(false);
    }
  };

  // Sincroniza (em silêncio) o token do Meta para o servidor ao abrir a página
  useEffect(() => { syncMetaTokenToServer(); }, []);

  // ---- Notificações (CRUD) ----
  const { data: notificacoes = [] } = useQuery({
    queryKey: ["notificacoes"],
    queryFn: async () => {
      const { data, error } = await (supabase as any).from("notificacoes").select("*").order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []) as Notificacao[];
    },
  });

  // Histórico de envios de uma notificação
  const [logNotif, setLogNotif] = useState<Notificacao | null>(null);
  const { data: logs = [], isLoading: loadingLogs } = useQuery({
    queryKey: ["notificacao_logs", logNotif?.id],
    enabled: !!logNotif,
    queryFn: async () => {
      const { data } = await (supabase as any).from("notificacao_logs")
        .select("*").eq("notificacao_id", logNotif!.id).order("created_at", { ascending: false }).limit(200);
      return (data || []) as any[];
    },
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [deleting, setDeleting] = useState<Notificacao | null>(null);
  const [grupoPopoverIdx, setGrupoPopoverIdx] = useState<number | null>(null);

  // Carrega os grupos automaticamente ao abrir o dialog (se ainda não carregou)
  useEffect(() => {
    if (dialogOpen && isConnected && grupos.length === 0 && !loadingGrupos) {
      carregarGrupos();
    }
    if (dialogOpen && emailAccounts.length === 0) carregarContasEmail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen]);

  const addDest = () => setForm((f) => ({ ...f, destinatarios: [...f.destinatarios, { tipo: "grupo", valor: "", nome: "" }] }));
  const removeDest = (i: number) => setForm((f) => ({ ...f, destinatarios: f.destinatarios.filter((_, idx) => idx !== i) }));
  const updateDest = (i: number, patch: Partial<Dest>) =>
    setForm((f) => ({ ...f, destinatarios: f.destinatarios.map((d, idx) => (idx === i ? { ...d, ...patch } : d)) }));

  const abrirNovo = () => {
    setEditingId(null);
    setForm({ ...emptyForm, destinatarios: [{ tipo: "grupo", valor: "", nome: "" }] });
    setDialogOpen(true);
  };
  const abrirEdicao = (n: Notificacao) => {
    setEditingId(n.id);
    const dests: Dest[] = (n.destinatarios && n.destinatarios.length)
      ? n.destinatarios.map((d) => ({ tipo: d.tipo, valor: d.valor, nome: d.nome || "" }))
      : [{ tipo: n.destinatario_tipo || "grupo", valor: n.destinatario || "", nome: n.destinatario_nome || "" }];
    setForm({
      nome: n.nome, gatilho: n.gatilho, ativo: n.ativo,
      instancia: (n as any).instancia || "",
      destinatarios: dests, mensagem: n.mensagem,
      cidade_slug: n.cidade_slug, horario: n.horario || "09:00",
      disparo_dia_evento: (n as any).disparo_dia_evento || false,
      horario_evento: (n as any).horario_evento || "12:00",
      sheets_ativo: (n as any).sheets_ativo || false,
      sheets_spreadsheet_id: (n as any).sheets_spreadsheet_id || "",
      sheets_spreadsheet_nome: (n as any).sheets_spreadsheet_nome || "",
      sheets_aba: (n as any).sheets_aba || "",
      sheets_mapa: (n as any).sheets_mapa || {},
      email_ativo: (n as any).email_ativo || false,
      email_config_id: (n as any).email_config_id ?? null,
      email_destinatarios: (() => {
        const lista = String((n as any).email_para || "").split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
        return lista.length ? lista : [""];
      })(),
      email_assunto: (n as any).email_assunto || "",
      email_corpo: (n as any).email_corpo || "",
    });
    setDialogOpen(true);
  };

  // Persiste e retorna o id (sem fechar o dialog)
  const salvar = async (): Promise<string | null> => {
    const dests = form.destinatarios.filter((d) => d.valor.trim());
    if (!form.nome || dests.length === 0 || !form.mensagem) {
      toast.error("Preencha nome, ao menos um destinatário e a mensagem"); return null;
    }
    const payload = {
      nome: form.nome, gatilho: form.gatilho, ativo: form.ativo,
      instancia: form.instancia || null,
      mensagem: form.mensagem, cidade_slug: form.cidade_slug, horario: form.horario,
      disparo_dia_evento: form.disparo_dia_evento,
      horario_evento: form.horario_evento,
      destinatarios: dests,
      // legado (1º destinatário) para compatibilidade
      destinatario_tipo: dests[0].tipo, destinatario: dests[0].valor, destinatario_nome: dests[0].nome || null,
      sheets_ativo: form.sheets_ativo,
      sheets_spreadsheet_id: form.sheets_spreadsheet_id || null,
      sheets_spreadsheet_nome: form.sheets_spreadsheet_nome || null,
      sheets_aba: form.sheets_aba || null,
      sheets_mapa: form.sheets_mapa || {},
      email_ativo: form.email_ativo,
      email_config_id: form.email_config_id,
      email_para: emailParaJoin(form.email_destinatarios) || null,
      email_assunto: form.email_assunto || null,
      email_corpo: form.email_corpo || null,
    };
    if (form.email_ativo && (!emailParaJoin(form.email_destinatarios) || !form.email_corpo.trim())) {
      toast.error("E-mail ativo: preencha ao menos um destinatário e o corpo do e-mail"); return null;
    }
    if (editingId) {
      const { error } = await (supabase as any).from("notificacoes").update(payload).eq("id", editingId);
      if (error) { toast.error("Erro ao salvar notificação"); return null; }
      queryClient.invalidateQueries({ queryKey: ["notificacoes"] });
      return editingId;
    }
    const { data, error } = await (supabase as any).from("notificacoes").insert(payload).select("id").single();
    if (error) { toast.error("Erro ao salvar notificação"); return null; }
    setEditingId(data.id);
    queryClient.invalidateQueries({ queryKey: ["notificacoes"] });
    return data.id;
  };

  const salvarEFechar = async () => {
    const id = await salvar();
    if (id) { toast.success("Notificação salva"); setDialogOpen(false); }
  };

  const salvarETestar = async () => {
    setTestando(true);
    try {
      const id = await salvar();
      if (id) { await chamarUazapi("send_test", { notificacao_id: id }); toast.success("Teste enviado"); }
    } catch (e: any) {
      toast.error(e?.message || "Falha ao enviar teste");
    } finally {
      setTestando(false);
    }
  };

  const excluir = async () => {
    if (!deleting) return;
    await (supabase as any).from("notificacoes").delete().eq("id", deleting.id);
    setDeleting(null);
    queryClient.invalidateQueries({ queryKey: ["notificacoes"] });
    toast.success("Notificação excluída");
  };

  const toggleAtivo = async (n: Notificacao) => {
    await (supabase as any).from("notificacoes").update({ ativo: !n.ativo }).eq("id", n.id);
    queryClient.invalidateQueries({ queryKey: ["notificacoes"] });
  };

  const enviarTeste = async (id: string) => {
    setTestandoId(id);
    try {
      await chamarUazapi("send_test", { notificacao_id: id });
      toast.success("Mensagem de teste enviada");
    } catch (e: any) {
      toast.error(e?.message || "Falha ao enviar teste");
    } finally {
      setTestandoId(null);
    }
  };

  const mensagemRef = useRef<HTMLTextAreaElement>(null);
  const inserirVar = (v: string) => {
    const token = `{{${v}}}`;
    const ta = mensagemRef.current;
    if (ta) {
      const start = ta.selectionStart ?? form.mensagem.length;
      const end = ta.selectionEnd ?? form.mensagem.length;
      const novo = form.mensagem.slice(0, start) + token + form.mensagem.slice(end);
      setForm((f) => ({ ...f, mensagem: novo }));
      requestAnimationFrame(() => {
        ta.focus();
        const pos = start + token.length;
        ta.setSelectionRange(pos, pos);
      });
    } else {
      setForm((f) => ({ ...f, mensagem: f.mensagem + token }));
    }
  };

  // ---- Google Sheets (config por notificação) ----
  const [sheetsList, setSheetsList] = useState<{ id: string; name: string }[]>([]);
  const [tabsList, setTabsList] = useState<string[]>([]);
  const [headersList, setHeadersList] = useState<string[]>([]);
  const [loadingSheets, setLoadingSheets] = useState(false);
  const [sheetsPopover, setSheetsPopover] = useState(false);
  const [colarLink, setColarLink] = useState("");
  const [testandoSheets, setTestandoSheets] = useState(false);

  const testarSheets = async () => {
    if (!form.sheets_spreadsheet_id || !form.sheets_aba) { toast.error("Selecione planilha e aba"); return; }
    setTestandoSheets(true);
    const exemplo: Record<string, string> = {
      nome: "Fulano (teste)", email: "fulano@email.com", telefone: "5511999999999", documento: "000.000.000-00",
      produto: "Workshop Scale | São Paulo - SP", cidade: "São Paulo",
      valor: "R$ 247,00", tipo: "Individual", status: "Pagamento aprovado", quantidade: "1", pagamento: "Pix", forma_pagamento: "Pix",
      data: new Date().toLocaleDateString("pt-BR"),
      participantes: "120", vips: "15", convidados: "8", bilheteria: "R$ 30.000,00", bilheteria_resultado: "R$ 18.000,00",
      cac: "R$ 180,00", projecao: "150", investimento: "R$ 12.000,00", projecao_investimento: "R$ 20.000,00",
      total_cidades: "6", participantes_total: "540", bilheteria_total: "R$ 130.000,00", investimento_total: "R$ 60.000,00", bilheteria_resultado_total: "R$ 70.000,00",
    };
    const valores: Record<string, string> = {};
    for (const [col, tpl] of Object.entries(form.sheets_mapa)) {
      if (!tpl) continue;
      valores[col] = String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => exemplo[k] ?? "");
    }
    if (Object.keys(valores).length === 0) { toast.error("Mapeie ao menos uma coluna"); setTestandoSheets(false); return; }
    try {
      await gs("append", { spreadsheet_id: form.sheets_spreadsheet_id, aba: form.sheets_aba, valores });
      toast.success("Linha de teste adicionada na planilha!");
    } catch (e: any) { toast.error(e.message || "Erro ao escrever no Sheets"); }
    finally { setTestandoSheets(false); }
  };

  const usarLink = async () => {
    const m = colarLink.match(/\/d\/([a-zA-Z0-9-_]+)/) || colarLink.match(/([a-zA-Z0-9-_]{30,})/);
    const id = m?.[1];
    if (!id) { toast.error("Link ou ID inválido"); return; }
    try {
      const d = await gs("list_tabs", { spreadsheet_id: id });
      setForm((f) => ({ ...f, sheets_spreadsheet_id: id, sheets_spreadsheet_nome: d.title || "Planilha", sheets_aba: "", sheets_mapa: {} }));
      setTabsList(d.tabs || []); setHeadersList([]); setColarLink("");
      toast.success(`Planilha carregada: ${d.title || id}`);
    } catch (e: any) { toast.error(e.message || "Não consegui acessar (sem permissão?)"); }
  };

  const gs = async (action: string, extra: any = {}) => {
    const { data, error } = await (supabase as any).functions.invoke("google-sheets", { body: { action, ...extra } });
    if (error || data?.error) throw new Error(data?.error || error?.message || "Erro Google");
    return data;
  };
  const carregarPlanilhas = async () => {
    setLoadingSheets(true);
    try { const d = await gs("list_spreadsheets"); setSheetsList(d.files || []); }
    catch (e: any) { toast.error(e.message); } finally { setLoadingSheets(false); }
  };
  const carregarAbas = async (spreadsheetId: string) => {
    try { const d = await gs("list_tabs", { spreadsheet_id: spreadsheetId }); setTabsList(d.tabs || []); } catch (e: any) { toast.error(e.message); }
  };
  const carregarCabecalhos = async (spreadsheetId: string, aba: string) => {
    try { const d = await gs("list_headers", { spreadsheet_id: spreadsheetId, aba }); setHeadersList(d.headers || []); } catch (e: any) { toast.error(e.message); }
  };

  // Ao abrir uma notificação que já tem Sheets, recarrega abas/cabeçalhos.
  useEffect(() => {
    if (dialogOpen && form.sheets_ativo) {
      if (sheetsList.length === 0) carregarPlanilhas();
      if (form.sheets_spreadsheet_id) carregarAbas(form.sheets_spreadsheet_id);
      if (form.sheets_spreadsheet_id && form.sheets_aba) carregarCabecalhos(form.sheets_spreadsheet_id, form.sheets_aba);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen]);

  const gatilhoAtual = GATILHOS[form.gatilho];
  const precisaCidade = form.gatilho === "nova_venda" || form.gatilho === "resumo_cidade" || form.gatilho === "manual";
  const precisaHorario = form.gatilho === "resumo_cidade" || form.gatilho === "resumo_geral";

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full">
        <AppSidebar />
        <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
          <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-border bg-background/80 backdrop-blur-sm px-6 py-3">
            <SidebarTrigger />
            <div className="flex-1">
              <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
                <Bot className="h-5 w-5 text-primary" /> Notificações
              </h1>
              <p className="text-sm text-muted-foreground">
                Envie notificações no WhatsApp (UAZAPI) para grupos ou números
              </p>
            </div>
            <Button onClick={abrirNovo}>
              <Plus className="mr-2 h-4 w-4" /> Nova notificação
            </Button>
          </header>

          <div className="p-6 space-y-6">
            {/* Instâncias (pool compartilhado) */}
            <InstanciasUazapi
              funcao="uazapi"
              onInstancias={setInstancias}
              extraActions={(inst) => (
                (inst.status === "connected" || inst.status === "conectado")
                  ? <Button size="sm" variant="outline" onClick={() => carregarGrupos(inst.nome)} disabled={loadingGrupos}>
                      {loadingGrupos ? "Carregando..." : "Carregar grupos"}
                    </Button>
                  : null
              )}
            />

            {/* Lista de notificações */}
            <div className="space-y-3">
              {!isConnected && (
                <p className="text-sm text-muted-foreground">
                  Você pode criar e configurar notificações normalmente. Conecte o WhatsApp acima para <strong>enviar</strong> (testes e disparos).
                </p>
              )}
              {notificacoes.length === 0 ? (
                <Card><CardContent className="py-10 text-center text-muted-foreground">
                  Nenhuma notificação configurada ainda.
                </CardContent></Card>
              ) : (
                notificacoes.map((n) => (
                  <Card key={n.id}>
                    <CardContent className="flex items-center gap-4 py-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{n.nome}</span>
                          <Badge variant="secondary">{GATILHOS[n.gatilho]?.label || n.gatilho}</Badge>
                          {!n.ativo && <Badge variant="outline" className="text-muted-foreground">inativa</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 truncate">
                          → {((n.destinatarios && n.destinatarios.length)
                              ? n.destinatarios
                              : [{ tipo: n.destinatario_tipo, valor: n.destinatario, nome: n.destinatario_nome }]
                            ).map((d: any) => d.nome || d.valor).join(", ")}
                          {n.cidade_slug ? ` · ${n.cidade_slug}` : ""}{n.horario && (n.gatilho.startsWith("resumo")) ? ` · ${n.horario}` : ""}
                        </p>
                      </div>
                      <Switch checked={n.ativo} onCheckedChange={() => toggleAtivo(n)} />
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => enviarTeste(n.id)} disabled={testandoId === n.id} title="Enviar teste">
                        {testandoId === n.id ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setLogNotif(n)} title="Histórico de envios">
                        <History className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => abrirEdicao(n)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => setDeleting(n)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </div>
        </main>
      </div>

      {/* Dialog de edição */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? "Editar notificação" : "Nova notificação"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Nome</Label>
              <Input value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} placeholder="Ex: Aviso de venda no grupo" />
            </div>
            <div className="space-y-1">
              <Label>Gatilho</Label>
              <Select value={form.gatilho} onValueChange={(v) => setForm({ ...form, gatilho: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(GATILHOS).map(([k, g]) => (
                    <SelectItem key={k} value={k}>{g.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{gatilhoAtual?.desc}</p>
            </div>

            <div className="space-y-1 md:col-span-2">
              <Label>Instância de envio</Label>
              <Select value={form.instancia || ""} onValueChange={(v) => setForm({ ...form, instancia: v })}>
                <SelectTrigger><SelectValue placeholder="Selecione a instância" /></SelectTrigger>
                <SelectContent>
                  {instancias.length === 0
                    ? <SelectItem value="__none" disabled>nenhuma instância criada</SelectItem>
                    : instancias.map((i) => (
                        <SelectItem key={i.nome} value={i.nome}>
                          {i.nome}{(i.status === "connected" || i.status === "conectado") ? " · conectada" : ` · ${i.status}`}
                        </SelectItem>
                      ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">De qual WhatsApp essa notificação será enviada.</p>
            </div>

            <div className="space-y-2 md:col-span-2">
              <Label>Destinatários</Label>
              {form.destinatarios.map((d, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <Select value={d.tipo} onValueChange={(v) => updateDest(i, { tipo: v, valor: "", nome: "" })}>
                    <SelectTrigger className="w-[110px] shrink-0"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="grupo">Grupo</SelectItem>
                      <SelectItem value="numero">Número</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="flex-1 min-w-0">
                    {d.tipo === "grupo" ? (
                      loadingGrupos ? (
                        <div className="flex items-center gap-2 h-10 px-3 rounded-md border border-input text-sm text-muted-foreground">
                          <RefreshCw className="h-4 w-4 animate-spin" /> Carregando...
                        </div>
                      ) : grupos.length > 0 ? (
                        <Popover open={grupoPopoverIdx === i} onOpenChange={(o) => setGrupoPopoverIdx(o ? i : null)}>
                          <PopoverTrigger asChild>
                            <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
                              <span className="truncate">{d.valor ? (d.nome || d.valor) : "Selecione um grupo"}</span>
                              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                            <Command>
                              <CommandInput placeholder="Pesquisar grupo..." />
                              <CommandList>
                                <CommandEmpty>Nenhum grupo encontrado.</CommandEmpty>
                                <CommandGroup>
                                  {grupos.map((g) => (
                                    <CommandItem key={g.id} value={`${g.name} ${g.id}`}
                                      onSelect={() => { updateDest(i, { valor: g.id, nome: g.name }); setGrupoPopoverIdx(null); }}>
                                      <Check className={`mr-2 h-4 w-4 ${d.valor === g.id ? "opacity-100" : "opacity-0"}`} />
                                      <span className="truncate">{g.name}</span>
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              </CommandList>
                            </Command>
                          </PopoverContent>
                        </Popover>
                      ) : (
                        <Input value={d.valor} onChange={(e) => updateDest(i, { valor: e.target.value })}
                          placeholder="ID do grupo (xxxx@g.us)" />
                      )
                    ) : (
                      <Input value={d.valor} onChange={(e) => updateDest(i, { valor: e.target.value })}
                        placeholder="5591999999999" />
                    )}
                  </div>
                  <Button type="button" variant="ghost" size="icon" className="shrink-0 text-destructive"
                    onClick={() => removeDest(i)} disabled={form.destinatarios.length === 1}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={addDest}>
                <Plus className="mr-2 h-4 w-4" /> Adicionar destinatário
              </Button>
            </div>

            {precisaCidade && (
              <div className="space-y-1">
                <Label>Cidade (filtro)</Label>
                <Select value={form.cidade_slug || "all"} onValueChange={(v) => setForm({ ...form, cidade_slug: v === "all" ? null : v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todas as cidades</SelectItem>
                    {cidades.map((c) => <SelectItem key={c.id} value={c.slug}>{c.nome}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            {precisaHorario && (
              <div className="space-y-1">
                <Label>Horário do envio</Label>
                <Input type="time" value={form.horario || ""} onChange={(e) => setForm({ ...form, horario: e.target.value })} />
              </div>
            )}

            {form.gatilho === "resumo_cidade" && (
              <div className="md:col-span-2 space-y-2 rounded-md border border-border p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label>Disparo extra no dia do evento</Label>
                    <p className="text-[11px] text-muted-foreground">
                      No dia do evento, dispara também só da cidade do evento daquele dia (ignora as demais)
                      e envia <strong>apenas para os números</strong> (não para grupos).
                    </p>
                  </div>
                  <Switch checked={form.disparo_dia_evento} onCheckedChange={(v) => setForm({ ...form, disparo_dia_evento: v })} />
                </div>
                {form.disparo_dia_evento && (
                  <div className="space-y-1">
                    <Label>Horário do disparo no dia do evento</Label>
                    <Input type="time" value={form.horario_evento || ""} onChange={(e) => setForm({ ...form, horario_evento: e.target.value })} />
                  </div>
                )}
              </div>
            )}

            <div className="space-y-1 md:col-span-2">
              <Label>Mensagem</Label>
              {gatilhoAtual?.vars.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-1">
                  <span className="text-xs text-muted-foreground mr-1">Variáveis:</span>
                  {gatilhoAtual.vars.map((v) => (
                    <button key={v} type="button" onClick={() => inserirVar(v)}
                      className="text-xs px-2 py-0.5 rounded bg-muted hover:bg-accent transition-colors">
                      {`{{${v}}}`}
                    </button>
                  ))}
                </div>
              )}
              <Textarea ref={mensagemRef} rows={5} value={form.mensagem} onChange={(e) => setForm({ ...form, mensagem: e.target.value })}
                placeholder={"Ex: 🎉 Nova venda em {{cidade}}!\nProduto: {{produto}}\nValor: {{valor}}\nComprador: {{nome}}"} />
            </div>

            {/* Google Sheets */}
            <div className="md:col-span-2 rounded-md border p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label>Enviar também ao Google Sheets</Label>
                  <p className="text-xs text-muted-foreground">Grava uma linha na planilha a cada envio.</p>
                </div>
                <Switch checked={form.sheets_ativo} onCheckedChange={(v) => {
                  setForm({ ...form, sheets_ativo: v });
                  if (v && sheetsList.length === 0) carregarPlanilhas();
                }} />
              </div>
              {form.sheets_ativo && (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1"><Label className="text-xs flex items-center gap-2">Planilha
                      <button type="button" onClick={() => carregarPlanilhas()} className="text-muted-foreground hover:text-foreground" title="Atualizar lista">
                        <RefreshCw className={`h-3 w-3 ${loadingSheets ? "animate-spin" : ""}`} />
                      </button>
                    </Label>
                      <Popover open={sheetsPopover} onOpenChange={setSheetsPopover}>
                        <PopoverTrigger asChild>
                          <Button variant="outline" className="w-full justify-between font-normal">
                            <span className="truncate">{form.sheets_spreadsheet_nome || (loadingSheets ? "Carregando..." : "Selecione")}</span>
                            <ChevronsUpDown className="ml-2 h-4 w-4 opacity-50 shrink-0" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[280px] p-0" align="start">
                          <Command>
                            <CommandInput placeholder="Buscar planilha..." />
                            <CommandList>
                              <CommandEmpty>Nenhuma planilha encontrada</CommandEmpty>
                              <CommandGroup>
                                {sheetsList.map((s) => (
                                  <CommandItem key={s.id} value={s.name} onSelect={() => {
                                    setForm({ ...form, sheets_spreadsheet_id: s.id, sheets_spreadsheet_nome: s.name, sheets_aba: "", sheets_mapa: {} });
                                    setHeadersList([]); carregarAbas(s.id); setSheetsPopover(false);
                                  }}>
                                    <Check className={`mr-2 h-4 w-4 ${form.sheets_spreadsheet_id === s.id ? "opacity-100" : "opacity-0"}`} />
                                    <span className="truncate">{s.name}</span>
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    </div>
                    <div className="space-y-1"><Label className="text-xs flex items-center gap-2">Aba
                      <button type="button" disabled={!form.sheets_spreadsheet_id} onClick={() => carregarAbas(form.sheets_spreadsheet_id)} className="text-muted-foreground hover:text-foreground disabled:opacity-30" title="Atualizar abas">
                        <RefreshCw className="h-3 w-3" />
                      </button>
                    </Label>
                      <Select value={form.sheets_aba || undefined} disabled={!form.sheets_spreadsheet_id}
                        onValueChange={(v) => { setForm({ ...form, sheets_aba: v }); carregarCabecalhos(form.sheets_spreadsheet_id, v); }}>
                        <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                        <SelectContent>{tabsList.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="flex items-end gap-2">
                    <div className="flex-1 space-y-1">
                      <Label className="text-xs">Ou cole o link/ID da planilha (ex.: Drive compartilhado)</Label>
                      <Input value={colarLink} onChange={(e) => setColarLink(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/..." />
                    </div>
                    <Button variant="outline" onClick={usarLink} disabled={!colarLink.trim()}>Usar</Button>
                  </div>
                  {headersList.length > 0 && (
                    <div className="space-y-2">
                      <Label className="text-xs">Mapear colunas → dados</Label>
                      {headersList.map((h) => (
                        <div key={h} className="flex items-center gap-2">
                          <span className="text-xs w-32 truncate" title={h}>{h}</span>
                          <Select value={form.sheets_mapa[h] || "_none"}
                            onValueChange={(v) => setForm({ ...form, sheets_mapa: { ...form.sheets_mapa, [h]: v === "_none" ? "" : v } })}>
                            <SelectTrigger className="h-8 flex-1"><SelectValue placeholder="—" /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="_none">— vazio</SelectItem>
                              {gatilhoAtual?.vars.map((v) => <SelectItem key={v} value={`{{${v}}}`}>{`{{${v}}}`}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                      <p className="text-[11px] text-muted-foreground">As colunas vêm do cabeçalho (linha 1) da aba. Deixe "vazio" nas que não quer preencher.</p>
                      <Button variant="outline" size="sm" onClick={testarSheets} disabled={testandoSheets}>
                        {testandoSheets ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                        {testandoSheets ? "Enviando..." : "Testar no Sheets (linha de exemplo)"}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Envio por E-mail */}
            <div className="md:col-span-2 rounded-md border p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label>Enviar também por e-mail</Label>
                  <p className="text-xs text-muted-foreground">Dispara um e-mail (SMTP) a cada notificação, com título e corpo configuráveis.</p>
                </div>
                <Switch checked={form.email_ativo} onCheckedChange={(v) => {
                  setForm({ ...form, email_ativo: v });
                  if (v && emailAccounts.length === 0) carregarContasEmail();
                }} />
              </div>
              {form.email_ativo && (
                <div className="space-y-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label className="text-xs flex items-center gap-2">Conta de envio
                        <button type="button" onClick={() => carregarContasEmail()} className="text-muted-foreground hover:text-foreground" title="Atualizar contas">
                          <RefreshCw className="h-3 w-3" />
                        </button>
                        <button type="button" onClick={() => { setContaForm({ ...CONTA_VAZIA }); setContaModalOpen(true); }} className="ml-auto text-primary hover:underline text-[11px] flex items-center gap-1">
                          <Plus className="h-3 w-3" /> Nova conta
                        </button>
                      </Label>
                      <Select
                        value={form.email_config_id != null ? String(form.email_config_id) : ""}
                        onValueChange={(v) => setForm({ ...form, email_config_id: v ? Number(v) : null })}
                      >
                        <SelectTrigger><SelectValue placeholder={emailAccounts.length ? "Selecione a conta" : "Nenhuma conta configurada"} /></SelectTrigger>
                        <SelectContent>
                          {emailAccounts.map((a) => (
                            <SelectItem key={a.id} value={String(a.id)}>{a.nome}{a.ativo === false ? " · inativa" : ""}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-[11px] text-muted-foreground">A conta de e-mail (SMTP) é cadastrada no módulo de E-mail dos Eventos.</p>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Para (destinatários)</Label>
                      {form.email_destinatarios.map((d, i) => (
                        <div key={i} className="flex gap-2 items-center">
                          <Input value={d} onChange={(e) => updateEmailDest(i, e.target.value)}
                            placeholder="email@empresa.com ou {{email}}" />
                          <Button type="button" variant="ghost" size="icon" className="shrink-0 text-destructive"
                            onClick={() => removeEmailDest(i)} disabled={form.email_destinatarios.length === 1}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                      <Button type="button" variant="outline" size="sm" onClick={addEmailDest}>
                        <Plus className="mr-2 h-4 w-4" /> Adicionar e-mail
                      </Button>
                      <p className="text-[11px] text-muted-foreground">Um por linha. Aceita variáveis (ex.: {"{{email}}"} envia ao comprador).</p>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Título (assunto)</Label>
                    <Input value={form.email_assunto} onChange={(e) => setForm({ ...form, email_assunto: e.target.value })}
                      placeholder="Nova venda Inside Sales — {{nome}}" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Corpo do e-mail</Label>
                    {gatilhoAtual?.vars.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-1">
                        <span className="text-xs text-muted-foreground mr-1">Variáveis:</span>
                        {gatilhoAtual.vars.map((v) => (
                          <button key={v} type="button" onClick={() => setForm((f) => ({ ...f, email_corpo: f.email_corpo + `{{${v}}}` }))}
                            className="text-xs px-2 py-0.5 rounded bg-muted hover:bg-accent transition-colors">
                            {`{{${v}}}`}
                          </button>
                        ))}
                      </div>
                    )}
                    <Textarea rows={6} value={form.email_corpo} onChange={(e) => setForm({ ...form, email_corpo: e.target.value })}
                      placeholder={"Olá,\n\nNova venda registrada:\nCliente: {{nome}}\nProduto: {{produto}}\nValor: {{valor}}\nOrigem: {{origem}}"} />
                    <p className="text-[11px] text-muted-foreground">Pode usar HTML. As mesmas variáveis da mensagem do WhatsApp valem aqui.</p>
                  </div>
                  <Button variant="outline" size="sm" onClick={enviarEmailTeste} disabled={testandoEmail}>
                    {testandoEmail ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                    {testandoEmail ? "Enviando..." : "Enviar e-mail de teste"}
                  </Button>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between md:col-span-2 rounded-md border p-3">
              <div>
                <Label>Ativa</Label>
                <p className="text-xs text-muted-foreground">Notificações inativas não disparam.</p>
              </div>
              <Switch checked={form.ativo} onCheckedChange={(v) => setForm({ ...form, ativo: v })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancelar</Button>
            <Button variant="secondary" onClick={salvarETestar} disabled={testando}>
              {testando ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              {testando ? "Enviando..." : "Salvar e testar"}
            </Button>
            <Button onClick={salvarEFechar}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Nova conta de e-mail (cadastro inline) */}
      <Dialog open={contaModalOpen} onOpenChange={setContaModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Nova conta de e-mail</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Nome (apelido)</Label>
              <Input value={contaForm.nome} onChange={(e) => setContaForm({ ...contaForm, nome: e.target.value })} placeholder="Ex: Comercial" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">E-mail (usuário)</Label>
                <Input value={contaForm.username} onChange={(e) => setContaForm({ ...contaForm, username: e.target.value })} placeholder="vendas@seudominio.com.br" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Senha</Label>
                <Input type="password" value={contaForm.password} onChange={(e) => setContaForm({ ...contaForm, password: e.target.value })} placeholder="senha do e-mail" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Nome de exibição (De)</Label>
              <Input value={contaForm.from_name} onChange={(e) => setContaForm({ ...contaForm, from_name: e.target.value })} placeholder="Equipe Scale" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Servidor SMTP (envio)</Label>
                <Input value={contaForm.smtp_host} onChange={(e) => setContaForm({ ...contaForm, smtp_host: e.target.value })} placeholder="mail.seudominio.com.br" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Porta SMTP</Label>
                <Input type="number" value={contaForm.smtp_port} onChange={(e) => setContaForm({ ...contaForm, smtp_port: Number(e.target.value) || 465 })} placeholder="465" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Servidor IMAP (opcional)</Label>
                <Input value={contaForm.imap_host} onChange={(e) => setContaForm({ ...contaForm, imap_host: e.target.value })} placeholder="igual ao SMTP se vazio" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Porta IMAP</Label>
                <Input type="number" value={contaForm.imap_port} onChange={(e) => setContaForm({ ...contaForm, imap_port: Number(e.target.value) || 993 })} placeholder="993" />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">Para só enviar (notificações) basta SMTP. O IMAP é usado pelo módulo de E-mail dos Eventos.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setContaModalOpen(false)}>Cancelar</Button>
            <Button onClick={salvarNovaConta} disabled={salvandoConta}>
              {salvandoConta ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              {salvandoConta ? "Salvando..." : "Adicionar conta"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Histórico de envios */}
      <Dialog open={!!logNotif} onOpenChange={(o) => !o && setLogNotif(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="h-5 w-5 text-primary" /> Histórico — {logNotif?.nome}
            </DialogTitle>
          </DialogHeader>
          {logNotif && (
            <p className="text-xs text-muted-foreground -mt-2">
              Gatilho: {GATILHOS[logNotif.gatilho]?.label || logNotif.gatilho}
            </p>
          )}
          <div className="space-y-2">
            {loadingLogs ? (
              <p className="text-sm text-muted-foreground py-4 text-center">Carregando...</p>
            ) : logs.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">Nenhum envio registrado ainda.</p>
            ) : (
              logs.map((l) => (
                <div key={l.id} className="rounded-md border border-border p-3 space-y-1">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-xs font-medium flex items-center gap-1.5">
                      {l.status === "erro"
                        ? <XCircle className="h-3.5 w-3.5 text-destructive" />
                        : <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
                      {new Date(l.created_at).toLocaleString("pt-BR")}
                    </span>
                    <div className="flex items-center gap-1 flex-wrap">
                      {l.cidade && <Badge variant="outline" className="text-[10px]">{l.cidade}</Badge>}
                      <Badge variant="secondary" className="text-[10px]">{l.destinatario}</Badge>
                    </div>
                  </div>
                  {l.erro && <p className="text-xs text-destructive">Erro: {l.erro}</p>}
                  <p className="text-sm whitespace-pre-wrap text-muted-foreground bg-muted/40 rounded p-2">{l.mensagem}</p>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir notificação?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleting?.nome}" será removida permanentemente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={excluir} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarProvider>
  );
}
