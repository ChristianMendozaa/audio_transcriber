"use client";

import { useState, useRef, useEffect } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [progressText, setProgressText] = useState("");
  const [transcription, setTranscription] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const ffmpegRef = useRef<any>(null);
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);

  useEffect(() => {
    loadFfmpeg();
  }, []);

  const loadFfmpeg = async () => {
    try {
      const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
      const ffmpeg = new FFmpeg();
      ffmpegRef.current = ffmpeg;
      
      ffmpeg.on("log", ({ message }) => {
        console.log(message);
      });
      
      await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
      });
      setFfmpegLoaded(true);
    } catch (err) {
      console.error("Error loading FFmpeg:", err);
      // Wait for user interaction or fallback
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
      setTranscription(null);
      setError(null);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setFile(e.dataTransfer.files[0]);
      setTranscription(null);
      setError(null);
    }
  };

  const formatFileSize = (bytes: number) => {
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  };

  const processAndUpload = async () => {
    if (!file) return;

    if (!ffmpegLoaded) {
      setError("El procesador de audio aún se está inicializando. Espera unos segundos e intenta de nuevo.");
      return;
    }

    setIsUploading(true);
    setError(null);
    setTranscription(null);

    const ffmpeg = ffmpegRef.current;
    const ext = file.name.split(".").pop()?.toLowerCase() || "mp3";
    const supportedFormats = ["flac", "m4a", "mp3", "mp4", "mpeg", "mpga", "oga", "ogg", "wav", "webm"];
    const videoExtensions = ["mp4", "mkv", "avi", "mov", "webm", "flv", "wmv", "m4v", "3gp"];
    const isVideo = file.type.startsWith("video/") || videoExtensions.includes(ext);
    
    let outExt = ext;
    let encodeArgs = ["-c", "copy"];
    
    if (isVideo || !supportedFormats.includes(ext)) {
      // Si es un video o formato exótico, re-codificamos extrayendo solo el audio.
      // Parámetros mágicos de Accuracy: Whisper funciona a 16kHz internamente. 
      // Al convertirlo en el navegador a 16kHz y Mono, evitamos perder calidad real,
      // mientras eliminamos el 90% del peso de canales estéreo y frecuencias que la IA ignora.
      outExt = "m4a"; 
      encodeArgs = ["-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "64k"];
    } else if (ext === "aac") {
      outExt = "m4a"; // AAC nativo se envuelve directo
    }

    const inName = `input.${ext}`;

    try {
      if (!isVideo && file.size <= 3.5 * 1024 * 1024 && supportedFormats.includes(ext) && ext !== "aac") {
        // Less than 3.5MB natively supported pure AUDIO, skip segmentation and send directly
        setProgressText(`Transcribiendo archivo íntegro (${formatFileSize(file.size)})...`);
        await transcribeChunk(file, 1, 1);
        return;
      }

      setProgressText(isVideo ? "Extrayendo y optimizando audio del video..." : "Cortando/Convirtiendo el archivo en tu navegador...");

      // Load file into ffmpeg virtual FS
      await ffmpeg.writeFile(inName, await fetchFile(file));

      // Cut into segments, applying logic for videos and unsupported codecs
      setProgressText(`Procesando localmente para sortear límites de Servidor...`);
      await ffmpeg.exec([
        "-i", inName,
        "-f", "segment",
        "-segment_time", "60",
        ...encodeArgs,
        `out%03d.${outExt}`
      ]);

      setProgressText("Leyendo fragmentos generados...");
      const files = await ffmpeg.listDir(".");
      const chunks = files
        .filter((f: any) => f.name.startsWith("out") && f.name.endsWith(`.${outExt}`))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));

      if (chunks.length === 0) {
        throw new Error("No se pudo segmentar el audio correctamente (formato no soportado por -c copy). Intenta convertir tu archivo a .mp3 o .m4a e intentar de nuevo.");
      }

      for (let i = 0; i < chunks.length; i++) {
        setProgressText(`Transcribiendo fragmento ${i + 1} de ${chunks.length}...`);
        
        const fileData = await ffmpeg.readFile(chunks[i].name);
        // readFile returns Uint8Array or String in v0.12.
        const chunkBlob = new Blob([fileData as any], { type: file.type });
        const chunkFile = new File([chunkBlob], chunks[i].name, { type: file.type });
        
        // Clean up from memory
        await ffmpeg.deleteFile(chunks[i].name);

        await transcribeChunk(chunkFile, i + 1, chunks.length);
      }

      await ffmpeg.deleteFile(inName);
      
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Ha ocurrido un error inesperado al procesar tu audio.");
    } finally {
      setIsUploading(false);
      setProgressText("");
    }
  };

  const transcribeChunk = async (chunkFile: File, idx: number, total: number) => {
    const formData = new FormData();
    formData.append("file", chunkFile);

    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://127.0.0.1:8000";

    const response = await fetch(`${backendUrl}/api/transcribe`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.detail || `Error transcribiendo la parte ${idx}`);
    }

    const data = await response.json();
    setTranscription((prev) => (prev ? prev + " " + data.text : data.text));
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6 relative overflow-hidden">
      
      <div className="z-10 text-center mb-10 animate-float">
        <h1 className="text-5xl md:text-6xl font-extrabold bg-clip-text text-transparent bg-gradient-to-r from-indigo-400 to-purple-400">
          Audio to Text AI
        </h1>
        <p className="mt-4 text-slate-300 text-lg max-w-xl mx-auto">
          Sube tu audio inmenso. El navegador lo cortará inteligentemente y lo sincronizará a Vercel sin límites.
        </p>
      </div>

      <div className="z-10 w-full max-w-2xl glassmorphism rounded-3xl p-8 backdrop-blur-xl border border-white/10 shadow-2xl">
        
        {!transcription || isUploading ? (
          <div className="flex flex-col items-center">
            
            <div
              className={`w-full border-2 border-dashed rounded-2xl p-10 flex flex-col items-center justify-center transition-all ${
                file ? "border-indigo-400 bg-indigo-500/10" : "border-slate-500 hover:border-purple-400 hover:bg-purple-500/5 cursor-pointer"
              }`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              onClick={() => !file && fileInputRef.current?.click()}
            >
              <input
                type="file"
                className="hidden"
                ref={fileInputRef}
                onChange={handleFileChange}
                accept="audio/*,video/*,.aac,.mp3,.wav,.m4a,.mp4,.mkv,.avi,.mov,.webm,.flv,.wmv,.m4v,.3gp"
              />
              
              {!file ? (
                <>
                  <div className="bg-slate-800 p-4 rounded-full mb-4 relative">
                    {!ffmpegLoaded && (
                       <span className="absolute -top-2 -right-2 flex h-4 w-4">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-4 w-4 bg-red-500"></span>
                      </span>
                    )}
                    <svg className="w-8 h-8 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
                  </div>
                  <p className="text-xl font-semibold text-slate-200">
                    {!ffmpegLoaded ? "Inicializando Motor (10MB)..." : "Arrastra y suelta tu archivo gigante aquí"}
                  </p>
                  <p className="text-sm text-slate-400 mt-2">Formatos válidos: MP3, AAC, M4A, WAV...</p>
                </>
              ) : (
                <div className="flex flex-col items-center text-center">
                  <div className="bg-green-500/20 p-4 rounded-full mb-4">
                    <svg className="w-8 h-8 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path></svg>
                  </div>
                  <p className="text-xl font-semibold text-slate-200">{file.name}</p>
                  <p className="text-sm text-slate-400 mt-2">{formatFileSize(file.size)}</p>
                  {!isUploading && (
                    <button 
                      onClick={(e) => { e.stopPropagation(); setFile(null); }}
                      className="mt-4 text-sm text-red-400 hover:text-red-300 underline"
                    >
                      Remover
                    </button>
                  )}
                </div>
              )}
            </div>

            {error && (
              <div className="w-full mt-6 bg-red-500/10 border border-red-500/50 rounded-xl p-4 text-red-200 text-sm text-center">
                {error}
              </div>
            )}

            <button
              onClick={processAndUpload}
              disabled={!file || isUploading || !ffmpegLoaded}
              className={`mt-8 w-full py-4 rounded-xl font-bold text-lg transition-all flex items-center justify-center gap-3 ${
                !file || isUploading || !ffmpegLoaded
                ? "bg-slate-700 text-slate-400 cursor-not-allowed" 
                : "bg-gradient-to-r from-indigo-500 to-purple-500 hover:from-indigo-400 hover:to-purple-400 text-white shadow-[0_0_20px_rgba(99,102,241,0.4)] hover:shadow-[0_0_30px_rgba(168,85,247,0.6)]"
              }`}
            >
              {isUploading ? (
                <>
                  <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  {progressText}
                </>
              ) : (
                "Transcribir Ahora"
              )}
            </button>
            
            {transcription && isUploading && (
              <div className="mt-8 w-full">
                <p className="text-sm font-bold text-slate-300 mb-2">Transcripción Parcial en Vivo:</p>
                <div className="bg-black/30 p-4 rounded-xl max-h-32 overflow-y-auto text-slate-400 text-sm custom-scrollbar">
                  {transcription}
                </div>
              </div>
            )}
            
          </div>
        ) : (
          <div className="flex flex-col h-full">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-white flex gap-2 items-center">
                <svg className="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                Transcripción Completada
              </h2>
              <button 
                onClick={() => setTranscription(null)}
                className="text-sm bg-slate-700 hover:bg-slate-600 px-4 py-2 rounded-lg transition-colors text-white"
              >
                Nuevo Audio
              </button>
            </div>
            
            <div className="bg-black/40 w-full rounded-2xl p-6 overflow-y-auto min-h-[200px] max-h-[500px] border border-white/5 custom-scrollbar">
              <p className="text-lg leading-relaxed text-slate-200 font-light whitespace-pre-wrap">
                {transcription}
              </p>
            </div>
            
            <button 
              onClick={() => {
                navigator.clipboard.writeText(transcription);
                alert("¡Copiado al portapapeles!");
              }}
              className="mt-6 w-full py-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl font-bold transition-all flex justify-center items-center gap-2 text-white"
            >
              <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"></path></svg>
              Copiar Texto
            </button>
          </div>
        )}
      </div>

    </main>
  );
}
