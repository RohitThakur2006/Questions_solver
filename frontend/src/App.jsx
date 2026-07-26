import React, { useState, useEffect } from 'react';
import './App.css';

function App() {
  const [prompts, setPrompts] = useState({});
  const [selectedPrompt, setSelectedPrompt] = useState('');
  const [customPrompt, setCustomPrompt] = useState('');
  const [backendUrl, setBackendUrl] = useState(`http://${window.location.hostname}:8000`);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);

  // Fetch available prompts and check backend connection on load
  useEffect(() => {
    fetchPrompts();
  }, [backendUrl]);

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
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.detail || `Server error: ${res.status}`);
      }

      setResult(data.result);
    } catch (err) {
      console.error("Capture trigger error:", err);
      setError(err.message || "Failed to trigger capture and analysis.");
    } finally {
      setLoading(false);
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

      <div className="settings-card">
        <label htmlFor="backend-url-input">Backend IP / URL:</label>
        <div className="url-row">
          <input 
            id="backend-url-input"
            type="text" 
            value={backendUrl} 
            onChange={(e) => setBackendUrl(e.target.value)} 
            placeholder="http://192.168.x.x:8000"
          />
          <button onClick={fetchPrompts} className="btn-secondary">Reconnect</button>
        </div>
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
          <h2>AI Answer</h2>
          <div className="result-content">
            {result}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
