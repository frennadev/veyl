// /app (exported as app.html): the Veyl app. React components on top of the browser engine (engine/ + sdk/, the veyl-sol.js
// bundle), which the app loads itself (lib/veyl/runtime.ts). Every screen lives in features/; architecture and the rules for
// adding to it: web/INTEGRATION.md. Element ids and classes follow app.css and the e2e suites (e2e/*.js drive this page).
import PageHead from '@/components/PageHead';
import AppShell from '@/features/shell/AppShell';
import { asset } from '@/lib/assets';

const DESCRIPTION = 'Veyl app: private DLMM pools, swaps, limit orders and shielded positions on Solana.';

export default function App() {
  return (
    <>
      <PageHead title="Veyl App" description={DESCRIPTION} styles={[asset('app.css')]} />
      <AppShell />
    </>
  );
}
