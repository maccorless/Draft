import React from 'react';
import ReactDOM from 'react-dom/client';

// Root app entry point — routing and screen selection handled by later modules.
// For now this is a placeholder that won't cause any errors.
function App(): React.ReactElement {
  return <div id="app-root">Draft Platform Loading...</div>;
}

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
