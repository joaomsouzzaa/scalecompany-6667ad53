import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Wifi, WifiOff, RefreshCw, QrCode, LogOut, Plus, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export type Instancia = { nome: string; status: string; numero: string | null };

const conectada = (s: string) => s === "connected" || s === "conectado";

/**
 * Gerencia o POOL compartilhado de instâncias UAZAPI (criar/conectar/QR/deletar).
 * As credenciais de admin (URL + token) ficam em secrets no backend; aqui o
 * usuário só lida com o nome das instâncias. Usado em Notificações e Cobrança.
 */
export function InstanciasUazapi({
  funcao = "uazapi",
  onInstancias,
  extraActions,
}: {
  funcao?: "uazapi" | "cobranca";
  onInstancias?: (instancias: Instancia[]) => void;
  extraActions?: (inst: Instancia) => React.ReactNode;
}) {
  const [instancias, setInstancias] = useState<Instancia[]>([]);
  const [novoNome, setNovoNome] = useState("");
  const [criando, setCriando] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // nome em operação
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const chamar = useCallback(async (action: string, payload: Record<string, unknown> = {}) => {
    const { data, error } = await supabase.functions.invoke(funcao, { body: { action, ...payload } });
    if (error) {
      let msg = error.message;
      try { const ctx = (error as any).context; if (ctx?.json) { const b = await ctx.json(); if (b?.error) msg = b.error; } } catch { /* ignore */ }
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }, [funcao]);

  const carregar = useCallback(async () => {
    try {
      const data = await chamar("listar_instancias");
      const list = (data?.instancias || []) as Instancia[];
      setInstancias(list);
      onInstancias?.(list);
    } catch { /* silencioso */ }
  }, [chamar, onInstancias]);

  useEffect(() => { carregar(); }, [carregar]);

  const criar = async () => {
    const nome = novoNome.trim();
    if (!nome) { toast.error("Digite um nome para a instância"); return; }
    setCriando(true);
    try {
      await chamar("criar_instancia", { nome });
      setNovoNome("");
      toast.success(`Instância "${nome}" criada. Clique em Conectar para gerar o QR.`);
      await carregar();
    } catch (e: any) {
      toast.error(e?.message || "Falha ao criar instância");
    } finally {
      setCriando(false);
    }
  };

  const atualizar = async (nome: string, silent = false) => {
    try {
      const data = await chamar("status", { instancia: nome });
      if (conectada(data?.status) || data?.connected) { if (qrFor === nome) { setQrCode(null); setQrFor(null); } }
      else if (data?.qrcode && qrFor === nome) setQrCode(data.qrcode);
      await carregar();
      return !!(conectada(data?.status) || data?.connected);
    } catch (e: any) {
      if (!silent) toast.error(e?.message || "Falha ao consultar status");
      return false;
    }
  };

  const conectar = async (nome: string) => {
    setBusy(nome);
    setQrFor(nome);
    setQrCode(null);
    try {
      const data = await chamar("connect", { instancia: nome });
      if (data?.qrcode) setQrCode(data.qrcode);
      toast.success("Escaneie o QR Code no WhatsApp");
      // poll status até conectar (~1min)
      if (pollRef.current) window.clearInterval(pollRef.current);
      let tries = 0;
      pollRef.current = window.setInterval(async () => {
        tries++;
        const ok = await atualizar(nome, true);
        if (ok || tries >= 20) { if (pollRef.current) window.clearInterval(pollRef.current); }
      }, 3000);
    } catch (e: any) {
      toast.error(e?.message || "Falha ao conectar");
      setQrFor(null);
    } finally {
      setBusy(null);
    }
  };

  const desconectar = async (nome: string) => {
    if (!confirm(`Desconectar a instância "${nome}"? Será preciso escanear o QR de novo.`)) return;
    setBusy(nome);
    try {
      await chamar("disconnect", { instancia: nome });
      if (qrFor === nome) { setQrCode(null); setQrFor(null); }
      toast.success("Instância desconectada.");
      await carregar();
    } catch (e: any) {
      toast.error(e?.message || "Falha ao desconectar");
    } finally {
      setBusy(null);
    }
  };

  const deletar = async (nome: string) => {
    if (!confirm(`Deletar a instância "${nome}" na UAZAPI? Esta ação é irreversível.`)) return;
    setBusy(nome);
    try {
      await chamar("deletar_instancia", { nome });
      if (qrFor === nome) { setQrCode(null); setQrFor(null); }
      toast.success("Instância deletada.");
      await carregar();
    } catch (e: any) {
      toast.error(e?.message || "Falha ao deletar instância");
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current); }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Instâncias WhatsApp (UAZAPI)</CardTitle>
        <CardDescription>
          Crie quantas instâncias precisar e conecte cada uma escaneando o QR Code. As instâncias são compartilhadas entre Notificações e Cobrança.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label>Nova instância</Label>
            <Input placeholder="ex: vendas" value={novoNome} onChange={(e) => setNovoNome(e.target.value)} className="w-56"
              onKeyDown={(e) => { if (e.key === "Enter") criar(); }} />
          </div>
          <Button onClick={criar} disabled={criando}><Plus className="mr-2 h-4 w-4" />{criando ? "Criando..." : "Criar instância"}</Button>
        </div>

        {instancias.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma instância criada ainda.</p>
        ) : (
          <div className="space-y-2">
            {instancias.map((inst) => (
              <div key={inst.nome} className="rounded-md border border-border p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  {conectada(inst.status) ? <Wifi className="h-4 w-4 text-success" /> : <WifiOff className="h-4 w-4 text-muted-foreground" />}
                  <span className="font-medium">{inst.nome}</span>
                  <Badge variant={conectada(inst.status) ? "default" : "secondary"}>
                    {conectada(inst.status) ? `Conectado${inst.numero ? ` · ${inst.numero}` : ""}` : inst.status}
                  </Badge>
                  <div className="ml-auto flex flex-wrap gap-2">
                    {!conectada(inst.status) && (
                      <Button size="sm" onClick={() => conectar(inst.nome)} disabled={busy === inst.nome}>
                        <QrCode className="mr-2 h-4 w-4" /> Conectar / QR
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => atualizar(inst.nome)} disabled={busy === inst.nome}>
                      <RefreshCw className="mr-2 h-4 w-4" /> Status
                    </Button>
                    {extraActions?.(inst)}
                    {conectada(inst.status) && (
                      <Button size="sm" variant="outline" onClick={() => desconectar(inst.nome)} disabled={busy === inst.nome}>
                        <LogOut className="mr-2 h-4 w-4" /> Desconectar
                      </Button>
                    )}
                    <Button size="sm" variant="outline" className="text-destructive" onClick={() => deletar(inst.nome)} disabled={busy === inst.nome}>
                      <Trash2 className="mr-2 h-4 w-4" /> Deletar
                    </Button>
                  </div>
                </div>
                {qrFor === inst.nome && qrCode && (
                  <div className="flex flex-col items-center gap-2 pt-1">
                    <img src={qrCode.startsWith("data:") ? qrCode : `data:image/png;base64,${qrCode}`} alt="QR Code WhatsApp" className="h-52 w-52 rounded-lg border border-border bg-white p-2" />
                    <p className="text-xs text-muted-foreground">WhatsApp → Aparelhos conectados → Conectar aparelho → escaneie</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
