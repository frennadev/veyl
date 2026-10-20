// The icon sprite (<symbol id="i-…">) every app page references with <use href="#i-name">. One copy, shared by /app and /v2.
// The {' '} text nodes are the whitespace the old HTML had between the symbols, kept so /app's markup stays byte-identical.
export default function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">{' '}
    <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.9-4.3-1.7-7.5-5.3-7.5-9.9V6z" fill="none" stroke="currentColor" strokeWidth="1.9" /><path d="M8.8 12.2l2.3 2.3 4.3-4.6" fill="none" stroke="currentColor" strokeWidth="1.9" /></symbol>{' '}
    <symbol id="i-lock" viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="10" rx="3" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" fill="none" stroke="currentColor" strokeWidth="2" /></symbol>{' '}
    <symbol id="i-key" viewBox="0 0 24 24"><circle cx="8" cy="15" r="4" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M11 12l8-8M16 7l2 2M14 9l2 2" fill="none" stroke="currentColor" strokeWidth="2" /></symbol>{' '}
    <symbol id="i-eye" viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" fill="none" stroke="currentColor" strokeWidth="1.8" /><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.8" /></symbol>{' '}
    <symbol id="i-eyeoff" viewBox="0 0 24 24"><path d="M3 3l18 18M10 5.7A9.6 9.6 0 0 1 12 5.5C18 5.5 21.5 12 21.5 12a16 16 0 0 1-2.7 3.4M15 18a8.6 8.6 0 0 1-3 .5C6 18.5 2.5 12 2.5 12a16 16 0 0 1 3.9-4.6" fill="none" stroke="currentColor" strokeWidth="1.8" /></symbol>{' '}
    <symbol id="i-back" viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" /></symbol>{' '}
    <symbol id="i-right" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.2" /></symbol>{' '}
    <symbol id="i-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" /></symbol>{' '}
    <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="2" /></symbol>{' '}
    <symbol id="i-check" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" /></symbol>{' '}
    <symbol id="i-alert" viewBox="0 0 24 24"><path d="M12 3.5 2.5 20h19L12 3.5Z" fill="none" stroke="currentColor" strokeWidth="1.9" /><path d="M12 10v4.5M12 17.2v.3" stroke="currentColor" strokeWidth="2" /></symbol>{' '}
    <symbol id="i-down" viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.2" /></symbol>{' '}
    <symbol id="i-qr" viewBox="0 0 24 24"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /><path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 18.5h2M18.5 14H20" fill="none" stroke="currentColor" strokeWidth="1.8" /></symbol>{' '}
    <symbol id="i-up" viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6" fill="none" stroke="currentColor" strokeWidth="2.2" /></symbol>{' '}
    <symbol id="i-wallet" viewBox="0 0 24 24"><rect x="3.5" y="6" width="17" height="13" rx="3" fill="none" stroke="currentColor" strokeWidth="1.9" /><path d="M16 12.5h1.5M3.5 9.5h17" stroke="currentColor" strokeWidth="1.9" /></symbol>{' '}
    <symbol id="i-bars" viewBox="0 0 24 24"><path d="M4 20V14M8 20V10M12 20V6M16 20V10M20 20V14" stroke="currentColor" strokeWidth="2.2" /></symbol>{' '}
    <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.9" /><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" strokeWidth="1.9" /></symbol>{' '}
    <symbol id="i-swap" viewBox="0 0 24 24"><path d="M7 4v13M3.5 13.5 7 17l3.5-3.5M17 20V7M13.5 10.5 17 7l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.9" /></symbol>{' '}
    <symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M3.5 12h17M12 3.5c3 3 3 14 0 17M12 3.5c-3 3-3 14 0 17" fill="none" stroke="currentColor" strokeWidth="1.6" /></symbol>{' '}
    <symbol id="i-menu" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10" stroke="currentColor" strokeWidth="2" /></symbol>{' '}
    <symbol id="i-book" viewBox="0 0 24 24"><path d="M5 4.5h9.5a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3Z" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M5 17a3 3 0 0 1 3-3h9.5" fill="none" stroke="currentColor" strokeWidth="1.8" /></symbol>{' '}
    <symbol id="i-seal" viewBox="0 0 24 24"><rect x="3.5" y="7" width="17" height="12" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M3.5 9.5 12 14l8.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M8 7V5.5a4 4 0 0 1 8 0V7" fill="none" stroke="currentColor" strokeWidth="1.8" /></symbol>{' '}
    <symbol id="i-filter" viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" strokeWidth="2" /></symbol>{' '}
    <symbol id="i-cols" viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M9.5 5v14M14.5 5v14" stroke="currentColor" strokeWidth="1.8" /></symbol>{' '}
    <symbol id="i-ext" viewBox="0 0 24 24"><path d="M9 6h9v9M18 6 7 17" fill="none" stroke="currentColor" strokeWidth="2" /></symbol>{' '}
    <symbol id="i-bolt" viewBox="0 0 24 24"><path d="M13.5 2.5 5 13.5h6.5L10 21.5l9-11.5h-6.5l1-7.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" /></symbol>{' '}
    </svg>
  );
}
