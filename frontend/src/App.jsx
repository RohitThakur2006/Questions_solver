import React, { useState, useEffect, useRef } from 'react';
import './App.css';

function App() {
  const [activeTab, setActiveTab] = useState('manual'); // 'manual', 'auto', or 'coding'
  const [prompts, setPrompts] = useState({});
  const [selectedPrompt, setSelectedPrompt] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [backendUrl, setBackendUrl] = useState(`http://${window.location.hostname}:8000`);
  const [authToken, setAuthToken] = useState('super-secret-token-123');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);

  // Auto-Bot Mode State
  const [maxCycles, setMaxCycles] = useState(100);
  const [delaySeconds, setDelaySeconds] = useState(0.5);
  const [automationStatus, setAutomationStatus] = useState({
    is_running: false,
    cycle: 0,
    max_cycles: 100,
    last_action: 'Idle',
    last_answer: null,
    error: null
  });
  const fetchStatusRef = useRef(null);

  // Coding Mode State
  const [codingCount, setCodingCount] = useState(0);
  const [codingHasAnswer, setCodingHasAnswer] = useState(false);
  const [codingLoading, setCodingLoading] = useState(false);
  const [codingCapturing, setCodingCapturing] = useState(false);
  const [codingResult, setCodingResult] = useState('');
  const [codingPrompt, setCodingPrompt] = useState('');

  // Session History (sessionStorage)
  const [history, setHistory] = useState(() => {
    try {
      const saved = sessionStorage.getItem('session_history');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Fetch available prompts and connection status
  useEffect(() => {
    fetchPrompts();
  }, [backendUrl]);

  // Save history to sessionStorage whenever it changes
  useEffect(() => {
    try {
      sessionStorage.setItem('session_history', JSON.stringify(history));
    } catch (err) {
      console.error("Failed to save session history:", err);
    }
  }, [history]);

  // Poll automation status when connected or running
  useEffect(() => {
    let interval;
    if (connected) {
      fetchStatusRef.current();
      interval = setInterval(() => fetchStatusRef.current(), 1000);
    }
    return () => clearInterval(interval);
  }, [connected, backendUrl]);

  const fetchPrompts = async () => {
    try {
      setError('');
      const res = await fetch(`${backendUrl}/prompts`);
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      const data = await res.json();
      setPrompts(data);
      const keys = Object.keys(data);
      if (keys.length > 0 && !selectedPrompt) {
        setSelectedPrompt(keys[0]);
      }
      setConnected(true);
    } catch (err) {
      console.error("Connection error:", err);
      setConnected(false);
      setError(`Could not connect to backend at ${backendUrl}. Ensure FastAPI is running and both devices are on the same Wi-Fi.`);
    }
  };

  const fetchAutomationStatus = async () => {
    try {
      const res = await fetch(`${backendUrl}/automation-status`);
      if (!res.ok) return;
      const data = await res.json();
      setAutomationStatus(data);

      // The backend "results" list is the single source of truth for Auto Bot history.
      // Rebuild the Auto Bot portion of history from it on every poll so it always
      // reflects the full, correct set of answered questions (never duplicates).
      if (Array.isArray(data.results)) {
        const autoItems = data.results
          .filter(r => r && r.question != null && r.answer != null)
          .map(r => ({
            id: `${data.run_id}-${r.question}`,
            timestamp: new Date().toLocaleTimeString(),
            mode: 'Auto Bot',
            question: r.question,
            answer: r.answer
          }))
          .reverse(); // newest question first

        setHistory(prev => {
          const manualItems = prev.filter(i => i.mode !== 'Auto Bot');
          return [...autoItems, ...manualItems];
        });
      }
    } catch (err) {
      console.error("Failed to fetch automation status:", err);
    }
  };

  fetchStatusRef.current = fetchAutomationStatus;

  const handleManualCapture = async () => {
    if (!selectedPrompt) {
      setError("Please select an AI prompt mode.");
      return;
    }

    if (selectedPrompt === 'custom' && !customPrompt.trim()) {
      setError("Please enter your custom prompt instructions.");
      return;
    }

    setLoading(true);
    setError('');
    setResult('');

    try {
      const payload = { prompt_key: selectedPrompt };
      if (selectedPrompt === 'custom') {
        payload.custom_prompt = customPrompt.trim();
      }

      const res = await fetch(`${backendUrl}/capture`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Token': authToken,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.detail || `Server error: ${res.status}`);
      }

      const answerText = data.result;
      setResult(answerText);

      const promptName = selectedPrompt === 'custom' 
        ? `Custom: ${customPrompt.substring(0, 30)}...` 
        : (prompts[selectedPrompt]?.name || selectedPrompt);

      const newItem = {
        id: Date.now(),
        timestamp: new Date().toLocaleTimeString(),
        mode: promptName,
        answer: answerText
      };

      setHistory(prev => [newItem, ...prev]);

    } catch (err) {
      console.error("Capture trigger error:", err);
      setError(err.message || "Failed to trigger capture and analysis.");
    } finally {
      setLoading(false);
    }
  };

  const handleStartAutomation = async () => {
    setError('');
    try {
      const res = await fetch(`${backendUrl}/start-automation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Token': authToken,
        },
        body: JSON.stringify({
          max_cycles: parseInt(maxCycles, 10),
          delay_seconds: parseFloat(delaySeconds) || 0.1
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || `Failed to start bot: ${res.status}`);
      }

      fetchAutomationStatus();
    } catch (err) {
      console.error("Start automation error:", err);
      setError(err.message || "Failed to start autonomous bot.");
    }
  };

  const handleStopAutomation = async () => {
    try {
      const res = await fetch(`${backendUrl}/stop-automation`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Token': authToken,
        },
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || "Failed to stop bot.");
      }

      fetchAutomationStatus();
    } catch (err) {
      console.error("Stop automation error:", err);
      setError(err.message || "Failed to stop autonomous bot.");
    }
  };

  const clearHistory = () => {
    setHistory([]);
    sessionStorage.removeItem('session_history');
  };

  const fetchCodingStatus = async () => {
    try {
      const res = await fetch(`${backendUrl}/coding/status`);
      if (res.ok) {
        const data = await res.json();
        setCodingCount(data.count);
        setCodingHasAnswer(data.has_answer);
      }
    } catch (err) {
      console.error("Failed to fetch coding status:", err);
    }
  };

  const handleCodingCapture = async () => {
    setCodingCapturing(true);
    setError('');
    try {
      const res = await fetch(`${backendUrl}/coding/capture`, {
        method: 'POST',
        headers: { 'X-Auth-Token': authToken },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `Server error: ${res.status}`);
      setCodingCount(data.count);
    } catch (err) {
      console.error("Coding capture error:", err);
      setError(err.message || "Failed to capture screenshot.");
    } finally {
      setCodingCapturing(false);
    }
  };

  const handleCodingClear = async () => {
    setError('');
    setCodingResult('');
    try {
      const res = await fetch(`${backendUrl}/coding/clear`, {
        method: 'POST',
        headers: { 'X-Auth-Token': authToken },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `Server error: ${res.status}`);
      setCodingCount(data.count);
      setCodingHasAnswer(false);
    } catch (err) {
      console.error("Coding clear error:", err);
      setError(err.message || "Failed to clear screenshots.");
    }
  };

  const handleCodingSolve = async () => {
    setError('');
    setCodingResult('');
    if (codingCount === 0) {
      setError("Capture at least one screenshot first.");
      return;
    }
    setCodingLoading(true);
    try {
      const res = await fetch(`${backendUrl}/coding/solve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Token': authToken,
        },
        body: JSON.stringify({ custom_prompt: codingPrompt.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `Server error: ${res.status}`);
      setCodingResult(data.result);
      setCodingHasAnswer(true);
    } catch (err) {
      console.error("Coding solve error:", err);
      setError(err.message || "Failed to solve the problem.");
    } finally {
      setCodingLoading(false);
    }
  };

  const handleCodingPaste = async (method) => {
    setError('');
    // Tell the user immediately where to focus, BEFORE the backend types,
    // otherwise they never know to click into the editor field.
    if (method === 'type') {
      setError('Typing code onto your computer... Click your editor field within 2 seconds.');
    }
    try {
      const res = await fetch(`${backendUrl}/coding/paste`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Token': authToken,
        },
        body: JSON.stringify({ method }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `Server error: ${res.status}`);
      setError(method === 'type'
        ? 'Typing complete. Code was typed into your editor.'
        : 'Pasted to computer. Click your editor field within 2 seconds of the next paste.');
    } catch (err) {
      console.error("Coding paste error:", err);
      setError(err.message || "Failed to paste code.");
    }
  };

  return (
    <div className="container">
      <header className="header">
        <h1>AI Screen Analyzer</h1>
        <div className={`status-badge ${connected ? 'online' : 'offline'}`}>
          {connected ? '● Backend Connected' : '○ Disconnected'}
        </div>
      </header>

      {/* Mode Switcher Tabs */}
      <div className="tab-bar">
        <button 
          className={`tab-btn ${activeTab === 'manual' ? 'active' : ''}`}
          onClick={() => setActiveTab('manual')}
        >
          📷 Manual Mode
        </button>
        <button 
          className={`tab-btn ${activeTab === 'auto' ? 'active' : ''}`}
          onClick={() => setActiveTab('auto')}
        >
          🤖 Auto Bot Mode {automationStatus.is_running && <span className="running-dot">●</span>}
        </button>
        <button 
          className={`tab-btn ${activeTab === 'coding' ? 'active' : ''}`}
          onClick={() => setActiveTab('coding')}
        >
          💻 Coding Mode
        </button>
      </div>

      <div className="settings-card">
        <label htmlFor="backend-url-input">Backend IP / URL:</label>
        <div className="url-row" style={{ marginBottom: '12px' }}>
          <input 
            id="backend-url-input"
            type="text" 
            value={backendUrl} 
            onChange={(e) => setBackendUrl(e.target.value)} 
            placeholder="http://192.168.x.x:8000"
          />
          <button onClick={fetchPrompts} className="btn-secondary">Reconnect</button>
        </div>

        <label htmlFor="auth-token-input">Auth Token:</label>
        <input 
          id="auth-token-input"
          type="password" 
          value={authToken} 
          onChange={(e) => setAuthToken(e.target.value)} 
          placeholder="Enter secret token"
          style={{
            width: '100%',
            padding: '10px',
            borderRadius: '8px',
            border: '1px solid #475569',
            background: '#0f172a',
            color: '#f8fafc',
            fontSize: '0.95rem',
            boxSizing: 'border-box',
            outline: 'none'
          }}
        />
      </div>

      {/* MANUAL MODE UI */}
      {activeTab === 'manual' && (
        <div className="control-card">
          <label htmlFor="prompt-select">Select AI Mode:</label>
          <select 
            id="prompt-select"
            value={selectedPrompt} 
            onChange={(e) => setSelectedPrompt(e.target.value)}
            disabled={loading || Object.keys(prompts).length === 0}
          >
            {Object.keys(prompts).length === 0 ? (
              <option>Loading modes...</option>
            ) : (
              Object.entries(prompts).map(([key, val]) => (
                <option key={key} value={key}>
                  {val.name}
                </option>
              ))
            )}
          </select>
          {prompts[selectedPrompt] && (
            <p className="prompt-desc">{prompts[selectedPrompt].description}</p>
          )}

          {selectedPrompt === 'custom' && (
            <div className="custom-prompt-container" style={{ marginBottom: '16px' }}>
              <label htmlFor="custom-prompt-input">Custom Prompt Instructions:</label>
              <textarea
                id="custom-prompt-input"
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder="Enter what you want the AI to do with the screen..."
                rows={3}
                style={{
                  width: '100%',
                  padding: '12px',
                  borderRadius: '8px',
                  border: '1px solid #475569',
                  background: '#0f172a',
                  color: '#f8fafc',
                  fontSize: '0.95rem',
                  boxSizing: 'border-box',
                  resize: 'vertical',
                  outline: 'none',
                  fontFamily: 'inherit'
                }}
              />
            </div>
          )}

          <button 
            onClick={handleManualCapture} 
            disabled={loading || !connected} 
            className="btn-primary"
          >
            {loading ? (
              <span className="spinner-container">
                <span className="spinner"></span> Capturing & Analyzing...
              </span>
            ) : (
              '📸 Capture & Analyze Screen'
            )}
          </button>
        </div>
      )}

      {/* AUTO BOT MODE UI */}
      {activeTab === 'auto' && (
        <div className="control-card">
          <h2>Autonomous Bot Controller</h2>
          <p className="prompt-desc">
            Automatically captures questions, spatial tracks option boxes & submit buttons, clicks answers using scatter-clicks, and iterates through questions.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
            <div>
              <label htmlFor="max-cycles-input">Max Cycles (1-100):</label>
              <input 
                id="max-cycles-input"
                type="number" 
                min="1" 
                max="100" 
                value={maxCycles} 
                onChange={(e) => setMaxCycles(e.target.value)}
                disabled={automationStatus.is_running}
              />
            </div>
            <div>
              <label htmlFor="delay-input">Cycle Delay (s):</label>
              <input 
                id="delay-input"
                type="number" 
                step="0.5" 
                min="0.5" 
                value={delaySeconds} 
                onChange={(e) => setDelaySeconds(e.target.value)}
                disabled={automationStatus.is_running}
              />
            </div>
          </div>

          <div className="status-box" style={{ background: '#0f172a', padding: '14px', borderRadius: '10px', marginBottom: '16px', border: '1px solid #334155' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
              <span style={{ fontWeight: 600, color: automationStatus.is_running ? '#34d399' : '#94a3b8' }}>
                {automationStatus.is_running ? '🤖 Bot Running' : '⏸ Bot Stopped'}
              </span>
              <span style={{ fontSize: '0.85rem', color: '#cbd5e1' }}>
                Cycle: {automationStatus.cycle} / {automationStatus.max_cycles}
              </span>
            </div>

            <div style={{ fontSize: '0.85rem', color: '#38bdf8', marginBottom: '4px' }}>
              <strong>Last Action:</strong> {automationStatus.last_action}
            </div>

            {automationStatus.last_answer && (
              <div style={{ fontSize: '0.85rem', color: '#a7f3d0' }}>
                <strong>Last Detected Answer:</strong> {automationStatus.last_answer}
              </div>
            )}

            {automationStatus.error && (
              <div style={{ fontSize: '0.85rem', color: '#f87171', marginTop: '4px' }}>
                <strong>Error:</strong> {automationStatus.error}
              </div>
            )}
          </div>

          {automationStatus.is_running ? (
            <button 
              onClick={handleStopAutomation} 
              className="btn-danger"
            >
              ⏹ Stop Automation Bot
            </button>
          ) : (
            <button 
              onClick={handleStartAutomation} 
              disabled={!connected} 
              className="btn-primary"
            >
              ▶ Start Automation Bot
            </button>
          )}
        </div>
      )}

      {/* CODING MODE UI */}
      {activeTab === 'coding' && (
        <div className="control-card">
          <h2>Coding Problem Solver</h2>
          <p className="prompt-desc">
            Capture one or more screenshots of a coding problem (e.g. problem statement, examples, starter code), then send them all to the AI at once for a single solution. Optionally paste the answer directly into your editor on the computer.
          </p>

          <div className="status-box" style={{ background: '#0f172a', padding: '14px', borderRadius: '10px', marginBottom: '16px', border: '1px solid #334155' }}>
            <div style={{ fontSize: '0.85rem', color: '#cbd5e1' }}>
              <strong>Captured Screenshots:</strong> {codingCount}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '16px' }}>
            <button 
              onClick={handleCodingCapture} 
              disabled={codingCapturing || !connected} 
              className="btn-primary"
            >
              {codingCapturing ? 'Capturing...' : `📸 Capture Screenshot (${codingCount})`}
            </button>
            <button 
              onClick={handleCodingClear} 
              disabled={codingCount === 0 || codingLoading} 
              className="btn-secondary"
            >
              🗑 Clear Screenshots
            </button>
          </div>

          <div className="custom-prompt-container" style={{ marginBottom: '16px' }}>
            <label htmlFor="coding-prompt-input">Additional Instructions (optional):</label>
            <textarea
              id="coding-prompt-input"
              value={codingPrompt}
              onChange={(e) => setCodingPrompt(e.target.value)}
              placeholder="e.g. Use Python, optimize for large inputs, explain the approach in comments..."
              rows={3}
              style={{
                width: '100%',
                padding: '12px',
                borderRadius: '8px',
                border: '1px solid #475569',
                background: '#0f172a',
                color: '#f8fafc',
                fontSize: '0.95rem',
                boxSizing: 'border-box',
                resize: 'vertical',
                outline: 'none',
                fontFamily: 'inherit'
              }}
            />
          </div>

          <button 
            onClick={handleCodingSolve} 
            disabled={codingLoading || codingCount === 0 || !connected} 
            className="btn-primary"
            style={{ width: '100%' }}
          >
            {codingLoading ? (
              <span className="spinner-container">
                <span className="spinner"></span> Solving {codingCount} screenshot(s)...
              </span>
            ) : (
              `🚀 Solve Problem (${codingCount} screenshot${codingCount === 1 ? '' : 's'})`
            )}
          </button>

          {codingResult && (
            <div className="result-card" style={{ marginTop: '16px' }}>
              <h2>Solution Answer</h2>
              <div className="result-content" style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
                {codingResult}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '12px' }}>
                <button 
                  onClick={() => handleCodingPaste('paste')} 
                  disabled={!connected} 
                  className="btn-primary"
                >
                  📋 Paste Code to Computer
                </button>
                <button 
                  onClick={() => handleCodingPaste('type')} 
                  disabled={!connected} 
                  className="btn-primary"
                  style={{ background: 'linear-gradient(135deg, #334155 0%, #475569 100%)', boxShadow: '0 4px 12px rgba(71, 85, 105, 0.3)' }}
                >
                  ⌨️ Type Code (if paste blocked)
                </button>
              </div>
              <p style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '8px', textAlign: 'center' }}>
                Tap an option, then click your editor field on the computer within 2 seconds.
              </p>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="error-card">
          <strong>⚠️ Error</strong>
          <p>{error}</p>
        </div>
      )}

      {result && activeTab === 'manual' && (
        <div className="result-card">
          <h2>Latest AI Answer</h2>
          <div className="result-content">
            {result}
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div className="history-card" style={{ background: '#1e293b', borderRadius: '16px', padding: '20px', marginBottom: '16px', border: '1px solid #334155' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h2 style={{ fontSize: '1.1rem', color: '#38bdf8', margin: 0 }}>Session History ({history.length})</h2>
            <button onClick={clearHistory} className="btn-secondary" style={{ fontSize: '0.8rem', padding: '6px 12px' }}>Clear History</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '350px', overflowY: 'auto' }}>
            {history.map((item) => (
              <div key={item.id} style={{ background: '#0f172a', padding: '12px', borderRadius: '8px', border: '1px solid #334155' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '6px' }}>
                  <span style={{ fontWeight: 600, color: '#38bdf8' }}>{item.mode}{item.question != null ? ` — Question ${item.question}` : ''}</span>
                  <span>{item.timestamp}</span>
                </div>
                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace', fontSize: '0.85rem', color: '#e2e8f0' }}>
                  {item.answer}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
