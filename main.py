import os
import io
import json
import logging
import random
import re
import time
import threading
from typing import Dict, Any, Optional, List
from fastapi import FastAPI, HTTPException, status, Header, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import mss
from PIL import Image
import pyautogui
from google import genai
from google.genai import types
from dotenv import load_dotenv

# Configure PyAutoGUI safety settings
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.1

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Mobile-Triggered AI Screen Analyzer",
    description="Backend API for capturing screen, processing images in-memory, and analyzing via Gemini Vision API with Manual and Autonomous Auto-Bot modes.",
    version="2.0.0"
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

# Default model and auth token
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
API_TOKEN = os.getenv("API_TOKEN", "super-secret-token-123")

def verify_token(x_auth_token: Optional[str] = Header(None)):
    if API_TOKEN and x_auth_token != API_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing authentication token."
        )
    return x_auth_token

# Predefined System Prompts Dictionary for Manual Mode
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

class AutomationStartRequest(BaseModel):
    max_cycles: Optional[int] = 100
    delay_seconds: Optional[float] = 0.5

class CodingPasteRequest(BaseModel):
    text: Optional[str] = None
    method: Optional[str] = "paste"  # "paste" (clipboard) or "type" (simulated typing)

class CodingSolveRequest(BaseModel):
    custom_prompt: Optional[str] = None

# Global Automation State & Lock
automation_lock = threading.Lock()
stop_event = threading.Event()
automation_thread: Optional[threading.Thread] = None

automation_state: Dict[str, Any] = {
    "is_running": False,
    "cycle": 0,
    "max_cycles": 100,
    "question_number": None,
    "last_action": "Idle",
    "last_answer": None,
    "error": None,
    "run_id": None,
    "results": []
}

# Coding Mode State & Lock
coding_lock = threading.Lock()
coding_buffer: List[io.BytesIO] = []
coding_last_answer: Optional[str] = None

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

def capture_and_optimize_screen(max_width: int = 1280, jpeg_quality: int = 90) -> io.BytesIO:
    """
    Captures primary monitor using mss and downscales image in memory via Pillow.
    Never saves to physical hard drive.
    """
    try:
        with mss.mss() as sct:
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
            img.save(buffer, format="JPEG", quality=jpeg_quality, optimize=True)
            buffer.seek(0)
            return buffer
    except Exception as e:
        logger.error(f"Screen capture error: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to capture screen: {str(e)}"
        )

def get_screen_resolution() -> tuple[int, int]:
    """Returns physical screen width and height using mss primary monitor."""
    with mss.mss() as sct:
        mon = sct.monitors[1]
        return mon["width"], mon["height"]

def translate_normalized_box(box: List[float], screen_w: int, screen_h: int) -> tuple[int, int]:
    """
    Translates Gemini 0-1000 normalized bounding box [ymin, xmin, ymax, xmax] 
    to absolute screen center coordinates (x, y).
    """
    ymin, xmin, ymax, xmax = box
    cx = int(((xmin + xmax) / 2.0 / 1000.0) * screen_w)
    cy = int(((ymin + ymax) / 2.0 / 1000.0) * screen_h)
    return cx, cy

def perform_scatter_click(center_x: int, center_y: int, clicks: int = 3, radius: int = 8):
    """
    Executes a 'scatter click' cluster around the center point to guarantee selection.
    """
    for _ in range(clicks):
        offset_x = center_x + random.randint(-radius, radius)
        offset_y = center_y + random.randint(-radius, radius)
        pyautogui.click(offset_x, offset_y)
        time.sleep(0.08)

def extract_code_from_answer(text: str) -> str:
    """
    Extracts the cleanest code from the LLM answer. Prefers the largest fenced code
    block, otherwise returns the whole answer with leading/trailing whitespace trimmed.
    Tabs are converted to 4 spaces and trailing whitespace is stripped per line so the
    code is stable to type.
    """
    if not text:
        return ""
    blocks = re.findall(r'```(?:\w+)?\s*\n?([\s\S]*?)```', text)
    if blocks:
        code = max(blocks, key=len)
    else:
        code = text
    lines = []
    for line in code.splitlines():
        line = line.replace("\t", "    ").rstrip()
        lines.append(line)
    # drop leading/trailing blank lines
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(lines)

