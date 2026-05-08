import os
import tempfile
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from dotenv import load_dotenv
import logging

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="Transcriptor API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://audio-transcriber-tu81.vercel.app",
        "http://localhost:3000",
        "http://127.0.0.1:3000"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

openai_api_key = os.getenv("OPENAI_API_KEY")
if not openai_api_key:
    raise ValueError("OPENAI_API_KEY no configurada en el archivo .env")

client = OpenAI(api_key=openai_api_key)

@app.post("/api/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    logger.info(f"--- NUEVA PETICIÓN RECIBIDA en /api/transcribe ---")
    if not file.filename:
        logger.error("La petición falló: No se incluyó ningún nombre de archivo.")
        raise HTTPException(status_code=400, detail="No file provided")

    logger.info(f"Recibiendo Chunk de archivo: {file.filename} (Content-Type: {file.content_type})")

    # 1. Guardar el archivo subido en un temporal
    with tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(file.filename)[1]) as tmp_input:
        tmp_input.write(await file.read())
        tmp_input_path = tmp_input.name
    
    file_size_mb = os.path.getsize(tmp_input_path) / (1024 * 1024)
    logger.info(f"Chunk guardado temporalmente: {tmp_input_path} (Tamaño: {file_size_mb:.2f} MB)")

    try:
        if file_size_mb > 25:
            # Aunque Vercel bloqueará en 4.5MB, esto protege casos locales
            raise HTTPException(status_code=413, detail="File too large for direct Whisper API (max 25MB).")

        # Intentar arreglar/reempaquetar el archivo con ffmpeg si está disponible
        import subprocess
        fixed_tmp_input_path = tmp_input_path + "_fixed.m4a"
        file_to_send = tmp_input_path
        try:
            # Intentar reempaquetar (ej: ADTS a m4a) o convertir
            subprocess.run(["ffmpeg", "-y", "-i", tmp_input_path, "-c:a", "copy", fixed_tmp_input_path], 
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if os.path.exists(fixed_tmp_input_path) and os.path.getsize(fixed_tmp_input_path) > 0:
                file_to_send = fixed_tmp_input_path
                file.filename = "audio.m4a"
        except Exception:
            pass # Si ffmpeg no está disponible (ej. en Vercel) o falla, enviamos el original

        logger.info("Enviando Fragmento directamente a OpenAI Whisper API...")
        with open(file_to_send, "rb") as audio_file:
            response = client.audio.transcriptions.create(
                model="whisper-1",
                language="es",
                prompt="El siguiente es un audio en español transcrito con excelente ortografía, gramática y puntuación precisa. Se utilizan comas y puntos finales correctamente.",
                file=(file.filename, audio_file.read())
            )
            
        logger.info(f"Respuesta exitosa de OpenAI para el chunk. Limpiando y devolviendo...")
        text = response.text
            
    except Exception as e:
        logger.error(f"¡ERROR al comunicarse con OpenAI! Detalles: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error en OpenAI API: {str(e)}")
            
    finally:
        # Siempre limpiar el archivo subido
        if os.path.exists(tmp_input_path):
            os.unlink(tmp_input_path)
        try:
            if 'fixed_tmp_input_path' in locals() and os.path.exists(fixed_tmp_input_path):
                os.unlink(fixed_tmp_input_path)
        except Exception:
            pass

    return {"text": text.strip()}
