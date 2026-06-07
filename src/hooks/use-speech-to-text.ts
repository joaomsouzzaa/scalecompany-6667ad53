import { useCallback, useEffect, useRef, useState } from "react";

// Ditado por voz usando a Web Speech API nativa do navegador (Chrome/Edge).
// onText recebe o texto reconhecido (final) para anexar ao campo.
export function useSpeechToText(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const supported = typeof window !== "undefined" &&
    !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

  useEffect(() => {
    if (!supported) return;
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = "pt-BR";
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e: any) => {
      let finalText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      }
      if (finalText.trim()) onTextRef.current(finalText.trim());
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    return () => { try { rec.stop(); } catch { /* noop */ } };
  }, [supported]);

  const toggle = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    if (listening) {
      rec.stop();
      setListening(false);
    } else {
      try { rec.start(); setListening(true); } catch { /* já iniciado */ }
    }
  }, [listening]);

  return { supported, listening, toggle };
}
