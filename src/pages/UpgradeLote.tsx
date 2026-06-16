import { useState, useMemo } from "react";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
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
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCidades } from "@/hooks/useCidades";
import { getHiddenCidades } from "@/components/EditCidadeDialog";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Download, ArrowRight, Search } from "lucide-react";
import { toast } from "sonner";

// Normaliza texto p/ comparação (sem acento, minúsculo, sem espaços/hífens).
const norm = (s: string) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[\s-]/g, "");
// Normaliza e-mail (sem acento, minúsculo, trim).
const normEmail = (s: string) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

// Um produto é "upgrade" quando o nome contém "upgrade".
const ehUpgrade = (produto: string) => /upgrade/i.test(produto || "");
// Já é um lote VIP?
const ehVIP = (batch: string) => /vip\s*$/i.test((batch || "").trim());

// Lote-alvo VIP = mesmo nome do lote + " VIP" no final (mantém o hífen como está).
// "Lote 2 - Duplo" -> "Lote 2 - Duplo VIP"; "Pré-Venda Duplo" -> "Pré-Venda Duplo VIP"
function loteAlvoVIP(batch: string): string {
  return (batch || "").trim() + " VIP";
}

type VendaRow = {
  email_comprador: string | null;
  produto: string | null;
  status: string | null;
  payload: any;
};

type Linha = {
  id: string;
  nome: string;
  email: string;
  comprador: string;
  loteAtual: string;
  loteAlvo: string;
  acao: boolean;
};

