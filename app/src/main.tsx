import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startIndexUpdates } from './games/indexUpdates';
import { ErrorBoundary } from './ui/ErrorBoundary';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// Looks for the nightly card index build in the background; the app keeps using the one it has until a new one is complete.
startIndexUpdates();
