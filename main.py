import os
import io
import logging
from typing import Dict, Any, Optional
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import mss
from PIL import Image
from google import genai
from google.genai import types
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Mobile-Triggered AI Screen Analyzer",
    description="Backend API for capturing screen, processing images in-memory, and analyzing via Gemini Vision API.",
    version="1.0.0"
)

# Configure CORS for local network access (Pixel 8 / mobile browser)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for local Wi-Fi triggers
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize Gemini Client
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    logger.warning("GEMINI_API_KEY environment variable not set. AI calls will fail until set.")

client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None

# Default model (can be configured via env)
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

# Predefined System Prompts Dictionary
SYSTEM_PROMPTS: Dict[str, Dict[str, str]] = {
    "mcq_answer_only": {
        "name": "MCQ Answer Only",
        "description": "Output ONLY the correct option letter or text without any reasoning or extra text.",
        "instruction": "Analyze the screenshot and output ONLY the correct option letter or text for the multiple-choice question. Do not include any reasoning, markdown formatting, or extra text."
    },
    "mcq_with_explanation": {
        "name": "MCQ with Explanation",
        "description": "Output the correct answer alongside a brief justification.",
        "instruction": "Analyze the screenshot. Identify the correct answer to the multiple-choice question and provide a concise, clear justification/explanation."
    },
    "code_explanation": {
        "name": "Code Explanation",
        "description": "Provide a line-by-line breakdown and identify potential bugs.",
        "instruction": "Analyze the code visible in the screenshot. Provide a clear breakdown of what the code does, explain key sections, and identify any potential bugs, edge cases, or performance improvements."
    },
    "custom": {
        "name": "Custom Prompt",
        "description": "Enter your own custom prompt instructions.",
        "instruction": ""
    }
}

class CaptureRequest(BaseModel):
    prompt_key: str
    custom_prompt: Optional[str] = None

@app.get("/")
def health_check():
    return {"status": "running", "service": "Mobile-Triggered AI Screen Analyzer Backend"}

@app.get("/prompts")
def get_prompts():
    """Returns available AI prompt modes and descriptions."""
    return {
        key: {"name": val["name"], "description": val["description"]}
        for key, val in SYSTEM_PROMPTS.items()
    }

def capture_and_optimize_screen(max_width: int = 1024) -> io.BytesIO:
    """
    Captures primary monitor using mss and downscales image in memory via Pillow.
    Never saves to physical hard drive.
    """
    try:
        with mss.mss() as sct:
            # sct.monitors[1] is typically the primary monitor
            monitor = sct.monitors[1]
            sct_img = sct.grab(monitor)
            
            # Convert raw mss image to PIL Image
            img = Image.frombytes("RGB", sct_img.size, sct_img.bgra, "raw", "BGRX")
            
            # Downscale if width exceeds max_width while maintaining aspect ratio
            width, height = img.size
            if width > max_width:
                new_height = int((max_width / width) * height)
                img = img.resize((max_width, new_height), Image.Resampling.LANCZOS)
                
            # Compress and save to in-memory BytesIO buffer (JPEG format)
            buffer = io.BytesIO()
            img.save(buffer, format="JPEG", quality=85)
            buffer.seek(0)
            return buffer
    except Exception as e:
        logger.error(f"Screen capture error: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to capture screen: {str(e)}"
        )

@app.post("/capture")
def trigger_analysis(req: CaptureRequest):
    """
    Triggers invisible screen capture, downscales in memory, 
    sends to Gemini API with selected system instruction, and returns answer.
    """
    if req.prompt_key not in SYSTEM_PROMPTS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid prompt key. Available keys: {list(SYSTEM_PROMPTS.keys())}"
        )
        
    if req.prompt_key == "custom":
        if not req.custom_prompt or not req.custom_prompt.strip():
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Custom prompt cannot be empty when 'custom' mode is selected."
            )
        selected_prompt = req.custom_prompt.strip()
    else:
        selected_prompt = SYSTEM_PROMPTS[req.prompt_key]["instruction"]
        
    if not client:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Gemini API client is not initialized. Please set GEMINI_API_KEY."
        )
    
    # 1. Capture and downscale image in memory
    image_buffer = capture_and_optimize_screen()
    
    try:
        # Prepare image part for Gemini API
        image_bytes = image_buffer.read()
        image_part = types.Part.from_bytes(
            data=image_bytes,
            mime_type="image/jpeg",
        )
        
        # 2. Call Gemini API with temperature 0.0 and system instruction
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[image_part, selected_prompt],
            config=types.GenerateContentConfig(
                temperature=0.0,
                system_instruction=selected_prompt
            )
        )
        
        return {"result": response.text}
        
    except Exception as e:
        logger.error(f"Gemini API error: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"AI processing error: {str(e)}"
        )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
