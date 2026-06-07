import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const REDIRECT_URI = "https://app.scalehacking.com.br/integracoes";
const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

function svc() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}
async function getCfg(supabase: any) {
  const { data } = await supabase.from("google_config").select("*").eq("id", 1).maybeSingle();
  return data || {};
}

// Token de acesso válido (renova com refresh_token se expirado).
async function getAccessToken(supabase: any): Promise<string> {
  const cfg = await getCfg(supabase);
  if (!cfg.refresh_token) throw new Error("Google não conectado");
  const exp = cfg.token_expiry ? new Date(cfg.token_expiry).getTime() : 0;
  if (cfg.access_token && exp > Date.now() + 60000) return cfg.access_token;
  // refresh
  const body = new URLSearchParams({
    client_id: cfg.client_id, client_secret: cfg.client_secret,
    refresh_token: cfg.refresh_token, grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  const j = await r.json();
  if (!r.ok) throw new Error(`Falha ao renovar token Google: ${j.error_description || j.error}`);
  const expiry = new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString();
  await supabase.from("google_config").update({ access_token: j.access_token, token_expiry: expiry }).eq("id", 1);
  return j.access_token;
}

async function gapi(token: string, url: string, init?: RequestInit) {
  const r = await fetch(url, { ...init, headers: { ...(init?.headers || {}), Authorization: `Bearer ${token}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `Google API ${r.status}`);
  return j;
}

// Append de uma linha mapeando { "Coluna": "valor" } para a ordem do cabeçalho.
async function appendRow(supabase: any, spreadsheetId: string, aba: string, valoresPorColuna: Record<string, string>) {
  const token = await getAccessToken(supabase);
  const range = `${aba}!1:1`;
  const head = await gapi(token, `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`);
  const headers: string[] = head.values?.[0] || [];
  if (headers.length === 0) throw new Error("A aba não tem cabeçalho na linha 1");
  const linha = headers.map((h) => valoresPorColuna[h] ?? "");
  await gapi(token,
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(aba)}:append?valueInputOption=USER_ENTERED`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values: [linha] }) });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const supabase = svc();
  try {
    const body = await req.json();
    const action = body.action;

    if (action === "get_auth_url") {
      const cfg = await getCfg(supabase);
      if (!cfg.client_id) throw new Error("Cadastre o Client ID/Secret do Google primeiro");
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.searchParams.set("client_id", cfg.client_id);
      u.searchParams.set("redirect_uri", REDIRECT_URI);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", SCOPES);
      u.searchParams.set("access_type", "offline");
      u.searchParams.set("prompt", "consent");
      return json({ url: u.toString() });
    }

    if (action === "exchange") {
      const cfg = await getCfg(supabase);
      const form = new URLSearchParams({
        code: body.code, client_id: cfg.client_id, client_secret: cfg.client_secret,
        redirect_uri: REDIRECT_URI, grant_type: "authorization_code",
      });
      const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: form });
      const j = await r.json();
      if (!r.ok) throw new Error(`Erro no OAuth: ${j.error_description || j.error}`);
      const expiry = new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString();
      let email = null;
      try {
        const ui = await gapi(j.access_token, "https://www.googleapis.com/oauth2/v2/userinfo");
        email = ui.email;
      } catch { /* ignore */ }
      const patch: any = { access_token: j.access_token, token_expiry: expiry, email, updated_at: new Date().toISOString() };
      if (j.refresh_token) patch.refresh_token = j.refresh_token; // só vem na 1ª vez
      await supabase.from("google_config").update(patch).eq("id", 1);
      return json({ ok: true, email });
    }

    if (action === "status") {
      const cfg = await getCfg(supabase);
      return json({ connected: !!cfg.refresh_token, email: cfg.email, has_client: !!cfg.client_id });
    }

    if (action === "disconnect") {
      await supabase.from("google_config").update({ access_token: null, refresh_token: null, token_expiry: null, email: null }).eq("id", 1);
      return json({ ok: true });
    }

    if (action === "list_spreadsheets") {
      const token = await getAccessToken(supabase);
      // Pagina por TODAS as planilhas (não só as 100 recentes) p/ aparecer renomeadas/antigas.
      const files: any[] = [];
      let pageToken = "";
      do {
        const u = "https://www.googleapis.com/drive/v3/files?q=" +
          encodeURIComponent("mimeType='application/vnd.google-apps.spreadsheet' and trashed=false") +
          "&orderBy=modifiedTime desc&pageSize=1000&fields=nextPageToken,files(id,name)" +
          "&includeItemsFromAllDrives=true&supportsAllDrives=true&corpora=allDrives" +
          (pageToken ? `&pageToken=${pageToken}` : "");
        const j = await gapi(token, u);
        files.push(...(j.files || []));
        pageToken = j.nextPageToken || "";
      } while (pageToken && files.length < 5000);
      return json({ files });
    }

    if (action === "list_tabs") {
      const token = await getAccessToken(supabase);
      const j = await gapi(token, `https://sheets.googleapis.com/v4/spreadsheets/${body.spreadsheet_id}?fields=properties.title,sheets.properties.title`);
      const tabs = (j.sheets || []).map((s: any) => s.properties.title);
      return json({ tabs, title: j.properties?.title });
    }

    if (action === "list_headers") {
      const token = await getAccessToken(supabase);
      const range = `${body.aba}!1:1`;
      const j = await gapi(token, `https://sheets.googleapis.com/v4/spreadsheets/${body.spreadsheet_id}/values/${encodeURIComponent(range)}`);
      return json({ headers: j.values?.[0] || [] });
    }

    if (action === "append") {
      await appendRow(supabase, body.spreadsheet_id, body.aba, body.valores || {});
      return json({ ok: true });
    }

    return json({ error: "ação desconhecida" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Erro interno" }, 400);
  }
});
