import { useState } from "react";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Settings2, Zap, Plus, Trash2, CheckCircle2, XCircle } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type Campo = {
  id: string;
  ordem: number;
  label: string;
  caminho: string;
  tipo: string;
  ativo: boolean;
};

type Gatilho = {
  id: string;
  nome: string | null;
  produto: string | null;
  forma_pagamento: string | null;
  mensagem: string;
  prioridade: number;
  ativo: boolean;
};

type Venda = {
  id: string;
  id_transacao: string | null;
  status: string | null;
  produto: string | null;
  forma_pagamento: string | null;
  telefone: string | null;
  nome: string | null;
  dados: Record<string, unknown>;
  mensagem_enviada: boolean;
  mensagem_status: string | null;
  data_venda: string | null;
  created_at: string;
};

// Produtos cadastrados no CRM (o webhook envia exatamente um destes valores no
// campo "Tipo de produto vendido"). Ajuste a lista conforme o CRM.
const PRODUTOS_MENTORIA = [
  "Programa Scale",
  "Scale Club",
  "Formatação de franquia",
  "Publicidade",
  "Patrocinio",
  "Consultoria",
  "Renovação Club",
  "Renovação Programa Scale",
  "Embaixador de marca",
  "Trilha Mentor",
  "Imersão Scale",
  "Imersão formação de franquia",
  "Conselho",
];

const MentoriaVendas = () => {
  const qc = useQueryClient();
  const [mapOpen, setMapOpen] = useState(false);
  const [trigOpen, setTrigOpen] = useState(false);

  const { data: campos = [] } = useQuery({
    queryKey: ["mentoria-campos"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("mentoria_campos")
        .select("*")
        .order("ordem");
      if (error) throw error;
      return data as Campo[];
    },
  });

  const { data: vendas = [], isLoading } = useQuery({
    queryKey: ["mentoria-vendas"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("mentoria_vendas")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return data as Venda[];
    },
  });

  const camposAtivos = campos.filter((c) => c.ativo);

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full">
        <AppSidebar />
        <main className="flex-1 p-6 space-y-6">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <SidebarTrigger />
              <div>
                <h1 className="text-2xl font-bold">Vendas (Mentoria)</h1>
                <p className="text-sm text-muted-foreground">
                  Vendas de produtos de mentoria recebidas via webhook, com disparo
                  automático de WhatsApp.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setMapOpen(true)}>
                <Settings2 className="h-4 w-4 mr-2" /> Mapear campos
              </Button>
              <Button variant="outline" onClick={() => setTrigOpen(true)}>
                <Zap className="h-4 w-4 mr-2" /> Gatilhos
              </Button>
            </div>
          </div>

          <div className="rounded-lg border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {camposAtivos.map((c) => (
                    <TableHead key={c.id}>{c.label}</TableHead>
                  ))}
                  <TableHead>Mensagem</TableHead>
                  <TableHead>Recebida em</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow>
                    <TableCell colSpan={camposAtivos.length + 2}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ) : vendas.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={camposAtivos.length + 2}
                      className="text-center text-muted-foreground py-8"
                    >
                      Nenhuma venda recebida ainda.
                    </TableCell>
                  </TableRow>
                ) : (
                  vendas.map((v) => (
                    <TableRow key={v.id}>
                      {camposAtivos.map((c) => (
                        <TableCell key={c.id}>
                          {v.dados?.[c.label] != null
                            ? String(v.dados[c.label])
                            : "—"}
                        </TableCell>
                      ))}
                      <TableCell>
                        {v.mensagem_enviada ? (
                          <Badge className="bg-green-600 gap-1">
                            <CheckCircle2 className="h-3 w-3" /> Enviada
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="gap-1">
                            <XCircle className="h-3 w-3" />
                            {v.mensagem_status || "Não enviada"}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {new Date(v.created_at).toLocaleString("pt-BR")}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </main>
      </div>

      <MapearCamposDialog
        open={mapOpen}
        onOpenChange={setMapOpen}
        campos={campos}
        lastPayload={(vendas[0]?.dados as Record<string, unknown>) || null}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["mentoria-campos"] });
        }}
      />
      <GatilhosDialog
        open={trigOpen}
        onOpenChange={setTrigOpen}
        variaveis={camposAtivos.map((c) => c.label)}
      />
    </SidebarProvider>
  );
};

