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
import { X } from "lucide-react";
import { useCidades } from "@/hooks/useCidades";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getHiddenCidades } from "@/components/EditCidadeDialog";

type LeadRow = {
  id: string;
  tipo_evento: string | null;
  id_transacao: string | null;
  nome: string | null;
  email: string | null;
  telefone: string | null;
  produto: string | null;
  cidade: string | null;
  valor: number | null;
  tipo_ingresso: string | null;
  plataforma: string | null;
  status: string | null;
  proxima_ordem: number | null;
  proximo_envio_em: string | null;
  comprou_em: string | null;
  data_venda: string | null;
};

const STATUS_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  aguardando: { label: "Aguardando", variant: "secondary" },
  em_fluxo: { label: "Em fluxo", variant: "default" },
  comprou: { label: "Comprou", variant: "outline" },
  fluxo_concluido: { label: "Fluxo concluído", variant: "outline" },
};

const EVENTO_LABEL: Record<string, string> = {
  abandono: "Carrinho abandonado",
  recusada: "Compra recusada",
};

const fmtBRL = (n: number | null) =>
  n != null ? `R$ ${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";

const RecuperacaoVendas = () => {
  const [dateRange, setDateRange] = useState<string>("90d");
  const [startDate, setStartDate] = useState<Date | undefined>(() => { const s = new Date(); s.setDate(s.getDate() - 89); return s; });
  const [endDate, setEndDate] = useState<Date | undefined>(() => new Date());
  const [city, setCity] = useState(() => localStorage.getItem("selected_city") || "all");
  const [statusFilter, setStatusFilter] = useState("all");
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

  const { data: leads = [], isLoading } = useQuery({
    queryKey: ["recuperacao-leads", start, end, city, statusFilter],
    queryFn: async () => {
      const citySlug = city !== "all" ? city : null;
      const { data, error } = await (supabase.rpc as any)("buscar_recuperacao_leads", {
        p_status: statusFilter,
        p_start: start,
        p_end: end,
        p_city_slug: citySlug,
      });
      if (error) throw error;
      return (data || []) as LeadRow[];
    },
    refetchInterval: 60_000,
  });

  const filtered = useMemo(() => {
    let result = leads;
    if (nomeFilter.trim()) {
      const term = nomeFilter.trim().toLowerCase();
      result = result.filter((r) =>
        r.nome?.toLowerCase().includes(term) ||
        r.email?.toLowerCase().includes(term) ||
        r.telefone?.toLowerCase().includes(term));
    }
    return result;
  }, [leads, nomeFilter]);

  // Resumo por status.
  const porStatus = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of filtered) { const s = r.status || "—"; m[s] = (m[s] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [filtered]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageRows = filtered.slice((page - 1) * perPage, page * perPage);
  const fmtData = (s: string | null) => (s ? new Date(s).toLocaleDateString("pt-BR") : "—");
  const fmtDataHora = (s: string | null) => (s ? new Date(s).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full">
        <AppSidebar />
        <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
          <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-border bg-background/80 backdrop-blur-sm px-6 py-3">
            <SidebarTrigger />
            <div>
              <h1 className="text-xl font-bold tracking-tight">Recuperação de Vendas</h1>
              <p className="text-sm text-muted-foreground">
                Leads de carrinho abandonado e compra recusada — fluxo de recuperação no WhatsApp
              </p>
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
              <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
                <SelectTrigger className="w-[180px] bg-card">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="aguardando">Aguardando</SelectItem>
                  <SelectItem value="em_fluxo">Em fluxo</SelectItem>
                  <SelectItem value="comprou">Comprou</SelectItem>
                  <SelectItem value="fluxo_concluido">Fluxo concluído</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder="Nome, email ou telefone..."
                value={nomeFilter}
                onChange={(e) => { setNomeFilter(e.target.value); setPage(1); }}
                className="w-[220px] bg-card"
              />
              {(statusFilter !== "all" || nomeFilter) && (
                <Button variant="ghost" size="sm" onClick={() => { setStatusFilter("all"); setNomeFilter(""); setPage(1); }}>
                  <X className="mr-1 h-4 w-4" /> Limpar
                </Button>
              )}
            </div>

            {/* Resumo por status */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">Total: <strong>{filtered.length}</strong> leads</span>
              {porStatus.map(([s, n]) => (
                <Badge key={s} variant="secondary">{STATUS_BADGE[s]?.label || s}: {n}</Badge>
              ))}
            </div>

            {/* Tabela */}
            <div className="rounded-md border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data</TableHead>
                    <TableHead>Nome</TableHead>
                    <TableHead>Telefone</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Produto</TableHead>
                    <TableHead>Cidade</TableHead>
                    <TableHead>Valor</TableHead>
                    <TableHead>Evento</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Próxima msg</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    Array.from({ length: 8 }).map((_, i) => (
                      <TableRow key={i}><TableCell colSpan={10}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
                    ))
                  ) : pageRows.length === 0 ? (
                    <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground py-8">Nenhum lead encontrado</TableCell></TableRow>
                  ) : (
                    pageRows.map((r) => {
                      const badge = STATUS_BADGE[r.status || ""] || { label: r.status || "—", variant: "secondary" as const };
                      return (
                        <TableRow key={r.id}>
                          <TableCell className="whitespace-nowrap text-sm">{fmtData(r.data_venda)}</TableCell>
                          <TableCell className="font-medium">{r.nome || "—"}</TableCell>
                          <TableCell className="text-sm">{r.telefone || "—"}</TableCell>
                          <TableCell className="text-sm">{r.email || "—"}</TableCell>
                          <TableCell className="text-sm max-w-[220px] truncate" title={r.produto || ""}>{r.produto || "—"}</TableCell>
                          <TableCell>{r.cidade || "—"}</TableCell>
                          <TableCell className="whitespace-nowrap">{fmtBRL(r.valor)}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{EVENTO_LABEL[r.tipo_evento || ""] || r.tipo_evento || "—"}</Badge>
                          </TableCell>
                          <TableCell><Badge variant={badge.variant}>{badge.label}</Badge></TableCell>
                          <TableCell className="text-sm whitespace-nowrap">
                            {r.status === "comprou"
                              ? <span className="text-green-600">comprou {fmtDataHora(r.comprou_em)}</span>
                              : r.status === "fluxo_concluido"
                                ? "—"
                                : r.proximo_envio_em
                                  ? <span>#{r.proxima_ordem} · {fmtDataHora(r.proximo_envio_em)}</span>
                                  : "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })
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

export default RecuperacaoVendas;
