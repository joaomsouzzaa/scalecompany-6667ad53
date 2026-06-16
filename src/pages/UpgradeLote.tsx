import { useState } from "react";
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

type Linha = {
  id: string;
  nome: string;
  email: string;
  comprador: string;
  loteAtual: string;
  loteAlvo: string;
  acao: boolean;
};

type Resultado = {
  produtos_evento: string[];
  produtos_upgrade: string[];
  total_participantes: number;
  compradores_upgrade: number;
  compradores_elegiveis: number;
  ingressos_a_alterar: number;
  por_lote: { de: string; para: string; qtd: number }[];
  linhas: Linha[];
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
  const [buscaKey, setBuscaKey] = useState<number>(0);

  const { data: resultado, isFetching, refetch, isError, error } = useQuery<Resultado>({
    queryKey: ["upgrade-lote", city, buscaKey],
    enabled: false,
    queryFn: async () => {
      const c = activeCidades.find((x) => x.slug === city);
      const { data, error } = await supabase.functions.invoke("upgrade-lote", {
        body: { city_slug: c?.slug || city, city_nome: c?.nome || "" },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data as Resultado;
    },
  });

  const handleBuscar = () => {
    if (!city) { toast.error("Selecione uma cidade"); return; }
    setBuscaKey((k) => k + 1);
    setTimeout(() => refetch(), 0);
  };

  const exportarCSV = () => {
    const aAlterar = (resultado?.linhas || []).filter((l) => l.acao);
    if (aAlterar.length === 0) { toast.error("Nada a exportar"); return; }
    const headers = "nome;email;comprador;lote_atual;lote_novo";
    const linhas = aAlterar.map(
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

  const aAlterar = (resultado?.linhas || []).filter((l) => l.acao).length;

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
                Dados ao vivo da Kiwify — quem comprou normal + upgrade, para trocar o lote para VIP
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="outline" onClick={exportarCSV} disabled={aAlterar === 0}>
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
                {isFetching ? "Buscando na Kiwify..." : "Buscar"}
              </Button>
            </div>

            {isError && (
              <p className="text-sm text-destructive">
                Erro ao buscar na Kiwify: {(error as Error)?.message || "tente novamente"}
              </p>
            )}

            {isFetching && (
              <div className="space-y-2">
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-64 w-full" />
              </div>
            )}

            {!isFetching && resultado && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm text-muted-foreground">Compradores de upgrade</CardTitle>
                    </CardHeader>
                    <CardContent><p className="text-2xl font-bold">{resultado.compradores_upgrade}</p></CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm text-muted-foreground">Compradores elegíveis</CardTitle>
                    </CardHeader>
                    <CardContent><p className="text-2xl font-bold">{resultado.compradores_elegiveis}</p></CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm text-muted-foreground">Ingressos a alterar</CardTitle>
                    </CardHeader>
                    <CardContent><p className="text-2xl font-bold">{aAlterar}</p></CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm text-muted-foreground">Lotes-alvo distintos</CardTitle>
                    </CardHeader>
                    <CardContent><p className="text-2xl font-bold">{resultado.por_lote.length}</p></CardContent>
                  </Card>
                </div>

                {resultado.produtos_evento?.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Evento: {resultado.produtos_evento.join(", ")} · Upgrade: {resultado.produtos_upgrade.join(", ") || "—"} · Participantes: {resultado.total_participantes}
                  </p>
                )}

                {resultado.por_lote.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Resumo por lote</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1">
                      {resultado.por_lote.map((p) => (
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
                              {l.acao ? <Badge>Alterar</Badge> : <Badge variant="secondary">Sem ação</Badge>}
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
