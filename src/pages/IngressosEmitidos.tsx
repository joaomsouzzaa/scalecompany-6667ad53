import { useState, useMemo } from "react";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { DateRangePicker } from "@/components/DateRangePicker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronDown, X } from "lucide-react";
import { useCidades } from "@/hooks/useCidades";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getHiddenCidades } from "@/components/EditCidadeDialog";

type IngressoRow = {
  id: string;
  venda_id: string | null;
  order_id: string | null;
  ingresso_id: string | null;
  nome: string | null;
  email: string | null;
  telefone: string | null;
  cidade: string | null;
  tipo_ingresso: string | null;
  plataforma: string | null;
  status: string | null;
  data_venda: string | null;
};

const STATUS_DOT: Record<string, string> = {
  aprovada: "bg-green-500",
  cancelada: "bg-red-500",
  pendente: "bg-yellow-500",
  reembolsada: "bg-orange-500",
};

const IngressosEmitidos = () => {
  const [dateRange, setDateRange] = useState<string>("90d");
  const [startDate, setStartDate] = useState<Date | undefined>(() => { const s = new Date(); s.setDate(s.getDate() - 89); return s; });
  const [endDate, setEndDate] = useState<Date | undefined>(() => new Date());
  const [city, setCity] = useState(() => localStorage.getItem("selected_city") || "all");
  const [tipoFilter, setTipoFilter] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState("aprovada");
  const [nomeFilter, setNomeFilter] = useState("");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(25);

  const { data: cidades = [] } = useCidades();
  const hiddenCidades = getHiddenCidades();
  const visibleCidades = cidades.filter((c) => !hiddenCidades.includes(c.id));
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const activeCidades = visibleCidades.filter((c) => {
    if (!c.data_evento) return true;
    const ev = new Date(c.data_evento); ev.setHours(0, 0, 0, 0);
    return ev >= hoje;
  });

  const { start, end } = useMemo(() => {
    const s = startDate ? startDate.toISOString() : new Date(0).toISOString();
    const e = endDate ? new Date(endDate.getTime() + 86400000 - 1).toISOString() : new Date().toISOString();
    return { start: s, end: e };
  }, [startDate, endDate]);

  const { data: ingressos = [], isLoading } = useQuery({
    queryKey: ["ingressos-emitidos", start, end, city, statusFilter],
    queryFn: async () => {
      const citySlug = city !== "all" ? city : null;
      const { data, error } = await (supabase.rpc as any)("buscar_ingressos_emitidos", {
        p_status: statusFilter,
        p_start: start,
        p_end: end,
        p_city_slug: citySlug,
      });
      if (error) throw error;
      return (data || []) as IngressoRow[];
    },
    refetchInterval: 60_000,
  });

  const tipoOptions = useMemo(() => {
    const set = new Set<string>();
    ingressos.forEach((r) => { if (r.tipo_ingresso) set.add(r.tipo_ingresso); });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [ingressos]);

  const filtered = useMemo(() => {
    let result = ingressos;
    if (tipoFilter.length > 0) result = result.filter((r) => r.tipo_ingresso != null && tipoFilter.includes(r.tipo_ingresso));
    if (nomeFilter.trim()) {
      const term = nomeFilter.trim().toLowerCase();
      result = result.filter((r) => r.nome?.toLowerCase().includes(term) || r.email?.toLowerCase().includes(term));
    }
    return result;
  }, [ingressos, tipoFilter, nomeFilter]);

  // Reconciliação: total de ingressos por cidade.
  const porCidade = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of filtered) { const c = r.cidade || "—"; m[c] = (m[c] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [filtered]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageRows = filtered.slice((page - 1) * perPage, page * perPage);
  const fmtData = (s: string | null) => (s ? new Date(s).toLocaleDateString("pt-BR") : "—");

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full">
        <AppSidebar />
        <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
          <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-border bg-background/80 backdrop-blur-sm px-6 py-3">
            <SidebarTrigger />
            <div>
              <h1 className="text-xl font-bold tracking-tight">Ingressos Emitidos</h1>
              <p className="text-sm text-muted-foreground">
                1 linha por pessoa — dado real dos ingressos gerados (Kiwify)
              </p>
            </div>
          </header>

          <div className="p-6 space-y-4">
            {/* Filtros (mesmos da página de Vendas) */}
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
              <Select value={city} onValueChange={(v) => { setCity(v); localStorage.setItem("selected_city", v); setPage(1); }}>
                <SelectTrigger className="w-[240px] bg-card">
                  <SelectValue placeholder="Cidade" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas as cidades</SelectItem>
                  {activeCidades.map((c) => (
                    <SelectItem key={c.id} value={c.slug}>{c.nome}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-[200px] justify-between bg-card font-normal">
                    {tipoFilter.length === 0 ? "Todos os tipos" : `${tipoFilter.length} tipo(s)`}
                    <ChevronDown className="ml-2 h-4 w-4 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[200px] p-2" align="start">
                  <div className="flex flex-col gap-1 max-h-60 overflow-y-auto">
                    {tipoOptions.map((t) => (
                      <label key={t} className="flex items-center gap-2 px-2 py-1.5 text-sm rounded-sm hover:bg-accent cursor-pointer">
                        <Checkbox
                          checked={tipoFilter.includes(t)}
                          onCheckedChange={(checked) => {
                            setTipoFilter((prev) => checked ? [...prev, t] : prev.filter((x) => x !== t));
                            setPage(1);
                          }}
                        />
                        {t}
                      </label>
                    ))}
                    {tipoFilter.length > 0 && (
                      <Button variant="ghost" size="sm" className="mt-1" onClick={() => { setTipoFilter([]); setPage(1); }}>
                        Limpar filtro
                      </Button>
                    )}
                  </div>
                </PopoverContent>
              </Popover>
              <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
                <SelectTrigger className="w-[180px] bg-card">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="aprovada">Aprovada</SelectItem>
                  <SelectItem value="cancelada">Cancelada</SelectItem>
                  <SelectItem value="pendente">Pendente</SelectItem>
                  <SelectItem value="reembolsada">Reembolsada</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder="Nome ou email..."
                value={nomeFilter}
                onChange={(e) => { setNomeFilter(e.target.value); setPage(1); }}
                className="w-[200px] bg-card"
              />
              {(statusFilter !== "aprovada" || nomeFilter || tipoFilter.length > 0) && (
                <Button variant="ghost" size="sm" onClick={() => { setStatusFilter("aprovada"); setNomeFilter(""); setTipoFilter([]); setPage(1); }}>
                  <X className="mr-1 h-4 w-4" /> Limpar
                </Button>
              )}
            </div>

            {/* Reconciliação por cidade */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">Total: <strong>{filtered.length}</strong> ingressos</span>
              {porCidade.map(([c, n]) => (
                <Badge key={c} variant="secondary">{c}: {n}</Badge>
              ))}
            </div>

            {/* Tabela */}
            <div className="rounded-md border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nome</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Telefone</TableHead>
                    <TableHead>Cidade</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Venda (pedido)</TableHead>
                    <TableHead>Data</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    Array.from({ length: 8 }).map((_, i) => (
                      <TableRow key={i}><TableCell colSpan={7}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                    ))
                  ) : pageRows.length === 0 ? (
                    <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">Nenhum ingresso encontrado</TableCell></TableRow>
                  ) : (
                    pageRows.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium">{r.nome || "—"}</TableCell>
                        <TableCell className="text-sm">{r.email || "—"}</TableCell>
                        <TableCell className="text-sm">{r.telefone || "—"}</TableCell>
                        <TableCell>{r.cidade || "—"}</TableCell>
                        <TableCell>{r.tipo_ingresso || "—"}</TableCell>
                        <TableCell className="font-mono text-xs">{r.order_id ? r.order_id.slice(0, 8) : "—"}</TableCell>
                        <TableCell className="whitespace-nowrap text-sm">{fmtData(r.data_venda)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Paginação */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Por página</span>
                <Select value={String(perPage)} onValueChange={(v) => { setPerPage(Number(v)); setPage(1); }}>
                  <SelectTrigger className="w-[80px] h-8 bg-card"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[10, 25, 50, 100].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Anterior</Button>
                <span className="text-sm text-muted-foreground">{page} / {totalPages}</span>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Próxima</Button>
              </div>
            </div>
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
};

export default IngressosEmitidos;
