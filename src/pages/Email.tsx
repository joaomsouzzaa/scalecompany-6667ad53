import { useState } from "react";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Mail, RefreshCw, Send, Plug, Sparkles, Loader2, Plus, Pencil } from "lucide-react";

// Chama a edge function `email` e extrai a mensagem de erro REAL do corpo da
// resposta (supabase.functions.invoke só expõe "non-2xx status code" no error).
async function invokeEmail(body: Record<string, unknown>): Promise<any> {
  const { data, error } = await supabase.functions.invoke("email", { body });
  if (error) {
    let msg = error.message;
    try {
      const ctx = (error as any).context;
      if (ctx && typeof ctx.text === "function") {
        const txt = await ctx.text();
        try { msg = JSON.parse(txt)?.error || txt || msg; } catch { msg = txt || msg; }
      }
    } catch { /* mantém msg */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

type Conta = {
  id: number;
  nome: string | null;
  imap_host: string | null; imap_port: number | null;
  smtp_host: string | null; smtp_port: number | null;
  username: string | null; password: string | null;
  from_name: string | null;
  whatsapp_destino: string | null;
  keywords: string[] | null;
  ativo: boolean;
  ultima_execucao: string | null;
};

type EmailMsg = {
  id: string;
  from_email: string | null;
  from_name: string | null;
  subject: string | null;
  received_at: string | null;
  body: string | null;
  resumo: string | null;
  categoria: string | null;
  draft_reply: string | null;
  status: string;
  replied_at: string | null;
};

const STATUS_LABEL: Record<string, string> = { novo: "Novo", respondido: "Respondido", ignorado: "Ignorado" };
const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = { novo: "default", respondido: "secondary", ignorado: "outline" };

const FORM_VAZIO = {
  id: 0, nome: "", imap_host: "", imap_port: 993, smtp_host: "", smtp_port: 465,
  username: "", password: "", from_name: "", whatsapp_destino: "", keywords: "", ativo: true,
};

export default function Email() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("novo");
  const [aberto, setAberto] = useState<EmailMsg | null>(null);
  const [respostaEdit, setRespostaEdit] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [regenerando, setRegenerando] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);

  // Modal de conta (adicionar/editar)
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({ ...FORM_VAZIO });
  const [salvando, setSalvando] = useState(false);
  const [testando, setTestando] = useState(false);

  const { data: contas = [], isLoading: loadingContas } = useQuery({
    queryKey: ["email-contas"],
    queryFn: async () => {
      const { data, error } = await supabase.from("email_config").select("*").order("id");
      if (error) throw error;
      return (data || []) as Conta[];
    },
  });

  const { data: emails = [], isLoading } = useQuery({
    queryKey: ["email-mensagens", statusFilter],
    queryFn: async () => {
      let q = supabase.from("email_mensagens").select("*").order("received_at", { ascending: false });
      if (statusFilter !== "todos") q = q.eq("status", statusFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as EmailMsg[];
    },
    refetchInterval: 60_000,
  });

  const novaConta = () => { setForm({ ...FORM_VAZIO }); setModalOpen(true); };
  const editarConta = (c: Conta) => {
    setForm({
      id: c.id, nome: c.nome || "", imap_host: c.imap_host || "", imap_port: c.imap_port || 993,
      smtp_host: c.smtp_host || "", smtp_port: c.smtp_port || 465,
      username: c.username || "", password: c.password || "", from_name: c.from_name || "",
      whatsapp_destino: c.whatsapp_destino || "", keywords: (c.keywords || []).join(", "), ativo: c.ativo ?? true,
    });
    setModalOpen(true);
  };

  // Salva e devolve o id da conta (insere se nova, atualiza se editando).
  const salvarConta = async (): Promise<number | null> => {
    const keywords = form.keywords.split(",").map((k) => k.trim()).filter(Boolean);
    const dados: any = {
      nome: form.nome || form.username, imap_host: form.imap_host, imap_port: Number(form.imap_port) || 993,
      smtp_host: form.smtp_host, smtp_port: Number(form.smtp_port) || 465,
      username: form.username, password: form.password, from_name: form.from_name,
      whatsapp_destino: form.whatsapp_destino, keywords, ativo: form.ativo,
    };
    if (form.id) {
      const { error } = await supabase.from("email_config").update(dados).eq("id", form.id);
      if (error) { toast.error("Erro ao salvar: " + error.message); return null; }
      queryClient.invalidateQueries({ queryKey: ["email-contas"] });
      return form.id;
    }
    const { data, error } = await supabase.from("email_config").insert(dados).select("id").maybeSingle();
    if (error) { toast.error("Erro ao salvar: " + error.message); return null; }
    const novoId = (data as any)?.id ?? null;
    if (novoId) setForm((f) => ({ ...f, id: novoId }));
    queryClient.invalidateQueries({ queryKey: ["email-contas"] });
    return novoId;
  };

  const onSalvar = async () => {
    setSalvando(true);
    const id = await salvarConta();
    setSalvando(false);
    if (id) { toast.success("Conta salva"); setModalOpen(false); }
  };

  const onTestar = async () => {
    setTestando(true);
    try {
      const id = await salvarConta();
      if (!id) return;
      const data = await invokeEmail({ action: "test_connection", id });
      toast.success(data?.message || "Conexão OK");
    } catch (e: any) {
      toast.error("Falha na conexão: " + (e?.message || e));
    } finally {
      setTestando(false);
    }
  };

  const sincronizar = async () => {
    setSincronizando(true);
    try {
      const data = await invokeEmail({ action: "fetch_emails" });
      toast.success(`${data?.inserted ?? 0} novo(s) e-mail(s) em ${data?.contas ?? 0} conta(s)`);
      queryClient.invalidateQueries({ queryKey: ["email-mensagens"] });
    } catch (e: any) {
      toast.error("Erro: " + (e?.message || e));
    } finally {
      setSincronizando(false);
    }
  };

  const abrir = (e: EmailMsg) => { setAberto(e); setRespostaEdit(e.draft_reply || ""); };

  const regenerar = async () => {
    if (!aberto) return;
    setRegenerando(true);
    try {
      const data = await invokeEmail({ action: "regenerate_draft", id: aberto.id });
      setRespostaEdit(data.draft || "");
      toast.success("Rascunho regenerado");
      queryClient.invalidateQueries({ queryKey: ["email-mensagens"] });
    } catch (e: any) {
      toast.error("Erro: " + (e?.message || e));
    } finally {
      setRegenerando(false);
    }
  };

  const responder = async () => {
    if (!aberto) return;
    setEnviando(true);
    try {
      await invokeEmail({ action: "send_reply", id: aberto.id, reply: respostaEdit });
      toast.success("Resposta enviada");
      setAberto(null);
      queryClient.invalidateQueries({ queryKey: ["email-mensagens"] });
    } catch (e: any) {
      toast.error("Erro ao enviar: " + (e?.message || e));
    } finally {
      setEnviando(false);
    }
  };

  const ignorar = async (e: EmailMsg) => {
    const { error } = await supabase.from("email_mensagens").update({ status: "ignorado" }).eq("id", e.id);
    if (error) { toast.error(error.message); return; }
    queryClient.invalidateQueries({ queryKey: ["email-mensagens"] });
  };

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full">
        <AppSidebar />
        <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
          <header className="sticky top-0 z-10 flex items-center gap-4 border-b bg-background/80 backdrop-blur px-6 py-3">
            <SidebarTrigger />
            <div className="flex items-center gap-2">
              <Mail className="h-5 w-5" />
              <div>
                <h1 className="text-xl font-bold">E-mail</h1>
                <p className="text-sm text-muted-foreground">Captura, resumo e resposta de e-mails de eventos</p>
              </div>
            </div>
            <div className="ml-auto">
              <Button onClick={sincronizar} disabled={sincronizando}>
                {sincronizando ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Sincronizar agora
              </Button>
            </div>
          </header>

          <div className="p-6 space-y-6">
            {/* Contas conectadas */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold">Contas de e-mail</h2>
                <Button size="sm" variant="secondary" onClick={novaConta}>
                  <Plus className="h-4 w-4" /> Adicionar conta
                </Button>
              </div>
              {loadingContas ? (
                <Skeleton className="h-16 w-full" />
              ) : contas.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">Nenhuma conta cadastrada. Clique em "Adicionar conta".</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {contas.map((c) => (
                    <Card key={c.id}>
                      <CardContent className="py-4 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium truncate">{c.nome || c.username}</span>
                            <Badge variant={c.ativo ? "default" : "outline"} className="text-xs">{c.ativo ? "Ativa" : "Inativa"}</Badge>
                          </div>
                          <p className="text-sm text-muted-foreground truncate">{c.username}</p>
                          {c.ultima_execucao && (
                            <p className="text-xs text-muted-foreground mt-1">Última captura: {new Date(c.ultima_execucao).toLocaleString("pt-BR")}</p>
                          )}
                        </div>
                        <Button size="sm" variant="ghost" onClick={() => editarConta(c)}><Pencil className="h-4 w-4" /> Editar</Button>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>

            {/* Inbox */}
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold">Caixa de entrada</h2>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="novo">Novos</SelectItem>
                  <SelectItem value="respondido">Respondidos</SelectItem>
                  <SelectItem value="ignorado">Ignorados</SelectItem>
                  <SelectItem value="todos">Todos</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {isLoading ? (
              <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
            ) : emails.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">Nenhum e-mail aqui.</p>
            ) : (
              <div className="space-y-3">
                {emails.map((e) => (
                  <Card key={e.id} className="cursor-pointer hover:bg-accent/40 transition-colors" onClick={() => abrir(e)}>
                    <CardContent className="py-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium truncate">{e.from_name || e.from_email}</span>
                            {e.categoria && <Badge variant="outline" className="text-xs">{e.categoria}</Badge>}
                            <Badge variant={STATUS_VARIANT[e.status] || "default"} className="text-xs">{STATUS_LABEL[e.status] || e.status}</Badge>
                          </div>
                          <p className="text-sm font-medium mt-1 truncate">{e.subject}</p>
                          <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">{e.resumo || "(sem resumo)"}</p>
                        </div>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {e.received_at ? new Date(e.received_at).toLocaleString("pt-BR") : ""}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>

          {/* Modal de conta */}
          <Dialog open={modalOpen} onOpenChange={setModalOpen}>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-base">
                  <Plug className="h-4 w-4" /> {form.id ? "Editar conta" : "Nova conta de e-mail"}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Nome da conta (identificação)</Label>
                  <Input placeholder="Ex.: Eventos Raphael" value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>Servidor IMAP (leitura)</Label>
                    <Input placeholder="mail.seudominio.com" value={form.imap_host} onChange={(e) => setForm({ ...form, imap_host: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Porta IMAP</Label>
                    <Input type="number" value={form.imap_port} onChange={(e) => setForm({ ...form, imap_port: Number(e.target.value) })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Servidor SMTP (envio)</Label>
                    <Input placeholder="mail.seudominio.com" value={form.smtp_host} onChange={(e) => setForm({ ...form, smtp_host: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Porta SMTP</Label>
                    <Input type="number" value={form.smtp_port} onChange={(e) => setForm({ ...form, smtp_port: Number(e.target.value) })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>E-mail (login)</Label>
                    <Input placeholder="contato@seudominio.com" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Senha</Label>
                    <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Nome de exibição (remetente)</Label>
                    <Input placeholder="Equipe Scale" value={form.from_name} onChange={(e) => setForm({ ...form, from_name: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>WhatsApp do relatório (número)</Label>
                    <Input placeholder="5581999999999" value={form.whatsapp_destino} onChange={(e) => setForm({ ...form, whatsapp_destino: e.target.value })} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Palavras-chave (separadas por vírgula)</Label>
                  <Textarea rows={2} value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} />
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={form.ativo} onCheckedChange={(v) => setForm({ ...form, ativo: v })} />
                  <Label>Captura diária ativa (8h)</Label>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="outline" onClick={onTestar} disabled={testando}>
                    {testando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />} Testar conexão
                  </Button>
                  <Button onClick={onSalvar} disabled={salvando}>
                    {salvando && <Loader2 className="h-4 w-4 animate-spin" />} Salvar
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          {/* Painel de aprovação */}
          <Dialog open={!!aberto} onOpenChange={(o) => !o && setAberto(null)}>
            <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
              {aberto && (
                <>
                  <DialogHeader>
                    <DialogTitle className="text-base">{aberto.subject}</DialogTitle>
                    <p className="text-sm text-muted-foreground">
                      De: {aberto.from_name ? `${aberto.from_name} <${aberto.from_email}>` : aberto.from_email}
                    </p>
                  </DialogHeader>

                  <div className="space-y-4">
                    <div>
                      <Label className="text-xs uppercase text-muted-foreground">E-mail recebido</Label>
                      <div className="mt-1 text-sm whitespace-pre-wrap rounded-md border p-3 max-h-60 overflow-y-auto bg-muted/30">
                        {aberto.body || "(vazio)"}
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center justify-between">
                        <Label className="text-xs uppercase text-muted-foreground">Rascunho de resposta (IA)</Label>
                        <Button size="sm" variant="ghost" onClick={regenerar} disabled={regenerando}>
                          {regenerando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Regenerar
                        </Button>
                      </div>
                      <Textarea rows={10} className="mt-1" value={respostaEdit} onChange={(e) => setRespostaEdit(e.target.value)} />
                    </div>

                    <div className="flex justify-end gap-2">
                      <Button variant="outline" onClick={() => { ignorar(aberto); setAberto(null); }}>Ignorar</Button>
                      <Button onClick={responder} disabled={enviando || aberto.status === "respondido"}>
                        {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                        {aberto.status === "respondido" ? "Já respondido" : "Aprovar e responder"}
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </DialogContent>
          </Dialog>
        </main>
      </div>
    </SidebarProvider>
  );
}
