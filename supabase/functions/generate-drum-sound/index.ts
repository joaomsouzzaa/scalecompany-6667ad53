import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { encode as base64Encode } from "https://deno.land/std@0.168.0/encoding/base64.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const BUCKET = "sons";
const PATH = "venda.mp3";

// Som de comemoração padrão: SINO + TAMBOR (cultura de vendas da empresa).
const PROMPT =
  "A short celebratory sound effect of a hand bell ringing brightly together with a marching bass drum and snare drum hits, festive and triumphant, like a sales team ringing the bell to celebrate a closed deal, energetic, clean, no music, no voices";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    let regenerate = false;
    try { const b = await req.json(); regenerate = !!b?.regenerate; } catch { /* sem body */ }

    // 1) Usa o som já salvo (mesmo som em toda venda) — a menos que peça pra regenerar.
    if (!regenerate) {
      const { data } = await supabase.storage.from(BUCKET).download(PATH);
      if (data) {
        const buf = await data.arrayBuffer();
        return new Response(JSON.stringify({ audioContent: base64Encode(buf), cached: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // 2) Não existe (ou regenerate): gera UMA vez no ElevenLabs e salva pra reusar.
    const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
    if (!ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY não configurada");

    const response = await fetch("https://api.elevenlabs.io/v1/sound-generation", {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ text: PROMPT, duration_seconds: 4, prompt_influence: 0.9 }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("ElevenLabs error:", response.status, errorText);
      throw new Error(`ElevenLabs API error: ${response.status}`);
    }

    const audioBuffer = await response.arrayBuffer();

    // Salva no storage pra padronizar (todas as próximas vendas usam este).
    await supabase.storage.createBucket(BUCKET, { public: true }).catch(() => {});
    await supabase.storage.from(BUCKET).upload(PATH, new Uint8Array(audioBuffer), {
      contentType: "audio/mpeg", upsert: true,
    });

    return new Response(JSON.stringify({ audioContent: base64Encode(audioBuffer), cached: false }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error generating drum sound:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
