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

// Normaliza e-mail/texto para comparação (sem acento, minúsculo, sem espaços).
const norm = (s: string) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

// Um produto é "upgrade" quando o nome contém "upgrade".
const ehUpgrade = (produto: string) => /upgrade/i.test(produto || "");

// Já é um lote VIP? (não precisa alterar)
const ehVIP = (batch: string) => /vip\s*$/i.test((batch || "").trim());

// Calcula o lote-alvo VIP a partir do lote atual.
// Ex.: "Pré-Venda Duplo" -> "Pré-Venda Duplo VIP"
//      "Lote 1 - Duplo"  -> "Lote 1 Duplo VIP" (remove o " - " com espaços; mantém o hífen de "Pré-Venda")
function loteAlvoVIP(batch: string): string {
  return (batch || "").replace(/\s+-\s+/g, " ").trim() + " VIP";
}

type IngressoRow = {
  id: string;
  nome: string | null;
  email: string | null;
  batch_name: string | null;
  order_id: string | null;
  cidade: string | null;
};

type Linha = {
  id: string;
  nome: string;
  email: string;
  loteAtual: string;
  loteAlvo: string;
  acao: boolean; // true = precisa alterar
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
  const [cidadeNome, setCidadeNome] = useState<string>("");

  // Busca disparada por botão: só roda quando há uma cidade (nome) selecionada.
  const { data, isFetching, refetch, isError } = useQuery({
    queryKey: ["upgrade-lote", cidadeNome],
    enabled: false,
    queryFn: async () => {
      // Vendas da cidade: precisamos do e-mail e do produto p/ separar normal x upgrade.
      const { data: vendas, error: ev } = await supabase
        .from("vendas")
        .select("email_comprador, produto, status")
        .eq("cidade", cidadeNome)
        .limit(20000);
      if (ev) throw ev;

      // Ingressos emitidos da cidade: lote atual por pessoa.
      const { data: ingressos, error: ei } = await supabase
        .from("ingressos_emitidos")
        .select("id, nome, email, batch_name, order_id, cidade")
        .eq("cidade", cidadeNome)
        .limit(50000);
      if (ei) throw ei;

      return { vendas: vendas || [], ingressos: (ingressos || []) as IngressoRow[] };
    },
  });

  const resultado = useMemo(() => {
    if (!data) return null;
    const normais = new Set<string>();
    const upgrades = new Set<string>();
    for (const v of data.vendas) {
      const email = norm(v.email_comprador as string);
      if (!email) continue;
      if (ehUpgrade(v.produto as string)) upgrades.add(email);
      else normais.add(email);
    }
    // Elegíveis: comprou venda normal E upgrade.
    const elegiveis = new Set([...upgrades].filter((e) => normais.has(e)));

    const linhas: Linha[] = data.ingressos
      .filter((i) => {
        const e = norm(i.email || "");
        return e && elegiveis.has(e);
      })
      .map((i) => {
        const loteAtual = (i.batch_name || "").trim();
        const jaVip = ehVIP(loteAtual) || !loteAtual;
        return {
          id: i.id,
          nome: i.nome || "—",
          email: i.email || "—",
          loteAtual: loteAtual || "(sem lote)",
          loteAlvo: jaVip ? "—" : loteAlvoVIP(loteAtual),
          acao: !jaVip,
        };
      })
      .sort((a, b) => Number(b.acao) - Number(a.acao) || a.loteAtual.localeCompare(b.loteAtual));

    const aAlterar = linhas.filter((l) => l.acao);
    // Resumo por lote-alvo.
    const porLote = new Map<string, { de: string; para: string; qtd: number }>();
    for (const l of aAlterar) {
      const k = `${l.loteAtual}→${l.loteAlvo}`;
      const cur = porLote.get(k) || { de: l.loteAtual, para: l.loteAlvo, qtd: 0 };
      cur.qtd++;
      porLote.set(k, cur);
    }

    return {
      elegiveis: elegiveis.size,
      linhas,
      aAlterar,
      porLote: [...porLote.values()].sort((a, b) => b.qtd - a.qtd),
    };
  }, [data]);

  const handleBuscar = () => {
    if (!city) { toast.error("Selecione uma cidade"); return; }
    const c = activeCidades.find((x) => x.slug === city);
    setCidadeNome(c?.nome || "");
    // refetch após o estado atualizar
    setTimeout(() => refetch(), 0);
  };

  const exportarCSV = () => {
    if (!resultado || resultado.aAlterar.length === 0) {
      toast.error("Nada a exportar");
      return;
    }
    const headers = "nome;email;lote_atual;lote_novo";
    const linhas = resultado.aAlterar.map(
      (l) => `${l.nome};${l.email};${l.loteAtual};${l.loteAlvo}`
    );
    const blob = new Blob(["﻿" + headers + "\n" + linhas.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `upgrade-lote-${norm(cidadeNome).replace(/\s+/g, "-") || "cidade"}.csv`;
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
            {/* Filtros */}
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
                {/* KPIs */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm text-muted-foreground">
                        Compradores elegíveis (normal + upgrade)
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold">{resultado.elegiveis}</p>
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

                {/* Resumo por lote-alvo */}
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

                {/* Tabela de preview */}
                <div className="rounded-lg border border-border overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Nome</TableHead>
                        <TableHead>E-mail</TableHead>
                        <TableHead>Lote atual</TableHead>
                        <TableHead>Lote-alvo</TableHead>
                        <TableHead>Ação</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {resultado.linhas.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                            Nenhum ingresso de comprador elegível encontrado nesta cidade.
                          </TableCell>
                        </TableRow>
                      ) : (
                        resultado.linhas.map((l) => (
                          <TableRow key={l.id}>
                            <TableCell>{l.nome}</TableCell>
                            <TableCell>{l.email}</TableCell>
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