def _type_text_sendinput(text: str, interval: float = 0.02, line_delay: float = 0.03):
    """
    Types text on Windows using the SendInput API with KEYEVENTF_UNICODE events.
    This types every character exactly (including { } and other symbols that
    pyautogui.typewrite mishandles).

    Indentation strategy: each line is typed WITHOUT its leading whitespace so the
    editor's own auto-indent (triggered after Enter) applies. This avoids the
    double-indentation that occurs when typed spaces stack on top of auto-indent.
    """
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", wintypes.WORD),
            ("wScan", wintypes.WORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
        ]

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [
            ("dx", wintypes.LONG),
            ("dy", wintypes.LONG),
            ("mouseData", wintypes.DWORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
        ]

    class INPUTUNION(ctypes.Union):
        _fields_ = [
            ("ki", KEYBDINPUT),
            ("mi", MOUSEINPUT),
        ]

    class INPUT(ctypes.Structure):
        _fields_ = [
            ("type", wintypes.DWORD),
            ("u", INPUTUNION),
        ]

    INPUT_KEYBOARD = 1
    KEYEVENTF_KEYUP = 0x0002
    KEYEVENTF_UNICODE = 0x0004
    VK_RETURN = 0x0D

    def send_key(wVk, wScan, flags):
        inp = INPUT()
        inp.type = INPUT_KEYBOARD
        inp.u.ki.wVk = wVk
        inp.u.ki.wScan = wScan
        inp.u.ki.dwFlags = flags
        inp.u.ki.time = 0
        inp.u.ki.dwExtraInfo = None
        result = user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
        if result != 1:
            raise ctypes.WinError(ctypes.get_last_error())

    def press_key(wVk):
        send_key(wVk, 0, 0)
        send_key(wVk, 0, KEYEVENTF_KEYUP)

    lines = text.splitlines() or [""]
    for line in lines:
        # Type the line without leading whitespace; the editor auto-indents.
        stripped = line.lstrip(" \t")
        for ch in stripped:
            code = ord(ch)
            send_key(0, code, KEYEVENTF_UNICODE)
            send_key(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)
            time.sleep(interval)

        # Newline to move to the next line (editor applies auto-indent).
        press_key(VK_RETURN)
        time.sleep(line_delay)

@app.post("/capture")
def trigger_analysis(req: CaptureRequest, token: Optional[str] = Depends(verify_token)):
    """
    Manual Mode: Triggers invisible screen capture, downscales in memory, 
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
    
    # Capture and downscale image in memory
    image_buffer = capture_and_optimize_screen()
    
    try:
        image_bytes = image_buffer.read()
        image_part = types.Part.from_bytes(
            data=image_bytes,
            mime_type="image/jpeg",
        )
        
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

def parse_gemini_json(raw_text: str) -> dict:
    """Robustly extract and parse JSON from Gemini response text."""
    raw_text = raw_text.strip()

    # Handle markdown code fences
    json_match = re.search(r'```(?:json)?\s*([\s\S]*?)```', raw_text)
    if json_match:
        raw_text = json_match.group(1).strip()

    # Extract outermost JSON object
    start = raw_text.find('{')
    end = raw_text.rfind('}')
    if start == -1 or end == -1 or end <= start:
        raise ValueError("No JSON object found in Gemini response")

    raw_text = raw_text[start:end+1]

    # Attempt 1: direct parse
    try:
        return json.loads(raw_text)
    except json.JSONDecodeError:
        pass

    # Attempt 2: replace single quotes with double quotes (common LLM issue)
    # Only replace single quotes that act as JSON string delimiters (not inside words)
    inside_str = False
    prev = ''
    chars = []
    for ch in raw_text:
        if ch == '"' and prev != '\\':
            inside_str = not inside_str
            chars.append(ch)
        elif ch == "'" and not inside_str:
            chars.append('"')
        elif ch == "'" and inside_str:
            chars.append("'")
        else:
            chars.append(ch)
        prev = ch

    cleaned = ''.join(chars)

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    # Attempt 3: also remove trailing commas
    cleaned = re.sub(r',\s*([\]}])', r'\1', cleaned)

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as e:
        logger.error(f"Gemini raw response text: {raw_text[:500]}")
        raise

def run_autonomous_loop(max_cycles: int, delay_seconds: float):
    """
    Background worker function running the autonomous bot loop.
    Single API Call per cycle retrieves answer and spatial coordinates for option & submit buttons.
    """
    global automation_state
    screen_w, screen_h = get_screen_resolution()
    
    auto_prompt = (
        "You are an automated screen analyzer. Look at the multiple-choice question on screen:\n"
        "1. Identify the question number shown on screen (e.g. 'Question 3', 'Q3', the counter in '3 of 10', etc.). If you cannot find one, output a best-guess number or 0.\n"
        "2. Identify the correct answer option.\n"
        "3. Provide the bounding box [ymin, xmin, ymax, xmax] on a 0-1000 scale for the option button/checkbox of the correct answer.\n"
        "4. Provide the bounding box [ymin, xmin, ymax, xmax] on a 0-1000 scale for the 'Submit', 'Next', or 'Continue' button.\n"
        "Output ONLY valid JSON matching the schema."
    )

    response_schema = {
        "type": "OBJECT",
        "properties": {
            "question_number": {"type": "INTEGER"},
            "answer_text": {"type": "STRING"},
            "option_box": {
                "type": "ARRAY",
                "items": {"type": "NUMBER"},
                "minItems": 4,
                "maxItems": 4
            },
            "submit_box": {
                "type": "ARRAY",
                "items": {"type": "NUMBER"},
                "minItems": 4,
                "maxItems": 4
            }
        },
        "required": ["question_number", "answer_text", "option_box", "submit_box"]
    }

    logger.info(f"Starting autonomous loop (max cycles: {max_cycles}, delay: {delay_seconds}s)")

    for cycle in range(1, max_cycles + 1):
        if stop_event.is_set():
            logger.info("Stop signal received before cycle start.")
            break

        with automation_lock:
            automation_state["cycle"] = cycle
            automation_state["last_action"] = f"Cycle {cycle}/{max_cycles}: Capturing screen & analyzing..."

        try:
            # 1. Capture screen
            image_buffer = capture_and_optimize_screen()
            if stop_event.is_set():
                break

            image_bytes = image_buffer.read()
            image_part = types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg")

            # 2. Single Gemini API Call for answer + spatial bounding boxes
            response = client.models.generate_content(
                model=GEMINI_MODEL,
                contents=[image_part, auto_prompt],
                config=types.GenerateContentConfig(
                    temperature=0.0,
                    response_mime_type="application/json",
                    response_schema=response_schema
                )
            )

            if stop_event.is_set():
                break

            # Parse JSON
            data = parse_gemini_json(response.text)

            answer_text = data.get("answer_text", "Unknown")
            question_number = data.get("question_number", cycle)
            option_box = data.get("option_box")
            submit_box = data.get("submit_box")

            with automation_lock:
                automation_state["last_answer"] = answer_text
                automation_state["question_number"] = question_number
                automation_state["last_action"] = f"Cycle {cycle}: Q{question_number} answer found -> '{answer_text}'"
                # Record result, deduplicated by question number (keep latest answer)
                results = automation_state["results"]
                results = [r for r in results if r.get("question") != question_number]
                results.append({
                    "cycle": cycle,
                    "question": question_number,
                    "answer": answer_text
                })
                automation_state["results"] = results

            # 3. Scatter Click Option
            if option_box and len(option_box) == 4:
                opt_x, opt_y = translate_normalized_box(option_box, screen_w, screen_h)
                with automation_lock:
                    automation_state["last_action"] = f"Cycle {cycle}: Scatter clicking option at ({opt_x}, {opt_y})..."
                
                perform_scatter_click(opt_x, opt_y, clicks=3, radius=8)

            time.sleep(0.5)
            if stop_event.is_set():
                break

            # 4. Click Submit Button
            if submit_box and len(submit_box) == 4:
                sub_x, sub_y = translate_normalized_box(submit_box, screen_w, screen_h)
                with automation_lock:
                    automation_state["last_action"] = f"Cycle {cycle}: Clicking Submit at ({sub_x}, {sub_y})..."
                
                pyautogui.click(sub_x, sub_y)

            # 5. Delay before next cycle (interruptible sleep)
            with automation_lock:
                automation_state["last_action"] = f"Cycle {cycle}: Completed. Waiting {delay_seconds}s for next question..."
            
            # Interruptible sleep honoring the configured delay
            elapsed = 0.0
            while elapsed < delay_seconds:
                if stop_event.is_set():
                    break
                time.sleep(0.1)
                elapsed += 0.1

        except Exception as e:
            logger.error(f"Automation error in cycle {cycle}: {str(e)}")
            with automation_lock:
                automation_state["error"] = f"Cycle {cycle} error: {str(e)}"
                automation_state["last_action"] = f"Error in cycle {cycle}"
            break

    with automation_lock:
        automation_state["is_running"] = False
        automation_state["last_action"] = "Stopped" if stop_event.is_set() else f"Finished ({automation_state['cycle']}/{max_cycles} cycles)"
    logger.info("Autonomous loop finished.")

@app.post("/start-automation")
def start_automation(req: AutomationStartRequest, token: Optional[str] = Depends(verify_token)):
    """Starts the autonomous bot loop in a background thread."""
    global automation_thread, automation_state

    if not client:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Gemini API client is not initialized. Please set GEMINI_API_KEY."
        )

    with automation_lock:
        if automation_state["is_running"]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Automation is already running."
            )

        stop_event.clear()
        max_cycles = min(max(1, req.max_cycles or 100), 100)  # Enforce 1-100 safety limit
        delay = max(0.5, req.delay_seconds or 0.5)

        automation_state.update({
            "is_running": True,
            "cycle": 0,
            "max_cycles": max_cycles,
            "question_number": None,
            "last_action": "Starting automation...",
            "last_answer": None,
            "error": None,
            "run_id": int(time.time() * 1000),
            "results": []
        })

        automation_thread = threading.Thread(
            target=run_autonomous_loop,
            args=(max_cycles, delay),
            daemon=True
        )
        automation_thread.start()

    return {"status": "started", "max_cycles": max_cycles, "delay_seconds": delay}

@app.post("/stop-automation")
def stop_automation(token: Optional[str] = Depends(verify_token)):
    """Stops the autonomous bot loop immediately."""
    with automation_lock:
        if not automation_state["is_running"]:
            return {"status": "already_stopped"}

        stop_event.set()
        automation_state["last_action"] = "Stop requested by user..."

    return {"status": "stopping"}

@app.get("/automation-status")
def get_automation_status():
    """Returns live status of the autonomous bot loop."""
    with automation_lock:
        return dict(automation_state)

@app.post("/coding/capture")
def coding_capture(token: Optional[str] = Depends(verify_token)):
    """Coding Mode: Captures the current screen and appends it to the in-memory buffer."""
    try:
        image_buffer = capture_and_optimize_screen()
        with coding_lock:
            coding_buffer.append(image_buffer)
            count = len(coding_buffer)
        return {"status": "captured", "count": count}
    except Exception as e:
        logger.error(f"Coding capture error: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to capture screen: {str(e)}"
        )

@app.post("/coding/clear")
def coding_clear(token: Optional[str] = Depends(verify_token)):
    """Coding Mode: Clears the in-memory screenshot buffer."""
    with coding_lock:
        coding_buffer.clear()
        count = 0
    return {"status": "cleared", "count": count}

@app.get("/coding/status")
def coding_status():
    """Coding Mode: Returns buffer size and last answer state."""
    with coding_lock:
        return {"count": len(coding_buffer), "has_answer": coding_last_answer is not None}

@app.post("/coding/solve")
def coding_solve(req: CodingSolveRequest, token: Optional[str] = Depends(verify_token)):
    """
    Coding Mode: Sends ALL buffered screenshots to Gemini as one multimodal request
    and returns a single solution answer. An optional custom prompt can be appended
    to the default instructions.
    """
    if not client:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Gemini API client is not initialized. Please set GEMINI_API_KEY."
        )

    with coding_lock:
        buffers = list(coding_buffer)
        count = len(buffers)

    if count == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No screenshots captured yet. Capture at least one screenshot first."
        )

    logger.info(f"Coding solve request with {count} screenshot(s).")

    solve_prompt = (
        "You are an expert coding problem solver. Analyze ALL the provided screenshots "
        "together; they may show parts of a single coding problem (problem statement, "
        "input/output constraints, starter code, etc.).\n"
        "1. Understand the complete problem.\n"
        "2. Write the full, correct, and efficient solution code.\n"
        "3. If you can infer the programming language from the starter code or problem, use it; "
        "otherwise pick the most appropriate language.\n"
        "Output the solution as a single fenced code block containing ONLY the code. "
        "Do NOT include any explanation outside the code block."
    )

    if req.custom_prompt and req.custom_prompt.strip():
        solve_prompt += (
            "\n\nAdditional instructions from the user that MUST be honored:\n"
            f"{req.custom_prompt.strip()}"
        )

    try:
        image_parts = []
        for buf in buffers:
            buf.seek(0)
            image_bytes = buf.read()
            image_parts.append(
                types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg")
            )

        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[*image_parts, solve_prompt],
            config=types.GenerateContentConfig(temperature=0.2)
        )

        answer = response.text
        with coding_lock:
            global coding_last_answer
            coding_last_answer = answer

        return {"result": answer, "screenshots": count}

    except Exception as e:
        logger.error(f"Coding Gemini API error: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"AI processing error: {str(e)}"
        )

@app.post("/coding/paste")
def coding_paste(req: CodingPasteRequest, token: Optional[str] = Depends(verify_token)):
    """
    Coding Mode: Inserts the solution code onto the computer at the current cursor
    location. Supports two methods:
      - "paste": copies to clipboard and sends Ctrl+V (fast, may be blocked).
      - "type": simulates real keystrokes character by character (works where paste is blocked).
    If no text is provided, uses the last solved answer.
    """
    text = req.text
    if text is None:
        with coding_lock:
            text = coding_last_answer
    if not text or not text.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Nothing to paste. Provide code text or solve a problem first."
        )

    # Strip code fences if the LLM wrapped the answer (extract the cleanest code block)
    text = extract_code_from_answer(text)

    method = (req.method or "paste").lower()
    if method not in ("paste", "type"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid method. Use 'paste' or 'type'."
        )

    try:
        # Give the user a window to click the target editor field first
        time.sleep(2)

        if method == "paste":
            import pyperclip
            pyperclip.copy(text)
            pyautogui.hotkey('ctrl', 'v')
            return {"status": "pasted", "method": "paste", "chars": len(text)}

        # Simulated typing: send exact keystrokes via Windows SendInput (handles all
        # characters reliably, including { } which break pyautogui.typewrite).
        _type_text_sendinput(text)
        return {"status": "pasted", "method": "type", "chars": len(text)}

    except Exception as e:
        logger.error(f"Coding paste error: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to paste code: {str(e)}"
        )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