export default function UpgradeLote() {
  const { data: cidades = [] } = useCidades();
  const hiddenCidades = getHiddenCidades();
  const visibleCidades = cidades.filter((c) => !hiddenCidades.includes(c.id));
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const activeCidades = visibleCidades.filter((c) => {
    if (!c.data_evento) return true;
    const ev = new Date(c.data_evento); ev.setHours(0, 0, 0, 0);
    return ev >= hoje;
  });

  const [city, setCity] = useState<string>("");
  const [cidadeSlug, setCidadeSlug] = useState<string>("");

  const { data, isFetching, refetch, isError } = useQuery({
    queryKey: ["upgrade-lote", cidadeSlug],
    enabled: false,
    queryFn: async () => {
      // Partes do slug da cidade (ex.: "portoalegre, POA") p/ casar com o nome do produto.
      const partes = cidadeSlug.split(",").map((s) => s.trim()).filter(Boolean);
      const orFilter = partes.map((p) => `produto.ilike.*${p}*`).join(",");
      let q = supabase
        .from("vendas")
        .select("email_comprador, produto, status, payload")
        .eq("status", "aprovada")
        .limit(20000);
      if (orFilter) q = q.or(orFilter);
      const { data: vendas, error } = await q;
      if (error) throw error;
      return (vendas || []) as VendaRow[];
    },
  });

  const resultado = useMemo(() => {
    if (!data) return null;

    // Quem comprou upgrade (por e-mail).
    const upgrades = new Set<string>();
    for (const v of data) {
      if (ehUpgrade(v.produto || "")) {
        const e = normEmail(v.email_comprador || "");
        if (e) upgrades.add(e);
      }
    }

    // Vendas normais (evento, com lote) de quem também comprou upgrade.
    const linhas: Linha[] = [];
    for (const v of data) {
      if (ehUpgrade(v.produto || "")) continue; // pula os próprios upgrades
      const compradorEmail = normEmail(v.email_comprador || "");
      if (!compradorEmail || !upgrades.has(compradorEmail)) continue; // só elegíveis

      const p = v.payload || {};
      const loteAtual = String(p?.event_batch?.name || "").trim();
      const jaVip = !loteAtual || ehVIP(loteAtual);
      const tickets = Array.isArray(p?.event_tickets) && p.event_tickets.length > 0
        ? p.event_tickets
        : [{ id: p?.order_id || compradorEmail, name: v.payload?.Customer?.full_name || v.email_comprador, email: v.email_comprador }];

      for (const t of tickets) {
        linhas.push({
          id: String(t.id || `${compradorEmail}-${linhas.length}`),
          nome: t.name || "—",
          email: t.email || "—",
          comprador: v.email_comprador || "—",
          loteAtual: loteAtual || "(sem lote)",
          loteAlvo: jaVip ? "—" : loteAlvoVIP(loteAtual),
          acao: !jaVip,
        });
      }
    }
    linhas.sort((a, b) => Number(b.acao) - Number(a.acao) || a.loteAtual.localeCompare(b.loteAtual));

    const aAlterar = linhas.filter((l) => l.acao);
    const compradoresElegiveis = new Set(linhas.map((l) => normEmail(l.comprador))).size;

    const porLote = new Map<string, { de: string; para: string; qtd: number }>();
    for (const l of aAlterar) {
      const k = `${l.loteAtual}→${l.loteAlvo}`;
      const cur = porLote.get(k) || { de: l.loteAtual, para: l.loteAlvo, qtd: 0 };
      cur.qtd++;
      porLote.set(k, cur);
    }

    return {
      compradoresElegiveis,
      linhas,
      aAlterar,
      porLote: [...porLote.values()].sort((a, b) => b.qtd - a.qtd),
    };
  }, [data]);

  const handleBuscar = () => {
    if (!city) { toast.error("Selecione uma cidade"); return; }
    const c = activeCidades.find((x) => x.slug === city);
    setCidadeSlug(c?.slug || "");
    setTimeout(() => refetch(), 0);
  };

  const exportarCSV = () => {
    if (!resultado || resultado.aAlterar.length === 0) {
      toast.error("Nada a exportar");
      return;
    }
    const headers = "nome;email;comprador;lote_atual;lote_novo";
    const linhas = resultado.aAlterar.map(
      (l) => `${l.nome};${l.email};${l.comprador};${l.loteAtual};${l.loteAlvo}`
    );
    const blob = new Blob(["﻿" + headers + "\n" + linhas.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const c = activeCidades.find((x) => x.slug === city);
    a.download = `upgrade-lote-${(c?.slug || "cidade").replace(/[^\w]+/g, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full">
        <AppSidebar />
        <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
          <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-border bg-background/80 backdrop-blur-sm px-6 py-3">
            <SidebarTrigger />
            <div>
              <h1 className="text-xl font-bold tracking-tight">Upgrade de Lote</h1>
              <p className="text-sm text-muted-foreground">
                Quem comprou a venda normal + o upgrade — preview da troca de lote para VIP
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="outline"
                onClick={exportarCSV}
                disabled={!resultado || resultado.aAlterar.length === 0}
              >
                <Download className="mr-2 h-4 w-4" />
                Exportar CSV
              </Button>
            </div>
          </header>

          <div className="p-6 space-y-4">
            <div className="flex flex-wrap items-center gap-3">
              <Select value={city} onValueChange={setCity}>
                <SelectTrigger className="w-[240px] bg-card">
                  <SelectValue placeholder="Selecione a cidade" />
                </SelectTrigger>
                <SelectContent>
                  {activeCidades.map((c) => (
                    <SelectItem key={c.id} value={c.slug}>
                      {c.nome}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={handleBuscar} disabled={isFetching}>
                <Search className="mr-2 h-4 w-4" />
                {isFetching ? "Buscando..." : "Buscar"}
              </Button>
            </div>

            {isError && (
              <p className="text-sm text-destructive">Erro ao buscar os dados. Tente novamente.</p>
            )}

            {isFetching && (
              <div className="space-y-2">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-64 w-full" />
              </div>
            )}

            {!isFetching && resultado && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm text-muted-foreground">
                        Compradores elegíveis (normal + upgrade)
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold">{resultado.compradoresElegiveis}</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm text-muted-foreground">
                        Ingressos a alterar
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold">{resultado.aAlterar.length}</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm text-muted-foreground">
                        Lotes-alvo distintos
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold">{resultado.porLote.length}</p>
                    </CardContent>
                  </Card>
                </div>

                {resultado.porLote.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Resumo por lote</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1">
                      {resultado.porLote.map((p) => (
                        <div key={`${p.de}-${p.para}`} className="flex items-center gap-2 text-sm">
                          <span className="text-muted-foreground">{p.de}</span>
                          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="font-medium">{p.para}</span>
                          <Badge variant="secondary" className="ml-auto">{p.qtd}</Badge>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}

                <div className="rounded-lg border border-border overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Nome</TableHead>
                        <TableHead>E-mail</TableHead>
                        <TableHead>Comprador</TableHead>
                        <TableHead>Lote atual</TableHead>
                        <TableHead>Lote-alvo</TableHead>
                        <TableHead>Ação</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {resultado.linhas.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                            Nenhum ingresso de comprador elegível encontrado nesta cidade.
                          </TableCell>
                        </TableRow>
                      ) : (
                        resultado.linhas.map((l) => (
                          <TableRow key={l.id}>
                            <TableCell>{l.nome}</TableCell>
                            <TableCell>{l.email}</TableCell>
                            <TableCell className="text-muted-foreground">{l.comprador}</TableCell>
                            <TableCell>{l.loteAtual}</TableCell>
                            <TableCell>{l.loteAlvo}</TableCell>
                            <TableCell>
                              {l.acao ? (
                                <Badge>Alterar</Badge>
                              ) : (
                                <Badge variant="secondary">Sem ação</Badge>
                              )}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>

                <p className="text-xs text-muted-foreground">
                  A troca de lote é aplicada manualmente na Kiwify (a API não permite escrita).
                  Use o CSV exportado na importação/edição de participantes do painel.
                </p>
              </>
            )}
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}
