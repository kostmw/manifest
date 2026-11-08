export function LegalFooter() {
  return (
    <footer className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-xs leading-relaxed text-zinc-500">
      <p>
        Manifest is unofficial fan content. It is not affiliated with, endorsed by, or sponsored by Wizards of the
        Coast, The Pokémon Company, or Konami. Card data ©{' '}
        <a className="underline hover:text-zinc-300" href="https://scryfall.com" rel="noreferrer" target="_blank">
          Scryfall
        </a>
        . Card images never leave your device.
      </p>
    </footer>
  );
}
