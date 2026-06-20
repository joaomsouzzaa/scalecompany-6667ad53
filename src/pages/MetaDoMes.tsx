import { useState, useMemo, useEffect } from "react";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { KpiCard } from "@/components/KpiCard";
import { Target, DollarSign, TrendingUp, Percent, RefreshCw, Loader2, Users, Tv } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  RadialBarChart, RadialBar, PolarAngleAxis,
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
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

// ===== Gráficos (reutilizados na tela normal e no Modo TV) =====
function Gauge({ pct, cor, tv, fill }: { pct: number; cor: string; tv?: boolean; fill?: boolean }) {
  const data = [{ name: "faturado", value: Math.min(pct, 100), fill: cor }];
  return (
    <div className={`relative ${tv ? "h-full min-h-0" : fill ? "h-[58vh] min-h-[320px]" : "h-[240px]"}`}>
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart innerRadius="70%" outerRadius="100%" data={data} startAngle={180} endAngle={0}>
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          {/* Trilho (parte não atingida) em tom suave da própria cor: mostra "até onde dá pra chegar" sem chamar atenção */}
          <RadialBar background={{ fill: cor, fillOpacity: 0.12 }} dataKey="value" cornerRadius={12} />
        </RadialBarChart>
      </ResponsiveContainer>
      {/* Texto na abertura do semicírculo (parte de baixo), sem cobrir o arco */}
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center pointer-events-none" style={{ height: "42%", justifyContent: "center" }}>
        <span className="font-bold leading-none" style={{ color: cor, fontSize: tv || fill ? "clamp(2rem, 7vh, 5rem)" : "2.25rem" }}>
          {pct.toFixed(0)}%
        </span>
        <span className="text-muted-foreground" style={{ fontSize: tv || fill ? "clamp(0.8rem, 1.6vh, 1.4rem)" : "0.75rem" }}>da meta</span>
      </div>
    </div>
  );
}

