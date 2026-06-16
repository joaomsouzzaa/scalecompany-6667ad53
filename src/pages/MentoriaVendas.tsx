import { useState, useMemo, useCallback } from "react";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { DateRangePicker } from "@/components/DateRangePicker";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Settings2,
  Zap,
  Plus,
  Trash2,
  CheckCircle2,
  XCircle,
  MoreHorizontal,
  Pencil,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  X,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

function stripAccentsLower(s: string): string {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

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
  payload: Record<string, unknown> | null;
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

// Formas de pagamento cadastradas no CRM (combinações de Espécie/Boleto/Cheque/Cartão).
const FORMAS_PAGAMENTO = [
  "Espécie",
  "Boleto",
  "Cheque",
  "Cartão",
  "Espécie + Cartão",
  "Espécie + Boleto",
  "Espécie + Cheque",
  "Boleto + Cartão",
  "Boleto + Cheque",
  "Cheque + Cartão",
  "Espécie + Boleto + Cartão",
  "Espécie + Cheque + Cartão",
  "Espécie + Boleto + Cheque",
  "Boleto + Cheque + Cartão",
  "Espécie + Boleto + Cheque + Cartão",
];

const MentoriaVendas = () => {
  const qc = useQueryClient();
  const [mapOpen, setMapOpen] = useState(false);
  const [trigOpen, setTrigOpen] = useState(false);

  // Filtros
  const [dateRange, setDateRange] = useState<string>("lifetime");
  const [startDate, setStartDate] = useState<Date | undefined>(undefined);
  const [endDate, setEndDate] = useState<Date | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [msgFilter, setMsgFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(20);

  // Ordenação (chave = label do campo, ou "__msg"/"__data")
  const [sortKey, setSortKey] = useState<string>("__data");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Seleção / edição / exclusão
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [editing, setEditing] = useState<Venda | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<Venda | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<Record<string, string>>({});

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
        .limit(1000);
      if (error) throw error;
      return data as Venda[];
    },
    refetchInterval: 60_000,
  });

  const camposAtivos = campos.filter((c) => c.ativo);
  const colCount = camposAtivos.length + 3; // checkbox + msg + data + ações

  // Filtro de data (client-side, sobre created_at)
  const filtered = useMemo(() => {
    let result = vendas;
    if (startDate || endDate) {
      const ini = startDate ? startDate.getTime() : 0;
      const fim = endDate ? endDate.getTime() + 86400000 - 1 : Date.now();
      result = result.filter((v) => {
        const t = new Date(v.created_at).getTime();
        return t >= ini && t <= fim;
      });
    }
    if (msgFilter !== "all") {
      result = result.filter((v) => {
        const st = (v.mensagem_status || "").toLowerCase();
        if (msgFilter === "enviada") return v.mensagem_enviada;
        if (msgFilter === "sem_gatilho") return st.includes("sem gatilho");
        if (msgFilter === "erro") return st.startsWith("erro");
        if (msgFilter === "nao_enviada") return !v.mensagem_enviada;
        return true;
      });
    }
    if (search.trim()) {
      const term = stripAccentsLower(search);
      result = result.filter((v) => {
        const campos = [v.nome, v.telefone, ...Object.values(v.dados || {})];
        return campos.some((x) => x != null && stripAccentsLower(String(x)).includes(term));
      });
    }
    return result;
  }, [vendas, startDate, endDate, msgFilter, search]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const getVal = (v: Venda): string | number => {
      if (sortKey === "__data") return new Date(v.created_at).getTime();
      if (sortKey === "__msg") return v.mensagem_enviada ? 1 : 0;
      const raw = v.dados?.[sortKey];
      return raw == null ? "" : String(raw);
    };
    arr.sort((a, b) => {
      const av = getVal(a);
      const bv = getVal(b);
      if (typeof av === "number" && typeof bv === "number") return sortDir === "asc" ? av - bv : bv - av;
      const cmp = String(av).localeCompare(String(bv), "pt-BR", { sensitivity: "base" });
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / perPage));
  const currentPage = Math.min(page, totalPages);
  const paginated = sorted.slice((currentPage - 1) * perPage, currentPage * perPage);

  const toggleSort = useCallback((key: string) => {
    setSortKey((prev) => {
      if (prev === key) { setSortDir((d) => (d === "asc" ? "desc" : "asc")); return prev; }
      setSortDir("asc");
      return key;
    });
    setPage(1);
  }, []);

  const SortIcon = ({ col }: { col: string }) => {
    if (sortKey !== col) return <ArrowUpDown className="ml-1 h-3 w-3 opacity-40" />;
    return sortDir === "asc" ? <ArrowUp className="ml-1 h-3 w-3" /> : <ArrowDown className="ml-1 h-3 w-3" />;
  };

  const sortableHead = (label: string, col: string, className?: string) => (
    <TableHead className={className} style={{ minWidth: 90 }}>
      <button
        type="button"
        className="inline-flex items-center gap-0.5 hover:text-foreground transition-colors whitespace-nowrap"
        onClick={() => toggleSort(col)}
      >
        {label}
        <SortIcon col={col} />
      </button>
    </TableHead>
  );

  // Seleção
  const toggleSelectId = (id: string) =>
    setSelectedIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allPageSelected = paginated.length > 0 && paginated.every((v) => selectedIds.has(v.id));
  const toggleSelectAll = () =>
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (allPageSelected) paginated.forEach((v) => n.delete(v.id));
      else paginated.forEach((v) => n.add(v.id));
      return n;
    });

  const refresh = () => qc.invalidateQueries({ queryKey: ["mentoria-vendas"] });

  // Editar
  const openEdit = (v: Venda) => {
    setEditing(v);
    const f: Record<string, string> = {};
    camposAtivos.forEach((c) => { f[c.label] = v.dados?.[c.label] != null ? String(v.dados[c.label]) : ""; });
    setEditForm(f);
  };
  const saveEdit = async () => {
    if (!editing) return;
    const dados = { ...(editing.dados || {}), ...editForm };
    const { error } = await (supabase as any)
      .from("mentoria_vendas")
      .update({ dados })
      .eq("id", editing.id);
    if (error) { toast.error("Erro ao salvar", { description: error.message }); return; }
    toast.success("Venda atualizada");
    setEditing(null);
    refresh();
  };

  // Excluir
  const handleDelete = async () => {
    if (!deleting) return;
    const { error } = await (supabase as any).from("mentoria_vendas").delete().eq("id", deleting.id);
    if (error) { toast.error("Erro ao excluir", { description: error.message }); return; }
    toast.success("Venda excluída");
    setDeleting(null);
    refresh();
  };
  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    const { error } = await (supabase as any).from("mentoria_vendas").delete().in("id", ids);
    if (error) { toast.error("Erro ao excluir", { description: error.message }); return; }
    toast.success(`${ids.length} venda(s) excluída(s)`);
    setSelectedIds(new Set());
    setShowBulkDelete(false);
    refresh();
  };

  // Cadastrar manual
  const openCreate = () => {
    const f: Record<string, string> = {};
    camposAtivos.forEach((c) => { f[c.label] = ""; });
    setCreateForm(f);
    setCreateOpen(true);
  };
  const detectCore = (dados: Record<string, string>) => {
    const find = (kws: string[]) => {
      for (const c of camposAtivos) {
        const hay = stripAccentsLower(c.label) + " " + stripAccentsLower(c.caminho);
        if (kws.some((k) => hay.includes(k)) && dados[c.label]) return dados[c.label];
      }
      return null;
    };
    return {
      nome: find(["produt"]) ? find(["nome", "name"]) : find(["nome", "name"]),
      telefone: find(["telefone", "phone", "celular", "whatsapp", "fone"]),
      produto: find(["produt"]),
      forma_pagamento: find(["pagamento", "payment"]),
    };
  };
  const handleCreate = async () => {
    const core = detectCore(createForm);
    const { error } = await (supabase as any).from("mentoria_vendas").insert({
      dados: createForm,
      nome: core.nome,
      telefone: core.telefone,
      produto: core.produto,
      forma_pagamento: core.forma_pagamento,
      mensagem_enviada: false,
      mensagem_status: "manual",
      data_venda: new Date().toISOString(),
    });
    if (error) { toast.error("Erro ao cadastrar", { description: error.message }); return; }
    toast.success("Venda cadastrada");
    setCreateOpen(false);
    refresh();
  };

  const msgBadge = (v: Venda) =>
    v.mensagem_enviada ? (
      <Badge className="bg-green-600 gap-1">
        <CheckCircle2 className="h-3 w-3" /> Enviada
      </Badge>
    ) : (
      <Badge variant="secondary" className="gap-1">
        <XCircle className="h-3 w-3" />
        {v.mensagem_status || "Não enviada"}
      </Badge>
    );

  const temFiltro = !!search || msgFilter !== "all" || !!startDate || !!endDate;

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full">
        <AppSidebar />
        <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
          <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-border bg-background/80 backdrop-blur-sm px-6 py-3">
            <SidebarTrigger />
            <div>
              <h1 className="text-xl font-bold tracking-tight">Vendas (Mentoria)</h1>
              <p className="text-sm text-muted-foreground">
                Vendas de mentoria recebidas via webhook, com disparo automático de WhatsApp.
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="outline" onClick={() => setMapOpen(true)}>
                <Settings2 className="mr-2 h-4 w-4" /> Mapear campos
              </Button>
              <Button variant="outline" onClick={() => setTrigOpen(true)}>
                <Zap className="mr-2 h-4 w-4" /> Gatilhos
              </Button>
              <Button onClick={openCreate}>
                <Plus className="mr-2 h-4 w-4" /> Cadastrar Venda
              </Button>
            </div>
          </header>

          <div className="p-6 space-y-4">
            {/* Filtros */}
            <div className="flex flex-wrap items-center gap-3">
              <DateRangePicker
                preset={dateRange}
                startDate={startDate}
                endDate={endDate}
                onApply={(preset, s, e) => {
                  setDateRange(preset);
                  setStartDate(s);
                  setEndDate(e);
                  setPage(1);
                }}
              />
              <Select value={msgFilter} onValueChange={(v) => { setMsgFilter(v); setPage(1); }}>
                <SelectTrigger className="w-[200px] bg-card">
                  <SelectValue placeholder="Mensagem" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas as mensagens</SelectItem>
                  <SelectItem value="enviada">Enviada</SelectItem>
                  <SelectItem value="sem_gatilho">Sem gatilho</SelectItem>
                  <SelectItem value="erro">Com erro</SelectItem>
                  <SelectItem value="nao_enviada">Não enviada</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder="Buscar nome, telefone..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                className="w-[220px] bg-card"
              />
              {temFiltro && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { setSearch(""); setMsgFilter("all"); setDateRange("lifetime"); setStartDate(undefined); setEndDate(undefined); setPage(1); }}
                  className="text-muted-foreground"
                >
                  <X className="mr-1 h-4 w-4" /> Limpar filtros
                </Button>
              )}
              <span className="text-sm text-muted-foreground ml-auto">
                {sorted.length} venda{sorted.length !== 1 ? "s" : ""}
              </span>
            </div>

            {/* Banner de exclusão em massa */}
            {selectedIds.size > 0 && (
              <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2">
                <span className="text-sm font-medium">
                  {selectedIds.size} venda{selectedIds.size > 1 ? "s" : ""} selecionada{selectedIds.size > 1 ? "s" : ""}
                </span>
                <Button variant="destructive" size="sm" onClick={() => setShowBulkDelete(true)}>
                  <Trash2 className="mr-2 h-4 w-4" /> Excluir selecionadas
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
                  Limpar seleção
                </Button>
              </div>
            )}

            {/* Tabela */}
            <div className="rounded-lg border border-border overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox checked={allPageSelected} onCheckedChange={toggleSelectAll} />
                    </TableHead>
                    {camposAtivos.map((c) => sortableHead(c.label, c.label))}
                    {sortableHead("Mensagem", "__msg")}
                    {sortableHead("Recebida em", "__data")}
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    Array.from({ length: 6 }).map((_, i) => (
                      <TableRow key={i}>
                        {Array.from({ length: colCount }).map((_, j) => (
                          <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                        ))}
                      </TableRow>
                    ))
                  ) : sorted.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={colCount} className="text-center text-muted-foreground py-8">
                        {vendas.length === 0 ? "Nenhuma venda recebida ainda." : "Nenhuma venda para os filtros selecionados."}
                      </TableCell>
                    </TableRow>
                  ) : (
                    paginated.map((v) => (
                      <TableRow key={v.id} data-state={selectedIds.has(v.id) ? "selected" : undefined}>
                        <TableCell>
                          <Checkbox checked={selectedIds.has(v.id)} onCheckedChange={() => toggleSelectId(v.id)} />
                        </TableCell>
                        {camposAtivos.map((c) => (
                          <TableCell key={c.id} className="max-w-[220px] truncate">
                            {v.dados?.[c.label] != null ? String(v.dados[c.label]) : "—"}
                          </TableCell>
                        ))}
                        <TableCell>{msgBadge(v)}</TableCell>
                        <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                          {new Date(v.created_at).toLocaleString("pt-BR")}
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => openEdit(v)}>
                                <Pencil className="mr-2 h-4 w-4" /> Editar
                              </DropdownMenuItem>
                              <DropdownMenuItem className="text-destructive" onClick={() => setDeleting(v)}>
                                <Trash2 className="mr-2 h-4 w-4" /> Excluir
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Paginação */}
            {sorted.length > perPage && (
              <div className="flex items-center justify-between pt-2">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground">
                    Mostrando {(currentPage - 1) * perPage + 1}–{Math.min(currentPage * perPage, sorted.length)} de {sorted.length}
                  </span>
                  <Select value={String(perPage)} onValueChange={(v) => { setPerPage(Number(v)); setPage(1); }}>
                    <SelectTrigger className="w-[80px] h-8 bg-card"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {[10, 20, 50, 100].map((n) => (<SelectItem key={n} value={String(n)}>{n}</SelectItem>))}
                    </SelectContent>
                  </Select>
                  <span className="text-sm text-muted-foreground">por página</span>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Anterior</Button>
                  <span className="text-sm font-medium">{currentPage} / {totalPages}</span>
                  <Button variant="outline" size="sm" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>Próxima</Button>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>

      <MapearCamposDialog
        open={mapOpen}
        onOpenChange={setMapOpen}
        campos={campos}
        lastPayload={vendas[0]?.payload || null}
        onSaved={() => { qc.invalidateQueries({ queryKey: ["mentoria-campos"] }); }}
      />
      <GatilhosDialog
        open={trigOpen}
        onOpenChange={setTrigOpen}
        variaveis={camposAtivos.map((c) => c.label)}
      />

      {/* Editar venda */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Editar venda</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            {camposAtivos.map((c) => (
              <div key={c.id} className="space-y-1">
                <Label>{c.label}</Label>
                <Input
                  value={editForm[c.label] ?? ""}
                  onChange={(e) => setEditForm({ ...editForm, [c.label]: e.target.value })}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
            <Button onClick={saveEdit}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cadastrar venda manual */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Cadastrar venda</DialogTitle>
          </DialogHeader>
          {camposAtivos.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Mapeie ao menos um campo em "Mapear campos" antes de cadastrar manualmente.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {camposAtivos.map((c) => (
                <div key={c.id} className="space-y-1">
                  <Label>{c.label}</Label>
                  <Input
                    value={createForm[c.label] ?? ""}
                    onChange={(e) => setCreateForm({ ...createForm, [c.label]: e.target.value })}
                  />
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancelar</Button>
            <Button onClick={handleCreate} disabled={camposAtivos.length === 0}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Excluir (individual) */}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir venda?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação é irreversível. A venda de{" "}
              <strong>{deleting?.nome || "contato desconhecido"}</strong> será removida permanentemente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Excluir</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Excluir (em massa) */}
      <AlertDialog open={showBulkDelete} onOpenChange={setShowBulkDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir {selectedIds.size} venda{selectedIds.size > 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação é irreversível. As <strong>{selectedIds.size}</strong> vendas selecionadas serão removidas permanentemente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleBulkDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Excluir todas</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
          <div className="rounded-md border bg-muted/40 p-2 max-h-40 overflow-y-auto">
            <p className="text-xs font-medium mb-1">
              Campos recebidos no último webhook (use como "Caminho"):
            </p>
            <div className="space-y-0.5">
              {Object.entries(lastPayload).map(([k, v]) => (
                <div key={k} className="text-xs flex gap-2">
                  <code className="text-foreground shrink-0">{k}</code>
                  <span className="text-muted-foreground truncate">
                    = {v == null ? "—" : String(v)}
                  </span>
                </div>
              ))}
            </div>
          </div>
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
  });
  const [saving, setSaving] = useState(false);

  const { data: gatilhos = [] } = useQuery({
    queryKey: ["mentoria-gatilhos"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("mentoria_gatilhos")
        .select("*")
        .order("created_at", { ascending: false });
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
    });
    setSaving(false);
    if (error) {
      toast.error("Erro ao salvar gatilho", { description: error.message });
      return;
    }
    setForm({ produto: "", forma_pagamento: "", mensagem: "" });
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
            <strong>forma de pagamento</strong>. Vazio = qualquer. O gatilho mais
            específico vence automaticamente.
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
          <div className="grid grid-cols-2 gap-2">
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
              <Select
                value={form.forma_pagamento || "__any__"}
                onValueChange={(v) =>
                  setForm({ ...form, forma_pagamento: v === "__any__" ? "" : v })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Qualquer" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__any__">Qualquer forma</SelectItem>
                  {FORMAS_PAGAMENTO.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
