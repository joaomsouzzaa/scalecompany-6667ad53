import { useState, useMemo } from "react";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { KpiCard } from "@/components/KpiCard";
import { Target, DollarSign, TrendingUp, Percent, RefreshCw, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  RadialBarChart, RadialBar, PolarAngleAxis,
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, LabelList,
} from "recharts";

const VERDE = "#39ff14";
const ROSA = "#ff2d75";
const AZUL = "#00d4ff";
const VERMELHO = "#ff3b30";
const AMARELO = "#faff00";

// Cor do velocímetro conforme o atingimento: <50% vermelho, 50-80% amarelo, >=80% azul.
const corMeta = (pct: number) => (pct >= 80 ? AZUL : pct >= 50 ? AMARELO : VERMELHO);

const fmtBRL = (n: number) =>
  `R$ ${(Number(n) || 0).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}`;

interface Config {
  id: string; instancia: string; grupo_id: string | null; grupo_nome: string | null;
  faturado: number; meta: number; atualizado_em: string | null;
}
interface Snapshot { faturado: number; meta: number; captado_em: string; }

export default function MetaDoMes() {
  const qc = useQueryClient();
  const [syncing, setSyncing] = useState(false);

  const { data: config } = useQuery({
    queryKey: ["meta-faturado-config"],
    queryFn: async (): Promise<Config | null> => {
      const { data, error } = await (supabase as any)
        .from("meta_faturado_config").select("*").limit(1).maybeSingle();
      if (error) throw error;
      return data;
    },
    refetchInterval: 60_000,
  });

  const { data: snapshots = [] } = useQuery({
    queryKey: ["meta-faturado-snapshots"],
    queryFn: async (): Promise<Snapshot[]> => {
      const { data, error } = await (supabase as any)
        .from("meta_faturado_snapshots")
        .select("faturado, meta, captado_em")
        .order("captado_em", { ascending: true })
        .limit(500);
      if (error) throw error;
      return data || [];
    },
    refetchInterval: 60_000,
  });

  // Grupos da instância (para escolher qual seguir).
  const { data: grupos = [] } = useQuery({
    queryKey: ["meta-faturado-grupos", config?.instancia],
    enabled: !!config,
    queryFn: async (): Promise<{ id: string; name: string }[]> => {
      const { data, error } = await supabase.functions.invoke("uazapi", {
        body: { action: "meta_grupos", instancia: config?.instancia },
      });
      if (error) throw error;
      return (data as any)?.groups || [];
    },
  });

  const faturado = config?.faturado ?? 0;
  const meta = config?.meta ?? 0;
  const falta = Math.max(meta - faturado, 0);
  const pct = meta > 0 ? (faturado / meta) * 100 : 0;

  const atualizadoTxt = useMemo(() => {
    if (!config?.atualizado_em) return "ainda não sincronizado";
    const d = new Date(config.atualizado_em);
    return `atualizado ${d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
  }, [config?.atualizado_em]);

  const histData = useMemo(
    () => snapshots.map((s) => ({
      label: new Date(s.captado_em).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
      faturado: Number(s.faturado),
      meta: Number(s.meta),
    })),
    [snapshots],
  );

  async function sincronizar() {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("uazapi", { body: { action: "meta_sync" } });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success("Sincronizado com o nome do grupo!");
      qc.invalidateQueries({ queryKey: ["meta-faturado-config"] });
      qc.invalidateQueries({ queryKey: ["meta-faturado-snapshots"] });
    } catch (e: any) {
      toast.error(e.message || "Falha ao sincronizar");
    } finally {
      setSyncing(false);
    }
  }

  async function escolherGrupo(grupoId: string) {
    const g = grupos.find((x) => x.id === grupoId);
    if (!config) return;
    const { error } = await (supabase as any).from("meta_faturado_config")
      .update({ grupo_id: g?.id, grupo_nome: g?.name }).eq("id", config.id);
    if (error) { toast.error(error.message); return; }
    toast.success("Grupo atualizado — sincronizando…");
    qc.invalidateQueries({ queryKey: ["meta-faturado-config"] });
    sincronizar();
  }

  const corGauge = corMeta(pct);
  const gaugeData = [{ name: "faturado", value: Math.min(pct, 100), fill: corGauge }];
  const barData = [
    { name: "Meta", value: meta, fill: ROSA },
    { name: "Faturado", value: faturado, fill: VERDE },
  ];

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full">
        <AppSidebar />
        <main className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
          <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-border bg-background/80 backdrop-blur-sm px-6 py-3">
            <SidebarTrigger />
            <div className="flex-1">
              <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
                <Target className="h-5 w-5 text-primary" /> Meta do Mês
              </h1>
              <p className="text-sm text-muted-foreground">
                Faturado vs Meta — lido do nome do grupo no WhatsApp ({atualizadoTxt})
              </p>
            </div>
            <Button onClick={sincronizar} disabled={syncing} size="sm">
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Atualizar agora
            </Button>
          </header>

          <div className="p-6 space-y-6 max-w-6xl">
            {/* KPIs */}
            <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
              <KpiCard title="Faturado" value={fmtBRL(faturado)} icon={DollarSign}
                iconColor="bg-[#39ff14]/10 text-[#39ff14]" />
              <KpiCard title="Meta" value={fmtBRL(meta)} icon={Target}
                iconColor="bg-[#ff2d75]/10 text-[#ff2d75]" />
              <KpiCard title="Falta" value={fmtBRL(falta)} icon={TrendingUp}
                iconColor="bg-[#00d4ff]/10 text-[#00d4ff]" />
              <KpiCard title="Atingido" value={`${pct.toFixed(1)}%`} icon={Percent} />
            </div>

            {/* Config do grupo */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Grupo monitorado</CardTitle>
                <CardDescription>
                  Instância <strong>{config?.instancia || "—"}</strong> · seguindo{" "}
                  <strong>{config?.grupo_nome || "—"}</strong>. O nome deve conter
                  {" "}<code>(faturado/meta)</code>, ex.: Scale Company (847.250/2.705.000).
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="max-w-md space-y-1">
                  <Label className="text-xs">Trocar grupo</Label>
                  <Select value={config?.grupo_id || ""} onValueChange={escolherGrupo}>
                    <SelectTrigger><SelectValue placeholder="Selecione o grupo…" /></SelectTrigger>
                    <SelectContent>
                      {grupos.map((g) => (
                        <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>

            {/* ===== 3 OPÇÕES DE GRÁFICO (escolher uma e remover as outras) ===== */}

            {/* Opção 1 — Velocímetro + evolução do mês */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Opção 1 — Velocímetro + evolução do mês</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-6 md:grid-cols-2">
                  <div className="relative h-[240px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <RadialBarChart innerRadius="70%" outerRadius="100%" data={gaugeData}
                        startAngle={180} endAngle={0}>
                        <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
                        <RadialBar background dataKey="value" cornerRadius={12} />
                      </RadialBarChart>
                    </ResponsiveContainer>
                    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none -mt-6">
                      <span className="text-4xl font-bold" style={{ color: corGauge }}>{pct.toFixed(0)}%</span>
                      <span className="text-xs text-muted-foreground">da meta</span>
                    </div>
                  </div>
                  <div className="h-[240px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={histData}>
                        <defs>
                          <linearGradient id="gFat" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={VERDE} stopOpacity={0.5} />
                            <stop offset="100%" stopColor={VERDE} stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                        <XAxis dataKey="label" tick={{ fontSize: 10 }} hide={histData.length > 12} />
                        <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                        <Tooltip formatter={(v: any) => fmtBRL(Number(v))} />
                        <Area type="monotone" dataKey="meta" stroke={ROSA} strokeDasharray="4 4" fill="none" />
                        <Area type="monotone" dataKey="faturado" stroke={VERDE} fill="url(#gFat)" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Opção 2 — Barra de progresso grande */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Opção 2 — Barra de progresso</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 py-6">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Faturado <strong className="text-foreground">{fmtBRL(faturado)}</strong></span>
                  <span className="text-muted-foreground">Meta <strong className="text-foreground">{fmtBRL(meta)}</strong></span>
                </div>
                <div className="relative h-8 w-full rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full transition-all"
                    style={{ width: `${Math.min(pct, 100)}%`, background: `linear-gradient(90deg, ${AZUL}, ${VERDE})` }} />
                  <span className="absolute inset-0 flex items-center justify-center text-sm font-bold">
                    {pct.toFixed(1)}%
                  </span>
                </div>
                <p className="text-xs text-muted-foreground text-center">Falta {fmtBRL(falta)} para a meta</p>
              </CardContent>
            </Card>

            {/* Opção 3 — Barras comparativas */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Opção 3 — Barras Meta x Faturado</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-[220px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={barData} layout="vertical" margin={{ left: 20, right: 40 }}>
                      <CartesianGrid strokeDasharray="3 3" opacity={0.15} horizontal={false} />
                      <XAxis type="number" tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 11 }} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={80} />
                      <Tooltip formatter={(v: any) => fmtBRL(Number(v))} />
                      <Bar dataKey="value" radius={[0, 6, 6, 0]}>
                        {barData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                        <LabelList dataKey="value" position="right" formatter={(v: any) => fmtBRL(Number(v))} style={{ fontSize: 11 }} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}
