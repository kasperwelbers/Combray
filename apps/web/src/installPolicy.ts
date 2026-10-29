// Imported first by main.tsx, so the policy exists before any module touches the DOM or starts
// the data worker (imports are evaluated in order, before main.tsx's own code runs).
import { installTrustedTypesPolicy } from './security';

installTrustedTypesPolicy();