function Evolution({ data, tv, fill }: { data: { label: string; faturado: number; meta: number }[]; tv?: boolean; fill?: boolean }) {
  return (
    <div className={tv ? "h-full min-h-0" : fill ? "h-[58vh] min-h-[320px]" : "h-[240px]"}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data}>
          <defs>
            <linearGradient id="gFat" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={VERDE} stopOpacity={0.5} />
              <stop offset="100%" stopColor={VERDE} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
          <XAxis dataKey="label" tick={{ fontSize: tv ? 13 : 10 }} hide={data.length > 12} />
          <YAxis tick={{ fontSize: tv ? 13 : 10 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
          <Tooltip formatter={(v: any) => fmtBRL(Number(v))} />
          <Area type="monotone" dataKey="meta" stroke={ROSA} strokeDasharray="4 4" fill="none" />
          <Area type="monotone" dataKey="faturado" stroke={VERDE} fill="url(#gFat)" strokeWidth={tv ? 3 : 2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function MetaDoMes() {
  const qc = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const [grupoOpen, setGrupoOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [tvMode, setTvMode] = useState(false);
  const [tvLayout, setTvLayout] = useState<"16:9" | "2:1">("16:9");

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

  const { data: grupos = [] } = useQuery({
    queryKey: ["meta-faturado-grupos", config?.instancia],
    enabled: !!config && grupoOpen,
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
  const corGauge = corMeta(pct);

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

  // Modo TV: fecha a sidebar e entra/sai de fullscreen.
  useEffect(() => { setSidebarOpen(!tvMode); }, [tvMode]);
  useEffect(() => {
    const onFs = () => { if (!document.fullscreenElement) setTvMode(false); };
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const entrarTv = async (layout: "16:9" | "2:1") => {
    setTvLayout(layout);
    try { await document.documentElement.requestFullscreen(); } catch {}
    setTvMode(true);
  };
  const sairTv = async () => {
    if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch {} }
    setTvMode(false);
  };

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
    setGrupoOpen(false);
    qc.invalidateQueries({ queryKey: ["meta-faturado-config"] });
    sincronizar();
  }

  // Blocos reutilizáveis ------------------------------------------------------
  const kpiCards = [
    <KpiCard key="f" title="Faturado" value={fmtBRL(faturado)} icon={DollarSign} iconColor="bg-[#39ff14]/10 text-[#39ff14]" />,
    <KpiCard key="m" title="Meta" value={fmtBRL(meta)} icon={Target} iconColor="bg-[#ff2d75]/10 text-[#ff2d75]" />,
    <KpiCard key="x" title="Falta" value={fmtBRL(falta)} icon={TrendingUp} iconColor="bg-[#00d4ff]/10 text-[#00d4ff]" />,
    <KpiCard key="a" title="Atingido" value={`${pct.toFixed(1)}%`} icon={Percent} />,
  ];
  const kpisBlock = <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">{kpiCards}</div>;

  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <div className="min-h-screen flex w-full">
        <AppSidebar />
        <main className={tvMode ? `flex-1 meta-tv ${tvLayout === "2:1" ? "meta-tv-2x1" : ""}` : "flex-1 min-w-0 overflow-y-auto overflow-x-hidden"}>
          <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/80 backdrop-blur-sm px-6 py-3">
            <SidebarTrigger />
            <div className="flex-1">
              <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
                <Target className="h-5 w-5 text-primary" /> Meta do Mês
              </h1>
              {!tvMode && (
                <p className="text-sm text-muted-foreground">
                  Faturado vs Meta — lido do nome do grupo no WhatsApp ({atualizadoTxt})
                </p>
              )}
            </div>

            {tvMode ? (
              <Button variant="default" size="sm" onClick={sairTv} className="gap-2">
                <Tv className="h-4 w-4" /> Sair do Modo TV
              </Button>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={() => setGrupoOpen(true)} className="gap-2">
                  <Users className="h-4 w-4" /> Grupo
                </Button>
                <Button onClick={sincronizar} disabled={syncing} size="sm" className="gap-2">
                  {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Atualizar agora
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-2">
                      <Tv className="h-4 w-4" /> Modo TV
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => entrarTv("16:9")}>📺 16:9 (1 TV)</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => entrarTv("2:1")}>🖥️ 2:1 (2 TVs lado a lado)</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </header>

          {/* ===================== MODO TV ===================== */}
          {tvMode ? (
            <div className="meta-tv-body">
              {tvLayout === "2:1" ? (
                <>
                  {/* TV 1 — métricas grandes (2x2 preenchendo a tela 16:9) */}
                  <div className="meta-tv-col meta-tv-metrics">
                    <div className="meta-tv-kpis">{kpiCards}</div>
                  </div>
                  {/* TV 2 — gráficos grandes (velocímetro + evolução) */}
                  <div className="meta-tv-col meta-tv-charts">
                    <div className="meta-tv-gauge"><Gauge pct={pct} cor={corGauge} tv /></div>
                    <div className="meta-tv-evo"><Evolution data={histData} tv /></div>
                  </div>
                </>
              ) : (
                <>
                  {/* 16:9 — uma tela: métricas (2x2) à esquerda, gráficos à direita */}
                  <div className="meta-tv-col meta-tv-metrics">
                    <div className="meta-tv-kpis">{kpiCards}</div>
                  </div>
                  <div className="meta-tv-col meta-tv-charts">
                    <div className="meta-tv-gauge"><Gauge pct={pct} cor={corGauge} tv /></div>
                    <div className="meta-tv-evo"><Evolution data={histData} tv /></div>
                  </div>
                </>
              )}
            </div>
          ) : (
            /* ===================== TELA NORMAL ===================== */
            <div className="p-6 space-y-6">
              {kpisBlock}

              {/* Velocímetro + evolução do mês — preenche a tela (altura em vh) */}
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base">Velocímetro + evolução do mês</CardTitle></CardHeader>
                <CardContent>
                  <div className="grid gap-6 md:grid-cols-2">
                    <Gauge pct={pct} cor={corGauge} fill />
                    <Evolution data={histData} fill />
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </main>
      </div>

      {/* Popup de seleção de grupo */}
      <Dialog open={grupoOpen} onOpenChange={setGrupoOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Grupo monitorado</DialogTitle>
            <DialogDescription>
              Instância <strong>{config?.instancia || "—"}</strong> · seguindo{" "}
              <strong>{config?.grupo_nome || "—"}</strong>. O nome do grupo deve conter{" "}
              <code>(faturado/meta)</code>, ex.: Scale Company (847.250/2.705.000).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label className="text-xs">Trocar grupo</Label>
            <Select value={config?.grupo_id || ""} onValueChange={escolherGrupo}>
              <SelectTrigger><SelectValue placeholder="Selecione o grupo…" /></SelectTrigger>
              <SelectContent>
                {grupos.map((g) => (
                  <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground pt-1">Ao trocar, sincronizamos automaticamente.</p>
          </div>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}
