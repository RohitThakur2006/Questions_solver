# Mobile-Triggered AI Screen Analyzer & Autonomous Bot

A local Wi-Fi automation system that allows you to press a button on your mobile phone, triggering your laptop to silently capture its active screen, optimize the image in memory, process it via the Gemini Vision API using dynamic or custom prompts, and return the final answer to your phone interface—with a fully autonomous **Auto Bot Mode**.

---

## Features & Modes

* **📷 Manual Mode:** Original single-fire trigger button. Select predefined or custom prompts, capture screen instantly, and view AI answers on your phone.
* **🤖 Auto Bot Mode:** Autonomous loop that captures the screen, performs **single-call Gemini spatial tracking** to locate option checkboxes and Submit buttons, executes randomized **scatter clicks** to guarantee selection, clicks Submit, and auto-iterates through questions.
* **🔒 Token Security:** Pre-shared secret token (`X-Auth-Token` header) protects endpoints from unauthorized network access.
* **💾 Session History:** Maintains a live audit trail of captures in `sessionStorage` (clears automatically when closing tab).

---

## Architecture & Tech Stack

* **Backend (Host):** FastAPI (Python), `mss` (high-speed capture), `Pillow` (in-memory compression), `PyAutoGUI` (mouse automation), `google-genai` SDK (`gemini-2.5-flash` / `gemini-3.5-flash-lite`).
* **Frontend (Trigger/Mobile):** React (Vite template), Dual Mode tabs (Manual vs Auto Bot), live status polling.
* **Network:** Local Wi-Fi network (direct laptop-to-phone communication via local IP).

---

## Prerequisites

1. Python 3.10+ installed on your laptop.
2. Node.js (v18+) installed on your laptop.
3. A Google Gemini API Key.

---

## Setup & Installation Guide

### 1. Clone & Set Up Backend

```bash
# Clone repository
git clone <your-repository-url>
cd automatic

# Install python dependencies
pip install -r requirements.txt

# Configure environment variables
cp .env.example .env
```

Open `.env` and add your Gemini API Key and secret `API_TOKEN`:
```env
GEMINI_API_KEY=your_actual_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash
API_TOKEN=super-secret-token-123
```

### 2. Set Up Frontend

```bash
cd frontend
npm install
```

---

## Running the Application

### Step 1: Start the Backend Server
From the root directory:
```bash
python main.py
```
*(The FastAPI server will run on `http://0.0.0.0:8000`)*

### Step 2: Start the Frontend
From the `frontend` directory:
```bash
npm run dev -- --host
```
Note the local network URL displayed in your terminal (e.g., `http://192.168.1.50:5173`).

### Step 3: Access from your Mobile Phone
1. Ensure your phone and laptop are connected to the **same Wi-Fi network**.
2. Open your phone browser and navigate to the Vite network URL (`http://<laptop-ip>:5173`).
3. In the app settings on your phone:
   - Ensure the Backend URL points to `http://<laptop-ip>:8000`.
   - Enter your `Auth Token` matching the `API_TOKEN` set in your laptop's `.env` file.
4. Choose between **Manual Mode** (single button capture) or **Auto Bot Mode** (Start/Stop autonomous loop)!
