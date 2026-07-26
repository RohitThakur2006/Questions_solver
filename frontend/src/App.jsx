import React, { useState, useEffect } from 'react';
import './App.css';

function App() {
  const [prompts, setPrompts] = useState({});
  const [selectedPrompt, setSelectedPrompt] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [backendUrl, setBackendUrl] = useState(`http://${window.location.hostname}:8000`);
  const [authToken, setAuthToken] = useState('super-secret-token-123');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState('');
  const [history, setHistory] = useState(() => {
    try {
      const saved = sessionStorage.getItem('session_history');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);

  // Fetch available prompts and check backend connection on load
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

  const handleCapture = async () => {
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

      // Add to session history
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

  const clearHistory = () => {
    setHistory([]);
    sessionStorage.removeItem('session_history');
  };

  return (
    <div className="container">
      <header className="header">
        <h1>AI Screen Analyzer</h1>
        <div className={`status-badge ${connected ? 'online' : 'offline'}`}>
          {connected ? '● Backend Connected' : '○ Disconnected'}
        </div>
      </header>

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
          onClick={handleCapture} 
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

      {error && (
        <div className="error-card">
          <strong>⚠️ Error</strong>
          <p>{error}</p>
        </div>
      )}

      {result && (
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '400px', overflowY: 'auto' }}>
            {history.map((item) => (
              <div key={item.id} style={{ background: '#0f172a', padding: '12px', borderRadius: '8px', border: '1px solid #334155' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#94a3b8', marginBottom: '6px' }}>
                  <span style={{ fontWeight: 600, color: '#38bdf8' }}>{item.mode}</span>
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
