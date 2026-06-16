import { useState, useEffect } from "react";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Mail, RefreshCw, Send, Plug, Sparkles, Loader2 } from "lucide-react";

type EmailMsg = {
  id: string;
  remetente: string;
  remetente_nome: string | null;
  assunto: string | null;
  recebido_em: string | null;
  corpo: string | null;
  resumo: string | null;
  categoria: string | null;
  rascunho_resposta: string | null;
  status: string;
  respondido_em: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  novo: "Novo",
  aprovado: "Aprovado",
  respondido: "Respondido",
  ignorado: "Ignorado",
};
const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  novo: "default",
  respondido: "secondary",
  ignorado: "outline",
  aprovado: "secondary",
};

export default function Email() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("novo");
  const [aberto, setAberto] = useState<EmailMsg | null>(null);
  const [respostaEdit, setRespostaEdit] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [regenerando, setRegenerando] = useState(false);
  const [sincronizando, setSincronizando] = useState(false);

  // ---- Config ----
  const [form, setForm] = useState({
    imap_host: "", imap_port: 993, smtp_host: "", smtp_port: 465,
    email_usuario: "", senha: "", whatsapp_destino: "", keywords: "", ativo: true,
  });
  const [salvando, setSalvando] = useState(false);
  const [testando, setTestando] = useState(false);

  const { data: cfg } = useQuery({
    queryKey: ["email-config"],
    queryFn: async () => {
      const { data, error } = await supabase.from("email_config").select("*").maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (cfg) {
      setForm({
        imap_host: cfg.imap_host || "", imap_port: cfg.imap_port || 993,
        smtp_host: cfg.smtp_host || "", smtp_port: cfg.smtp_port || 465,
        email_usuario: cfg.email_usuario || "", senha: cfg.senha || "",
        whatsapp_destino: cfg.whatsapp_destino || "",
        keywords: (cfg.keywords || []).join(", "), ativo: cfg.ativo ?? true,
      });
    }
  }, [cfg]);

  const { data: emails = [], isLoading } = useQuery({
    queryKey: ["email-mensagens", statusFilter],
    queryFn: async () => {
      let q = supabase.from("email_mensagens").select("*").order("recebido_em", { ascending: false });
      if (statusFilter !== "todos") q = q.eq("status", statusFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as EmailMsg[];
    },
    refetchInterval: 60_000,
  });

  const salvarConfig = async () => {
    setSalvando(true);
    const keywords = form.keywords.split(",").map((k) => k.trim()).filter(Boolean);
    const { error } = await supabase.from("email_config").upsert({
      id: 1, imap_host: form.imap_host, imap_port: Number(form.imap_port) || 993,
      smtp_host: form.smtp_host, smtp_port: Number(form.smtp_port) || 465,
      email_usuario: form.email_usuario, senha: form.senha,
      whatsapp_destino: form.whatsapp_destino, keywords, ativo: form.ativo,
      updated_at: new Date().toISOString(),
    });
    setSalvando(false);
    if (error) { toast.error("Erro ao salvar: " + error.message); return; }
    toast.success("Configuração salva");
    queryClient.invalidateQueries({ queryKey: ["email-config"] });
  };

  const testarConexao = async () => {
    setTestando(true);
    await salvarConfig();
    const { data, error } = await supabase.functions.invoke("email", { body: { action: "test_connection" } });
    setTestando(false);
    if (error || data?.error) { toast.error("Falha na conexão: " + (error?.message || data?.error)); return; }
    toast.success(data?.message || "Conexão OK");
  };

  const sincronizar = async () => {
    setSincronizando(true);
    const { data, error } = await supabase.functions.invoke("email", { body: { action: "fetch_emails" } });
    setSincronizando(false);
    if (error || data?.error) { toast.error("Erro: " + (error?.message || data?.error)); return; }
    toast.success(`${data?.novos ?? 0} novo(s) e-mail(s) capturado(s)`);
    queryClient.invalidateQueries({ queryKey: ["email-mensagens"] });
  };

  const abrir = (e: EmailMsg) => { setAberto(e); setRespostaEdit(e.rascunho_resposta || ""); };

  const regenerar = async () => {
    if (!aberto) return;
    setRegenerando(true);
    const { data, error } = await supabase.functions.invoke("email", { body: { action: "regenerate_draft", id: aberto.id } });
    setRegenerando(false);
    if (error || data?.error) { toast.error("Erro: " + (error?.message || data?.error)); return; }
    setRespostaEdit(data.rascunho || "");
    toast.success("Rascunho regenerado");
    queryClient.invalidateQueries({ queryKey: ["email-mensagens"] });
  };

  const responder = async () => {
    if (!aberto) return;
    setEnviando(true);
    const { data, error } = await supabase.functions.invoke("email", { body: { action: "send_reply", id: aberto.id, corpo: respostaEdit } });
    setEnviando(false);
    if (error || data?.error) { toast.error("Erro ao enviar: " + (error?.message || data?.error)); return; }
    toast.success("Resposta enviada");
    setAberto(null);
    queryClient.invalidateQueries({ queryKey: ["email-mensagens"] });
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
            {/* Conexão */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base"><Plug className="h-4 w-4" /> Conexão (cPanel)</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
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
                    <Input placeholder="contato@seudominio.com" value={form.email_usuario} onChange={(e) => setForm({ ...form, email_usuario: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Senha</Label>
                    <Input type="password" value={form.senha} onChange={(e) => setForm({ ...form, senha: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>WhatsApp do relatório (número)</Label>
                    <Input placeholder="5591999999999" value={form.whatsapp_destino} onChange={(e) => setForm({ ...form, whatsapp_destino: e.target.value })} />
                  </div>
                  <div className="flex items-center gap-2 pt-6">
                    <Switch checked={form.ativo} onCheckedChange={(v) => setForm({ ...form, ativo: v })} />
                    <Label>Captura diária ativa (8h)</Label>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label>Palavras-chave (separadas por vírgula)</Label>
                  <Textarea rows={2} value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} />
                </div>
                <div className="flex gap-2">
                  <Button onClick={salvarConfig} disabled={salvando} variant="secondary">
                    {salvando && <Loader2 className="h-4 w-4 animate-spin" />} Salvar
                  </Button>
                  <Button onClick={testarConexao} disabled={testando} variant="outline">
                    {testando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />} Testar conexão
                  </Button>
                  {cfg?.ultima_execucao && (
                    <span className="text-xs text-muted-foreground self-center ml-2">
                      Última captura: {new Date(cfg.ultima_execucao).toLocaleString("pt-BR")}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>

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
                            <span className="font-medium truncate">{e.remetente_nome || e.remetente}</span>
                            {e.categoria && <Badge variant="outline" className="text-xs">{e.categoria}</Badge>}
                            <Badge variant={STATUS_VARIANT[e.status] || "default"} className="text-xs">{STATUS_LABEL[e.status] || e.status}</Badge>
                          </div>
                          <p className="text-sm font-medium mt-1 truncate">{e.assunto}</p>
                          <p className="text-sm text-muted-foreground mt-0.5 line-clamp-2">{e.resumo || "(sem resumo)"}</p>
                        </div>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {e.recebido_em ? new Date(e.recebido_em).toLocaleString("pt-BR") : ""}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>

          {/* Painel de aprovação */}
          <Dialog open={!!aberto} onOpenChange={(o) => !o && setAberto(null)}>
            <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
              {aberto && (
                <>
                  <DialogHeader>
                    <DialogTitle className="text-base">{aberto.assunto}</DialogTitle>
                    <p className="text-sm text-muted-foreground">
                      De: {aberto.remetente_nome ? `${aberto.remetente_nome} <${aberto.remetente}>` : aberto.remetente}
                    </p>
                  </DialogHeader>

                  <div className="space-y-4">
                    <div>
                      <Label className="text-xs uppercase text-muted-foreground">E-mail recebido</Label>
                      <div className="mt-1 text-sm whitespace-pre-wrap rounded-md border p-3 max-h-60 overflow-y-auto bg-muted/30">
                        {aberto.corpo || "(vazio)"}
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
