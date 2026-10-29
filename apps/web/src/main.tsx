// Must stay the first import: see installPolicy.ts.
import './installPolicy';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './i18n';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
