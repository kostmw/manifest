import { CameraPreview } from './capture/CameraPreview';
import { LegalFooter } from './ui/LegalFooter';

export function App() {
  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col pt-[env(safe-area-inset-top)]">
      <header className="flex items-baseline gap-3 px-4 py-3">
        <h1 className="text-xl font-semibold tracking-tight">Manifest</h1>
        <p className="text-sm text-zinc-400">Scan a stack, get a list.</p>
      </header>
      <main className="flex flex-1 flex-col gap-4 px-4 pb-4">
        <CameraPreview />
      </main>
      <LegalFooter />
    </div>
  );
}
