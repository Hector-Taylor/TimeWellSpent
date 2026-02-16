import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { NewTabApp } from './newtab/NewTabApp';
import './newtab.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <NewTabApp />
  </StrictMode>,
);
