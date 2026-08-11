import { createRoot } from 'react-dom/client';
import { FluentProvider, webDarkTheme } from '@fluentui/react-components';
import { App } from './app';
import './styles.css';

createRoot(document.getElementById('root')!).render(<FluentProvider theme={webDarkTheme}><App /></FluentProvider>);
