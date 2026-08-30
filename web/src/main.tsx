import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { LoginGate } from './components/LoginGate.js';
import './styles.css';

// The gate wraps App rather than living inside it, so that App is never mounted for a caller who is
// not signed in: its very first render starts a poll of /api/stats, and a gate one level down would
// mean every unauthenticated visit fired a request that could only 401.
createRoot(document.getElementById('root') as HTMLElement).render(
    <StrictMode>
        <LoginGate>
            <App />
        </LoginGate>
    </StrictMode>,
);