function MapearCamposDialog({
  open,
  onOpenChange,
  campos,
  lastPayload,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  campos: Campo[];
  lastPayload: Record<string, unknown> | null;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState("");
  const [caminho, setCaminho] = useState("");
  const [saving, setSaving] = useState(false);

  const add = async () => {
    if (!label.trim() || !caminho.trim()) {
      toast.error("Preencha o nome da coluna e o caminho no payload.");
      return;
    }
    setSaving(true);
    const { error } = await (supabase as any).from("mentoria_campos").insert({
      label: label.trim(),
      caminho: caminho.trim(),
      ordem: campos.length,
    });
    setSaving(false);
    if (error) {
      toast.error("Erro ao salvar campo", { description: error.message });
      return;
    }
    setLabel("");
    setCaminho("");
    onSaved();
  };

  const toggle = async (c: Campo) => {
    const { error } = await supabase
      .from("mentoria_campos")
      .update({ ativo: !c.ativo })
      .eq("id", c.id);
    if (error) toast.error("Erro", { description: error.message });
    else onSaved();
  };

  const remove = async (c: Campo) => {
    const { error } = await (supabase as any).from("mentoria_campos").delete().eq("id", c.id);
    if (error) toast.error("Erro", { description: error.message });
    else onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Mapear campos do webhook</DialogTitle>
          <DialogDescription>
            Cada campo mapeado vira uma coluna na tabela. O caminho é a posição do
            valor no JSON do webhook (ex: <code>Customer.email</code>).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {campos.length === 0 && (
            <p className="text-sm text-muted-foreground">Nenhum campo mapeado.</p>
          )}
          {campos.map((c) => (
            <div key={c.id} className="flex items-center gap-2">
              <div className="flex-1 grid grid-cols-2 gap-2">
                <div className="text-sm font-medium">{c.label}</div>
                <code className="text-xs text-muted-foreground">{c.caminho}</code>
              </div>
              <Switch checked={c.ativo} onCheckedChange={() => toggle(c)} />
              <Button variant="ghost" size="icon" onClick={() => remove(c)}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
        </div>

        {lastPayload && Object.keys(lastPayload).length > 0 && (
          <p className="text-xs text-muted-foreground">
            Campos da última venda: {Object.keys(lastPayload).join(", ")}
          </p>
        )}

        <div className="grid grid-cols-2 gap-2 items-end border-t pt-4">
          <div className="space-y-1">
            <Label>Nome da coluna</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="email" />
          </div>
          <div className="space-y-1">
            <Label>Caminho no payload</Label>
            <Input
              value={caminho}
              onChange={(e) => setCaminho(e.target.value)}
              placeholder="Customer.email"
            />
          </div>
        </div>

        <DialogFooter>
          <Button onClick={add} disabled={saving}>
            <Plus className="h-4 w-4 mr-2" /> Adicionar campo
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GatilhosDialog({
  open,
  onOpenChange,
  variaveis,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  variaveis: string[];
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    produto: "",
    forma_pagamento: "",
    mensagem: "",
    prioridade: "0",
  });
  const [saving, setSaving] = useState(false);

  const { data: gatilhos = [] } = useQuery({
    queryKey: ["mentoria-gatilhos"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("mentoria_gatilhos")
        .select("*")
        .order("prioridade", { ascending: false });
      if (error) throw error;
      return data as Gatilho[];
    },
    enabled: open,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["mentoria-gatilhos"] });

  const add = async () => {
    if (!form.mensagem.trim()) {
      toast.error("Escreva a mensagem do gatilho.");
      return;
    }
    setSaving(true);
    const { error } = await (supabase as any).from("mentoria_gatilhos").insert({
      produto: form.produto.trim() || null,
      forma_pagamento: form.forma_pagamento.trim() || null,
      mensagem: form.mensagem.trim(),
      prioridade: parseInt(form.prioridade) || 0,
    });
    setSaving(false);
    if (error) {
      toast.error("Erro ao salvar gatilho", { description: error.message });
      return;
    }
    setForm({ produto: "", forma_pagamento: "", mensagem: "", prioridade: "0" });
    refresh();
  };

  const toggle = async (g: Gatilho) => {
    const { error } = await supabase
      .from("mentoria_gatilhos")
      .update({ ativo: !g.ativo })
      .eq("id", g.id);
    if (error) toast.error("Erro", { description: error.message });
    else refresh();
  };

  const remove = async (g: Gatilho) => {
    const { error } = await (supabase as any).from("mentoria_gatilhos").delete().eq("id", g.id);
    if (error) toast.error("Erro", { description: error.message });
    else refresh();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Gatilhos de mensagem</DialogTitle>
          <DialogDescription>
            Escolha qual mensagem é enviada por <strong>produto</strong> e{" "}
            <strong>forma de pagamento</strong>. Vazio = qualquer. Maior prioridade
            vence em caso de empate.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 max-h-64 overflow-y-auto">
          {gatilhos.length === 0 && (
            <p className="text-sm text-muted-foreground">Nenhum gatilho criado.</p>
          )}
          {gatilhos.map((g) => (
            <div key={g.id} className="flex items-start gap-2 border rounded-md p-2">
              <div className="flex-1 space-y-1">
                <div className="flex gap-2 flex-wrap text-xs">
                  <Badge variant="outline">Produto: {g.produto || "qualquer"}</Badge>
                  <Badge variant="outline">
                    Pagamento: {g.forma_pagamento || "qualquer"}
                  </Badge>
                  <Badge variant="outline">Prioridade: {g.prioridade}</Badge>
                </div>
                <p className="text-sm whitespace-pre-wrap">{g.mensagem}</p>
              </div>
              <Switch checked={g.ativo} onCheckedChange={() => toggle(g)} />
              <Button variant="ghost" size="icon" onClick={() => remove(g)}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
        </div>

        <div className="space-y-2 border-t pt-4">
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label>Produto</Label>
              <Select
                value={form.produto || "__any__"}
                onValueChange={(v) =>
                  setForm({ ...form, produto: v === "__any__" ? "" : v })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Qualquer" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__any__">Qualquer produto</SelectItem>
                  {PRODUTOS_MENTORIA.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Forma de pagamento</Label>
              <Input
                value={form.forma_pagamento}
                onChange={(e) => setForm({ ...form, forma_pagamento: e.target.value })}
                placeholder="pix"
              />
            </div>
            <div className="space-y-1">
              <Label>Prioridade</Label>
              <Input
                type="number"
                value={form.prioridade}
                onChange={(e) => setForm({ ...form, prioridade: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Mensagem</Label>
            <Textarea
              value={form.mensagem}
              onChange={(e) => setForm({ ...form, mensagem: e.target.value })}
              placeholder="Olá {{nome}}, sua compra de {{produto}} foi confirmada!"
              rows={3}
            />
            {variaveis.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Variáveis disponíveis: {variaveis.map((v) => `{{${v}}}`).join(", ")}
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button onClick={add} disabled={saving}>
            <Plus className="h-4 w-4 mr-2" /> Adicionar gatilho
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default MentoriaVendas;
